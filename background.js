/**
 * Envoy Bulk Booking — Background Service Worker
 *
 * Orchestrates the headless booking flow:
 *  1. Opens dashboard.envoy.com/schedule in a background tab
 *  2. Waits for it to fully load
 *  3. Sends START_BOOKING to the content script
 *  4. Relays progress / log messages to chrome.storage.session
 *     (popup reads live updates from storage)
 *  5. Closes the background tab when done (or on error)
 */

const SCHEDULE_URL        = 'https://dashboard.envoy.com/schedule';
const MAP_BASE_URL        = 'https://dashboard.envoy.com/spaces/maps/live';
const MAP_DEFAULT_LOC_ID  = '124269';
const TAB_LOAD_TIMEOUT    = 20_000;
const SSO_REDIRECT_TIMEOUT = 30_000;
const SSO_SETTLE_DELAY     = 1_500;
const SSO_REDIRECT_SETTLE  = 10_000;
const MAP_SEAT_TIMEOUT    = 35_000; // ms to wait for resolveFeatureId
const MAP_BOOKING_TIMEOUT = 30_000; // ms to wait for bookSeatOnCurrentPage

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toLocalDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/* ── Daily scheduling helpers ────────────────────────────────────────── */

function getTodayString() {
  return new Date().toISOString().slice(0, 10);
}

function scheduleNextAlarm() {
  const now = new Date();
  const next11am = new Date(now);
  next11am.setHours(11, 0, 0, 0);
  if (now >= next11am) next11am.setDate(next11am.getDate() + 1);
  chrome.alarms.create('dailyBooking', {
    when: next11am.getTime(),
    periodInMinutes: 1440,
  });
}

function showBookingNotification(status, total, errorMsg) {
  const isError = status === 'error';
  const isNone  = status === 'done' && total === 0;
  const message = isError ? `Booking failed: ${errorMsg}`
                : isNone  ? 'No desks found to book today.'
                :            `Done — scheduled ${total} desk(s).`;
  chrome.notifications.create('bookingResult', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Envoy Bulk Booking',
    message,
    requireInteraction: true,
  });
}

/* ── Storage helpers ─────────────────────────────────────────────────── */

async function getState() {
  const data = await chrome.storage.session.get('envoy_booking');
  return data.envoy_booking || defaultState();
}

function defaultState() {
  return {
    status: 'idle',          // idle | running | done | error
    current: 0,
    total: 0,
    log: [],
    bookings: [],
  };
}

async function setState(patch) {
  const prev = await getState();
  await chrome.storage.session.set({ envoy_booking: { ...prev, ...patch } });
}

async function addLog(level, msg) {
  const now  = new Date();
  const time = now.toTimeString().slice(0, 8);
  const entry = { time, level, msg };

  const prev = await getState();
  const log  = [...(prev.log || []), entry];
  await chrome.storage.session.set({ envoy_booking: { ...prev, log } });
}

/* ── Login helpers ───────────────────────────────────────────────────── */

function isLoginUrl(url) {
  return url.includes('/login') || url.includes('/sign-in') || url.includes('/auth');
}

function fillEmailAndSubmit(email) {
  const selectors = ['input[type="email"]', 'input[name="email"]', 'input[id*="email"]', 'input[placeholder*="email" i]'];
  let field = null;
  for (const s of selectors) { field = document.querySelector(s); if (field) break; }
  if (!field) return 'no_email_field';

  // React-compatible value injection
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(field, email);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));

  const btnSelectors = ['button[type="submit"]', 'button[data-test*="continue"]', 'button[data-test*="submit"]', 'input[type="submit"]'];
  let btn = null;
  for (const s of btnSelectors) { btn = document.querySelector(s); if (btn && !btn.disabled) break; }
  const form = field.closest('form');
  if (!btn) {
    btn = form ? Array.from(form.querySelectorAll('button')).find((b) => !b.disabled) : null;
  }
  if (btn) { btn.click(); return 'submitted'; }

  if (form) { form.submit(); return 'form_submitted'; }
  return 'no_submit_button';
}

async function attemptAutoLogin(tabId) {
  const { envoyEmail } = await chrome.storage.local.get('envoyEmail');

  if (!envoyEmail) {
    throw new Error('Redirected to login page. Open Settings (gear icon) and save your Envoy email to enable auto-login.');
  }

  await addLog('info', `Auto-login: submitting email ${envoyEmail}…`);

  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: fillEmailAndSubmit,
    args: [envoyEmail],
  });

  if (result[0]?.result === 'no_email_field') {
    throw new Error('Auto-login failed: email field not found. The Envoy login form may have changed.');
  }

  // Wait for SSO redirect — corporate IdP auth completes automatically via browser cookies
  await addLog('info', 'Auto-login: waiting for SSO redirect to complete…');
  await waitForTabComplete(tabId, SSO_REDIRECT_TIMEOUT).catch(() => {});
  await sleep(SSO_REDIRECT_SETTLE);

  const tab = await chrome.tabs.get(tabId);
  if (isLoginUrl(tab.url)) {
    throw new Error('Auto-login failed: still on login page after SSO redirect. Ensure you are signed in to your corporate identity provider in Chrome.');
  }

  await addLog('success', 'Auto-login: SSO login succeeded.');
}

/* ── Tab helpers ─────────────────────────────────────────────────────── */

function waitForTabComplete(tabId, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timed out'));
    }, timeout);

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function closeTab(tabId) {
  try { await chrome.tabs.remove(tabId); } catch { /* already closed */ }
}

/* ── Main booking flow ───────────────────────────────────────────────── */

let activeTabId = null;
let pendingSelectedDays = [1, 2, 3, 4, 5];

// Resolver slots for async replies from content script
let seatResultResolver = null;
let scanResultResolver = null;

function waitForSeatResult(timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      seatResultResolver = null;
      reject(new Error('Timed out waiting for seat result'));
    }, timeout);
    seatResultResolver = (msg) => {
      clearTimeout(timer);
      resolve(msg);
    };
  });
}

function waitForScanResult(timeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      scanResultResolver = null;
      resolve([]); // timeout is non-fatal — proceed without pre-filter
    }, timeout);
    scanResultResolver = (bookedDates) => {
      clearTimeout(timer);
      resolve(bookedDates);
    };
  });
}

/* ── Map booking helpers ─────────────────────────────────────────────── */

function getTargetDates(selectedDays) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const windowEnd = new Date(today);
  windowEnd.setDate(today.getDate() + 30);

  const dates = [];
  const cursor = new Date(today);
  while (cursor <= windowEnd) {
    if (selectedDays.includes(cursor.getDay())) {
      dates.push(new Date(cursor));
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates; // already ascending
}

function getDayTimestamps(date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 0, 0);
  return {
    selectedTime: Math.floor(start.getTime() / 1000),
    selectedEndTime: Math.floor(end.getTime() / 1000),
  };
}

function formatDate(date) {
  return date.toLocaleDateString('en-AU', { weekday: 'short', month: 'short', day: 'numeric' });
}

async function scanScheduleForBookedDates(tabId, targetDates) {
  try {
    await chrome.tabs.update(tabId, { url: SCHEDULE_URL });
    await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT);
    await sleep(2500);

    const loaded = await chrome.tabs.get(tabId);
    if (isLoginUrl(loaded.url)) {
      await attemptAutoLogin(tabId);
      await chrome.tabs.update(tabId, { url: SCHEDULE_URL });
      await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT);
      await sleep(2500);
    }

    await chrome.tabs.sendMessage(tabId, { type: 'SCAN_SCHEDULE', targetDates });
    const bookedDates = await waitForScanResult(60_000);
    await addLog('info', `Schedule scan complete — ${bookedDates.length} date(s) already booked.`);
    return bookedDates;
  } catch (err) {
    await addLog('warn', `Schedule scan failed (${err.message}) — proceeding without pre-filter.`);
    return [];
  }
}

async function runMapFlow(selectedDays, preferredSeat, cachedFeatureId, locationId) {
  await addLog('info', `Map booking: seat "${preferredSeat}" for ${selectedDays.length} selected day(s).`);

  const dates = getTargetDates(selectedDays);
  if (dates.length === 0) {
    await setState({ status: 'done', total: 0, current: 0 });
    await addLog('warn', 'No upcoming dates match the selected days.');
    showBookingNotification('done', 0);
    return;
  }

  // Open map page for first target date
  const { selectedTime: t0, selectedEndTime: e0 } = getDayTimestamps(dates[0]);
  const initialUrl = `${MAP_BASE_URL}/${locationId}?selectedTime=${t0}&selectedEndTime=${e0}`;

  let tab;
  try {
    tab = await chrome.tabs.create({ url: initialUrl, active: false });
    activeTabId = tab.id;
    await addLog('info', `Background tab created (id=${tab.id}).`);
    await waitForTabComplete(tab.id, TAB_LOAD_TIMEOUT);

    const loaded = await chrome.tabs.get(tab.id);
    await addLog('info', `Page loaded. URL: ${loaded.url}`);

    if (!loaded.url.includes('dashboard.envoy.com')) {
      throw new Error('Redirected away from Envoy — are you logged in?');
    }
    if (isLoginUrl(loaded.url)) {
      await attemptAutoLogin(tab.id);
      await chrome.tabs.update(tab.id, { url: initialUrl });
      await waitForTabComplete(tab.id, TAB_LOAD_TIMEOUT);
    }
  } catch (err) {
    await setState({ status: 'error' });
    await addLog('error', err.message);
    if (activeTabId) { await closeTab(activeTabId); activeTabId = null; }
    return;
  }

  await sleep(SSO_SETTLE_DELAY);

  // Resolve feature ID if not cached
  let seatFeatureId = cachedFeatureId;
  if (!seatFeatureId) {
    await addLog('info', `Looking up feature ID for "${preferredSeat}" via map search…`);
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'RESOLVE_SEAT', seatName: preferredSeat });
      const result = await waitForSeatResult(MAP_SEAT_TIMEOUT);
      if (result.error) throw new Error(result.error);
      seatFeatureId = result.featureId;
      await chrome.storage.local.set({ seatFeatureId });
      await addLog('info', `Feature ID for "${preferredSeat}": ${seatFeatureId}`);
    } catch (err) {
      await setState({ status: 'error' });
      await addLog('error', `Could not find seat "${preferredSeat}": ${err.message}`);
      await closeTab(activeTabId);
      activeTabId = null;
      showBookingNotification('error', 0, `Seat "${preferredSeat}" not found on map`);
      return;
    }
  }

  // Pre-scan schedule page to skip already-booked dates
  await addLog('info', 'Scanning schedule page for existing bookings…');
  const targetDateStrings = dates.map(toLocalDateStr);
  const bookedDates = await scanScheduleForBookedDates(activeTabId, targetDateStrings);
  const bookedSet = new Set(bookedDates);
  const datesToBook = dates.filter((d) => !bookedSet.has(toLocalDateStr(d)));
  const skipped = dates.length - datesToBook.length;
  if (skipped > 0) await addLog('info', `Skipping ${skipped} already-booked date(s).`);

  if (datesToBook.length === 0) {
    await setState({ status: 'done', total: 0, current: 0 });
    await addLog('info', 'All upcoming dates are already booked — nothing to do.');
    if (activeTabId) { await closeTab(activeTabId); activeTabId = null; }
    showBookingNotification('done', 0);
    return;
  }

  await setState({ status: 'running', total: datesToBook.length, current: 0 });
  let booked = 0;

  for (let i = 0; i < datesToBook.length; i++) {
    const date = datesToBook[i];
    const { selectedTime, selectedEndTime } = getDayTimestamps(date);
    const mapUrl = `${MAP_BASE_URL}/${locationId}?selectedTime=${selectedTime}&selectedEndTime=${selectedEndTime}&selectedFeatureId=${seatFeatureId}`;
    const dateStr = formatDate(date);

    await addLog('info', `[${dateStr}] Navigating to map page…`);
    try {
      await chrome.tabs.update(activeTabId, { url: mapUrl });
      await waitForTabComplete(activeTabId, TAB_LOAD_TIMEOUT);
      await sleep(2500); // let Leaflet finish rendering markers

      await chrome.tabs.sendMessage(activeTabId, {
        type: 'BOOK_SEAT',
        featureId: seatFeatureId,
        seatName: preferredSeat,
        dateStr,
      });

      const result = await waitForSeatResult(MAP_BOOKING_TIMEOUT);
      if (result.ok) {
        booked++;
        await addLog('success', `[${dateStr}] Booked "${preferredSeat}".`);
      } else {
        await addLog('error', `[${dateStr}] ${result.error}`);
      }
    } catch (err) {
      await addLog('error', `[${dateStr}] ${err.message}`);
    }

    await setState({ current: i + 1 });
  }

  await setState({ status: 'done', current: datesToBook.length, total: datesToBook.length });
  await addLog('success', `Done — ${booked}/${datesToBook.length} day(s) booked for "${preferredSeat}".`);
  if (activeTabId) { await closeTab(activeTabId); activeTabId = null; }
  await chrome.storage.local.set({ lastRunDate: getTodayString() });
  showBookingNotification('done', booked);
}

async function runBooking(selectedDays = [1, 2, 3, 4, 5]) {
  pendingSelectedDays = selectedDays;
  if (activeTabId !== null) {
    await addLog('warn', 'Booking already in progress — ignoring duplicate request.');
    return;
  }

  await chrome.storage.session.set({
    envoy_booking: { ...defaultState(), status: 'running', log: [] },
  });

  // Branch: map flow vs schedule flow
  const {
    bookingMode    = 'auto',
    preferredSeat  = '',
    seatFeatureId  = '',
    mapLocationId  = MAP_DEFAULT_LOC_ID,
  } = await chrome.storage.local.get(['bookingMode', 'preferredSeat', 'seatFeatureId', 'mapLocationId']);

  if (bookingMode === 'map' && preferredSeat) {
    await runMapFlow(selectedDays, preferredSeat, seatFeatureId, mapLocationId);
    return;
  }

  await addLog('info', 'Opening Envoy schedule page in background tab…');

  // Open schedule page in a background (inactive) tab
  let tab;
  try {
    tab = await chrome.tabs.create({ url: SCHEDULE_URL, active: false });
    activeTabId = tab.id;
    await addLog('info', `Background tab created (id=${tab.id}).`);
  } catch (err) {
    await setState({ status: 'error' });
    await addLog('error', `Failed to create tab: ${err.message}`);
    activeTabId = null;
    return;
  }

  // Wait for the tab to finish loading
  try {
    await addLog('info', 'Waiting for page to load…');
    await waitForTabComplete(tab.id, TAB_LOAD_TIMEOUT);

    // Re-fetch tab to check final URL (detect login redirect)
    const loaded = await chrome.tabs.get(tab.id);
    await addLog('info', `Page loaded. URL: ${loaded.url}`);

    if (!loaded.url.includes('dashboard.envoy.com')) {
      throw new Error('Redirected away from Envoy — are you logged in?');
    }
    if (isLoginUrl(loaded.url)) {
      await attemptAutoLogin(tab.id);
      // After SSO, Envoy may land on dashboard root — navigate back to schedule
      await chrome.tabs.update(tab.id, { url: SCHEDULE_URL });
      await waitForTabComplete(tab.id, TAB_LOAD_TIMEOUT);
    }
  } catch (err) {
    await setState({ status: 'error' });
    await addLog('error', err.message);
    await closeTab(tab.id);
    activeTabId = null;
    return;
  }

  await sleep(SSO_SETTLE_DELAY); // extra pause for the SPA to finish rendering

  // Kick off the content script
  await addLog('info', 'Sending booking command to page…');
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'START_BOOKING', selectedDays: pendingSelectedDays });
  } catch (err) {
    await setState({ status: 'error' });
    await addLog('error', `Could not communicate with content script: ${err.message}`);
    await closeTab(tab.id);
    activeTabId = null;
  }
  // The rest is driven by messages from the content script (see onMessage below)
}

/* ── Message listener ────────────────────────────────────────────────── */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {

      case 'START_BOOKING': {
        // Triggered by the popup
        sendResponse({ received: true });
        await runBooking(message.selectedDays || [1, 2, 3, 4, 5]);
        break;
      }

      case 'LOG': {
        // Content script sending a plain log entry
        await addLog(message.level || 'info', message.msg);
        sendResponse({ ok: true });
        break;
      }

      case 'BOOKING_PROGRESS': {
        await setState({ status: 'running', current: message.current, total: message.total });
        await addLog('info', `Scheduled ${message.current} / ${message.total}…`);
        sendResponse({ ok: true });
        break;
      }

      case 'BOOKING_DONE': {
        await setState({ status: 'done', current: message.total, total: message.total, bookings: message.bookings || [] });
        await addLog('success', `Done! Successfully scheduled ${message.total} desk(s).`);
        if (activeTabId !== null) {
          await closeTab(activeTabId);
          activeTabId = null;
        }
        await chrome.storage.local.set({ lastRunDate: getTodayString() });
        showBookingNotification('done', message.total);
        sendResponse({ ok: true });
        break;
      }

      case 'BOOKING_NONE': {
        await setState({ status: 'done', current: 0, total: 0 });
        await addLog('warn', message.message || 'No Schedule buttons were found on the page.');
        if (activeTabId !== null) {
          await closeTab(activeTabId);
          activeTabId = null;
        }
        await chrome.storage.local.set({ lastRunDate: getTodayString() });
        showBookingNotification('done', 0);
        sendResponse({ ok: true });
        break;
      }

      case 'BOOKING_ERROR': {
        await setState({ status: 'error' });
        await addLog('error', message.message || 'An unexpected error occurred.');
        if (activeTabId !== null) {
          await closeTab(activeTabId);
          activeTabId = null;
        }
        await chrome.storage.local.set({ lastRunDate: getTodayString() });
        showBookingNotification('error', 0, message.message || 'An unexpected error occurred.');
        sendResponse({ ok: true });
        break;
      }

      case 'SEAT_RESULT': {
        // Content script reporting outcome of RESOLVE_SEAT or BOOK_SEAT
        if (seatResultResolver) {
          seatResultResolver(message);
          seatResultResolver = null;
        }
        sendResponse({ ok: true });
        break;
      }

      case 'SCHEDULE_SCAN_RESULT': {
        if (scanResultResolver) {
          scanResultResolver(message.bookedDates || []);
          scanResultResolver = null;
        }
        sendResponse({ ok: true });
        break;
      }

      case 'CACHE_FEATURE_ID': {
        await chrome.storage.local.set({ seatFeatureId: message.featureId });
        sendResponse({ ok: true });
        break;
      }

      case 'GET_STATE': {
        // Popup asking for current state on open
        const state = await getState();
        sendResponse(state);
        break;
      }
    }
  })();
  return true; // keep message channel open for async response
});

/* ── Lifecycle listeners ─────────────────────────────────────────────── */

chrome.runtime.onInstalled.addListener(() => scheduleNextAlarm());

chrome.runtime.onStartup.addListener(async () => {
  scheduleNextAlarm();
  const now = new Date();
  if (now.getHours() >= 11) {
    const { lastRunDate, selectedDays } = await chrome.storage.local.get(['lastRunDate', 'selectedDays']);
    if (lastRunDate !== getTodayString()) {
      await runBooking(selectedDays || [1, 2, 3, 4, 5]);
    }
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'dailyBooking') return;
  const { lastRunDate, selectedDays } = await chrome.storage.local.get(['lastRunDate', 'selectedDays']);
  if (lastRunDate !== getTodayString()) {
    await runBooking(selectedDays || [1, 2, 3, 4, 5]);
  }
});

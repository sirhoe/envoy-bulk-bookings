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
const TAB_LOAD_TIMEOUT    = 20_000; // ms to wait for the tab to reach "complete"
const SSO_REDIRECT_TIMEOUT = 30_000; // ms to wait for corporate SSO redirect to complete
const SSO_SETTLE_DELAY     = 1_500;  // ms extra pause after SSO for SPA to stabilise
const SSO_REDIRECT_SETTLE  = 10_000; // ms to wait after SSO redirect before checking login

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

let activeTabId = null;      // guard against concurrent runs
let pendingSelectedDays = [1, 2, 3, 4, 5]; // forwarded to content script

async function runBooking(selectedDays = [1, 2, 3, 4, 5]) {
  pendingSelectedDays = selectedDays;
  if (activeTabId !== null) {
    await addLog('warn', 'Booking already in progress — ignoring duplicate request.');
    return;
  }

  await chrome.storage.session.set({
    envoy_booking: { ...defaultState(), status: 'running', log: [] },
  });

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

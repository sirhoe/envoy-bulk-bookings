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

const SCHEDULE_URL   = 'https://dashboard.envoy.com/schedule';
const TAB_LOAD_TIMEOUT = 20_000; // ms to wait for the tab to reach "complete"

/* ── Daily scheduling helpers ────────────────────────────────────────── */

function getTodayString() {
  return new Date().toISOString().slice(0, 10);
}

function scheduleNextAlarm() {
  const now = new Date();
  const next8am = new Date(now);
  next8am.setHours(8, 0, 0, 0);
  if (now >= next8am) next8am.setDate(next8am.getDate() + 1);
  chrome.alarms.create('dailyBooking', {
    when: next8am.getTime(),
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
    if (loaded.url.includes('/login') || loaded.url.includes('/sign-in') || loaded.url.includes('/auth')) {
      throw new Error('Redirected to login page — please sign in to Envoy in Chrome first.');
    }
  } catch (err) {
    await setState({ status: 'error' });
    await addLog('error', err.message);
    await closeTab(tab.id);
    activeTabId = null;
    return;
  }

  // Small extra pause for the SPA to finish rendering
  await new Promise((r) => setTimeout(r, 1500));

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
  if (now.getHours() >= 8) {
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

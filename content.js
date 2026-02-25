/**
 * Envoy Bulk Booking — Content Script
 *
 * Injected into every dashboard.envoy.com page.
 * When it receives START_BOOKING from the background service worker:
 *  1. Waits for Schedule buttons to appear (handles React SPA lazy render)
 *  2. Clicks each one sequentially
 *  3. Handles any confirmation modal
 *  4. Reports progress + detailed log back to background.js
 */

const DELAY_BETWEEN_CLICKS  = 1000;   // ms between each desk click
const BUTTON_WAIT_TIMEOUT   = 15_000; // ms to wait for buttons to appear
const BUTTON_POLL_INTERVAL  = 300;    // ms between polls
const MODAL_WAIT_TIMEOUT    = 3_000;  // ms to wait for confirmation modal
const MODAL_POLL_INTERVAL   = 100;

/* ── Helpers ─────────────────────────────────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function log(level, msg) {
  try {
    await chrome.runtime.sendMessage({ type: 'LOG', level, msg });
  } catch { /* popup may be closed */ }
}

async function waitFor(predicate, timeout, interval) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await sleep(interval);
  }
  return null;
}

/* ── Button detection ────────────────────────────────────────────────── */

// Matches button text against known Envoy scheduling CTA labels.
const BUTTON_LABELS = ['schedule', 'schedule desk', 'book desk', 'book', 'reserve'];

function isScheduleButton(btn) {
  if (btn.disabled) return false;
  const text = btn.textContent.trim().toLowerCase();
  return BUTTON_LABELS.some((label) => text === label);
}

function findScheduleButtons() {
  return Array.from(document.querySelectorAll('button')).filter(isScheduleButton);
}

async function waitForScheduleButtons() {
  await log('info', `Scanning page for Schedule buttons (timeout ${BUTTON_WAIT_TIMEOUT / 1000}s)…`);
  return waitFor(
    () => {
      const btns = findScheduleButtons();
      return btns.length > 0 ? btns : null;
    },
    BUTTON_WAIT_TIMEOUT,
    BUTTON_POLL_INTERVAL,
  );
}

/* ── Modal handling ──────────────────────────────────────────────────── */

const CONFIRM_KEYWORDS = ['confirm', 'book', 'schedule', 'reserve', 'yes', 'submit', 'ok'];

async function handleConfirmationModal() {
  const modal = await waitFor(() => (
    document.querySelector('[role="dialog"]') ||
    document.querySelector('[aria-modal="true"]') ||
    document.querySelector('.modal') ||
    document.querySelector('[class*="modal"]') ||
    document.querySelector('[class*="dialog"]')
  ), MODAL_WAIT_TIMEOUT, MODAL_POLL_INTERVAL);

  if (!modal) {
    await log('info', 'No confirmation modal detected — continuing.');
    return false;
  }

  await log('info', 'Confirmation modal detected.');
  await sleep(200); // let animation finish

  const buttons = Array.from(modal.querySelectorAll('button'));
  await log('info', `Modal buttons: [${buttons.map((b) => `"${b.textContent.trim()}"`).join(', ')}]`);

  const confirmBtn = buttons.find((btn) => {
    const text = btn.textContent.trim().toLowerCase();
    return CONFIRM_KEYWORDS.some((kw) => text.includes(kw));
  });

  const toClick = confirmBtn || (buttons.length === 1 ? buttons[0] : null);

  if (toClick && !toClick.disabled) {
    await log('info', `Clicking modal button: "${toClick.textContent.trim()}"`);
    toClick.click();
    await sleep(500);
    return true;
  }

  await log('warn', 'Could not find a confirm button in the modal — skipping modal.');
  return false;
}

/* ── Day-of-week helpers ─────────────────────────────────────────────── */

function getButtonContainer(btn) {
  return btn.closest('[data-test-day-card]')
    || btn.closest('[class*="item"],[class*="card"],[class*="day"],li,tr,[class*="slot"]')
    || btn.parentElement?.parentElement
    || null;
}

function getButtonDayOfWeek(btn) {
  const container = getButtonContainer(btn);
  if (!container) return null;
  const text = container.textContent;

  const dayAbbr = text.match(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*/i);
  if (dayAbbr) {
    const dayMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    return dayMap[dayAbbr[0].slice(0, 3).toLowerCase()] ?? null;
  }

  const dateStr = text.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}\b/i)
    || text.match(/\d{1,2}[\/\-]\d{1,2}/);
  if (dateStr) {
    const d = new Date(dateStr[0]);
    return isNaN(d) ? null : d.getDay();
  }
  return null;
}

function getButtonDateLabel(btn) {
  const container = getButtonContainer(btn);
  const text = container?.textContent.replace(/\s+/g, ' ').trim() || '';
  return text.replace(/schedule desk|book desk|schedule|book|reserve/gi, '').trim().slice(0, 40);
}

async function captureAssignedDesk(container) {
  await sleep(600);
  const text = container?.textContent || '';
  const m = text.match(/(?:desk|table|seat|spot|space)\s*[\w\d#\-]+/i);
  return m ? m[0].trim() : 'Booked';
}

/* ── Main booking routine ────────────────────────────────────────────── */

async function runBulkBooking(selectedDays = [1, 2, 3, 4, 5]) {
  await log('info', `Content script active on: ${location.href}`);

  // Verify we're on the right page
  if (!location.href.includes('/schedule')) {
    await log('warn', `Not on /schedule — navigating…`);
    location.href = 'https://dashboard.envoy.com/schedule';
    await sleep(3000); // wait for navigation
  }

  const buttons = await waitForScheduleButtons();

  if (!buttons) {
    await log('warn', 'No Schedule buttons found after waiting. The page may require login or the desks may already be booked.');
    await chrome.runtime.sendMessage({
      type: 'BOOKING_NONE',
      message: 'No Schedule buttons found. Ensure you\'re logged in and desks are available.',
    });
    return;
  }

  await log('info', `Found ${buttons.length} Schedule button(s). Filtering by selected days: [${selectedDays.join(',')}]`);

  // Filter buttons by day of week
  const filteredButtons = buttons.filter((btn, i) => {
    if (!selectedDays || selectedDays.length === 0) return true;
    const day = getButtonDayOfWeek(btn);
    if (day === null) {
      // Can't determine day — include it
      return true;
    }
    if (!selectedDays.includes(day)) {
      const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      log('info', `Skipping button ${i + 1} — day ${DAY_NAMES[day]} not in selected days`);
      return false;
    }
    return true;
  });

  if (filteredButtons.length === 0) {
    await log('warn', 'No buttons remain after day-of-week filter.');
    await chrome.runtime.sendMessage({
      type: 'BOOKING_NONE',
      message: 'No Schedule buttons matched the selected days.',
    });
    return;
  }

  await log('info', `${filteredButtons.length} button(s) after day filter.`);

  let booked = 0;
  const bookings = [];

  for (let i = 0; i < filteredButtons.length; i++) {
    const btn = filteredButtons[i];

    if (btn.disabled || !document.contains(btn)) {
      await log('warn', `Button ${i + 1} is no longer available — skipping.`);
      continue;
    }

    const dateLabel = getButtonDateLabel(btn);
    const label = dateLabel ? ` ("${dateLabel}")` : '';

    await log('info', `Clicking button ${i + 1}/${filteredButtons.length}${label}`);

    btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(300);
    btn.click();
    booked++;

    try {
      await chrome.runtime.sendMessage({
        type: 'BOOKING_PROGRESS',
        current: booked,
        total: filteredButtons.length,
      });
    } catch { /* background SW may have cycled */ }

    await handleConfirmationModal();

    const container = getButtonContainer(btn);
    const desk = await captureAssignedDesk(container);
    bookings.push({ date: dateLabel || `Booking ${booked}`, desk });

    if (i < filteredButtons.length - 1) {
      await sleep(DELAY_BETWEEN_CLICKS);
    }
  }

  await log('success', `All done — ${booked} desk(s) scheduled.`);
  try {
    await chrome.runtime.sendMessage({ type: 'BOOKING_DONE', total: booked, bookings });
  } catch { /* background SW may have cycled */ }
}

/* ── Message listener ────────────────────────────────────────────────── */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'START_BOOKING') {
    sendResponse({ received: true });
    runBulkBooking(message.selectedDays || [1, 2, 3, 4, 5]).catch(async (err) => {
      await log('error', `Unhandled error: ${err.message}`);
      try {
        await chrome.runtime.sendMessage({
          type: 'BOOKING_ERROR',
          message: `Unhandled error: ${err.message}`,
        });
      } catch { /* */ }
    });
  }
  return true;
});

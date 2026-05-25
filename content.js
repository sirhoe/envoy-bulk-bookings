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

/* ── Week navigation ─────────────────────────────────────────────────── */

const NEXT_WEEK_SELECTORS = [
  'button[aria-label="Next week"]',
  'button[aria-label="next week"]',
  'button[aria-label="Next"]',
  '[data-test="next-week"]',
  '[data-test*="next"]',
  'button[title="Next week"]',
  'button[title="Next"]',
];

function findNextWeekButton() {
  for (const sel of NEXT_WEEK_SELECTORS) {
    const el = document.querySelector(sel);
    if (el && !el.disabled) return el;
  }
  // Fallback: last icon-only button (SVG, no text) — typically the "›" chevron
  const iconOnly = Array.from(document.querySelectorAll('button'))
    .filter((b) => b.textContent.trim() === '' && b.querySelector('svg'));
  return iconOnly.length >= 1 ? iconOnly[iconOnly.length - 1] : null;
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

  const MAX_WEEKS = 4;
  let totalBooked = 0;
  const allBookings = [];

  for (let week = 0; week < MAX_WEEKS; week++) {
    const buttons = await waitForScheduleButtons();

    if (!buttons) {
      if (week === 0) {
        await log('warn', 'No Schedule buttons found after waiting. The page may require login or the desks may already be booked.');
        await chrome.runtime.sendMessage({
          type: 'BOOKING_NONE',
          message: 'No Schedule buttons found. Ensure you\'re logged in and desks are available.',
        });
        return;
      }
      await log('info', `Week ${week + 1}: no buttons found — stopping.`);
      break;
    }

    await log('info', `Week ${week + 1}/${MAX_WEEKS}: ${buttons.length} button(s). Filtering for days [${selectedDays.join(',')}]`);

    const filtered = buttons.filter((btn, i) => {
      if (!selectedDays || selectedDays.length === 0) return true;
      const day = getButtonDayOfWeek(btn);
      if (day === null) return true;
      if (!selectedDays.includes(day)) {
        const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        log('info', `Skipping button ${i + 1} — day ${DAY_NAMES[day]} not in selected days`);
        return false;
      }
      return true;
    });

    if (filtered.length > 0) {
      for (let attempt = 0; attempt < filtered.length; attempt++) {
        // Re-query each iteration — React re-renders detach previous refs
        const fresh = findScheduleButtons().filter((b) => {
          if (!selectedDays || selectedDays.length === 0) return true;
          const day = getButtonDayOfWeek(b);
          return day === null || selectedDays.includes(day);
        });

        if (fresh.length === 0) {
          await log('warn', 'No more Schedule buttons found — stopping early.');
          break;
        }

        const btn = fresh[0];
        const dateLabel = getButtonDateLabel(btn);
        const label = dateLabel ? ` ("${dateLabel}")` : '';

        await log('info', `Week ${week + 1} — clicking ${attempt + 1}/${filtered.length}${label}`);

        btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(300);
        btn.click();
        totalBooked++;

        try {
          await chrome.runtime.sendMessage({
            type: 'BOOKING_PROGRESS',
            current: totalBooked,
            total: totalBooked,
          });
        } catch { /* background SW may have cycled */ }

        await handleConfirmationModal();

        const container = getButtonContainer(btn);
        const desk = await captureAssignedDesk(container);
        allBookings.push({ date: dateLabel || `Booking ${totalBooked}`, desk });

        if (attempt < filtered.length - 1) {
          await sleep(DELAY_BETWEEN_CLICKS);
        }
      }
    } else {
      await log('info', `Week ${week + 1}: no buttons match selected days — advancing anyway.`);
    }

    if (week < MAX_WEEKS - 1) {
      const nextBtn = findNextWeekButton();
      if (!nextBtn) {
        await log('info', 'No next-week button found — stopping paging.');
        break;
      }
      await log('info', `Advancing to week ${week + 2}…`);
      nextBtn.click();
      await sleep(500);
      await waitFor(() => findScheduleButtons().length > 0 ? true : null, 10_000, 300);
      await sleep(800);
    }
  }

  await log('success', `All done — ${totalBooked} desk(s) scheduled.`);
  try {
    await chrome.runtime.sendMessage({ type: 'BOOKING_DONE', total: totalBooked, bookings: allBookings });
  } catch { /* background SW may have cycled */ }
}

/* ── Map booking — feature ID resolution ─────────────────────────────── */

const MAP_MARKER_WAIT    = 15_000;
const MAP_POPUP_WAIT     = 8_000;
const MAP_VERIFY_DELAY   = 3_000;

async function resolveFeatureId(seatName) {
  await log('info', `Resolving feature ID for "${seatName}" via map search…`);

  // Find the search input — Ember renders it as role="searchbox" or a plain input
  const searchEl = await waitFor(
    () =>
      document.querySelector('[role="searchbox"]') ||
      document.querySelector('input[type="search"]') ||
      document.querySelector('input[placeholder*="Search" i]'),
    15_000, 300
  );

  if (!searchEl) throw new Error('Map search box not found');
  const input = searchEl.tagName === 'INPUT' ? searchEl : searchEl.querySelector('input');
  if (!input) throw new Error('Map search input not found inside searchbox element');

  input.focus();
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(200);

  for (const ch of seatName) {
    input.value += ch;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup',   { key: ch, bubbles: true }));
    await sleep(80);
  }

  await log('info', `Typed "${seatName}" — waiting for search results…`);

  const resultBtn = await waitFor(() => {
    const btns = document.querySelectorAll('[data-test-search-result-resource]');
    for (const btn of btns) {
      if (btn.textContent.includes(seatName)) return btn;
    }
    return null;
  }, 8_000, 200);

  if (!resultBtn) throw new Error(`No search result found for seat "${seatName}"`);

  const prevHref = location.href;
  resultBtn.click();

  const newHref = await waitFor(() => {
    const h = location.href;
    if (h !== prevHref && h.includes('selectedFeatureId=')) return h;
    return null;
  }, 8_000, 200);

  if (!newHref) throw new Error(`URL did not gain selectedFeatureId after selecting "${seatName}"`);

  const m = newHref.match(/[?&]selectedFeatureId=(\d+)/);
  if (!m) throw new Error(`Could not parse selectedFeatureId from URL: ${newHref}`);

  return m[1];
}

/* ── Map booking — single-day seat booking ───────────────────────────── */

async function bookSeatOnCurrentPage(featureId, seatName, dateStr) {
  const markersReady = await waitFor(
    () => (document.querySelectorAll('[data-test-feature-type="desk"]').length > 0 ? true : null),
    MAP_MARKER_WAIT, 300
  );

  if (!markersReady) {
    return { ok: false, error: `Desk markers never appeared on map for ${dateStr}` };
  }

  const marker = document.querySelector(`[data-test-feature-id="${featureId}"]`);
  if (!marker) {
    return { ok: false, error: `Seat ${seatName} (id=${featureId}) not found on map` };
  }

  marker.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(200);
  marker.click();

  const popup = await waitFor(
    () => document.querySelector('.leaflet-popup-content') || null,
    MAP_POPUP_WAIT, 200
  );

  if (!popup) {
    return { ok: false, error: `No popup appeared after clicking ${seatName}` };
  }

  const text = popup.innerText || popup.textContent || '';

  if (text.includes('Unavailable to book')) {
    return { ok: false, error: `${seatName} is not in your neighbourhood` };
  }
  if (text.includes('Scheduled')) {
    return { ok: false, error: `${seatName} is already booked on ${dateStr}` };
  }
  if (!text.includes('Available')) {
    return { ok: false, error: `${seatName} shows unexpected popup state: ${text.slice(0, 80).replace(/\n/g, ' ')}` };
  }

  const bookBtn = popup.querySelector('[data-test-book-desk-button]')
    || document.querySelector('[data-test-book-desk-button]');
  if (!bookBtn) {
    return { ok: false, error: `"Book Desk" button not found in popup` };
  }

  bookBtn.click();
  await sleep(MAP_VERIFY_DELAY);

  const popupAfter = document.querySelector('.leaflet-popup-content');
  if (!popupAfter) return { ok: true };

  const textAfter = popupAfter.innerText || popupAfter.textContent || '';
  if (textAfter.includes('Scheduled')) return { ok: true };
  if (textAfter.includes('Available')) {
    return { ok: false, error: `Booking failed — popup still shows Available after clicking Book Desk` };
  }

  return { ok: true };
}

/* ── Message listener ────────────────────────────────────────────────── */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'START_BOOKING':
      sendResponse({ received: true });
      runBulkBooking(message.selectedDays || [1, 2, 3, 4, 5]).catch(async (err) => {
        await log('error', `Unhandled error: ${err.message}`);
        try {
          await chrome.runtime.sendMessage({ type: 'BOOKING_ERROR', message: `Unhandled error: ${err.message}` });
        } catch { /* */ }
      });
      break;

    case 'RESOLVE_SEAT':
      sendResponse({ received: true });
      resolveFeatureId(message.seatName)
        .then((featureId) => chrome.runtime.sendMessage({ type: 'SEAT_RESULT', featureId }))
        .catch((err) => chrome.runtime.sendMessage({ type: 'SEAT_RESULT', error: err.message }).catch(() => {}));
      break;

    case 'BOOK_SEAT':
      sendResponse({ received: true });
      bookSeatOnCurrentPage(message.featureId, message.seatName, message.dateStr)
        .then((result) => chrome.runtime.sendMessage({ type: 'SEAT_RESULT', ...result }))
        .catch((err) => chrome.runtime.sendMessage({ type: 'SEAT_RESULT', ok: false, error: err.message }).catch(() => {}));
      break;
  }
  return true;
});

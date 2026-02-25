const bookBtn        = document.getElementById('book-btn');
const statusBadge    = document.getElementById('status-badge');
const statusMsg      = document.getElementById('status-msg');
const progressWrap   = document.getElementById('progress-wrap');
const progressFill   = document.getElementById('progress-fill');
const progressLabel  = document.getElementById('progress-label');
const logBody        = document.getElementById('log-body');
const clearLogBtn    = document.getElementById('clear-log-btn');
const summarySection = document.getElementById('summary-section');
const summaryBody    = document.getElementById('summary-body');

/* ── Log rendering ──────────────────────────────────────────────────── */

const LEVEL_LABELS = { info: 'INFO ', success: 'OK   ', warn: 'WARN ', error: 'ERR  ' };

function renderLog(entries) {
  if (!entries || entries.length === 0) {
    logBody.innerHTML = '<span class="log-empty">No activity yet.</span>';
    return;
  }
  logBody.innerHTML = entries.map((e) => `
    <div class="log-entry">
      <span class="log-time">${e.time}</span>
      <span class="log-level log-level-${e.level}">${LEVEL_LABELS[e.level] || e.level.toUpperCase().padEnd(5)}</span>
      <span class="log-msg">${escHtml(e.msg)}</span>
    </div>`).join('');
  logBody.scrollTop = logBody.scrollHeight;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ── Status rendering ───────────────────────────────────────────────── */

function applyState(state) {
  // Badge
  statusBadge.className = `badge badge-${state.status}`;
  const BADGE_LABELS = { idle: 'Idle', running: 'Running…', done: 'Done', error: 'Error' };
  statusBadge.textContent = BADGE_LABELS[state.status] || state.status;

  // Button
  bookBtn.disabled = state.status === 'running';
  bookBtn.textContent = state.status === 'running' ? 'Booking…' : 'Book All Desks';
  if (state.status !== 'running') {
    // Re-inject the plus icon
    bookBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
      ${state.status === 'running' ? 'Booking…' : 'Book All Desks'}`;
  }

  // Status message
  if (state.status === 'running' && state.total > 0) {
    showMsg('info', `Scheduling ${state.current} of ${state.total}…`);
  } else if (state.status === 'done' && state.total > 0) {
    showMsg('success', `Scheduled ${state.total} desk(s) successfully.`);
  } else if (state.status === 'done' && state.total === 0) {
    showMsg('warn', 'No Schedule buttons were found on the page.');
  } else if (state.status === 'error') {
    showMsg('error', 'An error occurred. See the log below for details.');
  } else {
    statusMsg.classList.add('hidden');
  }

  // Progress
  if (state.status === 'running' && state.total > 0) {
    progressWrap.classList.remove('hidden');
    const pct = Math.round((state.current / state.total) * 100);
    progressFill.style.width = `${pct}%`;
    progressLabel.textContent = `${state.current} / ${state.total}`;
  } else if (state.status === 'done' && state.total > 0) {
    progressWrap.classList.remove('hidden');
    progressFill.style.width = '100%';
    progressLabel.textContent = `${state.total} / ${state.total}`;
  } else {
    progressWrap.classList.add('hidden');
  }

  // Summary
  if (state.status === 'done' && state.bookings?.length > 0) {
    summarySection.classList.remove('hidden');
    summaryBody.innerHTML = state.bookings.map((b) =>
      `<div class="summary-row">
         <span class="summary-date">${escHtml(b.date)}</span>
         <span class="summary-desk">${escHtml(b.desk)}</span>
       </div>`
    ).join('');
  } else if (state.status !== 'running') {
    summarySection.classList.add('hidden');
  }

  renderLog(state.log);
}

function showMsg(type, text) {
  statusMsg.className = `status-msg ${type}`;
  statusMsg.textContent = text;
  statusMsg.classList.remove('hidden');
}

/* ── Bootstrap ──────────────────────────────────────────────────────── */

// Load current state and saved day selection when popup opens
(async () => {
  try {
    const [state, { selectedDays }] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_STATE' }),
      chrome.storage.local.get({ selectedDays: [1, 2, 3, 4, 5] }),
    ]);
    document.querySelectorAll('.day-chip').forEach((chip) => {
      if (!selectedDays.includes(+chip.dataset.day)) chip.classList.remove('active');
    });
    if (state) applyState(state);
  } catch { /* service worker may not be running yet */ }
})();

// Day chip toggle — persist selection
document.querySelectorAll('.day-chip').forEach((chip) => {
  chip.addEventListener('click', async () => {
    chip.classList.toggle('active');
    const days = [...document.querySelectorAll('.day-chip.active')].map((c) => +c.dataset.day);
    await chrome.storage.local.set({ selectedDays: days });
  });
});

// Listen for live storage changes while the popup is open
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.envoy_booking) {
    applyState(changes.envoy_booking.newValue);
  }
});

/* ── Actions ────────────────────────────────────────────────────────── */

bookBtn.addEventListener('click', async () => {
  bookBtn.disabled = true;
  try {
    const days = [...document.querySelectorAll('.day-chip.active')].map((c) => +c.dataset.day);
    await chrome.runtime.sendMessage({ type: 'START_BOOKING', selectedDays: days });
  } catch (err) {
    showMsg('error', `Could not start booking: ${err.message}`);
    bookBtn.disabled = false;
  }
});

clearLogBtn.addEventListener('click', async () => {
  const data = await chrome.storage.session.get('envoy_booking');
  const prev = data.envoy_booking || {};
  await chrome.storage.session.set({ envoy_booking: { ...prev, log: [] } });
  renderLog([]);
});

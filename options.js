const emailInput    = document.getElementById('email');
const modeAutoRadio = document.getElementById('mode-auto');
const modeMapRadio  = document.getElementById('mode-map');
const seatField     = document.getElementById('seat-field');
const seatInput     = document.getElementById('preferred-seat');
const saveBtn       = document.getElementById('save-btn');
const saveMsg       = document.getElementById('save-msg');

(async () => {
  const { envoyEmail = '', bookingMode = 'auto', preferredSeat = '' } =
    await chrome.storage.local.get(['envoyEmail', 'bookingMode', 'preferredSeat']);
  emailInput.value = envoyEmail;
  seatInput.value  = preferredSeat;
  if (bookingMode === 'map') {
    modeMapRadio.checked = true;
    seatField.classList.remove('hidden');
  } else {
    modeAutoRadio.checked = true;
  }
})();

[modeAutoRadio, modeMapRadio].forEach((radio) => {
  radio.addEventListener('change', () => {
    seatField.classList.toggle('hidden', modeAutoRadio.checked);
  });
});

saveBtn.addEventListener('click', async () => {
  const email = emailInput.value.trim();
  if (!email) {
    showMsg('error', 'Please enter an email address.');
    return;
  }

  const bookingMode   = modeMapRadio.checked ? 'map' : 'auto';
  const preferredSeat = modeMapRadio.checked ? seatInput.value.trim() : '';

  const toSave = { envoyEmail: email, bookingMode, preferredSeat };
  if (bookingMode === 'auto') toSave.seatFeatureId = ''; // clear cached ID when switching to auto

  await chrome.storage.local.set(toSave);
  window.close();
});

function showMsg(type, text) {
  saveMsg.className = `status-msg ${type}`;
  saveMsg.textContent = text;
  saveMsg.classList.remove('hidden');
  setTimeout(() => saveMsg.classList.add('hidden'), 3000);
}

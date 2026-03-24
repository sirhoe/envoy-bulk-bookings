const emailInput = document.getElementById('email');
const saveBtn    = document.getElementById('save-btn');
const saveMsg    = document.getElementById('save-msg');

(async () => {
  const { envoyEmail = '' } = await chrome.storage.local.get('envoyEmail');
  emailInput.value = envoyEmail;
})();

saveBtn.addEventListener('click', async () => {
  const email = emailInput.value.trim();
  if (!email) {
    showMsg('error', 'Please enter an email address.');
    return;
  }
  await chrome.storage.local.set({ envoyEmail: email });
  showMsg('success', 'Saved.');
});

function showMsg(type, text) {
  saveMsg.className = `status-msg ${type}`;
  saveMsg.textContent = text;
  saveMsg.classList.remove('hidden');
  setTimeout(() => saveMsg.classList.add('hidden'), 3000);
}

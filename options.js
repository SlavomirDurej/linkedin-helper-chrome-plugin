const DEFAULTS = { postcode: 'SW1A 1AA', units: 'mi' };

const form = document.getElementById('form');
const postcodeInput = document.getElementById('postcode');
const unitsSelect = document.getElementById('units');
const googleKeyInput = document.getElementById('googleKey');
const status = document.getElementById('status');

function setStatus(text, kind) {
  status.textContent = text;
  status.className = kind || '';
}

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (res) => {
      resolve(chrome.runtime.lastError || !res ? { ok: false, error: 'Extension not responding' } : res);
    });
  });
}

chrome.storage.sync.get(DEFAULTS).then((s) => {
  postcodeInput.value = s.postcode;
  unitsSelect.value = s.units;
});
chrome.storage.local.get({ googleKey: '' }).then((s) => {
  googleKeyInput.value = s.googleKey;
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const postcode = postcodeInput.value.trim().toUpperCase();
  if (!postcode) return setStatus('Enter a postcode.', 'err');
  setStatus('Checking postcode…');
  const res = await send({ type: 'validatePostcode', postcode });
  if (!res.ok) return setStatus(res.error, 'err');
  postcodeInput.value = res.data.label;
  await chrome.storage.sync.set({ postcode: res.data.label, units: unitsSelect.value });
  await chrome.storage.local.set({ googleKey: googleKeyInput.value.trim() });
  setStatus(`Saved. Origin: ${res.data.label}`, 'ok');
});

document.getElementById('clear').addEventListener('click', async () => {
  const res = await send({ type: 'clearCache' });
  setStatus(res.ok ? 'Cache cleared.' : res.error, res.ok ? 'ok' : 'err');
});

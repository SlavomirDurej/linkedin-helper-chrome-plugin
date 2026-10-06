const DEFAULTS = {
  postcode: 'SW1A 1AA',
  units: 'mi',
  claudeUrl: 'https://claude.ai/project/01a081ac-eaa4-766b-a8f5-3fb641f7146b',
  claudeAutoSend: true,
  triageModel: 'openai/gpt-6-luna'
};

const form = document.getElementById('form');
const postcodeInput = document.getElementById('postcode');
const unitsSelect = document.getElementById('units');
const googleKeyInput = document.getElementById('googleKey');
const claudeUrlInput = document.getElementById('claudeUrl');
const claudeAutoSendInput = document.getElementById('claudeAutoSend');
const openRouterKeyInput = document.getElementById('openRouterKey');
const triageModelInput = document.getElementById('triageModel');
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
  claudeUrlInput.value = s.claudeUrl;
  claudeAutoSendInput.checked = s.claudeAutoSend;
  triageModelInput.value = s.triageModel;
});
chrome.storage.local.get({ googleKey: '', openRouterKey: '' }).then((s) => {
  googleKeyInput.value = s.googleKey;
  openRouterKeyInput.value = s.openRouterKey;
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const postcode = postcodeInput.value.trim().toUpperCase();
  if (!postcode) return setStatus('Enter a postcode.', 'err');
  const claudeUrl = claudeUrlInput.value.trim();
  if (!/^https:\/\/claude\.ai\//.test(claudeUrl)) return setStatus('Claude URL must start with https://claude.ai/', 'err');
  setStatus('Checking postcode…');
  const res = await send({ type: 'validatePostcode', postcode });
  if (!res.ok) return setStatus(res.error, 'err');
  postcodeInput.value = res.data.label;
  await chrome.storage.sync.set({
    postcode: res.data.label,
    units: unitsSelect.value,
    claudeUrl,
    claudeAutoSend: claudeAutoSendInput.checked,
    triageModel: triageModelInput.value.trim() || DEFAULTS.triageModel
  });
  await chrome.storage.local.set({
    googleKey: googleKeyInput.value.trim(),
    openRouterKey: openRouterKeyInput.value.trim()
  });
  setStatus(`Saved. Origin: ${res.data.label}`, 'ok');
});

document.getElementById('clear').addEventListener('click', async () => {
  const res = await send({ type: 'clearCache' });
  setStatus(res.ok ? 'Cache cleared.' : res.error, res.ok ? 'ok' : 'err');
});

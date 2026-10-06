// Content script for claude.ai: if the background worker has a job parked for
// this tab (see sendToClaude in background.js), puts it into the message box
// and, when enabled in settings, sends it.

(() => {
  const INPUT_SELECTORS = ['[data-testid="chat-input"]', 'div.ProseMirror[contenteditable="true"]'];
  const SEND_SELECTORS = ['button[data-testid="chat-input-send"]', 'button[aria-label="Send message"]'];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(find, timeoutMs) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const hit = find();
      if (hit) return hit;
      if (Date.now() > end) return null;
      await sleep(200);
    }
  }

  const findInput = () => INPUT_SELECTORS.map((s) => document.querySelector(s)).find(Boolean);
  const findSend = () =>
    SEND_SELECTORS.map((s) => document.querySelector(s)).find((b) => b && !b.disabled && b.getAttribute('aria-disabled') !== 'true');

  function notify(text) {
    const box = document.createElement('div');
    box.textContent = `LinkedIn Helper: ${text}`;
    box.style.cssText =
      'position:fixed;z-index:2147483000;right:16px;bottom:16px;max-width:320px;padding:10px 12px;border-radius:8px;' +
      'background:#1d2226;color:#fff;font:13px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35)';
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 8000);
  }

  // A scripted paste goes through the editor's own paste handling, so a long
  // job description is treated exactly like one pasted by hand.
  function paste(input, text) {
    input.focus();
    const data = new DataTransfer();
    data.setData('text/plain', text);
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }

  async function deliver({ text, autoSend }) {
    const input = await waitFor(findInput, 30000);
    if (!input) return notify('could not find the message box. Paste the job manually.');
    await sleep(500); // let the editor finish wiring up its handlers
    paste(input, text);
    let send = await waitFor(findSend, 3000);
    if (!send && !input.textContent.trim()) {
      input.focus();
      document.execCommand('insertText', false, text);
      send = await waitFor(findSend, 3000);
    }
    if (!autoSend) return;
    if (!send) return notify('the job is in the message box but the send button was not found. Press Enter to send.');
    send.click();
  }

  try {
    chrome.runtime.sendMessage({ type: 'takeClaudePending' }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok || !res.data) return;
      deliver(res.data);
    });
  } catch (e) {
    /* extension context gone */
  }
})();

// Content script: finds the location line of the open LinkedIn job, adds a map
// pin after it, and shows driving distance/time in a popover on hover or click.
// Also adds two buttons next to Save: "Evaluate" asks a cheap model for a quick
// fit score, and "Send to Claude" opens the job as a new chat in a claude.ai
// project. Both hand the job text to the background worker.

(() => {
  const PIN_CLASS = 'lidist-pin';
  const POPOVER_CLASS = 'lidist-popover';
  const BTN_CLASS = 'lidist-btn';
  const SEND_CLASS = 'lidist-send';
  const SEND_LABEL = 'Send to Claude';
  const EVAL_CLASS = 'lidist-eval';
  const EVAL_LABEL = 'Evaluate';
  const REASON_CLASS = 'lidist-reason';

  // LinkedIn's class names change often; these are tried first, then a
  // text-based heuristic takes over (see findByText).
  const KNOWN_LINE_SELECTORS = [
    '.job-details-jobs-unified-top-card__primary-description-container',
    '.job-details-jobs-unified-top-card__tertiary-description-container',
    '.jobs-unified-top-card__primary-description',
    '.jobs-unified-top-card__subtitle-primary-grouping',
    '.topcard__flavor-row'
  ];
  const META_WORDS = /\b(ago|applicants?|clicked apply|reposted)\b/i;
  // No leading \b on purpose: LinkedIn glues blocks together ("90K GBP/yrViewed").
  const NOT_A_LOCATION =
    /\bago\b|viewed|applicant|apply|applied|promoted|reposted|saved|alumni|connection|[£$€]|GBP|USD|EUR|\/(yr|hr|month)|\d\s*K\b/i;
  // Job cards in the results list are skipped; only the open job gets a pin.
  const SKIP_ANCESTORS = `.${POPOVER_CLASS}, li, a, [role="button"], button, nav, script, style`;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const results = new Map(); // "location|company" -> Promise<response>
  // Nodes this instance created. Reloading the extension leaves the previous
  // instance's pin and buttons in the page with dead handlers; anything with
  // our classes that is not in here is such a leftover and gets removed.
  const mine = new WeakSet();
  const own = (node) => (mine.add(node), node);
  const OURS = `.${POPOVER_CLASS}, .${PIN_CLASS}, .${BTN_CLASS}, .${REASON_CLASS}`;

  function dropLeftovers() {
    document.querySelectorAll(OURS).forEach((n) => mine.has(n) || n.remove());
  }

  // False once the extension has been reloaded or removed under this page.
  function alive() {
    try {
      return !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
  }
  let popover = null;
  let activePin = null;
  let pinned = false;
  let hideTimer = null;

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const onJobsPage = () => location.pathname.startsWith('/jobs');

  function isLocationLike(text) {
    return text.length >= 2 && text.length <= 80 && /[A-Za-z]/.test(text) && !NOT_A_LOCATION.test(text);
  }

  function ownText(el) {
    // textContent without anything we injected ourselves
    if (!el.querySelector(`.${PIN_CLASS}`)) return el.textContent;
    const clone = el.cloneNode(true);
    clone.querySelectorAll(`.${PIN_CLASS}`).forEach((n) => n.remove());
    return clone.textContent;
  }

  // Country-level locations ("United Kingdom", "England, United Kingdom") get no
  // pin: a distance to the middle of a country is meaningless.
  const COUNTRY_LEVEL = new Set(
    ['england', 'scotland', 'wales', 'northern ireland', 'great britain', 'britain', 'uk', 'usa', 'us',
      'emea', 'europe', 'european union', 'european economic area', 'worldwide', 'remote']
  );
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    for (let a = 65; a <= 90; a++) {
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        const name = names.of(code);
        if (name && name !== code) COUNTRY_LEVEL.add(name.toLowerCase());
      }
    }
  } catch (e) {
    COUNTRY_LEVEL.add('united kingdom').add('ireland').add('united states');
  }

  function isCountryOnly(loc) {
    const parts = loc
      .replace(/\([^)]*\)/g, ' ')
      .split(',')
      .map((p) => norm(p).toLowerCase())
      .filter(Boolean);
    return !parts.length || parts.every((p) => COUNTRY_LEVEL.has(p));
  }

  // First "·"-separated segment of a line, if it reads like a location.
  function rawLocation(el) {
    const text = norm(ownText(el));
    if (!text.includes('·')) return null;
    const first = norm(text.split('·')[0]);
    return isLocationLike(first) ? first : null;
  }

  function lineLocation(el) {
    const raw = rawLocation(el);
    return raw && !isCountryOnly(raw) ? raw : null;
  }

  // Company name of the job whose location line is `line`: the nearest
  // company link above it in the job's top card.
  function findCompany(line) {
    let el = line.parentElement;
    for (let depth = 0; el && el !== document.body && depth < 10; depth++, el = el.parentElement) {
      for (const a of el.querySelectorAll('a[href*="/company/"]')) {
        const name = norm(a.textContent);
        if (name && name.length <= 80) return name;
      }
    }
    return '';
  }

  function findByText(found, withCountry) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!META_WORDS.test(node.nodeValue)) continue;
      let el = node.parentElement;
      if (!el || el.closest(SKIP_ANCESTORS)) continue;
      for (let depth = 0; el && el !== document.body && depth < 6; depth++, el = el.parentElement) {
        const text = norm(ownText(el));
        if (text.length > 300) break;
        const raw = rawLocation(el);
        if (raw) {
          // a country-only line ends the search: climbing further would only
          // pick up the company name and job title above it
          if (withCountry || !isCountryOnly(raw)) found.add(el);
          break;
        }
      }
    }
  }

  // withCountry also returns country-only lines, which get no pin but still
  // mark where the open job's top card is.
  function findLocationLines(withCountry) {
    const found = new Set();
    const usable = withCountry ? rawLocation : lineLocation;
    for (const sel of KNOWN_LINE_SELECTORS) {
      document.querySelectorAll(sel).forEach((el) => usable(el) && found.add(el));
    }
    findByText(found, withCountry);
    // keep only the innermost match when candidates are nested
    const all = [...found];
    return all.filter((el) => !all.some((other) => other !== el && el.contains(other)));
  }

  function firstTextNode(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement.closest(`.${PIN_CLASS}`)) continue;
      if (norm(node.nodeValue)) return node;
    }
    return null;
  }

  function createPin(loc) {
    const pin = own(document.createElement('span'));
    pin.className = PIN_CLASS;
    pin.dataset.loc = loc;
    pin.setAttribute('role', 'button');
    pin.setAttribute('tabindex', '0');
    pin.setAttribute('aria-label', `Driving distance to ${loc}`);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute(
      'd',
      'M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z'
    );
    svg.appendChild(path);
    pin.appendChild(svg);

    pin.addEventListener('mouseenter', () => {
      clearTimeout(hideTimer);
      if (!(pinned && activePin === pin)) show(pin, false);
    });
    pin.addEventListener('mouseleave', scheduleHide);
    pin.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (pinned && activePin === pin) hide();
      else show(pin, true);
    });
    pin.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') pin.click();
      else if (e.key === 'Escape') hide();
      else return;
      e.preventDefault();
    });
    return pin;
  }

  function placePin(line) {
    const loc = lineLocation(line);
    const existing = line.querySelector(`.${PIN_CLASS}`);
    if (!loc) return;
    if (existing) {
      if (existing.dataset.loc === loc) {
        const company = findCompany(line); // same town, possibly a different job
        if (existing.dataset.company !== company) {
          existing.dataset.company = company;
          fetchRoute(existing);
        }
        return;
      }
      if (activePin === existing) hide();
      existing.remove();
    }
    let node = firstTextNode(line);
    if (!node) return;
    const dot = node.nodeValue.indexOf('·');
    if (dot >= 0) {
      // location and separator share a text node: split so the pin sits between them
      const head = node.nodeValue.slice(0, dot).replace(/\s+$/, '');
      node.splitText(head.length);
    }
    const pin = createPin(loc);
    pin.dataset.company = findCompany(line);
    node.after(pin);
    fetchRoute(pin); // warm up so the numbers are ready by the time of hover
  }

  function fetchRoute(pin) {
    const loc = pin.dataset.loc;
    const company = pin.dataset.company || '';
    const cacheKey = `${loc}|${company}`;
    if (!results.has(cacheKey)) {
      const p = new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: 'getRoute', location: loc, company }, (res) => {
            if (chrome.runtime.lastError || !res) {
              resolve({ ok: false, error: 'Extension was reloaded — refresh this page.' });
            } else {
              resolve(res);
            }
          });
        } catch (e) {
          resolve({ ok: false, error: 'Extension was reloaded — refresh this page.' });
        }
      });
      results.set(cacheKey, p);
      p.then((res) => {
        if (!res.ok) results.delete(cacheKey); // let a later hover retry
      });
    }
    return results.get(cacheKey);
  }

  // --- Popover ---------------------------------------------------------------

  function formatDistance(meters, units) {
    const value = units === 'km' ? meters / 1000 : meters / 1609.344;
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units === 'km' ? 'km' : 'mi'}`;
  }

  function formatDuration(seconds) {
    const mins = Math.max(1, Math.round(seconds / 60));
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (!h) return `${m} min`;
    return m ? `${h} h ${m} min` : `${h} h`;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function ensurePopover() {
    if (popover && popover.isConnected) return popover;
    popover = own(el('div', POPOVER_CLASS));
    popover.setAttribute('role', 'tooltip');
    popover.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    popover.addEventListener('mouseleave', scheduleHide);
    document.body.appendChild(popover);
    return popover;
  }

  function position(pin) {
    const r = pin.getBoundingClientRect();
    const p = popover.getBoundingClientRect();
    let left = r.left + r.width / 2 - p.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - p.width - 8));
    let top = r.bottom + 8;
    if (top + p.height > window.innerHeight - 8 && r.top - p.height - 8 > 0) top = r.top - p.height - 8;
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  }

  function render(pin, state, payload) {
    const loc = pin.dataset.loc;
    popover.replaceChildren();
    if (state === 'loading') {
      popover.append(el('div', 'lidist-title', loc), el('div', 'lidist-muted', 'Calculating route…'));
    } else if (state === 'error') {
      popover.append(el('div', 'lidist-title', loc), el('div', 'lidist-error', payload));
    } else {
      popover.append(el('div', 'lidist-title', payload.destination || loc));
      const grid = el('div', 'lidist-grid');
      grid.append(
        el('span', 'lidist-label', 'Distance'),
        el('span', 'lidist-value', formatDistance(payload.meters, payload.units)),
        el('span', 'lidist-label', 'Drive time'),
        el('span', 'lidist-value', formatDuration(payload.seconds))
      );
      const company = pin.dataset.company;
      const place = payload.query || loc;
      const note = el('div', 'lidist-muted', payload.precise ? payload.address : 'to the town centre');
      const foot = el('div', 'lidist-muted', `from ${payload.origin} · `);
      // Google can usually find the actual office from "Company, Town".
      const link = el('a', null, company ? `Route to ${company} office` : 'Google Maps');
      link.href =
        'https://www.google.com/maps/dir/?api=1&travelmode=driving' +
        `&origin=${encodeURIComponent(payload.origin)}` +
        `&destination=${encodeURIComponent(company ? `${company}, ${place}` : place)}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      foot.append(link);
      popover.append(grid, note, foot);
      if (payload.warning) popover.append(el('div', 'lidist-muted lidist-error', payload.warning));
    }
    position(pin);
  }

  function show(pin, pin_open) {
    clearTimeout(hideTimer);
    ensurePopover();
    activePin = pin;
    pinned = pin_open;
    popover.classList.add('lidist-visible');
    render(pin, 'loading');
    fetchRoute(pin).then((res) => {
      if (activePin !== pin || !popover.classList.contains('lidist-visible')) return;
      if (res.ok) render(pin, 'ok', res.data);
      else render(pin, 'error', res.error);
    });
  }

  function hide() {
    clearTimeout(hideTimer);
    if (popover) popover.classList.remove('lidist-visible');
    activePin = null;
    pinned = false;
  }

  function scheduleHide() {
    if (pinned) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 250);
  }

  document.addEventListener('click', (e) => {
    if (!pinned || !popover) return;
    if (popover.contains(e.target) || (activePin && activePin.contains(e.target))) return;
    hide();
  });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && hide());
  window.addEventListener('scroll', () => activePin && (activePin.isConnected ? position(activePin) : hide()), true);
  window.addEventListener('resize', () => activePin && position(activePin));

  // --- Send to Claude --------------------------------------------------------

  const DESCRIPTION_SELECTORS = ['article.jobs-description__container', '[class*="jobs-description__container"]', '#job-details'];
  const CARD_NOISE = /^(share|show more options|matches your job preferences\b.*)$/i;
  const CARD_END = /^(easy apply|apply|save|saved)$/i;

  function findDescription() {
    for (const sel of DESCRIPTION_SELECTORS) {
      const hit = document.querySelector(sel);
      if (hit && norm(hit.innerText).length > 50) return hit;
    }
    // class names gone: climb from the "About the job" heading to its section
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (norm(node.nodeValue).toLowerCase() !== 'about the job') continue;
      let hit = node.parentElement;
      for (let depth = 0; hit && hit !== document.body && depth < 6; depth++, hit = hit.parentElement) {
        if (norm(hit.innerText).length > 200) return hit;
      }
    }
    return null;
  }

  // The open job's top card: the largest block around the location line that
  // stops short of the description.
  function findTopCard(desc) {
    let card = findLocationLines(true)[0] || document.querySelector('h1');
    if (!card || !desc || card.contains(desc) || desc.contains(card)) return null;
    while (card.parentElement && card.parentElement !== document.body && !card.parentElement.contains(desc)) {
      card = card.parentElement;
    }
    return card;
  }

  function findSaveButton(card) {
    return [...card.querySelectorAll('button, a')].find(
      (b) => !b.classList.contains(BTN_CLASS) && /^saved?$/i.test(norm((b.innerText || '').split('\n')[0]))
    );
  }

  // Company, title, location line, workplace and job type; everything from the
  // Apply/Save buttons down is dropped.
  function cardText(card) {
    const lines = [];
    const ours = new Set([...card.querySelectorAll(`.${BTN_CLASS}, .${REASON_CLASS}`)].map((b) => norm(b.innerText)));
    for (const raw of card.innerText.split('\n')) {
      const line = norm(raw);
      if (!line || ours.has(line) || CARD_NOISE.test(line)) continue;
      if (CARD_END.test(line)) break;
      if (lines[lines.length - 1] !== line) lines.push(line);
    }
    return lines.join('\n');
  }

  function jobText() {
    const desc = findDescription();
    const card = findTopCard(desc);
    if (!desc || !card) return '';
    const body = desc.innerText
      .split('\n')
      .map((l) => l.replace(/\s+$/, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .replace(/\n+…\s*(see |show )?more$/i, ''); // the "… more" expander, not part of the text
    return `${cardText(card)}\n\n${body}`;
  }

  // LinkedIn's id for the open job, used to remember its evaluation.
  function jobId() {
    const m = location.pathname.match(/\/jobs\/view\/(\d+)/);
    return (m && m[1]) || new URLSearchParams(location.search).get('currentJobId') || '';
  }

  function ask(message) {
    return new Promise((resolve) => {
      const gone = { ok: false, error: 'Refresh this page' };
      try {
        chrome.runtime.sendMessage(message, (res) => resolve(chrome.runtime.lastError || !res ? gone : res));
      } catch (e) {
        resolve(gone);
      }
    });
  }

  function setLabel(btn, text) {
    btn.querySelector('.lidist-btn-label').textContent = text;
  }

  // Shows a message on the button for a moment, then calls `restore`.
  function flash(btn, text, isError, restore) {
    setLabel(btn, text);
    btn.classList.toggle('lidist-btn-error', !!isError);
    clearTimeout(btn.resetTimer);
    btn.resetTimer = setTimeout(() => {
      btn.classList.remove('lidist-btn-error');
      restore();
    }, 2500);
  }

  function icon(viewBox, d, className) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('aria-hidden', 'true');
    if (className) svg.setAttribute('class', className);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
  }

  // Claude mark, from https://commons.wikimedia.org/wiki/File:Claude_AI_logo.svg
  const CLAUDE_MARK =
    'm 105.01,322.07 29.14,-16.35 0.49,-1.42 -0.49,-0.79 h -1.42 l -4.87,-0.3 -16.65,-0.45 -14.44,-0.6 -13.99,-0.75 -3.52,-0.75 -3.3,-4.35 0.34,-2.17 2.96,-1.99 4.24,0.37 9.37,0.64 14.06,0.97 10.2,0.6 15.11,1.57 h 2.4 l 0.34,-0.97 -0.82,-0.6 -0.64,-0.6 -14.55,-9.86 -15.75,-10.42 -8.25,-6 -4.46,-3.04 -2.25,-2.85 -0.97,-6.22 4.05,-4.46 5.44,0.37 1.39,0.37 5.51,4.24 11.77,9.11 15.37,11.32 2.25,1.87 0.9,-0.64 0.11,-0.45 -1.01,-1.69 -8.36,-15.11 -8.92,-15.37 -3.97,-6.37 -1.05,-3.82 c -0.37,-1.57 -0.64,-2.89 -0.64,-4.5 l 4.61,-6.26 2.55,-0.82 6.15,0.82 2.59,2.25 3.82,8.74 6.19,13.76 9.6,18.71 2.81,5.55 1.5,5.14 0.56,1.57 h 0.97 v -0.9 l 0.79,-10.54 1.46,-12.94 1.42,-16.65 0.49,-4.69 2.32,-5.62 4.61,-3.04 3.6,1.72 2.96,4.24 -0.41,2.74 -1.76,11.44 -3.45,17.92 -2.25,12 h 1.31 l 1.5,-1.5 6.07,-8.06 10.2,-12.75 4.5,-5.06 5.25,-5.59 3.37,-2.66 h 6.37 l 4.69,6.97 -2.1,7.2 -6.56,8.32 -5.44,7.05 -7.8,10.5 -4.87,8.4 0.45,0.67 1.16,-0.11 17.62,-3.75 9.52,-1.72 11.36,-1.95 5.14,2.4 0.56,2.44 -2.02,4.99 -12.15,3 -14.25,2.85 -21.22,5.02 -0.26,0.19 0.3,0.37 9.56,0.9 4.09,0.22 h 10.01 l 18.64,1.39 4.87,3.22 2.92,3.94 -0.49,3 -7.5,3.82 -10.12,-2.4 -23.62,-5.62 -8.1,-2.02 h -1.12 v 0.67 l 6.75,6.6 12.37,11.17 15.49,14.4 0.79,3.56 -1.99,2.81 -2.1,-0.3 -13.61,-10.24 -5.25,-4.61 -11.89,-10.01 h -0.79 v 1.05 l 2.74,4.01 14.47,21.75 0.75,6.67 -1.05,2.17 -3.75,1.31 -4.12,-0.75 -8.47,-11.89 -8.74,-13.39 -7.05,-12 -0.86,0.49 -4.16,44.81 -1.95,2.29 -4.5,1.72 -3.75,-2.85 -1.99,-4.61 1.99,-9.11 2.4,-11.89 1.95,-9.45 1.76,-11.74 1.05,-3.9 -0.07,-0.26 -0.86,0.11 -8.85,12.15 -13.46,18.19 -10.65,11.4 -2.55,1.01 -4.42,-2.29 0.41,-4.09 2.47,-3.64 14.74,-18.75 8.89,-11.62 5.74,-6.71 -0.04,-0.97 h -0.34 l -39.15,25.42 -6.97,0.9 -3,-2.81 0.37,-4.61 1.42,-1.5 11.77,-8.1 -0.04,0.04 z';
  const NEW_TAB_ICON = 'M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4';

  function createButton(className, label, children, onClick) {
    const btn = own(el('button', `${BTN_CLASS} ${className}`));
    btn.type = 'button';
    btn.append(...children(el('span', 'lidist-btn-label', label)));
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick(btn);
    });
    return btn;
  }

  function createSendButton() {
    const reset = (btn) => () => setLabel(btn, SEND_LABEL);
    return createButton(
      SEND_CLASS,
      SEND_LABEL,
      (label) => [icon('75.96 223.53 148.1 148.2', CLAUDE_MARK, 'lidist-send-mark'), label, icon('0 0 24 24', NEW_TAB_ICON)],
      async (btn) => {
        const text = jobText();
        if (!text) return flash(btn, 'Job text not found', true, reset(btn));
        const res = await ask({ type: 'sendToClaude', text });
        flash(btn, res.ok ? 'Sent ✓' : res.error, !res.ok, reset(btn));
      }
    );
  }

  // --- Evaluate --------------------------------------------------------------

  // `result` is { score, verdict, reason }, or null for "not evaluated yet".
  // The reason goes on its own line under the buttons.
  function showVerdict(btn, result) {
    clearTimeout(btn.resetTimer);
    btn.classList.remove('lidist-btn-error', 'lidist-eval-busy');
    btn.dataset.verdict = result ? result.verdict : '';
    setLabel(btn, result ? `${result.score} · ${result.verdict}` : EVAL_LABEL);
    btn.title = result ? 'Click to evaluate again' : 'Quick fit score for this job';
    btn.result = result;
    showReason(result);
  }

  function showReason(result) {
    const reason = document.querySelector(`.${REASON_CLASS}`);
    if (!reason) return;
    reason.textContent = (result && result.reason) || '';
    reason.dataset.verdict = result ? result.verdict : '';
  }

  function createEvalButton() {
    return createButton(EVAL_CLASS, EVAL_LABEL, (label) => [label], async (btn) => {
      if (btn.classList.contains('lidist-eval-busy')) return;
      const job = jobId();
      const text = jobText();
      const before = btn.result;
      if (!text) return flash(btn, 'Job text not found', true, () => showVerdict(btn, before));
      showVerdict(btn, null);
      btn.classList.add('lidist-eval-busy');
      setLabel(btn, 'Evaluating…');
      const res = await ask({ type: 'evaluateJob', jobId: job, text });
      if (btn.dataset.job !== job) return; // another job was opened meanwhile
      btn.classList.remove('lidist-eval-busy');
      if (res.ok) return showVerdict(btn, res.data);
      btn.title = res.error;
      flash(btn, res.error, true, () => showVerdict(btn, before));
    });
  }

  // Shows the stored verdict when the open job has been evaluated before.
  function syncEvalButton(btn) {
    const job = jobId();
    if (btn.dataset.job === job) return;
    btn.dataset.job = job;
    showVerdict(btn, null);
    if (!job) return;
    ask({ type: 'getEvaluation', jobId: job }).then((res) => {
      if (res.ok && res.data && btn.dataset.job === job) showVerdict(btn, res.data);
    });
  }

  function isFlexRow(node) {
    const s = getComputedStyle(node);
    return s.display.includes('flex') && !s.flexDirection.includes('column');
  }

  function placeButtons() {
    const card = findTopCard(findDescription());
    if (!card) {
      document.querySelectorAll(`.${BTN_CLASS}, .${REASON_CLASS}`).forEach((b) => b.remove());
      return;
    }
    const evalBtn = document.querySelector(`.${EVAL_CLASS}`) || createEvalButton();
    const sendBtn = document.querySelector(`.${SEND_CLASS}`) || createSendButton();
    const reason = document.querySelector(`.${REASON_CLASS}`) || own(el('div', REASON_CLASS));
    // the reason may legitimately sit just after the card (see below)
    const reasonPlaced = card.contains(reason) || card.nextElementSibling === reason;
    if (!card.contains(evalBtn) || !card.contains(sendBtn) || !reasonPlaced) {
      const save = findSaveButton(card);
      // LinkedIn may wrap each button in its own box: climb to the item that
      // sits directly in the horizontal button row and join that row.
      let anchor = save;
      for (let depth = 0; anchor && depth < 3 && card.contains(anchor.parentElement); depth++) {
        if (isFlexRow(anchor.parentElement)) break;
        anchor = anchor.parentElement;
      }
      if (anchor && !isFlexRow(anchor.parentElement)) anchor = save;
      if (anchor) {
        anchor.after(evalBtn, sendBtn);
        // LinkedIn's grids stack their children in one cell, so the reason
        // has to go after the outermost grid around the row, not inside it.
        let holder = anchor.parentElement;
        while (holder !== card && getComputedStyle(holder.parentElement).display.includes('grid')) {
          holder = holder.parentElement;
        }
        holder.after(reason);
        const spaced = parseFloat(getComputedStyle(holder.parentElement).rowGap) > 0;
        reason.style.marginTop = spaced ? '0' : '';
      } else {
        card.append(evalBtn, sendBtn, reason);
      }
      showReason(evalBtn.result);
      const rowGap = anchor && parseFloat(getComputedStyle(anchor.parentElement).columnGap) > 0;
      for (const btn of save ? [evalBtn, sendBtn] : []) {
        // same height and text size as LinkedIn's own buttons
        if (save.offsetHeight) btn.style.height = `${save.offsetHeight}px`;
        btn.style.fontSize = getComputedStyle(save).fontSize;
        btn.style.marginLeft = rowGap ? '0' : '';
      }
    }
    syncEvalButton(evalBtn);
  }

  // --- Wiring ----------------------------------------------------------------

  function scan() {
    if (!alive()) {
      // a newer instance has taken over (or will after a refresh): stand down
      observer.disconnect();
      hide();
      return;
    }
    dropLeftovers();
    if (!onJobsPage()) return;
    placeButtons();
    if (activePin && !activePin.isConnected) hide();
    const lines = findLocationLines();
    // drop pins left behind when a line's location changed to something we skip
    document.querySelectorAll(`.${PIN_CLASS}`).forEach((pin) => {
      if (lines.some((line) => line.contains(pin))) return;
      if (activePin === pin) hide();
      pin.remove();
    });
    lines.forEach(placePin);
  }

  let scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 300);
  }

  const observer = new MutationObserver((mutations) => {
    // ignore the mutations caused by our own pin/popover/buttons
    const external = mutations.some((m) => {
      const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      if (t && t.closest(OURS)) return false;
      const nodes = [...m.addedNodes, ...m.removedNodes];
      return !nodes.length || nodes.some((n) => !(n.nodeType === 1 && n.matches(OURS)));
    });
    if (external) scheduleScan();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  // Changing the postcode or units invalidates anything already computed.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if ((area === 'sync' && (changes.postcode || changes.units)) || (area === 'local' && changes.googleKey)) {
        results.clear();
        hide();
      }
      // the list-scoring bar (bulk.js) may have just scored the open job
      const scored = area === 'local' && changes[`triage:${jobId()}`];
      const evalBtn = document.querySelector(`.${EVAL_CLASS}`);
      if (scored && evalBtn && mine.has(evalBtn) && !evalBtn.classList.contains('lidist-eval-busy')) {
        showVerdict(evalBtn, scored.newValue ? scored.newValue.v : null);
      }
    });
  } catch (e) {
    /* extension context gone */
  }

  // bulk.js runs in the same isolated world and reads the open job through this
  window.__lidist = { jobText, jobId };

  scan();
})();

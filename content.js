// Content script: finds the location line of the open LinkedIn job, adds a map
// pin after it, and shows driving distance/time in a popover on hover or click.

(() => {
  const PIN_CLASS = 'lidist-pin';
  const POPOVER_CLASS = 'lidist-popover';

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

  function findByText(found) {
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
          if (!isCountryOnly(raw)) found.add(el);
          break;
        }
      }
    }
  }

  function findLocationLines() {
    const found = new Set();
    for (const sel of KNOWN_LINE_SELECTORS) {
      document.querySelectorAll(sel).forEach((el) => lineLocation(el) && found.add(el));
    }
    findByText(found);
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
    const pin = document.createElement('span');
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
    popover = el('div', POPOVER_CLASS);
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

  // --- Wiring ----------------------------------------------------------------

  function scan() {
    if (!onJobsPage()) return;
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

  new MutationObserver((mutations) => {
    // ignore the mutations caused by our own pin/popover
    const external = mutations.some((m) => {
      const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      if (t && t.closest(`.${POPOVER_CLASS}, .${PIN_CLASS}`)) return false;
      const nodes = [...m.addedNodes, ...m.removedNodes];
      return !nodes.length || nodes.some((n) => !(n.nodeType === 1 && n.matches(`.${POPOVER_CLASS}, .${PIN_CLASS}`)));
    });
    if (external) scheduleScan();
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  // Changing the postcode or units invalidates anything already computed.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if ((area === 'sync' && (changes.postcode || changes.units)) || (area === 'local' && changes.googleKey)) {
        results.clear();
        hide();
      }
    });
  } catch (e) {
    /* extension context gone */
  }

  scan();
})();

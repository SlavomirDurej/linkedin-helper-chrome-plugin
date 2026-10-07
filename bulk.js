// Content script: bulk triage of the job list on LinkedIn's search pages.
// Adds a control bar above the list, opens every job in it one after another
// and scores it with the same text and model as the Evaluate button, writes
// the score under each job title, hides poor matches and lets the score tiles
// act as filters.

(() => {
  const BAR_CLASS = 'lidist-bar';
  const BADGE_CLASS = 'lidist-badge';
  const HIDDEN_CLASS = 'lidist-hidden';
  const FIT_ATTR = 'data-lidist-fit';
  const OURS = `.${BAR_CLASS}, .${BADGE_CLASS}`;
  const BAR_HEIGHT = 56;
  const OPEN_TIMEOUT_MS = 15000; // how long a job may take to load in the pane
  // Jobs scoring below the first band are hidden from the list.
  const BANDS = [
    { key: 'low', min: 0, max: 44, label: '<45' },
    { key: 'b1', min: 45, max: 60, label: '45-60' },
    { key: 'b2', min: 61, max: 70, label: '61-70' },
    { key: 'b3', min: 71, max: 80, label: '71-80' },
    { key: 'b4', min: 81, max: 90, label: '81-90' },
    { key: 'b5', min: 91, max: 100, label: '91-100' }
  ];
  const bandOf = (score) => BANDS.find((b) => score >= b.min && score <= b.max);

  const results = new Map(); // jobId -> { score, verdict, reason }
  const failed = new Map(); // jobId -> error message, cleared on Start
  const asked = new Set(); // jobIds already looked up in the cache
  const busy = new Set(); // jobIds being evaluated right now
  const mine = new WeakSet(); // nodes this instance created
  let running = false;
  let looping = false; // the run() loop is active
  const evals = new Set(); // model calls still in flight
  let nowTitle = '';
  let filter = null; // band key, or null for "everything not hidden"
  let bar = null;
  let jobs = []; // current list: { id, title, row, card }

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function alive() {
    try {
      return !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
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

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    mine.add(node);
    return node;
  }

  // --- Reading the list ------------------------------------------------------

  // LinkedIn serves two search layouts. Each returns the scrolling list
  // element plus one entry per job: its id, title, the element to hide and
  // the element the score goes after.
  function readClassicList() {
    const items = [...document.querySelectorAll('li[data-occludable-job-id]')];
    if (!items.length) return null;
    return {
      kind: 'classic',
      list: items[0].parentElement,
      jobs: items.map((li) => {
        const link = li.querySelector('a.job-card-container__link, a[href*="/jobs/view/"]');
        return {
          id: li.dataset.occludableJobId,
          title: link ? norm((link.innerText || '').split('\n')[0]) : '',
          row: li,
          card: li,
          anchor: li.querySelector('.artdeco-entity-lockup__title') || link
        };
      })
    };
  }

  function readNewList() {
    const list = document.querySelector('[data-testid="lazy-column"]');
    const cards = list ? [...list.querySelectorAll('[componentkey^="job-card-component-ref-"]')] : [];
    if (!cards.length) return null;
    return {
      kind: 'new',
      list,
      jobs: cards.map((card) => {
        let row = card;
        while (row.parentElement && row.parentElement !== list) row = row.parentElement;
        const dismiss = card.querySelector('button[aria-label^="Dismiss"]');
        const label = dismiss ? dismiss.getAttribute('aria-label') : '';
        // the title sits in a display:contents wrapper; the score goes after that wrapper
        let anchor = card.querySelector('p');
        while (anchor && getComputedStyle(anchor.parentElement).display === 'contents') anchor = anchor.parentElement;
        return {
          id: card.getAttribute('componentkey').replace('job-card-component-ref-', ''),
          title: norm(label.replace(/^Dismiss\s+/, '').replace(/\s+job$/, '')) || norm((card.querySelector('p') || {}).innerText),
          row,
          card,
          anchor
        };
      })
    };
  }

  // --- Opening jobs ------------------------------------------------------------

  class Stopped extends Error {}

  // Polls `test` until it returns something truthy; false on timeout.
  async function until(test, timeoutMs, stepMs = 300) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      if (!running) throw new Stopped();
      const hit = test();
      if (hit) return hit;
      if (Date.now() > end) return false;
      await new Promise((r) => setTimeout(r, stepMs));
    }
  }

  // The list row for a job as it is right now, and what to click to open it.
  // Classic rows are empty placeholders until they scroll into view.
  function findRow(id) {
    const li = document.querySelector(`li[data-occludable-job-id="${id}"]`);
    if (li) return { row: li, target: li.querySelector('.job-card-container, a[href*="/jobs/view/"]') };
    const card = document.querySelector(`[componentkey="job-card-component-ref-${id}"]`);
    return card ? { row: card, target: card.querySelector('[role="button"]') || card } : null;
  }

  // Opens the job in the details pane and returns the same text the Evaluate
  // button would send (top card plus the full "About the job").
  async function openJob(job) {
    const pane = window.__lidist; // jobText() and jobId() from content.js
    if (!pane) throw new Error('Refresh this page');
    let hit = findRow(job.id);
    if (!hit) throw new Error('Job is no longer in the list');
    if (!hit.target) {
      hit.row.scrollIntoView({ block: 'center' });
      await until(() => (hit = findRow(job.id)) && hit.target, 5000);
    }
    if (!hit || !hit.target) throw new Error('Job row did not load');
    const alreadyOpen = pane.jobId() === job.id;
    const before = alreadyOpen ? '' : pane.jobText();
    if (!alreadyOpen) {
      hit.row.scrollIntoView({ block: 'nearest' });
      hit.target.click();
    }
    const started = Date.now();
    let last = '';
    let clicks = 1;
    const loaded = await until(() => {
      if (pane.jobId() !== job.id) {
        // LinkedIn sometimes ignores a click; try again every few seconds
        if (clicks < 3 && Date.now() - started > clicks * 4000) {
          clicks++;
          const again = findRow(job.id);
          if (again && again.target) again.target.click();
        }
        return false;
      }
      const text = pane.jobText();
      const settled = !!text && text === last;
      last = text;
      // the pane shows the previous job for a moment after the address
      // changes; a repost with identical text is accepted after a few seconds
      return settled && (text !== before || Date.now() - started > 5000);
    }, OPEN_TIMEOUT_MS);
    if (!loaded) throw new Error('Job did not open');
    return last;
  }

  // --- Processing --------------------------------------------------------------

  const pending = () => jobs.filter((j) => !results.has(j.id) && !failed.has(j.id) && !busy.has(j.id));

  // The model call runs while the next job is already being opened.
  function evaluate(id, text) {
    const call = ask({ type: 'evaluateJob', jobId: id, text }).then((res) => {
      if (res.ok) results.set(id, res.data);
      else {
        failed.set(id, res.error);
        if (/key|refresh|prompt/i.test(res.error)) running = false; // every job would fail the same way
      }
      busy.delete(id);
      evals.delete(call);
      render();
    });
    evals.add(call);
  }

  async function run() {
    if (looping) return;
    looping = true;
    const home = window.__lidist ? window.__lidist.jobId() : '';
    while (running) {
      const job = pending()[0];
      if (!job) break;
      busy.add(job.id);
      nowTitle = job.title || `job ${job.id}`;
      renderBar();
      try {
        evaluate(job.id, await openJob(job));
      } catch (e) {
        busy.delete(job.id);
        if (!(e instanceof Stopped)) failed.set(job.id, e.message || String(e));
      }
      render();
    }
    await Promise.all([...evals]);
    running = false;
    looping = false;
    nowTitle = '';
    // go back to the job that was open before the run
    const back = home && window.__lidist && window.__lidist.jobId() !== home && findRow(home);
    if (back && back.target) back.target.click();
    render();
  }

  function start() {
    if (running) return;
    failed.clear(); // give earlier failures another go
    if (!pending().length) return render();
    filter = null; // filtered-out rows cannot be opened
    running = true;
    run();
    render();
  }

  function stop() {
    running = false;
    render();
  }

  // Scores from earlier sessions, and from the Evaluate button, are free.
  async function loadCached() {
    const ids = jobs.map((j) => j.id).filter((id) => !asked.has(id));
    if (!ids.length) return;
    ids.forEach((id) => asked.add(id));
    const res = await ask({ type: 'getEvaluations', jobIds: ids });
    if (!res.ok) return;
    for (const [id, v] of Object.entries(res.data)) results.set(id, v);
    render();
  }

  // --- Bar ---------------------------------------------------------------------

  function buildBar() {
    const node = el('div', BAR_CLASS);
    const inner = el('div', 'lidist-bar-inner');
    const now = el('div', 'lidist-bar-now');
    const tiles = el('div', 'lidist-bar-tiles');
    for (const band of BANDS) {
      const tile = el('button', 'lidist-tile');
      tile.type = 'button';
      tile.dataset.band = band.key;
      tile.append(el('span', 'lidist-tile-range', band.label), el('span', 'lidist-tile-count', '0'));
      tile.addEventListener('click', () => {
        filter = filter === band.key ? null : band.key;
        render();
      });
      tiles.append(tile);
    }
    const progress = el('div', 'lidist-bar-progress');
    progress.append(el('span', 'lidist-bar-count'), el('span', 'lidist-bar-track'));
    progress.querySelector('.lidist-bar-track').append(el('span', 'lidist-bar-fill'));
    const toggle = el('button', 'lidist-bar-toggle');
    toggle.type = 'button';
    toggle.addEventListener('click', () => (running ? stop() : start()));
    inner.append(now, tiles, progress, toggle);
    node.append(inner);
    return node;
  }

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  function renderBar() {
    if (!bar) return;
    const done = jobs.filter((j) => results.has(j.id)).length;
    const errors = jobs.filter((j) => failed.has(j.id)).length;
    const now = bar.querySelector('.lidist-bar-now');
    const firstError = errors ? failed.get(jobs.find((j) => failed.has(j.id)).id) : '';
    if (running && nowTitle) setText(now, `Now processing: ${nowTitle}`);
    else if (running) setText(now, 'Starting…');
    else if (errors) setText(now, `${errors} failed: ${firstError}`);
    else if (done === jobs.length && jobs.length) setText(now, 'All jobs in this list are scored');
    else setText(now, 'Score the jobs in this list');
    now.title = now.textContent;
    now.classList.toggle('lidist-bar-error', !running && !!errors);

    for (const band of BANDS) {
      const tile = bar.querySelector(`.lidist-tile[data-band="${band.key}"]`);
      const count = jobs.filter((j) => results.has(j.id) && bandOf(results.get(j.id).score) === band).length;
      setText(tile.querySelector('.lidist-tile-count'), String(count));
      tile.classList.toggle('lidist-tile-on', filter === band.key);
      tile.classList.toggle('lidist-tile-dim', !!filter && filter !== band.key);
      tile.title =
        band.key === 'low'
          ? `${count} hidden for scoring under 45. Click to show them.`
          : `Click to show only jobs scoring ${band.label}`;
    }

    setText(bar.querySelector('.lidist-bar-count'), `${done}/${jobs.length}`);
    bar.querySelector('.lidist-bar-fill').style.width = jobs.length ? `${Math.round((done / jobs.length) * 100)}%` : '0';
    const toggle = bar.querySelector('.lidist-bar-toggle');
    const left = jobs.length - done;
    setText(toggle, running ? 'Stop' : looping ? 'Stopping…' : errors ? 'Retry' : 'Start');
    toggle.disabled = !running && (looping || !left);
    toggle.classList.toggle('lidist-bar-stop', running);
  }

  // --- List rows -----------------------------------------------------------------

  function renderRows() {
    for (const job of jobs) {
      const result = results.get(job.id);
      const band = result && bandOf(result.score);
      // hidden: below the cut-off, unless that tile is the active filter;
      // with a filter on, everything outside it (unscored jobs included)
      const hide = filter ? !band || band.key !== filter : !!band && band.key === 'low';
      job.row.classList.toggle(HIDDEN_CLASS, hide);
      // the new layout puts a divider after each row; hide it with the row
      const next = job.row.nextElementSibling;
      if (next && next.tagName === 'HR') next.classList.toggle(HIDDEN_CLASS, hide);

      let badge = job.card.querySelector(`.${BADGE_CLASS}`);
      if (badge && !mine.has(badge)) {
        badge.remove(); // left behind by an earlier copy of the extension
        badge = null;
      }
      if (!result) {
        if (badge) badge.remove();
        continue;
      }
      if (!job.anchor) continue; // row not rendered yet; a later scan adds it
      if (!badge) {
        badge = el('div', BADGE_CLASS);
        job.anchor.after(badge);
      }
      setText(badge, `${result.score} · ${result.verdict}`);
      badge.dataset.verdict = result.verdict;
      badge.title = result.reason || '';
    }
  }

  function render() {
    renderBar();
    renderRows();
  }

  // --- Mounting the bar ------------------------------------------------------------

  // Classic layout: the two panes sit in a flex column that makes room by itself.
  function mountClassic() {
    const container = document.querySelector('.scaffold-layout__list-detail-container');
    if (!container) return false;
    if (container.firstElementChild !== bar) container.prepend(bar);
    return true;
  }

  // New layout: the panes have a fixed viewport-based height, so the boxes
  // between the bar and the panes are shortened by the bar's height.
  function mountNew(list) {
    let panes = list;
    while (panes.parentElement && panes.offsetWidth < list.offsetWidth * 1.5) panes = panes.parentElement;
    let child = panes;
    let column = panes.parentElement;
    for (let depth = 0; column && depth < 6; depth++, child = column, column = column.parentElement) {
      const s = getComputedStyle(column);
      if (s.display.includes('flex') && s.flexDirection === 'column') break;
    }
    if (!column || column === document.body) return false;
    if (child.previousElementSibling !== bar) child.before(bar);
    for (let node = panes; node && node !== column; node = node.parentElement) {
      if (node.hasAttribute(FIT_ATTR)) continue;
      const gap = window.innerHeight - node.getBoundingClientRect().height + BAR_HEIGHT;
      node.setAttribute(FIT_ATTR, '');
      node.style.height = `calc(100vh - ${Math.round(gap)}px)`;
    }
    return true;
  }

  function unmount() {
    if (bar) bar.remove();
    bar = null;
    document.querySelectorAll(`[${FIT_ATTR}]`).forEach((node) => {
      node.removeAttribute(FIT_ATTR);
      node.style.height = '';
    });
    document.querySelectorAll(`.${HIDDEN_CLASS}`).forEach((node) => node.classList.remove(HIDDEN_CLASS));
  }

  // --- Wiring ----------------------------------------------------------------------

  function scan() {
    if (!alive()) {
      // a newer copy of the extension has taken over: stand down
      observer.disconnect();
      running = false;
      return;
    }
    // remove anything an earlier copy of the extension left behind
    document.querySelectorAll(OURS).forEach((n) => mine.has(n) || n.remove());
    const found = readClassicList() || readNewList();
    if (!found) {
      jobs = [];
      unmount();
      return;
    }
    jobs = found.jobs.filter((j) => j.id);
    if (!bar) bar = buildBar();
    // re-run every scan: LinkedIn rebuilds these boxes when the search changes
    const placed = found.kind === 'classic' ? mountClassic() : mountNew(found.list);
    if (!placed && !bar.isConnected) {
      // unknown page structure: pin the bar to the top of the list instead
      bar.classList.add('lidist-bar-sticky');
      found.list.prepend(bar);
    }
    render();
    loadCached();
  }

  let scanTimer = null;
  const observer = new MutationObserver((mutations) => {
    const external = mutations.some((m) => {
      const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      if (t && t.closest(OURS)) return false;
      const nodes = [...m.addedNodes, ...m.removedNodes];
      return !nodes.length || nodes.some((n) => !(n.nodeType === 1 && n.matches(OURS)));
    });
    if (!external) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 400);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // The Evaluate button and other tabs write scores to the same store.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      let touched = false;
      for (const [key, change] of Object.entries(changes)) {
        if (!key.startsWith('triage:')) continue;
        const id = key.slice(7);
        if (change.newValue) results.set(id, change.newValue.v);
        else results.delete(id);
        touched = true;
      }
      if (touched) render();
    });
  } catch (e) {
    /* extension context gone */
  }

  scan();
})();

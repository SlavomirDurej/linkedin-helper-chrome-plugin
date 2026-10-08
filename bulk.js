// Content script: bulk triage of the job list on LinkedIn's search pages.
// Adds a control bar above the list, opens every job in it one after another
// and scores it with the same text and model as the Evaluate button, writes
// the score under each job title, hides poor matches and lets the score tiles
// act as filters. The tiles count every page visited in the last day, and
// clicking one lists those jobs in a panel under the bar.

(() => {
  const BAR_CLASS = 'lidist-bar';
  const BADGE_CLASS = 'lidist-badge';
  const HIDDEN_CLASS = 'lidist-hidden';
  const FIT_ATTR = 'data-lidist-fit';
  const PANEL_CLASS = 'lidist-panel';
  const ROWBAR_CLASS = 'lidist-rowbar';
  const OURS = `.${BAR_CLASS}, .${BADGE_CLASS}, .${PANEL_CLASS}, .${ROWBAR_CLASS}`;
  const MARKS_KEY = 'jobMarks';
  const SEEN_KEY = 'bulkSeen';
  const SEEN_TTL_MS = 24 * 60 * 60 * 1000;
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
  // Jobs the user marked. They leave the lists and get a tile of their own.
  const MARKS = [
    { key: 'applied', label: 'Applied', badge: '✓ Applied' },
    { key: 'removed', label: 'Removed', badge: '✕ Removed' }
  ];
  const TILES = [...BANDS, ...MARKS];

  const results = new Map(); // jobId -> { score, verdict, reason }
  const failed = new Map(); // jobId -> error message, cleared on Start
  const asked = new Set(); // jobIds already looked up in the cache
  const busy = new Set(); // jobIds being evaluated right now
  const mine = new WeakSet(); // nodes this instance created
  let running = false;
  let looping = false; // the run() loop is active
  let paused = false; // waiting for the tab to come back to the front
  const evals = new Set(); // model calls still in flight
  let nowTitle = '';
  let filter = null; // band key, or null for "everything not hidden"
  let autoNext = false; // carry on to the next page of results when one is done
  let bar = null;
  let jobs = []; // current list: { id, title, row, card }
  let seen = {}; // jobId -> { t, title, company, location } for every list row met in the last day
  let seenLoaded = false;
  let seenTimer = null;
  let marks = {}; // jobId -> { s: 'applied' | 'removed', t, title, company, location }
  const markOf = (id) => (marks[id] ? marks[id].s : '');

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

  // LinkedIn only loads a job into the pane while its tab is in front, so a
  // run waits here whenever the tab is in the background.
  async function inFront() {
    if (!document.hidden) return;
    nowTitle = '';
    paused = true;
    renderBar();
    while (document.hidden) {
      if (!running) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    paused = false;
    if (!running) throw new Stopped();
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

  // --- Next page -----------------------------------------------------------------

  function nextButton() {
    const btn =
      document.querySelector('button[aria-label="View next page"], [data-testid="pagination-controls-next-button-visible"]') ||
      [...document.querySelectorAll('button')].find((b) => norm(b.innerText) === 'Next' && b.offsetParent && !b.closest(OURS));
    return btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true' ? btn : null;
  }

  // Clicks Next and waits for a different set of jobs. False when there is no
  // next page or it did not load.
  async function nextPage() {
    nowTitle = 'Loading the next page…';
    renderBar();
    let btn = nextButton();
    if (!btn && jobs.length) {
      // the newer layout only adds the pager once the list is scrolled to its end
      jobs[jobs.length - 1].row.scrollIntoView({ block: 'end' });
      btn = await until(nextButton, 3000);
    }
    if (!btn) return false;
    const old = new Set(jobs.map((j) => j.id));
    btn.click();
    const loaded = await until(() => {
      const found = readClassicList() || readNewList();
      return !!found && found.jobs.some((j) => j.id && !old.has(j.id));
    }, OPEN_TIMEOUT_MS);
    if (!loaded) return false;
    await new Promise((r) => setTimeout(r, 800)); // let the rest of the list arrive
    scan();
    await loadCached();
    return true;
  }

  // --- Processing --------------------------------------------------------------

  const pending = () => jobs.filter((j) => !results.has(j.id) && !failed.has(j.id) && !busy.has(j.id) && !marks[j.id]);

  // Marks or, when the job already has that mark, clears it.
  function toggleMark(id, state, meta) {
    ask({ type: 'setMark', jobId: id, state: markOf(id) === state ? null : state, meta });
  }

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
      if (!job) {
        // page done: the box is read now, so unticking it mid-run stops here
        if (!autoNext) break;
        const moved = await nextPage().catch(() => false);
        if (!moved) break;
        continue;
      }
      busy.add(job.id);
      try {
        await inFront();
        nowTitle = job.title || `job ${job.id}`;
        renderBar();
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
    if (!pending().length && !(autoNext && nextButton())) return render();
    filter = null; // also closes the results panel, which would cover the pane
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
    const ids = [...new Set([...jobs.map((j) => j.id), ...Object.keys(seen), ...Object.keys(marks)])].filter((id) => !asked.has(id));
    if (!ids.length) return;
    ids.forEach((id) => asked.add(id));
    const res = await ask({ type: 'getEvaluations', jobIds: ids });
    if (!res.ok) return;
    for (const [id, v] of Object.entries(res.data)) results.set(id, v);
    render();
  }

  // --- Jobs seen across pages -------------------------------------------------------

  // Title, company and location of each job as its list row shows them.
  function cardMeta(job) {
    const lines = (job.card.innerText || '')
      .split('\n')
      .map(norm)
      .filter((l) => l && !/^\d{1,3} · /.test(l) && !/^[✓✕]/.test(l)) // not our own score line and buttons
      .filter((l) => !job.title || !l.startsWith(job.title)) // the title, and its "with verification" twin
      .filter((l) => !/^(viewed|promoted|·|easy apply|be an early applicant|dismiss.*|(posted )?.* ago)$/i.test(l));
    return { title: job.title, company: lines[0] || '', location: lines[1] || '' };
  }

  // Records the jobs in the current list so the tiles and the results panel
  // can cover every page visited, not just this one.
  function noteSeen() {
    if (!seenLoaded) return;
    let changed = false;
    for (const job of jobs) {
      const known = seen[job.id];
      if (known && known.title) continue;
      const meta = cardMeta(job);
      if (known && !meta.title) continue; // row still a placeholder
      seen[job.id] = { t: known ? known.t : Date.now(), ...meta };
      changed = true;
    }
    if (!changed) return;
    clearTimeout(seenTimer);
    seenTimer = setTimeout(() => {
      try {
        chrome.storage.local.set({ [SEEN_KEY]: seen });
      } catch (e) {
        /* extension context gone */
      }
    }, 1000);
  }

  function adoptSeen(stored) {
    const cutoff = Date.now() - SEEN_TTL_MS;
    const fresh = {};
    for (const [id, meta] of Object.entries(stored || {})) if (meta && meta.t > cutoff) fresh[id] = meta;
    return fresh;
  }

  async function loadSeen() {
    try {
      const stored = await chrome.storage.local.get([SEEN_KEY, MARKS_KEY]);
      marks = stored[MARKS_KEY] || {};
      seen = adoptSeen(stored[SEEN_KEY]);
    } catch (e) {
      /* extension context gone */
    }
    seenLoaded = true;
    noteSeen();
    render();
    loadCached();
  }

  // Every scored job seen in the last day, best first: [{ id, result, meta }].
  function scored() {
    const ids = new Set([...Object.keys(seen), ...jobs.map((j) => j.id)]);
    return [...ids]
      .filter((id) => results.has(id) && !marks[id])
      .map((id) => ({ id, result: results.get(id), meta: seen[id] || {} }))
      .sort((a, b) => b.result.score - a.result.score);
  }

  // --- Results panel ----------------------------------------------------------------

  let panel = null;
  let panelShows = ''; // what the panel was last built from

  function closePanel() {
    if (panel) panel.remove();
    panel = null;
    panelShows = '';
  }

  // Lists the jobs of the active tile from every page, under the bar.
  function renderPanel() {
    const band = TILES.find((b) => b.key === filter);
    if (!band || !bar || !bar.isConnected) return closePanel();
    const marked = MARKS.includes(band);
    const rows = marked
      ? Object.keys(marks)
          .filter((id) => marks[id].s === band.key)
          .sort((a, b) => marks[b].t - marks[a].t)
          .map((id) => ({ id, result: results.get(id), meta: marks[id] }))
      : scored().filter((s) => bandOf(s.result.score) === band);
    const shows = `${band.key}|${rows.map((r) => `${r.id}:${r.result ? r.result.score : ''}:${r.meta.title || ''}`).join(',')}`;
    if (!panel) {
      panel = el('div', PANEL_CLASS);
      document.body.append(panel);
      panelShows = '';
    }
    // sit directly under the bar, as wide as its contents
    const box = bar.querySelector('.lidist-bar-inner').getBoundingClientRect();
    const top = bar.getBoundingClientRect().bottom;
    panel.style.top = `${Math.round(top)}px`;
    panel.style.left = `${Math.round(box.left)}px`;
    panel.style.width = `${Math.round(box.width)}px`;
    panel.style.maxHeight = `${Math.max(160, Math.round(window.innerHeight - top - 16))}px`;
    if (shows === panelShows) return;
    panelShows = shows;

    const head = el('div', 'lidist-panel-head');
    const count = rows.length === 1 ? '1 job' : `${rows.length} jobs`;
    head.append(
      el(
        'span',
        null,
        marked
          ? `${band.label} · ${count} you marked, newest first`
          : `Score ${band.label} · ${count} from the lists you opened in the last 24 hours`
      )
    );
    const close = el('button', 'lidist-panel-close', '×');
    close.type = 'button';
    close.title = 'Close and clear the filter';
    close.addEventListener('click', () => {
      filter = null;
      render();
    });
    head.append(close);
    const list = el('div', 'lidist-panel-list');
    if (!rows.length) list.append(el('div', 'lidist-panel-empty', 'No jobs in this range yet.'));
    for (const { id, result, meta } of rows) {
      const row = el('a', 'lidist-panel-row');
      row.href = `https://www.linkedin.com/jobs/view/${id}/`;
      row.target = '_blank';
      row.rel = 'noopener noreferrer';
      const badge = el('span', BADGE_CLASS, result ? `${result.score} · ${result.verdict}` : band.badge);
      badge.dataset.verdict = result ? result.verdict : band.key;
      const main = el('span', 'lidist-panel-main');
      main.append(el('span', 'lidist-panel-title', meta.title || `Job ${id}`));
      const sub = [meta.company, meta.location].filter(Boolean).join(' · ');
      if (sub) main.append(el('span', 'lidist-panel-sub', sub));
      if (result && result.reason) main.append(el('span', 'lidist-panel-reason', result.reason));
      const acts = el('span', 'lidist-panel-acts');
      const act = (state, text, title) => {
        const btn = el('button', 'lidist-rowbtn', text);
        btn.type = 'button';
        btn.title = title;
        btn.addEventListener('click', (e) => {
          e.preventDefault(); // the row itself is a link to the job
          e.stopPropagation();
          toggleMark(id, state, meta);
        });
        acts.append(btn);
      };
      if (marked) act(band.key, 'Undo', 'Clear this mark');
      else {
        act('applied', '✓', 'I applied to this job');
        act('removed', '✕', 'Remove from my lists');
      }
      row.append(badge, main, acts);
      list.append(row);
    }
    panel.replaceChildren(head, list);
  }

  // --- Bar ---------------------------------------------------------------------

  function buildBar() {
    const node = el('div', BAR_CLASS);
    const inner = el('div', 'lidist-bar-inner');
    const now = el('div', 'lidist-bar-now');
    const tiles = el('div', 'lidist-bar-tiles');
    for (const band of TILES) {
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
    const auto = el('label', 'lidist-bar-auto');
    auto.title = 'When a page is finished, go to the next page of results and keep scoring';
    const box = el('input');
    box.type = 'checkbox';
    box.checked = autoNext;
    box.addEventListener('change', () => {
      autoNext = box.checked;
      try {
        chrome.storage.sync.set({ bulkAutoNext: autoNext });
      } catch (e) {
        /* extension context gone */
      }
      render();
    });
    auto.append(box, el('span', null, 'Auto next page'));
    inner.append(now, tiles, progress, auto, toggle);
    node.append(inner);
    return node;
  }

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  function renderBar() {
    if (!bar) return;
    const done = jobs.filter((j) => results.has(j.id) || marks[j.id]).length;
    const errors = jobs.filter((j) => failed.has(j.id)).length;
    const now = bar.querySelector('.lidist-bar-now');
    const firstError = errors ? failed.get(jobs.find((j) => failed.has(j.id)).id) : '';
    if (running && paused) setText(now, 'Paused: keep this tab in front, LinkedIn only loads jobs in a visible tab');
    else if (running && nowTitle) setText(now, `Now processing: ${nowTitle}`);
    else if (running) setText(now, 'Starting…');
    else if (errors) setText(now, `${errors} failed: ${firstError}`);
    else if (done === jobs.length && jobs.length) setText(now, 'All jobs in this list are scored');
    else setText(now, 'Score the jobs in this list');
    now.title = now.textContent;
    now.classList.toggle('lidist-bar-error', !running && !!errors);

    const all = scored();
    for (const band of TILES) {
      const tile = bar.querySelector(`.lidist-tile[data-band="${band.key}"]`);
      const marked = MARKS.includes(band);
      const count = marked
        ? Object.values(marks).filter((m) => m.s === band.key).length
        : all.filter((s) => bandOf(s.result.score) === band).length;
      setText(tile.querySelector('.lidist-tile-count'), String(count));
      tile.classList.toggle('lidist-tile-on', filter === band.key);
      tile.classList.toggle('lidist-tile-dim', !!filter && filter !== band.key);
      if (band.key === 'applied') tile.title = `${count} jobs you marked as applied. They are hidden from the lists. Click to see them.`;
      else if (band.key === 'removed') tile.title = `${count} jobs you removed. They are hidden from the lists. Click to see them.`;
      else if (band.key === 'low') tile.title = `${count} scored under 45 and hidden from the lists. Click to see them.`;
      else tile.title = `${count} scored ${band.label} across the lists opened in the last 24 hours. Click to see them.`;
    }

    setText(bar.querySelector('.lidist-bar-count'), `${done}/${jobs.length}`);
    bar.querySelector('.lidist-bar-fill').style.width = jobs.length ? `${Math.round((done / jobs.length) * 100)}%` : '0';
    const toggle = bar.querySelector('.lidist-bar-toggle');
    const left = jobs.length - done;
    setText(toggle, running ? 'Stop' : looping ? 'Stopping…' : errors ? 'Retry' : 'Start');
    toggle.disabled = !running && (looping || (!left && !(autoNext && nextButton())));
    bar.querySelector('.lidist-bar-auto input').checked = autoNext;
    toggle.classList.toggle('lidist-bar-stop', running);
  }

  // --- List rows -----------------------------------------------------------------

  // Under each job title: the score (or mark) and two quick buttons.
  function buildRowbar() {
    const rowbar = el('div', ROWBAR_CLASS);
    const act = (state, text, title) => {
      const btn = el('button', 'lidist-rowbtn', text);
      btn.type = 'button';
      btn.dataset.act = state;
      btn.title = title;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation(); // do not open the job
        const id = rowbar.dataset.id;
        const job = jobs.find((j) => j.id === id);
        toggleMark(id, state, job ? cardMeta(job) : {});
      });
      return btn;
    };
    rowbar.append(
      el('span', BADGE_CLASS),
      act('applied', '✓', 'I applied to this job (click again to undo)'),
      act('removed', '✕', 'Remove from my lists (click again to undo)')
    );
    return rowbar;
  }

  function renderRows() {
    const active = running ? null : filter; // a run needs every row in place
    for (const job of jobs) {
      const result = results.get(job.id);
      const band = result && bandOf(result.score);
      const mark = markOf(job.id);
      // marked jobs only show under their own tile; otherwise hidden are the
      // jobs below the cut-off, or with a filter on everything outside it
      // (unscored jobs included)
      let hide;
      if (mark) hide = active !== mark;
      else if (active) hide = !band || band.key !== active;
      else hide = !!band && band.key === 'low';
      job.row.classList.toggle(HIDDEN_CLASS, hide);
      // the new layout puts a divider after each row; hide it with the row
      const next = job.row.nextElementSibling;
      if (next && next.tagName === 'HR') next.classList.toggle(HIDDEN_CLASS, hide);

      if (!job.anchor) continue; // row not rendered yet; a later scan adds it
      let rowbar = job.card.querySelector(`.${ROWBAR_CLASS}`);
      if (!rowbar) {
        rowbar = buildRowbar();
        job.anchor.after(rowbar);
      }
      rowbar.dataset.id = job.id;
      const badge = rowbar.querySelector(`.${BADGE_CLASS}`);
      const text = mark ? MARKS.find((m) => m.key === mark).badge : result ? `${result.score} · ${result.verdict}` : '';
      setText(badge, text);
      badge.hidden = !text;
      badge.dataset.verdict = mark || (result ? result.verdict : '');
      badge.title = (result && result.reason) || '';
      for (const btn of rowbar.querySelectorAll('.lidist-rowbtn')) btn.classList.toggle('lidist-rowbtn-on', btn.dataset.act === mark);
    }
  }

  function render() {
    renderBar();
    renderRows();
    renderPanel();
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
    closePanel();
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
    noteSeen();
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
    chrome.storage.sync.get({ bulkAutoNext: false }).then((s) => {
      autoNext = !!s.bulkAutoNext;
      render();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.bulkAutoNext) {
        autoNext = !!changes.bulkAutoNext.newValue;
        render();
      }
      if (area !== 'local') return;
      if (changes[MARKS_KEY]) {
        marks = changes[MARKS_KEY].newValue || {};
        render();
        loadCached();
      }
      if (changes[SEEN_KEY]) {
        // another tab added jobs, or the cache was cleared
        const theirs = adoptSeen(changes[SEEN_KEY].newValue);
        seen = changes[SEEN_KEY].newValue ? { ...theirs, ...seen } : {};
        render();
        loadCached();
      }
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

  window.addEventListener('resize', () => panel && renderPanel());
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !panel) return;
    filter = null;
    render();
  });

  loadSeen();
  scan();
})();

// Service worker: resolves origin postcode + job location to coordinates and
// asks a public OSRM server for the driving route. All network calls live here
// so the content script never needs cross-origin access.

const DEFAULTS = { postcode: 'SW1A 1AA', units: 'mi' };
const CLAUDE_DEFAULTS = {
  claudeUrl: 'https://claude.ai/project/01a081ac-eaa4-766b-a8f5-3fb641f7146b',
  claudeAutoSend: true
};
const CLAUDE_PENDING_MS = 2 * 60 * 1000;
const TRIAGE_DEFAULTS = { triageModel: 'openai/gpt-6-luna' };
// The prompt describes the candidate, so it lives in a git-ignored file.
const TRIAGE_PROMPT_FILE = 'triage-prompt.md';
const TRIAGE_BANDS = [
  [85, 'perfect'],
  [70, 'yes'],
  [50, 'maybe'],
  [25, 'no'],
  [0, 'definitely no']
];
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TRAFFIC_TTL_MS = 12 * 60 * 60 * 1000; // Google drive times include traffic, so keep them fresher
const CACHE_PREFIXES = ['origin:', 'geo:', 'route:', 'gplace:', 'groute:', 'triage:', 'bulkSeen'];
const OFFICE_MAX_KM = 60; // an "office" further than this from the advertised town is a wrong match
const ROUTERS = [
  'https://router.project-osrm.org/route/v1/driving/',
  'https://routing.openstreetmap.de/routed-car/route/v1/driving/'
];

function normalizePostcode(pc) {
  return String(pc || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function getSettings() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  const { googleKey } = await chrome.storage.local.get({ googleKey: '' });
  return { postcode: s.postcode || DEFAULTS.postcode, units: s.units || DEFAULTS.units, googleKey: googleKey || '' };
}

async function cached(key, producer, ttl = CACHE_TTL_MS) {
  const hit = (await chrome.storage.local.get(key))[key];
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const v = await producer();
  await chrome.storage.local.set({ [key]: { t: Date.now(), v } });
  return v;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok && res.status !== 404) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

// --- Origin: UK postcode -> coordinates (postcodes.io) ---------------------

async function lookupPostcode(postcode) {
  const pc = normalizePostcode(postcode);
  if (!pc) throw new Error('No origin postcode set');
  const full = await fetchJson(`https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`);
  if (full.status === 200 && full.result) {
    return { lat: full.result.latitude, lon: full.result.longitude, label: full.result.postcode };
  }
  // Allow a bare outcode such as "SW1A".
  const out = await fetchJson(`https://api.postcodes.io/outcodes/${encodeURIComponent(pc)}`);
  if (out.status === 200 && out.result) {
    return { lat: out.result.latitude, lon: out.result.longitude, label: out.result.outcode };
  }
  throw new Error(`Postcode "${postcode}" not found`);
}

function geocodeOrigin(postcode) {
  return cached(`origin:${normalizePostcode(postcode)}`, () => lookupPostcode(postcode));
}

// --- Destination: LinkedIn location text -> coordinates (Nominatim) --------

// "Greater London Area (Hybrid)" -> "London"
function cleanLocation(text) {
  return String(text || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\bGreater\s+/gi, '')
    .replace(/\s+(Metropolitan\s+)?Area\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+,/g, ',')
    .trim()
    .replace(/^,|,$/g, '')
    .trim();
}

// Nominatim allows at most one request per second.
let nominatimQueue = Promise.resolve();
function nominatim(query, ukOnly) {
  const run = async () => {
    const url =
      'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=0' +
      (ukOnly ? '&countrycodes=gb' : '') +
      `&q=${encodeURIComponent(query)}`;
    const data = await fetchJson(url);
    await new Promise((r) => setTimeout(r, 1100));
    return Array.isArray(data) && data.length ? data[0] : null;
  };
  const p = nominatimQueue.then(run, run);
  nominatimQueue = p.catch(() => {});
  return p;
}

// Fallback geocoder (also OpenStreetMap data) for when Nominatim is unavailable.
async function photon(query) {
  const data = await fetchJson(`https://photon.komoot.io/api/?limit=1&lang=en&q=${encodeURIComponent(query)}`);
  const f = data && data.features && data.features[0];
  if (!f) return null;
  const p = f.properties || {};
  return {
    lat: String(f.geometry.coordinates[1]),
    lon: String(f.geometry.coordinates[0]),
    display_name: [p.name, p.county || p.state || p.country].filter(Boolean).join(', ')
  };
}

async function lookupLocation(location) {
  const q = cleanLocation(location);
  if (!q) throw new Error('No location to look up');
  const firstPart = q.split(',')[0].trim();
  const attempts = [
    () => nominatim(q, true),
    () => nominatim(q, false),
    () => nominatim(firstPart, true)
  ];
  let hit = null;
  try {
    for (const attempt of attempts) {
      if ((hit = await attempt())) break;
    }
  } catch (e) {
    hit = await photon(q);
  }
  if (!hit) throw new Error(`Could not find "${q}" on the map`);
  return {
    lat: parseFloat(hit.lat),
    lon: parseFloat(hit.lon),
    label: String(hit.display_name || q).split(',').slice(0, 2).join(',').trim()
  };
}

function geocodeLocation(location) {
  return cached(`geo:${cleanLocation(location).toLowerCase()}`, () => lookupLocation(location));
}

// --- Route: OSRM ------------------------------------------------------------

async function lookupRoute(from, to) {
  const coords = `${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;
  let lastError;
  for (const base of ROUTERS) {
    try {
      const data = await fetchJson(base + coords);
      if (data.code === 'Ok' && data.routes && data.routes.length) {
        return { meters: data.routes[0].distance, seconds: data.routes[0].duration };
      }
      lastError = new Error(data.code === 'NoRoute' ? 'No driving route found' : `Routing error (${data.code})`);
      if (data.code === 'NoRoute') break;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('Routing failed');
}

// --- Optional: Google Maps Platform (only when the user supplied an API key) --

async function googlePost(url, key, fieldMask, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': fieldMask },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || `Google request failed (${res.status})`);
  return data;
}

function distanceKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

// Places Text Search for "Company, Town", biased to the town. Returns null when
// nothing is found near the advertised town.
async function lookupOffice(key, company, location, town) {
  const data = await googlePost(
    'https://places.googleapis.com/v1/places:searchText',
    key,
    'places.displayName,places.formattedAddress,places.location',
    {
      textQuery: `${company}, ${cleanLocation(location)}`,
      pageSize: 1,
      locationBias: { circle: { center: { latitude: town.lat, longitude: town.lon }, radius: 50000 } }
    }
  );
  const place = data.places && data.places[0];
  if (!place || !place.location) return null;
  const office = {
    lat: place.location.latitude,
    lon: place.location.longitude,
    label: (place.displayName && place.displayName.text) || company,
    address: place.formattedAddress || ''
  };
  return distanceKm(office, town) <= OFFICE_MAX_KM ? office : null;
}

async function lookupGoogleRoute(key, from, to) {
  const point = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lon } } });
  const data = await googlePost(
    'https://routes.googleapis.com/directions/v2:computeRoutes',
    key,
    'routes.duration,routes.distanceMeters',
    { origin: point(from), destination: point(to), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE' }
  );
  const route = data.routes && data.routes[0];
  if (!route || route.distanceMeters == null) throw new Error('Google found no driving route');
  return { meters: route.distanceMeters, seconds: parseFloat(route.duration) };
}

async function getRoute(location, company) {
  const { postcode, units, googleKey } = await getSettings();
  const origin = await geocodeOrigin(postcode);
  const town = await geocodeLocation(location);
  const pc = normalizePostcode(postcode);
  let dest = town;
  let office = null;
  let route = null;
  let warning = '';

  if (googleKey) {
    try {
      if (company) {
        office = await cached(`gplace:${company.toLowerCase()}|${cleanLocation(location).toLowerCase()}`, () =>
          lookupOffice(googleKey, company, location, town)
        );
        if (office) dest = office;
      }
      route = await cached(
        `groute:${pc}|${dest.lat.toFixed(4)},${dest.lon.toFixed(4)}`,
        () => lookupGoogleRoute(googleKey, origin, dest),
        TRAFFIC_TTL_MS
      );
    } catch (e) {
      // fall back to the free route below rather than showing nothing
      warning = `Google: ${(e && e.message) || e}`;
    }
  }
  if (!route) {
    route = await cached(`route:${pc}|${dest.lat.toFixed(4)},${dest.lon.toFixed(4)}`, () => lookupRoute(origin, dest));
  }
  return {
    meters: route.meters,
    seconds: route.seconds,
    units,
    origin: origin.label,
    destination: dest.label,
    address: office ? office.address : '',
    precise: !!office,
    warning,
    query: cleanLocation(location)
  };
}

async function clearCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => CACHE_PREFIXES.some((p) => k.startsWith(p)));
  await chrome.storage.local.remove(keys);
  return true;
}

// --- Send to Claude ---------------------------------------------------------

// Loads the project in the Claude tab opened by an earlier send (or a new one
// if that tab is gone) and parks the job text under the tab's id; claude.js
// collects it from there once the page has loaded.
async function sendToClaude(text) {
  const { claudeUrl, claudeAutoSend } = await chrome.storage.sync.get(CLAUDE_DEFAULTS);
  if (!/^https:\/\/claude\.ai\//.test(claudeUrl)) throw new Error('Set a claude.ai URL in settings');
  const pending = { text, autoSend: claudeAutoSend, t: Date.now() };
  const { claudeTabId } = await chrome.storage.session.get('claudeTabId');
  let tab = null;
  const old = claudeTabId != null && (await chrome.tabs.get(claudeTabId).catch(() => null));
  // only take the tab over if it is still showing Claude
  if (old && /^https:\/\/claude\.ai\//.test(old.url || '')) {
    await chrome.storage.session.set({ [`claude:${claudeTabId}`]: pending });
    tab = await chrome.tabs.update(claudeTabId, { url: claudeUrl, active: true }).catch(() => null);
    if (!tab) await chrome.storage.session.remove(`claude:${claudeTabId}`);
  }
  if (!tab) {
    tab = await chrome.tabs.create({ url: claudeUrl });
    await chrome.storage.session.set({ [`claude:${tab.id}`]: pending, claudeTabId: tab.id });
  }
  chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return true;
}

async function takeClaudePending(tabId) {
  const key = `claude:${tabId}`;
  const hit = (await chrome.storage.session.get(key))[key];
  if (!hit) return null;
  await chrome.storage.session.remove(key);
  return Date.now() - hit.t < CLAUDE_PENDING_MS ? hit : null;
}

// --- Evaluate: quick fit score from a cheap model (OpenRouter) ---------------

async function triagePrompt() {
  const res = await fetch(chrome.runtime.getURL(TRIAGE_PROMPT_FILE)).catch(() => null);
  const text = res && res.ok ? (await res.text()).trim() : '';
  if (!text) throw new Error(`${TRIAGE_PROMPT_FILE} is missing`);
  return text;
}

async function lookupTriage(text) {
  const { openRouterKey } = await chrome.storage.local.get({ openRouterKey: '' });
  if (!openRouterKey) throw new Error('Add an OpenRouter key in settings');
  const { triageModel } = await chrome.storage.sync.get(TRIAGE_DEFAULTS);
  const body = {
    model: triageModel || TRIAGE_DEFAULTS.triageModel,
    messages: [
      { role: 'system', content: await triagePrompt() },
      { role: 'user', content: text }
    ],
    response_format: { type: 'json_object' },
    // thinking roughly doubles the wait and did not change the scores in testing
    reasoning: { effort: 'none' }
  };
  const post = async () => {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openRouterKey}`,
        'X-Title': 'LinkedIn Helper'
      },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    const error = !res.ok || data.error ? (data.error && data.error.message) || `OpenRouter failed (${res.status})` : '';
    return { data, error };
  };
  let { data, error } = await post();
  if (/reasoning/i.test(error)) {
    // some models refuse to run with thinking switched off
    delete body.reasoning;
    ({ data, error } = await post());
  }
  if (error) throw new Error(error);
  const reply = String((data.choices && data.choices[0] && data.choices[0].message.content) || '');
  let parsed = {};
  try {
    parsed = JSON.parse((reply.match(/\{[\s\S]*\}/) || [''])[0]) || {};
  } catch (e) {
    /* reported below */
  }
  const score = Math.round(Number(parsed.score));
  if (!(score >= 0 && score <= 100)) throw new Error('Model gave no usable score');
  // the band decides the verdict, so the two can never disagree
  return {
    score,
    verdict: TRIAGE_BANDS.find(([min]) => score >= min)[1],
    reason: String(parsed.reason || '').replace(/\s+/g, ' ').trim().slice(0, 300)
  };
}

async function evaluateJob(jobId, text) {
  const v = await lookupTriage(text);
  if (jobId) await chrome.storage.local.set({ [`triage:${jobId}`]: { t: Date.now(), v } });
  return v;
}

async function getEvaluation(jobId) {
  const key = `triage:${jobId}`;
  const hit = (await chrome.storage.local.get(key))[key];
  return hit && Date.now() - hit.t < CACHE_TTL_MS ? hit.v : null;
}

// Reloading or updating the extension orphans the content script in LinkedIn
// tabs that are already open, which leaves the buttons there dead. Start a
// fresh copy in those tabs so they keep working without a page refresh.
// --- Applied / removed marks ---------------------------------------------------

// One record per job the user marked: { s: 'applied' | 'removed', t, title,
// company, location }. Not part of the cache, so "Clear cache" leaves it alone.
const MARKS_KEY = 'jobMarks';
const MARK_TTL_MS = 180 * 24 * 60 * 60 * 1000; // postings are long gone by then

// Writes go through one queue so two tabs cannot overwrite each other.
let markQueue = Promise.resolve();
function setMark(jobId, state, meta) {
  const run = async () => {
    const all = (await chrome.storage.local.get(MARKS_KEY))[MARKS_KEY] || {};
    const cutoff = Date.now() - MARK_TTL_MS;
    for (const id of Object.keys(all)) if (!all[id] || all[id].t < cutoff) delete all[id];
    if (state === 'applied' || state === 'removed') {
      const old = all[jobId] || {};
      all[jobId] = {
        s: state,
        t: Date.now(),
        title: String(meta.title || old.title || '').slice(0, 200),
        company: String(meta.company || old.company || '').slice(0, 200),
        location: String(meta.location || old.location || '').slice(0, 200)
      };
    } else {
      delete all[jobId];
    }
    await chrome.storage.local.set({ [MARKS_KEY]: all });
    return true;
  };
  const done = markQueue.then(run, run);
  markQueue = done.catch(() => {});
  return done;
}

// Stored scores for a batch of jobs, as { jobId: result }.
async function getEvaluations(jobIds) {
  const keys = jobIds.map((id) => `triage:${id}`);
  const hits = await chrome.storage.local.get(keys);
  const out = {};
  for (const [key, hit] of Object.entries(hits)) {
    if (hit && Date.now() - hit.t < CACHE_TTL_MS) out[key.slice(7)] = hit.v;
  }
  return out;
}

chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' }).catch(() => []);
  for (const tab of tabs) {
    const target = { tabId: tab.id };
    chrome.scripting.insertCSS({ target, files: ['content.css'] }).catch(() => {});
    chrome.scripting.executeScript({ target, files: ['content.js', 'bulk.js'] }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  let work;
  if (msg.type === 'getRoute') work = getRoute(msg.location, msg.company || '');
  else if (msg.type === 'validatePostcode') work = lookupPostcode(msg.postcode);
  else if (msg.type === 'clearCache') work = clearCache();
  else if (msg.type === 'sendToClaude') work = sendToClaude(String(msg.text || ''));
  else if (msg.type === 'evaluateJob') work = evaluateJob(String(msg.jobId || ''), String(msg.text || ''));
  else if (msg.type === 'getEvaluation') work = getEvaluation(String(msg.jobId || ''));
  else if (msg.type === 'getEvaluations') work = getEvaluations((msg.jobIds || []).map(String));
  else if (msg.type === 'setMark' && msg.jobId) work = setMark(String(msg.jobId), msg.state, msg.meta || {});
  else if (msg.type === 'takeClaudePending') work = takeClaudePending(sender.tab && sender.tab.id);
  else return false;
  work.then(
    (data) => sendResponse({ ok: true, data }),
    (err) => sendResponse({ ok: false, error: (err && err.message) || String(err) })
  );
  return true; // keep the channel open for the async response
});

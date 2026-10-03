# LinkedIn Job Distance

A Chrome extension that adds a map pin after the location of the job you have open on LinkedIn. Hover or
click the pin to see the driving distance and drive time from your home postcode.

Personal-use tool, loaded unpacked. It is not published to the Chrome Web Store (see
[Why it is not published](#why-it-is-not-published)).

## What it does

- Adds a red pin after the location in the job detail pane, e.g. `Bolton, England, United Kingdom 📍`.
- Hovering shows a popover; clicking keeps it open until you click elsewhere or press Esc.
- The popover shows distance, drive time, where the route ends, and a link to the same route in Google Maps.
- Country-only locations (`United Kingdom`, `England, United Kingdom`, `United Kingdom (Remote)`) get no pin.
- Job cards in the results list get no pin; only the open job does.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.
3. Refresh any LinkedIn tab that was already open, then click a job.

After changing any file, click the reload button on the extension's card and refresh the LinkedIn tab.

## Settings

Click the extension's toolbar icon.

| Setting | Default | Notes |
| --- | --- | --- |
| Origin postcode (UK) | `SW1A 1AA` | Validated against postcodes.io on save. A bare outcode such as `SW1A` also works. |
| Distance units | Miles | Miles or kilometres. |
| Google Maps API key | empty | Optional; see below. Stored in `chrome.storage.local` on this machine only. |

**Clear cache** removes stored lookups but keeps your settings and key.

## Two modes

### Free (no key)

- Routes to the **town centre** of the advertised location.
- Drive time has **no live traffic**.
- Uses postcodes.io, Nominatim (Photon as fallback) and the public OSRM server.

### With a Google Maps API key

- Looks up `Company, Town` with Places API (New). If a match is found within 60 km of the advertised
  town, the route ends at that **office address**, which the popover shows.
- Otherwise it routes to the town centre.
- Drive time comes from Routes API and is **traffic-aware**.
- If Google returns an error, the popover shows the free result plus Google's message in red.

Each job opened costs at most one Places call and one Routes call. Office lookups are cached for 30 days,
Google drive times for 12 hours, everything else for 30 days.

#### Getting a key

1. In [Google Cloud Console](https://console.cloud.google.com/), pick a project with billing linked.
2. **APIs & Services → Library**: enable **Places API (New)** and **Routes API**.
3. **APIs & Services → Credentials → Create credentials → API key**.
4. Edit the key: restrict it to those two APIs; leave application restrictions as **None**.
5. Optionally cap daily quota for both APIs under **Quotas**.
6. Paste the key into the extension popup and save. Never put it in this folder.

## How it works

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V3 definition, host permissions for the lookup services. |
| `content.js` | Runs on linkedin.com. Finds the location line, inserts the pin, renders the popover. |
| `content.css` | Pin and popover styles. |
| `background.js` | Service worker. Does all network calls and caching. |
| `options.html`, `options.js` | Settings popup. |
| `icons/` | Toolbar and store icons. |

### Finding the location line

LinkedIn's class names are obfuscated and change, so `content.js` does not rely on them. It looks for
text such as "2 days ago" or "25 applicants", climbs to the smallest element whose text contains `·`
separators, and takes the first segment as the location. Elements inside list cards, links, buttons and
navigation are skipped. A `MutationObserver` re-runs the scan as LinkedIn swaps jobs without a page load.

The company name comes from the nearest `/company/` link above the location line.

### Lookup flow

1. Origin postcode → coordinates (postcodes.io).
2. Job town → coordinates (Nominatim, UK first, then worldwide; Photon if Nominatim fails).
3. With a key: company office → coordinates (Places API), then route (Routes API).
4. Otherwise, or if Google fails: route from OSRM.

## Troubleshooting

- **No pin on a page that was already open:** refresh the tab; Chrome only injects extensions into pages
  loaded after install or reload.
- **"Extension was reloaded — refresh this page":** do that.
- **Red "Google: …" line:** the message is Google's. Usual causes are an API not enabled, billing not
  linked, or key restrictions not yet applied (allow 5 minutes).
- **No pin on any job:** LinkedIn has probably changed its page structure; the heuristics in
  `findByText` in `content.js` need adjusting.

## Why it is not published

- LinkedIn's User Agreement prohibits modifying the appearance of its site, which adding a pin does.
- The public Nominatim and OSRM servers are for light personal use, not for an app with many users.

## Data sources

Map data © OpenStreetMap contributors. Postcode data from postcodes.io. Optional office lookup and
traffic-aware routing from Google Maps Platform.

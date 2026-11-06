# 🛠️ Developer Guide

Want to hack on the source? Here's everything you need.

## Setup

```bash
git clone https://github.com/BuenaIA/network-capture-extension.git
cd network-capture-extension
```

There is **no `npm install`** — there are no npm dependencies, no build step, no bundler. Edit a file, click ↻ on the extension card, refresh the page. That's the whole loop.

## The dev loop (10 seconds per iteration)

1. Edit a file
2. `chrome://extensions` → ↻ on the **Network Capture Extension** card
3. Reopen the popup or refresh the captured page
4. Watch logs in:
   - **Service worker logs** — `chrome://extensions` → "Inspect views: service worker"
   - **Popup logs** — right-click the popup → Inspect → Console
   - **Offscreen logs** — `chrome://extensions` → "Inspect views: offscreen.html"
   - **Panel logs** — open the panel → F12

## Code map

```
manifest.json        → permissions + entry points
background.js        → service worker (state, CDP, message routing)
  ├─ debugger.onEvent  → captures CDP events
  ├─ message router    → handles popup/panel actions
  ├─ finalize()        → closes a request and hands it to the offscreen store
  ├─ ensureOffscreen() → lazy-spawns offscreen doc
  └─ downloadAll()     → orchestrates the export flow

crawl.js             → "Capture whole site" (loaded by importScripts)
  ├─ acceptLink() / linksToQueue() → pure link policy (unit tested)
  ├─ FORM_GUARD        → script that makes forms impossible to submit
  └─ startCrawl() / runCrawl() / finishCrawl()

offscreen.js         → the capture (in memory) + streaming exports
  ├─ store             → finished requests, kept in memory
  ├─ harParts() / csvParts() / indexHtmlParts() → generators of file pieces
  ├─ layoutFor()       → where each request goes inside the ZIP
  └─ buildBlob()       → returns blob URL to background

zip.js               → custom STORE-method ZIP writer
popup.html/css/js    → toolbar popup
panel.html/js        → full panel + DevTools panel
devtools.html/js     → DevTools panel registration
```

## Adding a new export format

Say you want to add a Markdown export. Three changes:

1. **`offscreen.js`** — add a generator that yields the file in pieces and register it in `FORMATS`:
   ```js
   function* mdParts(entries, meta) {
     yield '# Capture\n\n';
     for (const e of entries) yield `- ${e.method} ${e.url}\n`;
   }
   const FORMATS = { /* … */ md: { mime: 'text/markdown', ext: 'md', parts: mdParts } };
   ```
2. **`popup.html`** — add a button:
   ```html
   <button id="dlMd" class="btn">⬇ Markdown</button>
   ```
3. **`popup.js`** — wire it:
   ```js
   ui.dlMd.addEventListener('click', () => doDownload('md'));
   ```

Done. (Mirror the same in `panel.html` / `panel.js` if you want it in the full panel too.)

## Adding a new background message type

1. Pick a unique `type` constant — convention: SCREAMING_SNAKE_CASE
2. Add a `case` in the `chrome.runtime.onMessage.addListener` switch in `background.js`
3. Call `sendResponse({ ok: true, ... })` (or throw — the catch wraps it as `{ok:false,error:…}`)
4. Add `handlers: [...]` entry so popup's stale-SW check still passes
5. Call from popup/panel via `await send('YOUR_TYPE', { ...data })`

## Debugging tips

| Symptom | First thing to check |
|---|---|
| Popup says "Stale SW — reload" | Click ↻ on the extension card |
| `unknown message type X` | Same — your SW is old |
| Downloads fail silently | Inspect offscreen.html → check console |
| No requests captured | Was the yellow CDP bar visible? Was DevTools open on the same tab? |
| Response body missing | Some CDN/bigfile responses are too big for `Network.getResponseBody` — check `responseBodyError` field |

## Style conventions

- 2-space indent, single quotes, no semicolons skipped — match what's already there
- Avoid frameworks. Vanilla JS is the project's identity.
- Keep `background.js` and `offscreen.js` strict-mode compatible (they already are by default in MV3)
- Minimal comments — only when *why* isn't obvious from *what*

## Tests

There are no automated tests yet (PRs welcome — see [[Roadmap]]). Manual smoke test before submitting a PR:

1. Load unpacked
2. Capture 50+ requests from any SPA
3. Pause / resume / clear
4. Export ZIP — open `index.html`, click 5 random rows, confirm bodies render
5. Export HAR — drop into Chrome DevTools → import → confirm requests show with bodies
6. Export CSV — open in a spreadsheet — column count matches header
7. Clear cookies + Hard reload — confirm cookies are gone and page re-fetches all assets

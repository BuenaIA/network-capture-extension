# 🧠 How It Works

A guided tour of the architecture, from "user clicks Start" to "ZIP lands in Downloads."

## 🏗 Architecture diagram

```
┌─────────────────────┐         ┌─────────────────────┐
│   Popup / Panel /   │ ◀─msg─▶ │  Service Worker     │
│   DevTools UI       │         │  (background.js)    │
└─────────────────────┘         └──────────┬──────────┘
                                           │
                                  attach   │  Network.* events
                                           ▼
                                ┌─────────────────────┐
                                │  Captured Tab       │
                                │  (Chrome DevTools   │
                                │   Protocol target)  │
                                └─────────────────────┘
                                           ▲
                                           │
                                  storage  │  download via blob URL
                                           │
                                ┌──────────┴──────────┐
                                │  Offscreen Document │
                                │  (offscreen.js)     │
                                │  builds ZIP/HAR/CSV │
                                └─────────────────────┘
```

## 🎬 What happens when you press Start

1. Popup → background: `{type: 'START'}`
2. Background calls `chrome.debugger.attach({tabId}, '1.3')`
3. Chrome shows the yellow "is being debugged" bar — required by Chrome's security policy
4. Background calls `Network.enable` with bigger buffers (50 MB per resource / 200 MB total)
5. State flips to `capturing: true`, badge becomes **REC**, and the offscreen document starts pinging the service worker so it is not evicted

## 📡 What happens during a request

The CDP fires events in this order:

| CDP event | What we save |
|---|---|
| `Network.requestWillBeSent` | URL · method · request headers · post body · initiator · resource type · parsed query params |
| `Network.requestWillBeSentExtraInfo` | Full headers (incl. Cookie), associated cookies, connect timing |
| `Network.responseReceived` | Status · response headers · MIME · remote IP · protocol · timing |
| `Network.responseReceivedExtraInfo` | Final headers, blocked cookies, partition key, raw header text |
| `Network.loadingFinished` | Encoded data length · then we call `Network.getResponseBody` to fetch the body |
| `Network.loadingFailed` | Error text, blocked reason, CORS error |

Each event merges into one entry keyed by CDP `requestId`; header sets from the basic and "extra info" events are merged into a single object. A redirect reuses the `requestId`, so the answered leg is stored as its own record (`<id>~1`) before the next leg starts. When a request finishes (or fails) its body is read, empty fields are dropped, and the clean record is handed to the offscreen document. Nothing is written to disk.

## 💾 Why an offscreen document holds the capture

Two Manifest V3 limits meet here. The **service worker is evicted after ~30 s without events**, so it cannot be the only owner of a capture. And it **cannot create `blob:` URLs**, which `chrome.downloads.download` needs.

Solution: an [offscreen document](https://developer.chrome.com/docs/extensions/reference/api/offscreen) registered with `reasons: ['BLOBS']`. It does not get evicted, so it keeps every finished request **in memory**, and it builds the export from that same memory — nothing has to be transferred. It replies to background with a `blob:` URL; background calls `chrome.downloads.download({ url, filename })` and asks offscreen to revoke the URL as soon as the download completes or is interrupted (and the offscreen document revokes it on its own after 30 min if the service worker was evicted in between).

## 🗜 The ZIP writer

To stay dependency-free we ship a small **STORE-method** (no compression) **streaming** ZIP writer in [zip.js](../zip.js). Each file is written as its pieces are produced, and its CRC and sizes go in a data descriptor after the data, so the archive never exists as one buffer. Every export format is a generator of small pieces that goes straight into a `Blob`, so no string or buffer ever has the size of the whole capture. It implements:

- Local file headers (`0x04034b50`) and data descriptors (`0x08074b50`)
- Central directory headers (`0x02014b50`) and the end-of-central-directory record (`0x06054b50`)
- Zip64 records (more than 65,534 files or more than 4 GiB of archive)
- Incremental CRC32, DOS time/date encoding, UTF-8 filenames (flag bit 11)

It produces ZIPs that unzip in every tool I've tested (Windows Explorer, macOS Finder, 7-Zip, `unzip`, `jar`, browsers' download viewers).

## 🔄 Persistence across SW eviction

MV3 service workers are evicted after ~30 s idle. We handle it in three layers:

1. **The data is not in the service worker.** Finished requests live in the offscreen document; the worker only persists a few settings (about 200 bytes) in `chrome.storage.local`.
2. **While capturing, the offscreen document pings the worker every 20 s**, so it is normally not evicted at all.
3. **If it is evicted anyway**, on startup the worker asks the offscreen document what it holds and checks with `chrome.debugger.getTargets()` whether the debugger is still attached. If it is, the capture simply continues; if not, the capture is marked as ended.

The capture lives as long as the browser is open: closing the browser (or reloading the extension) discards it, so export before you quit. Older versions kept the whole capture in `chrome.storage.local`; that data is removed the first time this version starts.

## 🧯 What happens at the limits

- **Stop / tab closed / debugger banner dismissed:** bodies still being read are waited for (up to 5 s); requests that never finished are kept and marked `incomplete`.
- **Memory:** response bodies are kept up to 1 GiB per capture. After that, requests are still recorded without their body, the popup shows how many were skipped, and `site-schema.md` lists the reason.
- **DevTools cache:** if Chrome has already evicted a body (`evicted from inspector cache`), the request is kept and the reason is recorded.
- **A single body near 64 MiB:** too big for one extension message, so the request is stored without that body.

## 🧩 File responsibilities

| File | Lines | Responsibility |
|---|---:|---|
| `manifest.json` | 30 | MV3 declaration, permissions, entry points |
| `background.js` | 640 | CDP attach/detach, event handler, closing each request, settings persistence, message router, downloads orchestration, browsingData |
| `offscreen.js` | 500 | The in-memory capture, ZIP/HAR/CSV/JSON generators, blob creation |
| `common.js` | 30 | Helpers shared by the service worker and the offscreen document |
| `offscreen.html` | 4 | Minimal host for offscreen scripts |
| `zip.js` | 170 | Streaming STORE-method ZIP writer with zip64 |
| `popup.html / .css / .js` | 350 | Compact toolbar UI |
| `panel.html / .js` | 270 | Full split-view UI (also serves as DevTools panel) |
| `devtools.html / .js` | 10 | Registers the DevTools tab |

# 🔑 Permissions Explained

The full list, with the *exact* reason each one exists.

| Permission | Why we need it | Could we drop it? |
|---|---|---|
| `debugger` | The only API that returns full response bodies (via `Network.getResponseBody`). The whole project depends on this. | No — this is the core. |
| `<all_urls>` | Lets the debugger attach to whichever tab you choose to capture. | Only by replacing it with `activeTab`, which is more limited. |
| `storage` | Keeps a few settings (about 200 bytes: whether a capture is running, its tab and start time) so a service worker that was evicted can pick the capture up again. The requests themselves are **not** stored here. | Only by losing that recovery. |
| `downloads` | Saves your ZIP / JSON / HAR / CSV files to disk. | No — alternative is right-click → Save As, which is a worse UX. |
| `tabs` | Reads the URL of the captured tab so we know what site you're on (for the "Target site" row and the export file name). | Not without losing that context after switching windows. |
| `browsingData` | Powers the **Clear cookies** and **Clear cache** buttons (origin-scoped). | Only by removing those buttons. |
| `offscreen` | Holds the capture in memory (the service worker is evicted, the offscreen document is not) and creates the blob URLs for downloads, which service workers can't. | No — without it, there is no place to keep the capture and downloads can't work. |

Version 1.0.2 removed `cookies`, `scripting`, `webNavigation`, `activeTab` and `unlimitedStorage`: none of them was used.

## What we deliberately do **not** ask for

- ❌ `webRequest` / `webRequestBlocking` — we use CDP instead, which gives us bodies
- ❌ `nativeMessaging` — no native binaries
- ❌ `notifications` — no popups
- ❌ `clipboardWrite` — copy buttons would only need short-term clipboard access; we don't have any
- ❌ `unlimitedStorage` — captures are not stored in browser storage at all; they live in memory

## What you should sanity-check before installing any extension that asks for `debugger`

The `debugger` permission is **powerful** — it can read and modify everything on the captured page. Always:

1. Check that the source code is open and matches what's loaded
2. Verify the network tab in `chrome://extensions → Inspect views: service worker` shows no outgoing requests to remote hosts
3. Look for `fetch(` / `XMLHttpRequest` / `WebSocket` / `navigator.sendBeacon` calls in the background script — there should be **none** here

This extension is open source precisely so you can verify all of the above.

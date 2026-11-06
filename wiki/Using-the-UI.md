# 🔍 Using the UI

The extension ships with **three** different surfaces. They share the same backend — pick whichever fits the moment.

## 1. Toolbar popup
Compact, always-on-top, perfect for quick captures.

| Section | What it does |
|---|---|
| **Status bar** | Shows `Idle / Recording / Paused` and the version badge |
| **Stats** | Live request count, elapsed timer, total bytes, start time |
| **Controls** | `● Start` · `‖ Pause` · `■ Stop` · `Clear` |
| **Capture whole site** | One click: visits the pages of the current site in a new window and downloads the ZIP. Options for pages, depth, links per page and menus. See below |
| **Download** | `⬇ ZIP` · `⬇ JSON` · `⬇ HAR` · `⬇ CSV` |
| **Target site** | URL + buttons: `Open / focus tab` · `Reload` · `Hard reload` · `Clear cookies` · `Clear cache` |
| **Filter bar** | Text filter + type dropdown + method dropdown |
| **Live list** | Latest 200 requests; click any row to expand its JSON |

### Capture whole site
Click **Capture whole site** while the site you want is the active tab. After a confirmation (it names the site, says forms are never submitted, and warns if it will replace a capture you have not exported) the extension:

1. opens a **new window** and starts recording — your own tab is not touched;
2. visits the pages of the same origin **with your browser session**, opening hover and click menus on the way;
3. shows a **progress window**: pages visited and queued, requests, data, elapsed time, the page being visited and the last pages visited. Close it any time; **Show crawl progress** brings it back and the crawl keeps going;
4. stops the capture and **downloads the ZIP**, which includes `site-schema.md` with the map of the pages.

In the progress window, **Stop and save** ends early and keeps what was visited; **Cancel and discard** throws everything away. Closing the crawl window by hand, or pressing **Stop** in the popup, also saves what was captured.

**Forms are never submitted.** The crawl does not click inside forms, cancels every `submit` event, and neutralises `form.submit()` and `requestSubmit()` in every page and iframe before the page's own scripts run. It also skips logout and delete links and links with `data-method` other than GET. The progress window counts the submissions it blocked.

## 2. Full panel (`Open full panel ↗`)
Splits the screen 50/50 — left list, right detail. Detail has tabs:

- **Overview** — URL, method, status, MIME, remote IP, timings, bytes
- **Request** — headers, query params, post body (raw + parsed)
- **Response** — headers, timing, security details
- **Cookies** — request cookies, `Set-Cookie` (parsed), blocked cookies
- **Body** — raw response body (or first 80 KB if huge)
- **Raw** — the entire entry as JSON, copy-pasteable

This is the best surface for digging deep into a single request.

## 3. DevTools panel
Open Chrome DevTools (F12) → switch to the **Network Capture** tab. Same controls, but lives next to the Elements / Console / Network tabs you already use.

⚠️ **Note** — only one debugger client per tab. If you open DevTools' Network panel, *that* takes the slot. Capture from a separate window, or use the popup/full-panel UIs instead.

---

## Filtering rules
The filter input matches against `method + url + status + mime` (case-insensitive substring). Combined with the type and method dropdowns. Examples:

| Filter text | Matches |
|---|---|
| `login` | any URL containing "login" |
| `400` | any status starting with 400-something |
| `json` | any response with `application/json` MIME |
| `api.example.com` | only that host |
| `POST` (in dropdown) | only POST requests |

## Status colour coding
- 🟢 `2xx` — green
- 🟡 `3xx` — yellow
- 🔴 `4xx` / `5xx` / failed — red
- ⚪ `…` — pending (response not received yet)

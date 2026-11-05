# 📦 Export Formats

You can export the same capture in four formats. Pick the one that matches your downstream tool.

## ⬇ ZIP — full archive (recommended)
The **richest** export. One archive contains everything you could ever want:

```
network_capture_<dominio>_<timestamp>.zip
├─ index.html                   ← browsable table, links to every request, body and POST
├─ site-schema.md / .json       ← map of the capture: pages, hosts, statuses, types, endpoints
├─ summary.json                 ← capture metadata (start, end, bytes, tab, bodies skipped)
├─ capture.har                  ← HAR 1.2 with bodies — open in DevTools/Postman
├─ capture.csv                  ← one row per request, for spreadsheets
├─ cookies/{request,response}_cookies.json ← every cookie, parsed
├─ requests/<host>/<NNNNN>_<METHOD>_<status>_<path>.json   ← one clean record per request
├─ bodies/<host>/<NNNNN>_<path>.<ext>                       ← response bodies as received
└─ post_data/<host>/<NNNNN>_<path>.txt                      ← request bodies, if any
```

Each record in `requests/` is grouped and has no empty fields: `request` (method, URL, query, headers, cookies, body), `response` (status, headers, cookies, server, cache, security, a reference to the body file), `timing`, `page` (the crawl page that triggered it) and `redirectTo` for redirects. Every hop of a redirect chain is its own record. Bodies are not duplicated: they live in `bodies/` (and in the HAR, which is a standard format).

**Best for:** bug reports, archives, sharing with teammates.

## ⬇ JSON
A single `.json` file with `{ meta, requests: [...] }`. The records have the same clean structure as the files in `requests/` inside the ZIP, with the bodies inline.

**Best for:** scripts (`jq`, Python `json.load`, Node), AI tooling, custom dashboards.

## ⬇ HAR
A **standard HTTP Archive 1.2** file. Drop it into:

- Chrome DevTools → Network → 🔼 *Import HAR*
- Firefox DevTools → Network → 📁 *Import*
- **Postman** → File → Import → choose the .har → instant collection
- **Charles Proxy** / **Insomnia** / **Fiddler** / **Paw**
- Online HAR viewers like [HAR Analyzer](https://toolbox.googleapps.com/apps/har_analyzer/)

Includes response bodies (text + base64 for binary).

**Best for:** team handoff, replay in DevTools-class tools, perf analysis.

## ⬇ CSV
A flat row-per-request summary:

```
#,time,method,status,type,host,path,duration_ms,bytes,mime,remote,request_cookies,response_set_cookies,url
1,2026-04-28T14:02:33.000Z,GET,200,Document,example.com,/,123,4521,text/html,93.184.216.34:443,sid=abc; theme=dark,session_id=…,https://example.com/
```

**Best for:** Excel, Google Sheets, quick stats, pivot tables.

---

## Comparison cheat-sheet

| Need | Use |
|---|---|
| Send to a teammate, capture-as-evidence | **ZIP** |
| Replay in DevTools, Postman, Charles | **HAR** |
| Pipe through `jq` / Python / AI | **JSON** |
| Spreadsheet, charts, KPIs | **CSV** |
| All of the above | **ZIP** (it includes HAR + CSV + JSON inside) |

## File naming
All exports use ISO-8601 timestamps so they sort lexicographically:

```
network_capture_buenaia.ai_2026-04-28T14-02-33-512Z.zip
network_capture_buenaia.ai_2026-04-28T14-02-33-512Z.har
…
```

You can change the destination folder in `chrome://settings/downloads`.

// Offscreen document: holds the captured requests in memory and builds the exports.
//
// Why here: the service worker is evicted after ~30 s without events, while this document
// stays open, so the capture survives. Nothing is written to disk or to any browser storage.
//
// Exports are streamed: every format is a generator of small text or byte pieces, and the
// pieces go straight into a Blob. No export ever builds a string or buffer the size of the
// whole capture, so the size of a capture is limited by memory and not by V8's string limit.

const enc = new TextEncoder();

// ---------- the capture ----------

const store = [];          // finished requests, in the order they were stored
const byId = new Map();
let bodyBytes = 0;
let maxSeq = 0;

function storeEntry(entry) {
  const previous = byId.get(entry.id);
  if (previous) {
    store[store.indexOf(previous)] = entry;
    bodyBytes -= (previous.responseBody || '').length;
  } else {
    store.push(entry);
  }
  byId.set(entry.id, entry);
  bodyBytes += (entry.responseBody || '').length;
  maxSeq = Math.max(maxSeq, entry.seq || 0);
}

function clearStore() {
  store.length = 0;
  byId.clear();
  bodyBytes = 0;
  maxSeq = 0;
}

// The list in the UI shows the newest requests; this keeps the message far below 64 MiB
const MAX_LISTED = 20000;

function listSummaries() {
  const newest = store.length > MAX_LISTED ? store.slice(store.length - MAX_LISTED) : store;
  return newest.map(NCP.summarize);
}

// ---------- names ----------

function safe(s, n = 80) {
  return String(s ?? '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, n) || 'x';
}
function pad(i, w) { return String(i).padStart(w, '0'); }

function extFromMime(mime, ct) {
  const m = (mime || ct || '').toLowerCase();
  if (m.includes('json')) return 'json';
  if (m.includes('html')) return 'html';
  if (m.includes('xml'))  return 'xml';
  if (m.includes('javascript')) return 'js';
  if (m.includes('css'))  return 'css';
  if (m.includes('plain')) return 'txt';
  if (m.includes('png'))  return 'png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('gif'))  return 'gif';
  if (m.includes('webp')) return 'webp';
  if (m.includes('svg'))  return 'svg';
  if (m.includes('pdf'))  return 'pdf';
  if (m.includes('font') || m.includes('woff')) return 'woff';
  if (m.includes('octet')) return 'bin';
  return 'bin';
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function isBase64(text) {
  return text.length % 4 === 0 && BASE64.test(text);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function csvEscape(s) {
  if (s === null || s === undefined) return '';
  const v = String(s);
  if (/[",\n\r]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

// Size of a stored body: bytes for binary content, characters for text
function bodySize(e) {
  if (!e.responseBody) return undefined;
  return e.responseBase64Encoded ? Math.floor(e.responseBody.length * 3 / 4) : e.responseBody.length;
}

// ---------- where each request goes inside the ZIP ----------
//
//   requests/<host>/<number>_<METHOD>_<status>_<path>.json    one clean record per request
//   bodies/<host>/<number>_<path>.<ext>                        the response body as received
//   post_data/<host>/<number>_<path>.txt                       the request body, if it had one

function folderFor(e) {
  const host = safe(e.hostname || 'unknown', 60);
  return e.port ? `${host}_${e.port}` : host;
}

function slugFor(e) {
  const raw = (e.pathname || '/').replace(/^\/+|\/+$/g, '') || 'root';
  return safe(raw.replace(/\//g, '_'), 80);
}

function layoutFor(e, number) {
  const folder = folderFor(e);
  const slug = slugFor(e);
  const id = pad(number, 5);
  const status = e.failed ? 'ERR' : (e.responseStatus || 'pending');

  let body = null, binary = false;
  if (e.responseBody) {
    const ext = extFromMime(e.responseMimeType, (e.responseHeaders && (e.responseHeaders['content-type'] || e.responseHeaders['Content-Type'])) || '');
    binary = !!e.responseBase64Encoded && isBase64(e.responseBody);
    // A body flagged as base64 that is not valid base64 is kept as text instead of dropped
    body = `bodies/${folder}/${id}_${slug}.${e.responseBase64Encoded && !binary ? ext + '.b64' : ext}`;
  }
  return {
    json: `requests/${folder}/${id}_${safe(e.method || 'GET', 8)}_${status}_${slug}.json`,
    body,
    bodyBinary: binary,
    post: e.postData ? `post_data/${folder}/${id}_${slug}.txt` : null
  };
}

// ---------- the clean record of one request ----------

function bodyReference(e, files) {
  if (!e.responseBody && !e.responseBodyError) return undefined;
  const inline = !files;
  const asText = e.responseBase64Encoded && (inline || !files.bodyBinary);
  return NCP.compact({
    file: files && files.body,
    encoding: asText ? 'base64' : undefined,
    data: inline ? e.responseBody : undefined,
    size: bodySize(e),
    error: e.responseBodyError
  });
}

// `files` is the layout inside a ZIP; without it (single-file JSON) bodies are written inline
function exportRecord(e, number, files, page) {
  const inline = !files;
  return NCP.compact({
    number,
    id: e.id,
    time: new Date(e.capturedAt || 0).toISOString(),
    page,
    request: NCP.compact({
      method: e.method,
      url: e.url,
      host: e.hostname,
      path: e.pathname,
      query: e.queryParams,
      resourceType: e.resourceType,
      initiator: e.initiator && NCP.compact(e.initiator),
      documentUrl: e.documentUrl,
      headers: e.requestHeaders,
      cookies: e.requestCookies,
      blockedCookies: e.blockedRequestCookies,
      body: e.postData ? NCP.compact({
        file: files && files.post,
        text: inline ? e.postData : undefined,
        json: e.postDataJson,
        form: e.postDataForm
      }) : undefined
    }),
    response: NCP.compact({
      status: e.responseStatus,
      statusText: e.responseStatusText,
      mimeType: e.responseMimeType,
      headers: e.responseHeaders,
      cookies: e.responseCookies,
      blockedCookies: e.blockedCookies,
      remoteAddress: e.remoteAddress,
      protocol: e.protocol,
      fromCache: e.fromCache,
      security: e.securityDetails || e.securityState,
      body: bodyReference(e, files)
    }),
    timing: NCP.compact({
      durationMs: e.duration === undefined ? undefined : Math.round(e.duration),
      details: e.responseTiming
    }),
    transferredBytes: e.encodedDataLength,
    redirectTo: e.redirectTo,
    failed: e.failed,
    error: NCP.compact({ text: e.errorText, canceled: e.canceled, blockedReason: e.blockedReason, cors: e.corsErrorStatus }),
    incomplete: e.incomplete,
    websocket: e.frames ? NCP.compact({ frames: e.frames, framesDropped: e.framesDropped }) : undefined
  });
}

// ---------- pages of a crawl ----------

// Index of the crawl page that was open at `time` (pages are in visit order), or -1
function pageIndexAt(pages, time) {
  let found = -1;
  for (let i = 0; i < pages.length; i++) {
    if (pages[i].startedAt <= time) found = i;
    else break;
  }
  return found;
}

function pageResolver(meta) {
  const pages = (meta.crawlReport && meta.crawlReport.pages) || [];
  return time => {
    const i = pageIndexAt(pages, time || 0);
    return i >= 0 ? pages[i].url : undefined;
  };
}

// ---------- sink: collects the Blob without holding every piece in one array ----------

const SINK_FLUSH_BYTES = 16 * 1024 * 1024;

class BlobSink {
  constructor(type) {
    this.type = type;
    this.blobs = [];
    this.pending = [];
    this.pendingBytes = 0;
  }
  write(part) {
    this.pending.push(part);
    this.pendingBytes += typeof part === 'string' ? part.length : part.byteLength;
    if (this.pendingBytes >= SINK_FLUSH_BYTES) this.flush();
  }
  flush() {
    if (!this.pending.length) return;
    this.blobs.push(new Blob(this.pending));
    this.pending = [];
    this.pendingBytes = 0;
  }
  finish() {
    this.flush();
    return new Blob(this.blobs, { type: this.type });
  }
}

// ---------- JSON helpers ----------

// `[item, item, …]` written one item at a time
function* jsonArrayParts(items) {
  yield '[';
  let first = true;
  for (const item of items) {
    yield (first ? '' : ',') + JSON.stringify(item);
    first = false;
  }
  yield ']';
}

// ---------- HAR ----------

function harEntry(e, meta, number) {
  const reqHeaders = Object.entries(e.requestHeaders || {})
    .map(([n, v]) => ({ name: n, value: String(v) }));
  const resHeaders = Object.entries(e.responseHeaders || {})
    .map(([n, v]) => ({ name: n, value: String(v) }));
  const queryString = Object.entries(e.queryParams || {}).flatMap(([n, v]) =>
    Array.isArray(v) ? v.map(vv => ({ name: n, value: String(vv) })) : [{ name: n, value: String(v) }]
  );
  const cookies = (e.requestCookies || []).map(c => ({ name: c.name, value: c.value }));
  const setCookies = (e.responseCookies || []).map(c => ({
    name: c.name, value: c.value, path: c.path, domain: c.domain,
    expires: c.expires, httpOnly: !!c.httpOnly, secure: !!c.secure
  }));
  const postData = e.postData ? {
    mimeType: (e.requestHeaders && (e.requestHeaders['content-type'] || e.requestHeaders['Content-Type'])) || 'application/octet-stream',
    text: e.postData,
    params: e.postDataForm
      ? Object.entries(e.postDataForm).map(([n, v]) => ({ name: n, value: String(v) }))
      : undefined
  } : undefined;

  return {
    startedDateTime: new Date(e.capturedAt || meta.startTime || Date.now()).toISOString(),
    time: e.duration || 0,
    request: {
      method: e.method || 'GET',
      url: e.url || '',
      httpVersion: e.protocol || 'HTTP/1.1',
      cookies,
      headers: reqHeaders,
      queryString,
      postData,
      headersSize: -1,
      bodySize: e.postData ? e.postData.length : 0
    },
    response: {
      status: e.responseStatus || 0,
      statusText: e.responseStatusText || '',
      httpVersion: e.protocol || 'HTTP/1.1',
      cookies: setCookies,
      headers: resHeaders,
      content: {
        size: bodySize(e) || 0,
        mimeType: e.responseMimeType || '',
        text: e.responseBody || '',
        encoding: e.responseBase64Encoded ? 'base64' : undefined
      },
      redirectURL: e.redirectTo || '',
      headersSize: -1,
      bodySize: e.encodedDataLength || 0
    },
    cache: {},
    timings: e.responseTiming || { send: 0, wait: e.duration || 0, receive: 0 },
    serverIPAddress: e.remoteAddress ? e.remoteAddress.split(':')[0] : undefined,
    _resourceType: e.resourceType,
    _number: number,
    pageref: 'page_1'
  };
}

function* harParts(entries, meta) {
  const log = {
    version: '1.2',
    creator: { name: 'Network Capture Extension', version: meta.version || 'unknown' },
    pages: [{
      startedDateTime: new Date(meta.startTime || Date.now()).toISOString(),
      id: 'page_1',
      title: meta.tabUrl || '',
      pageTimings: {}
    }]
  };
  // '{"log":{…}}' without its two closing braces, so the entries array can follow
  yield JSON.stringify({ log }).slice(0, -2) + ',"entries":[';
  let number = 0;
  for (const e of entries) {
    yield (number ? ',' : '') + JSON.stringify(harEntry(e, meta, ++number), null, 2);
  }
  yield ']}}';
}

// ---------- JSON export (single file) ----------

function* jsonExportParts(entries, meta) {
  const pageOf = pageResolver(meta);
  // '{"meta":{…},"requests":[' without the closing ']}'
  yield JSON.stringify({ meta, requests: [] }).slice(0, -2);
  let number = 0;
  for (const e of entries) {
    number++;
    yield (number > 1 ? ',' : '') + JSON.stringify(exportRecord(e, number, null, pageOf(e.capturedAt)), null, 2);
  }
  yield ']}';
}

// ---------- CSV ----------

const CSV_HEADER = [
  '#','time','method','status','type','host','path','duration_ms','bytes',
  'mime','remote','request_cookies','response_set_cookies','url'
].join(',');

function csvRow(e, number) {
  return [
    number,
    new Date(e.capturedAt || 0).toISOString(),
    e.method || '',
    e.failed ? 'ERR' : (e.responseStatus || ''),
    e.resourceType || '',
    e.hostname || '',
    e.pathname || '',
    e.duration ? Math.round(e.duration) : '',
    e.encodedDataLength || '',
    e.responseMimeType || '',
    e.remoteAddress || '',
    (e.requestCookies || []).map(c => `${c.name}=${c.value}`).join('; '),
    (e.responseCookies || []).map(c => c.name).join('; '),
    e.url || ''
  ].map(csvEscape).join(',');
}

function* csvParts(entries) {
  yield CSV_HEADER + '\n';
  let number = 0;
  for (const e of entries) yield csvRow(e, ++number) + '\n';
}

// ---------- index.html ----------

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function indexHtmlHead(entries, meta) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Capture ${new Date(meta.startTime||Date.now()).toISOString()}</title>
<style>body{font:13px -apple-system,Segoe UI,Roboto,sans-serif;padding:16px;background:#fafafa}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #eee;padding:6px;text-align:left;font-size:12px}
th{background:#f0f0f0}tr:hover{background:#fff}h1{font-size:18px}small{color:#666}</style></head>
<body><h1>Network Capture</h1>
<small>${entries.length} requests · ${new Date(meta.startTime||0).toLocaleString()} → ${new Date(meta.endTime||Date.now()).toLocaleString()} · ${escapeHtml(meta.tabUrl || '')} · <a href="site-schema.md">schema</a></small>
<table><thead><tr><th>#</th><th>Method</th><th>Status</th><th>Type</th><th>URL</th><th>Time</th><th>Bytes</th><th>Files</th></tr></thead><tbody>`;
}

function indexRow(e, number, files) {
  const status = e.failed ? `<span style="color:#c33">ERR ${escapeHtml(e.errorText || '')}</span>`
                          : `<span>${e.responseStatus || '…'}</span>`;
  const links = [`<a href="${escapeHtml(files.json)}">json</a>`];
  if (files.body) links.push(`<a href="${escapeHtml(files.body)}">body</a>`);
  if (files.post) links.push(`<a href="${escapeHtml(files.post)}">post</a>`);
  return `<tr>
      <td>${number}</td>
      <td>${escapeHtml(e.method)}</td>
      <td>${status}</td>
      <td>${escapeHtml(e.resourceType)}</td>
      <td title="${escapeHtml(e.url)}">${escapeHtml((e.hostname || '') + (e.pathname || ''))}</td>
      <td>${e.duration ? Math.round(e.duration) + 'ms' : ''}</td>
      <td>${e.encodedDataLength || ''}</td>
      <td>${links.join(' · ')}</td>
    </tr>`;
}

function* indexHtmlParts(entries, meta, plan) {
  yield indexHtmlHead(entries, meta);
  for (let i = 0; i < entries.length; i++) yield indexRow(entries[i], i + 1, plan[i]);
  yield '</tbody></table>\n</body></html>';
}

// ---------- cookies ----------

// Cookies of every request, each tagged with the URL that sent or received it
function* cookieItems(entries, key) {
  for (const e of entries) {
    for (const c of (e[key] || [])) yield { from: e.url, ...c };
  }
}

// ---------- schema of the capture (site-schema.json / site-schema.md) ----------

function countBy(items, keyOf) {
  const counts = {};
  for (const item of items) {
    const key = keyOf(item) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function sortedRows(map, sortKey) {
  return [...map.values()].sort((a, b) => b[sortKey] - a[sortKey]);
}

function mdCell(value) {
  return String(value ?? '').replace(/[|\r\n]+/g, ' ');
}

function fmtSize(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function buildSchema(entries, meta) {
  const report = meta.crawlReport || null;
  const pages = report ? report.pages : [];
  const pageRows = pages.map(p => ({ ...p, requests: 0, bytes: 0, errors: 0 }));
  const hosts = new Map();
  const endpoints = new Map();
  let bytes = 0, failed = 0, withBody = 0;
  const unavailable = [];

  for (const e of entries) {
    const size = e.encodedDataLength || 0;
    const isError = !!e.failed || e.responseStatus >= 400;
    bytes += size;
    if (e.failed) failed++;
    if (e.responseBody) withBody++;
    if (e.responseBodyError) unavailable.push(e);

    const host = e.hostname || 'unknown';
    const path = e.pathname || '/';
    const h = hosts.get(host) || { host, requests: 0, bytes: 0 };
    h.requests++; h.bytes += size;
    hosts.set(host, h);

    const key = `${e.method || 'GET'} ${host}${path}`;
    const ep = endpoints.get(key) || { method: e.method || 'GET', host, path, requests: 0, statuses: {} };
    ep.requests++;
    const status = e.failed ? 'failed' : String(e.responseStatus || 'pending');
    ep.statuses[status] = (ep.statuses[status] || 0) + 1;
    endpoints.set(key, ep);

    const page = pageRows[pageIndexAt(pages, e.capturedAt || 0)];
    if (page) {
      page.requests++; page.bytes += size;
      if (isError) page.errors++;
    }
  }

  const json = {
    generatedAt: new Date().toISOString(),
    source: meta.tabUrl || null,
    startTime: meta.startTime || null,
    endTime: meta.endTime || null,
    totals: {
      requests: entries.length,
      bytes,
      failed,
      incomplete: entries.filter(e => e.incomplete).length,
      notStored: meta.lostEntries || 0
    },
    bodies: {
      stored: withBody,
      unavailable: unavailable.length,
      reasons: countBy(unavailable, e => e.responseBodyError)
    },
    statusCodes: countBy(entries, e => e.failed ? 'failed' : e.responseStatus),
    contentTypes: countBy(entries, e => (e.responseMimeType || '').split(';')[0]),
    resourceTypes: countBy(entries, e => e.resourceType),
    hosts: sortedRows(hosts, 'requests'),
    endpoints: sortedRows(endpoints, 'requests'),
    crawl: report ? { startUrl: report.startUrl, options: report.options, pages: pageRows } : null
  };
  return { json, markdown: schemaMarkdown(json) };
}

function schemaMarkdown(s) {
  const seconds = s.startTime && s.endTime ? ((s.endTime - s.startTime) / 1000).toFixed(1) : null;
  const lines = [
    `# Capture schema`,
    ``,
    `- Source: ${s.source || '-'}`,
    `- Captured: ${s.startTime ? new Date(s.startTime).toISOString() : '-'} → ${s.endTime ? new Date(s.endTime).toISOString() : '-'}${seconds ? ` (${seconds} s)` : ''}`,
    `- Generated: ${s.generatedAt}`,
    `- Requests: ${s.totals.requests} · Size: ${fmtSize(s.totals.bytes)} · Failed: ${s.totals.failed}`,
    `- Bodies: ${s.bodies.stored} stored, ${s.bodies.unavailable} unavailable`
  ];
  for (const [reason, n] of Object.entries(s.bodies.reasons)) lines.push(`  - ${mdCell(reason)} ×${n}`);
  if (s.totals.incomplete) lines.push(`- Incomplete (still loading when the capture ended): ${s.totals.incomplete}`);
  if (s.totals.notStored) lines.push(`- **Not stored: ${s.totals.notStored}** (the offscreen document did not accept them)`);
  lines.push(``);
  if (s.crawl) {
    lines.push(`## Pages visited (${s.crawl.pages.length})`, ``);
    for (const p of s.crawl.pages) {
      const indent = '  '.repeat(p.depth);
      const errors = p.errors ? ` · ${p.errors} errors` : '';
      lines.push(`${indent}- [${mdCell(p.title || p.url)}](${p.url}) — depth ${p.depth} · ${p.requests} requests · ${fmtSize(p.bytes)}${errors}`);
    }
    lines.push(``);
  }
  lines.push(`## Hosts`, ``, `| Host | Requests | Size |`, `| --- | ---: | ---: |`);
  for (const h of s.hosts) lines.push(`| ${mdCell(h.host)} | ${h.requests} | ${fmtSize(h.bytes)} |`);
  lines.push(``, `## Status codes`, ``, `| Status | Requests |`, `| --- | ---: |`);
  for (const [code, n] of Object.entries(s.statusCodes)) lines.push(`| ${mdCell(code)} | ${n} |`);
  lines.push(``, `## Content types`, ``, `| Type | Requests |`, `| --- | ---: |`);
  for (const [type, n] of Object.entries(s.contentTypes)) lines.push(`| ${mdCell(type)} | ${n} |`);
  const LIMIT = 500;
  lines.push(``, `## Endpoints`, ``, `| Method | Host | Path | Requests | Statuses |`, `| --- | --- | --- | ---: | --- |`);
  for (const ep of s.endpoints.slice(0, LIMIT)) {
    const statuses = Object.entries(ep.statuses).map(([k, v]) => `${k}×${v}`).join(', ');
    lines.push(`| ${ep.method} | ${mdCell(ep.host)} | ${mdCell(ep.path)} | ${ep.requests} | ${statuses} |`);
  }
  if (s.endpoints.length > LIMIT) lines.push(``, `…${s.endpoints.length - LIMIT} more endpoints in site-schema.json.`);
  return lines.join('\n') + '\n';
}

// ---------- ZIP ----------

// Files of the ZIP, one at a time: { name, parts }. Per-request files are produced lazily.
function* zipFiles(entries, meta, schema) {
  const plan = entries.map((e, i) => layoutFor(e, i + 1));
  const pageOf = pageResolver(meta);

  yield { name: 'index.html', parts: indexHtmlParts(entries, meta, plan) };
  yield { name: 'site-schema.md', parts: [schema.markdown] };
  yield { name: 'site-schema.json', parts: [JSON.stringify(schema.json, null, 2)] };
  yield { name: 'summary.json', parts: [JSON.stringify({ meta, count: entries.length, generatedAt: new Date().toISOString() }, null, 2)] };
  yield { name: 'capture.har', parts: harParts(entries, meta) };
  yield { name: 'capture.csv', parts: csvParts(entries) };
  yield { name: 'cookies/request_cookies.json', parts: jsonArrayParts(cookieItems(entries, 'requestCookies')) };
  yield { name: 'cookies/response_cookies.json', parts: jsonArrayParts(cookieItems(entries, 'responseCookies')) };
  for (let i = 0; i < entries.length; i++) yield* requestFiles(entries[i], i + 1, plan[i], pageOf);
}

function* requestFiles(e, number, files, pageOf) {
  const record = exportRecord(e, number, files, pageOf(e.capturedAt));
  yield { name: files.json, parts: [JSON.stringify(record, null, 2)] };
  if (files.body) yield { name: files.body, parts: [files.bodyBinary ? b64ToBytes(e.responseBody) : e.responseBody] };
  if (files.post) yield { name: files.post, parts: [e.postData] };
}

// ---------- build ----------

const FORMATS = {
  json: { mime: 'application/json', ext: 'json', parts: jsonExportParts },
  har:  { mime: 'application/json', ext: 'har',  parts: harParts },
  csv:  { mime: 'text/csv',         ext: 'csv',  parts: csvParts }
};

// Blob URLs not revoked by the service worker (it may have been evicted) expire on their own
const BLOB_URL_TTL_MS = 30 * 60 * 1000;

async function buildBlob({ format, baseName, meta }) {
  const entries = store.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
  if (!entries.length) throw new Error('Nothing to export');
  const isZip = !FORMATS[format];
  const spec = isZip ? { mime: 'application/zip', ext: 'zip' } : FORMATS[format];
  const sink = new BlobSink(spec.mime);

  if (isZip) {
    NCPZip.writeTo(zipFiles(entries, meta, buildSchema(entries, meta)), sink);
  } else {
    for (const part of spec.parts(entries, meta)) sink.write(part);
  }

  const url = URL.createObjectURL(sink.finish());
  setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_TTL_MS);
  return { url, filename: `${baseName}.${spec.ext}`, mime: spec.mime };
}

// ---------- keep the service worker awake while capturing ----------

const KEEPALIVE_MS = 20 * 1000;
let keepaliveTimer = null;

function setKeepalive(on) {
  clearInterval(keepaliveTimer);
  keepaliveTimer = on
    ? setInterval(() => chrome.runtime.sendMessage({ target: 'background', type: 'KEEPALIVE' }).catch(() => {}), KEEPALIVE_MS)
    : null;
}

// ---------- messages from background.js ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  switch (msg.type) {
    case 'STORE_ENTRY':
      storeEntry(msg.entry);
      sendResponse({ ok: true });
      return;
    case 'STATS':
      sendResponse({ ok: true, count: store.length, bodyBytes, maxSeq });
      return;
    case 'LIST_SUMMARIES':
      sendResponse({ ok: true, summaries: listSummaries(), total: store.length });
      return;
    case 'GET_ENTRY':
      sendResponse({ ok: true, entry: byId.get(msg.id) || null });
      return;
    case 'CLEAR_STORE':
      clearStore();
      sendResponse({ ok: true });
      return;
    case 'SET_KEEPALIVE':
      setKeepalive(!!msg.on);
      sendResponse({ ok: true });
      return;
    case 'REVOKE_URL':
      try { URL.revokeObjectURL(msg.url); } catch {}
      sendResponse({ ok: true });
      return;
    case 'BUILD_AND_DOWNLOAD':
      buildBlob(msg).then(
        r => sendResponse({ ok: true, ...r }),
        e => {
          console.error('[offscreen] build error', e);
          sendResponse({ ok: false, error: e && e.message || String(e) });
        }
      );
      return true; // async sendResponse
  }
});

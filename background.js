// Network Capture Extension - service worker (Manifest V3)
// Uses chrome.debugger (Chrome DevTools Protocol) to capture full request/response data.
//
// Where the data lives: every finished request is sent to the offscreen document, which keeps
// it in memory until the capture is cleared or the browser is closed. Only a few settings go
// to chrome.storage, and no file is ever created except the exports you download.

importScripts('common.js', 'crawl.js');

const STATE_KEY = 'ncp_state_v2';
// Older versions kept the whole capture in chrome.storage; those keys are removed on start
const LEGACY_KEYS = ['ncp_state_v1', 'ncp_requests_v1'];

// Response bodies kept in memory per capture. Past this the requests are still recorded,
// without their bodies, and the report says how many were skipped.
const MAX_BODY_BYTES = 1024 * 1024 * 1024;
// DevTools keeps bodies in its own buffer until they are read. A bigger value brought down
// the whole browser in tests; this one is the largest that was stable.
const DEVTOOLS_BUFFER_BYTES = 200 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 50 * 1024 * 1024;
const DRAIN_TIMEOUT_MS = 5000;
const MAX_WEBSOCKET_FRAMES = 2000;

const state = {
  capturing: false,
  paused: false,
  draining: false,     // stopping: only requests already in flight are finished
  startTime: null,
  endTime: null,
  tabId: null,
  tabUrl: null,
  seq: 0,              // arrival order of requests
  stored: 0,           // requests held by the offscreen document
  bytes: 0,            // bytes transferred
  bodyBytes: 0,        // characters of response bodies held in memory
  bodiesSkipped: 0,    // bodies not kept because of MAX_BODY_BYTES
  lostEntries: 0,      // requests that could not be handed to the offscreen document
  bodiesInFlight: 0,
  crawlReport: null    // pages visited by tools/crawl-capture.js, if a crawl ran
};
const pending = new Map();   // requestId -> request still loading
const finalized = new Set(); // requestIds already stored, to ignore late events about them

// ---------- persistence: settings only ----------
function persistedState() {
  const { capturing, paused, startTime, endTime, tabId, tabUrl, seq, bytes, bodiesSkipped, lostEntries, crawlReport } = state;
  return { capturing, paused, startTime, endTime, tabId, tabUrl, seq, bytes, bodiesSkipped, lostEntries, crawlReport };
}

async function saveState() {
  try {
    await chrome.storage.local.set({ [STATE_KEY]: persistedState() });
  } catch (e) {
    console.warn('saveState failed', e);
  }
}

function resetCapture() {
  state.stored = 0;
  state.bytes = 0;
  state.bodyBytes = 0;
  state.bodiesSkipped = 0;
  state.lostEntries = 0;
  state.crawlReport = null;
  state.startTime = null;
  state.endTime = null;
  pending.clear();
  finalized.clear();
}

async function debuggerAttached(tabId) {
  if (!tabId) return false;
  const targets = await chrome.debugger.getTargets();
  return targets.some(t => t.tabId === tabId && t.attached);
}

// Runs on every service-worker start. The worker is evicted after ~30 s without events, so
// this has to pick the capture up again instead of assuming it ended.
async function loadState() {
  const data = await chrome.storage.local.get(STATE_KEY);
  if (data[STATE_KEY]) Object.assign(state, data[STATE_KEY]);
  chrome.storage.local.remove(LEGACY_KEYS).catch(() => {});

  const stats = await storeCall({ type: 'STATS' });
  if (stats) {
    state.stored = stats.count;
    state.bodyBytes = stats.bodyBytes;
    state.seq = Math.max(state.seq, stats.maxSeq);
  } else {
    // The offscreen document is gone (browser restarted, extension reloaded), and so is the data
    resetCapture();
  }

  if (state.capturing) {
    if (await debuggerAttached(state.tabId)) {
      await ensureOffscreen();
      await toOffscreen({ type: 'SET_KEEPALIVE', on: true });
    } else {
      state.capturing = false;
      state.endTime = Date.now();
    }
    await saveState();
  }
  setBadge();
}
const ready = loadState();

// ---------- offscreen document: holds the capture and builds the exports ----------
let offscreenCreating = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  offscreenCreating = offscreenCreating || chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Keep the captured requests and build the ZIP/JSON/HAR/CSV exports.'
  }).finally(() => { offscreenCreating = null; });
  await offscreenCreating;
}

function toOffscreen(msg) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
}

// Like toOffscreen, but returns null instead of throwing (e.g. when the document is not open)
async function storeCall(msg) {
  try {
    const reply = await toOffscreen(msg);
    return reply && reply.ok ? reply : null;
  } catch {
    return null;
  }
}

// ---------- helpers ----------
function parseUrl(u) {
  try {
    const x = new URL(u);
    const params = {};
    x.searchParams.forEach((v, k) => {
      if (params[k] === undefined) params[k] = v;
      else if (Array.isArray(params[k])) params[k].push(v);
      else params[k] = [params[k], v];
    });
    return {
      hostname: x.hostname,
      pathname: x.pathname,
      port: x.port,
      search: x.search,
      queryParams: params
    };
  } catch {
    return {};
  }
}

function parseCookieHeader(value) {
  if (!value) return [];
  return String(value).split(/;\s*/).filter(Boolean).map(part => {
    const i = part.indexOf('=');
    if (i === -1) return { name: part, value: '' };
    return { name: part.slice(0, i), value: part.slice(i + 1) };
  });
}

function parseSetCookie(value) {
  if (!value) return [];
  // Set-Cookie can be a single string with multiple cookies separated by newline (CDP returns joined)
  const lines = String(value).split('\n').filter(Boolean);
  return lines.map(line => {
    const parts = line.split(/;\s*/);
    const [nv, ...attrs] = parts;
    const i = nv.indexOf('=');
    const name = i === -1 ? nv : nv.slice(0, i);
    const val = i === -1 ? '' : nv.slice(i + 1);
    const cookie = { name, value: val };
    for (const a of attrs) {
      const j = a.indexOf('=');
      const k = (j === -1 ? a : a.slice(0, j)).toLowerCase();
      const v = j === -1 ? true : a.slice(j + 1);
      if (k === 'expires') cookie.expires = v;
      else if (k === 'max-age') cookie.maxAge = v;
      else if (k === 'domain') cookie.domain = v;
      else if (k === 'path') cookie.path = v;
      else if (k === 'samesite') cookie.sameSite = v;
      else if (k === 'secure') cookie.secure = true;
      else if (k === 'httponly') cookie.httpOnly = true;
      else cookie[k] = v;
    }
    return cookie;
  });
}

function lowerKeys(obj) {
  if (!obj) return {};
  const out = {};
  for (const k of Object.keys(obj)) out[k.toLowerCase()] = obj[k];
  return out;
}

function cacheSource(r) {
  if (r.fromServiceWorker) return 'service-worker';
  if (r.fromDiskCache) return 'disk';
  if (r.fromPrefetchCache) return 'prefetch';
  return undefined;
}

// DevTools errors arrive as '{"code":-32000,"message":"…"}'; keep only the readable part
function errorText(err) {
  const text = err && err.message ? err.message : String(err);
  try { return JSON.parse(text).message || text; } catch { return text; }
}

function waitUntil(predicate, timeoutMs) {
  const started = Date.now();
  return new Promise(resolve => {
    const tick = () => {
      if (predicate() || Date.now() - started > timeoutMs) resolve();
      else setTimeout(tick, 50);
    };
    tick();
  });
}

// ---------- building one request from DevTools events ----------

// What belongs to one leg of a request. A redirect starts a new leg under the same requestId.
const LEG_FIELDS = ['url', 'method', 'requestHeaders', 'requestCookies', 'blockedRequestCookies',
  'postData', 'postDataJson', 'postDataForm', 'responseStatus', 'responseStatusText', 'responseHeaders',
  'responseMimeType', 'responseCookies', 'blockedCookies', 'remoteAddress', 'protocol', 'responseTiming',
  'securityState', 'securityDetails', 'fromCache', 'redirectTo'];
const INTERNAL_FIELDS = ['requestTime', 'hops'];

function applyResponse(e, r) {
  e.responseStatus = r.status;
  e.responseStatusText = r.statusText;
  e.responseHeaders = { ...(e.responseHeaders || {}), ...(r.headers || {}) };
  e.responseMimeType = r.mimeType;
  e.remoteAddress = r.remoteIPAddress ? `${r.remoteIPAddress}:${r.remotePort}` : undefined;
  e.protocol = r.protocol;
  e.responseTiming = r.timing;
  e.securityState = r.securityState;
  e.securityDetails = r.securityDetails;
  e.fromCache = cacheSource(r);
  const setCookie = lowerKeys(e.responseHeaders)['set-cookie'];
  if (setCookie) e.responseCookies = parseSetCookie(setCookie);
}

// A redirect answers a request and starts another one with the same requestId. The answered
// leg is stored as its own record so the whole chain stays visible.
function splitRedirect(e, redirectResponse, nextUrl) {
  e.hops = (e.hops || 0) + 1;
  const hop = { ...e, id: `${e.id}~${e.hops}` };
  applyResponse(hop, redirectResponse);
  hop.redirectTo = nextUrl;
  finalize(hop);
  for (const key of LEG_FIELDS) delete e[key];
  e.seq = ++state.seq;
  e.capturedAt = Date.now();
}

async function fetchBody(e, tabId) {
  if (state.bodyBytes >= MAX_BODY_BYTES) {
    e.responseBodyError = 'skipped: memory limit for bodies reached';
    state.bodiesSkipped++;
    return;
  }
  state.bodiesInFlight++;
  try {
    const body = await chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId: e.id });
    if (body && body.body) {
      e.responseBody = body.body;
      e.responseBase64Encoded = !!body.base64Encoded;
      state.bodyBytes += body.body.length;
    }
  } catch (err) {
    e.responseBodyError = errorText(err);
  } finally {
    state.bodiesInFlight--;
  }
}

// Closes a request: drops empty and internal fields and hands it to the offscreen document
function finalize(e) {
  pending.delete(e.id);
  finalized.add(e.id);
  const record = NCP.compact(e);
  for (const key of INTERNAL_FIELDS) delete record[key];
  return enqueueStore(record);
}

// Requests are handed over one at a time, in order. The returned promise never rejects.
let storeChain = Promise.resolve();
function enqueueStore(record) {
  const job = storeChain.then(() => storeEntry(record));
  storeChain = job.catch(err => {
    state.lostEntries++;
    console.warn('could not store request', record.url, err);
  });
  return storeChain;
}

async function storeEntry(record) {
  await ensureOffscreen();
  let reply;
  try {
    reply = await toOffscreen({ type: 'STORE_ENTRY', entry: record });
  } catch (err) {
    if (!record.responseBody) throw err;
    // Too big for one message (about 64 MiB): keep the request, drop only its body
    state.bodyBytes -= record.responseBody.length;
    const { responseBody, responseBase64Encoded, ...rest } = record;
    reply = await toOffscreen({ type: 'STORE_ENTRY', entry: { ...rest, responseBodyError: 'body too large to store' } });
  }
  if (!reply || !reply.ok) throw new Error('offscreen did not accept the request');
  state.stored++;
  setBadge();
}

async function finalizePending() {
  for (const e of Array.from(pending.values())) {
    if (e.resourceType !== 'WebSocket') e.incomplete = true;
    finalize(e);
  }
  await storeChain;
}

// ---------- debugger event handler ----------
chrome.debugger.onEvent.addListener(async (source, method, params) => {
  await ready;
  if (!state.capturing) return;
  if (state.tabId && source.tabId !== state.tabId) return;
  const reqId = params && params.requestId;
  if (!reqId || finalized.has(reqId)) return;

  let e = pending.get(reqId);
  if (!e) {
    // Paused or stopping: requests already in flight keep going, new ones are ignored
    if (state.paused || state.draining) return;
    e = { id: reqId, seq: ++state.seq, capturedAt: Date.now() };
    pending.set(reqId, e);
  }

  switch (method) {
    case 'Network.requestWillBeSent': {
      const req = params.request || {};
      if (params.redirectResponse && e.url) splitRedirect(e, params.redirectResponse, req.url);
      e.url = req.url;
      e.method = req.method;
      e.requestHeaders = { ...(e.requestHeaders || {}), ...(req.headers || {}) };
      e.postData = req.postData;
      const init = params.initiator || {};
      e.initiator = { type: init.type, url: init.url, line: init.lineNumber };
      e.resourceType = params.type;
      e.documentUrl = params.documentURL;
      e.requestTime = params.timestamp;
      Object.assign(e, parseUrl(req.url));
      // attempt to parse post body when it's form / json
      if (req.postData) {
        try {
          const ct = lowerKeys(req.headers)['content-type'] || '';
          if (ct.includes('application/json')) e.postDataJson = JSON.parse(req.postData);
          else if (ct.includes('application/x-www-form-urlencoded')) {
            const p = {};
            new URLSearchParams(req.postData).forEach((v, k) => p[k] = v);
            e.postDataForm = p;
          }
        } catch { /* leave raw */ }
      }
      break;
    }
    case 'Network.requestWillBeSentExtraInfo': {
      // Extra info carries the headers the network stack really sent, including Cookie
      e.requestHeaders = { ...(e.requestHeaders || {}), ...(params.headers || {}) };
      const cookie = lowerKeys(params.headers).cookie;
      if (cookie) e.requestCookies = parseCookieHeader(cookie);
      const blocked = (params.associatedCookies || []).filter(c => c.blockedReasons && c.blockedReasons.length);
      if (blocked.length) e.blockedRequestCookies = blocked.map(c => ({ name: c.cookie && c.cookie.name, reasons: c.blockedReasons }));
      break;
    }
    case 'Network.responseReceived':
      applyResponse(e, params.response || {});
      break;
    case 'Network.responseReceivedExtraInfo': {
      e.responseHeaders = { ...(e.responseHeaders || {}), ...(params.headers || {}) };
      if (params.statusCode && e.responseStatus === undefined) e.responseStatus = params.statusCode;
      const blocked = params.blockedCookies || [];
      if (blocked.length) e.blockedCookies = blocked.map(c => ({ name: c.cookie && c.cookie.name, reasons: c.blockedReasons }));
      const setCookie = lowerKeys(e.responseHeaders)['set-cookie'];
      if (setCookie && !e.responseCookies) e.responseCookies = parseSetCookie(setCookie);
      break;
    }
    case 'Network.loadingFinished':
      e.encodedDataLength = params.encodedDataLength;
      e.duration = e.requestTime ? (params.timestamp - e.requestTime) * 1000 : undefined;
      state.bytes += params.encodedDataLength || 0;
      await fetchBody(e, source.tabId);
      await finalize(e);
      break;
    case 'Network.loadingFailed':
      e.failed = true;
      e.errorText = params.errorText;
      e.canceled = params.canceled;
      e.blockedReason = params.blockedReason;
      e.corsErrorStatus = params.corsErrorStatus;
      await finalize(e);
      break;
    case 'Network.webSocketCreated':
      e.resourceType = 'WebSocket';
      e.url = params.url;
      Object.assign(e, parseUrl(params.url));
      break;
    case 'Network.webSocketHandshakeResponseReceived':
      applyResponse(e, params.response || {});
      break;
    case 'Network.webSocketFrameSent':
    case 'Network.webSocketFrameReceived': {
      e.frames = e.frames || [];
      if (e.frames.length >= MAX_WEBSOCKET_FRAMES) { e.framesDropped = (e.framesDropped || 0) + 1; break; }
      const frame = params.response || {};
      e.frames.push({
        direction: method.endsWith('Sent') ? 'out' : 'in',
        timestamp: params.timestamp,
        opcode: frame.opcode,
        payload: frame.payloadData
      });
      break;
    }
    case 'Network.webSocketClosed':
      await finalize(e);
      break;
  }
});

chrome.debugger.onDetach.addListener(async (source) => {
  await ready;
  if (state.capturing && state.tabId === source.tabId) await finishCapture(false);
});

// ---------- capture control ----------
function attachError(err) {
  const text = err && err.message ? err.message : String(err);
  if (/already attached/i.test(text)) {
    return new Error('Another debugger (for example DevTools) is attached to this tab. Close it and try again.');
  }
  return err;
}

// options.tabUrl: the site being captured, when the tab is still blank (a crawl starts that way)
async function startCapture(tabId, options = {}) {
  if (state.capturing) return;
  if (!tabId) tabId = await activeTabId();
  if (!tabId) throw new Error('No active tab');
  const tab = await chrome.tabs.get(tabId);
  await ensureOffscreen();
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    throw attachError(err);
  }
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {
      maxResourceBufferSize: MAX_RESOURCE_BYTES,
      maxTotalBufferSize: DEVTOOLS_BUFFER_BYTES
    });
  } catch (err) {
    try { await chrome.debugger.detach({ tabId }); } catch {}
    throw err;
  }
  await toOffscreen({ type: 'SET_KEEPALIVE', on: true });
  pending.clear();
  finalized.clear();
  state.tabId = tabId;
  // A tab that is still loading reports about:blank as url; pendingUrl has the real target
  state.tabUrl = options.tabUrl || tab.pendingUrl || tab.url;
  state.capturing = true;
  state.paused = false;
  state.crawlReport = null;  // a report belongs to the capture it was produced with
  state.startTime = Date.now();
  state.endTime = null;
  await saveState();
  setBadge();
}

// Ends the capture without losing what is in flight: bodies still being read are waited for,
// and requests that never finished are kept and marked incomplete.
async function finishCapture(detach) {
  if (state.draining) return;
  state.draining = true;
  try {
    await waitUntil(() => state.bodiesInFlight === 0, DRAIN_TIMEOUT_MS);
    await finalizePending();
    if (detach) {
      try { await chrome.debugger.detach({ tabId: state.tabId }); } catch {}
    }
  } finally {
    state.draining = false;
    state.capturing = false;
    state.endTime = Date.now();
    await storeCall({ type: 'SET_KEEPALIVE', on: false });
    await saveState();
    setBadge();
  }
}

async function stopCapture() {
  if (!state.capturing) return;
  await finishCapture(true);
}

async function pauseCapture(paused) {
  state.paused = !!paused;
  await saveState();
  setBadge();
}

async function clearCapture() {
  await storeCall({ type: 'CLEAR_STORE' });
  const keepCapturing = state.capturing;
  const inFlight = Array.from(pending.keys());
  resetCapture();
  // Late events of requests that were cleared must not come back as empty records
  for (const id of inFlight) finalized.add(id);
  if (keepCapturing) state.startTime = Date.now();
  await saveState();
  setBadge();
}

function setBadge() {
  try {
    const total = state.stored + pending.size;
    if (state.capturing && !state.paused) {
      chrome.action.setBadgeText({ text: 'REC' });
      chrome.action.setBadgeBackgroundColor({ color: '#d33' });
    } else if (state.paused) {
      chrome.action.setBadgeText({ text: '||' });
      chrome.action.setBadgeBackgroundColor({ color: '#888' });
    } else if (total) {
      chrome.action.setBadgeText({ text: String(total) });
      chrome.action.setBadgeBackgroundColor({ color: '#2a6' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch {}
}

// ---------- exports ----------

// Domain of the captured tab for the file name: https://test.buenaia.ai/x -> test.buenaia.ai
function hostForFilename(tabUrl) {
  try {
    const url = new URL(tabUrl);
    // Only web pages have a meaningful domain; chrome:// and file:// pages do not
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'unknown';
    return url.hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]/g, '_') || 'unknown';
  } catch {
    return 'unknown';
  }
}

// Exports run one at a time: each one walks the whole capture
let exportQueue = Promise.resolve();
function downloadAll(format = 'zip') {
  const run = exportQueue.then(() => buildAndDownload(format));
  exportQueue = run.catch(() => {});
  return run;
}

// Blob URL of each download in progress, revoked as soon as the download ends
const activeDownloads = new Map();

async function buildAndDownload(format) {
  await ready;
  const stats = await storeCall({ type: 'STATS' });
  if (!stats || !stats.count) throw new Error('Nothing to download — capture some requests first.');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const reply = await toOffscreen({
    type: 'BUILD_AND_DOWNLOAD',
    format,
    baseName: `network_capture_${hostForFilename(state.tabUrl)}_${ts}`,
    meta: {
      version: chrome.runtime.getManifest().version,
      startTime: state.startTime,
      endTime: state.endTime || Date.now(),
      tabUrl: state.tabUrl,
      count: stats.count,
      bytes: state.bytes,
      bodyBytes: state.bodyBytes,
      bodiesSkipped: state.bodiesSkipped,
      lostEntries: state.lostEntries,
      crawlReport: state.crawlReport
    }
  });
  if (!reply || !reply.ok) throw new Error((reply && reply.error) || 'offscreen build failed');
  let id;
  try {
    id = await chrome.downloads.download({ url: reply.url, filename: reply.filename, saveAs: false });
  } catch (err) {
    await storeCall({ type: 'REVOKE_URL', url: reply.url });
    throw err;
  }
  activeDownloads.set(id, reply.url);
  return { ok: true, downloadId: id, filename: reply.filename };
}

chrome.downloads.onChanged.addListener(delta => {
  const url = activeDownloads.get(delta.id);
  if (!url || !delta.state) return;
  if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
    activeDownloads.delete(delta.id);
    storeCall({ type: 'REVOKE_URL', url });
  }
});

// ---------- site data clearing ----------
function originsFor(url) {
  try {
    const u = new URL(url);
    return [u.origin];
  } catch { return []; }
}

async function clearSiteData(url, opts = {}) {
  if (!url) throw new Error('No site URL — start a capture or pass a tab first.');
  const origins = originsFor(url);
  if (!origins.length) throw new Error('Could not parse site URL: ' + url);
  if (!chrome.browsingData) throw new Error('browsingData permission missing — reload the extension.');
  const what = {
    cookies: opts.cookies !== false,
    cache: opts.cache !== false,
    cacheStorage: opts.cache !== false,
    localStorage: opts.storage !== false,
    indexedDB: opts.storage !== false,
    serviceWorkers: opts.storage !== false,
    fileSystems: opts.storage !== false,
    webSQL: opts.storage !== false
  };
  await chrome.browsingData.remove({ origins }, what);
  return { ok: true, origins, cleared: what };
}

async function clearSiteCacheOnly(url) {
  return clearSiteData(url, { cookies: false, cache: true, storage: false });
}

async function clearSiteCookiesOnly(url) {
  return clearSiteData(url, { cookies: true, cache: false, storage: false });
}

// ---------- message router ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target && msg.target !== 'background') return;
  (async () => {
    try {
      await ready;
      switch (msg.type) {
        case 'KEEPALIVE':
          // Sent by the offscreen document while capturing so the worker is not evicted
          sendResponse({ ok: true });
          break;
        case 'GET_STATE':
          sendResponse({
            capturing: state.capturing,
            paused: state.paused,
            startTime: state.startTime,
            endTime: state.endTime,
            count: state.stored + pending.size,
            bytes: state.bytes,
            bodyBytes: state.bodyBytes,
            bodiesSkipped: state.bodiesSkipped,
            lostEntries: state.lostEntries,
            tabId: state.tabId,
            tabUrl: state.tabUrl,
            crawling: crawlRunning(),
            swVersion: chrome.runtime.getManifest().version
          });
          break;
        case 'CRAWL_START':
          await startCrawl(msg.url, msg.options);
          sendResponse({ ok: true });
          break;
        case 'CRAWL_STATE':
          sendResponse(crawlSnapshot());
          break;
        case 'CRAWL_STOP':
          requestCrawlStop('save');
          sendResponse({ ok: true });
          break;
        case 'CRAWL_CANCEL':
          requestCrawlStop('discard');
          sendResponse({ ok: true });
          break;
        case 'CRAWL_SHOW':
          await showCrawlProgress();
          sendResponse({ ok: true });
          break;
        case 'GET_REQUEST_LIST': {
          const stored = await storeCall({ type: 'LIST_SUMMARIES' });
          const list = (stored ? stored.summaries : []).concat(Array.from(pending.values(), NCP.summarize));
          sendResponse({ requests: list });
          break;
        }
        case 'GET_REQUEST': {
          const inFlight = pending.get(msg.id);
          const stored = inFlight ? null : await storeCall({ type: 'GET_ENTRY', id: msg.id });
          sendResponse({ request: inFlight || (stored && stored.entry) || null });
          break;
        }
        case 'START':
          await startCapture(msg.tabId);
          sendResponse({ ok: true });
          break;
        case 'STOP':
          await stopCapture();
          sendResponse({ ok: true });
          break;
        case 'PAUSE':
          await pauseCapture(true);
          sendResponse({ ok: true });
          break;
        case 'RESUME':
          await pauseCapture(false);
          sendResponse({ ok: true });
          break;
        case 'SET_CRAWL_REPORT':
          state.crawlReport = msg.report;
          await saveState();
          sendResponse({ ok: true });
          break;
        case 'CLEAR':
          await clearCapture();
          sendResponse({ ok: true });
          break;
        case 'DOWNLOAD': {
          const r = await downloadAll(msg.format);
          sendResponse({ ok: true, ...r });
          break;
        }
        case 'GET_TARGET_URL': {
          let url = state.tabUrl;
          if (!url) url = await activeTabUrl();
          sendResponse({ ok: true, url });
          break;
        }
        case 'OPEN_TARGET': {
          const url = msg.url || state.tabUrl;
          if (!url) throw new Error('No target URL');
          let focused = false;
          if (state.tabId) {
            try { await chrome.tabs.update(state.tabId, { active: true }); focused = true; }
            catch { /* tab gone, open a new one */ }
          }
          if (!focused) await chrome.tabs.create({ url });
          sendResponse({ ok: true });
          break;
        }
        case 'CLEAR_SITE_DATA': {
          const url = msg.url || state.tabUrl || (await activeTabUrl());
          const r = await clearSiteData(url, msg.opts || {});
          sendResponse({ ok: true, ...r });
          break;
        }
        case 'CLEAR_SITE_CACHE': {
          const url = msg.url || state.tabUrl || (await activeTabUrl());
          const r = await clearSiteCacheOnly(url);
          sendResponse({ ok: true, ...r });
          break;
        }
        case 'CLEAR_SITE_COOKIES': {
          const url = msg.url || state.tabUrl || (await activeTabUrl());
          const r = await clearSiteCookiesOnly(url);
          sendResponse({ ok: true, ...r });
          break;
        }
        case 'RELOAD_TARGET': {
          const tabId = state.tabId || (await activeTabId());
          if (tabId) await chrome.tabs.reload(tabId, { bypassCache: !!msg.bypassCache });
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message type ' + msg.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  })();
  return true; // async
});

// ---------- helpers used by message router ----------
async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && tab.id;
}
async function activeTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && tab.url;
}

// ---------- end the capture if its tab closes ----------
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  if (state.tabId === tabId && state.capturing) await finishCapture(false);
});

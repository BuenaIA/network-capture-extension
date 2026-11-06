// Crawl a whole site from inside the extension.
//
// Opens a window of its own, records every request while it visits the pages of the same
// origin (with the session of this browser), and downloads the ZIP at the end. The crawl is
// read-only: forms are never submitted. It runs in the service worker and is loaded with
// importScripts from background.js, whose capture functions and state it uses.

const CRAWL_DEFAULTS = {
  maxPages: 200,       // stop after this many pages
  maxDepth: 5,         // clicks away from the start page
  deepLinks: 1,        // new links followed from each page below the start page
  menus: true,         // hover and click navigation triggers to reveal more links
  settleMs: 1200,      // wait after each load for XHR/fetch to finish
  maxMinutes: 30,      // never run longer than this
  autoExport: true,    // download the ZIP when done
  showProgress: true   // open the progress window
};
const CRAWL_LIMITS = { maxPages: [1, 2000], maxDepth: [0, 10], deepLinks: [0, 20], settleMs: [200, 10000], maxMinutes: [1, 240] };
const CRAWL_LOAD_TIMEOUT_MS = 20000;
const CRAWL_RECENT = 12;
const MENU_DELAY_MS = 300;
const MAX_MENU_ACTIONS = 30;

// Links that end the session, change data or point to files are not followed
const SKIP_PATH = /(logout|log-out|signout|sign-out|salir|cerrar-sesion|delete|remove|destroy|unsubscribe|eliminar|borrar)/i;
const SKIP_FILE = /\.(jpe?g|png|gif|webp|svg|ico|css|js|mp3|mp4|webm|woff2?|ttf|zip|gz|exe|dmg|pdf)$/i;

// Runs before any script of every page and iframe the crawl opens. Forms are never submitted:
// the submit event is cancelled, and form.submit() / requestSubmit() do nothing (calling
// submit() from script does not fire the event, so the event alone would not be enough).
const FORM_GUARD = `(() => {
  if (window.__ncpGuard) return;
  window.__ncpGuard = true;
  window.__ncpBlockedForms = 0;
  const block = () => { window.__ncpBlockedForms++; };
  document.addEventListener('submit', e => { e.preventDefault(); e.stopImmediatePropagation(); block(); }, true);
  HTMLFormElement.prototype.submit = function () { block(); };
  HTMLFormElement.prototype.requestSubmit = function () { block(); };
})();`;

// Elements that usually open a menu. Hovering shows CSS-only menus; clicking shows
// script-driven ones. Links with a real href are hovered but never clicked: the crawl
// follows them as pages.
const MENU_TRIGGERS = [
  '[aria-haspopup]', '[aria-expanded="false"]', 'summary', '[role="tab"]',
  'nav button', 'nav a', 'nav li:has(> ul) > :first-child'
].join(', ');
// Skipped on purpose: they would pay, delete, send or end the session
const MENU_DANGER = /(delete|eliminar|borrar|remove|logout|log out|salir|cerrar sesi|pagar|pay|buy|comprar|checkout|enviar|send|submit|guardar|save|confirm)/i;

// ---------- pure helpers (unit tested) ----------

function normalizeUrl(href) {
  const url = new URL(href);
  url.hash = '';
  return url.href;
}

// The normalized URL of a link worth visiting, or null
function acceptLink(link, baseUrl, origin) {
  let url;
  try { url = new URL(link.href, baseUrl); } catch { return null; }
  if (url.origin !== origin) return null;
  if (link.method && link.method !== 'get') return null;  // data-method="post|delete…" simulates a form
  if (link.download) return null;
  if (SKIP_PATH.test(url.pathname) || SKIP_FILE.test(url.pathname)) return null;
  return normalizeUrl(url.href);
}

// Links to queue from a page: every new one from the start page, `deepLinks` from the rest
function linksToQueue(links, seen, depth, deepLinks) {
  const fresh = links.filter(link => !seen.has(link));
  return fresh.slice(0, depth === 0 ? fresh.length : deepLinks);
}

function sanitizeOptions(options = {}) {
  const out = { ...CRAWL_DEFAULTS };
  for (const key of Object.keys(CRAWL_DEFAULTS)) {
    if (options[key] === undefined) continue;
    if (typeof CRAWL_DEFAULTS[key] === 'boolean') { out[key] = !!options[key]; continue; }
    const [min, max] = CRAWL_LIMITS[key];
    const value = Number(options[key]);
    if (Number.isFinite(value)) out[key] = Math.min(max, Math.max(min, Math.round(value)));
  }
  return out;
}

const crawlSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------- state ----------

let crawl = null;   // the crawl in progress, or the last one that finished
const loadWaiters = new Map();
let progressWindowId = null;

function crawlRunning() {
  return !!crawl && ['starting', 'running', 'finishing'].includes(crawl.status);
}

function crawlAlive(c) {
  return state.capturing && state.tabId === c.tabId;
}

// What the progress window shows
function crawlSnapshot() {
  if (!crawl) return { status: 'idle' };
  const c = crawl;
  return {
    status: c.status,
    reason: c.reason,
    startUrl: c.startUrl,
    host: c.host,
    maxPages: c.options.maxPages,
    visited: c.pages.length,
    queued: c.queue.length,
    current: c.current,
    depth: c.currentDepth,
    recent: c.pages.slice(-CRAWL_RECENT).reverse().map(p => ({ url: p.url, depth: p.depth, title: p.title, menus: p.menusOpened, error: p.error })),
    requests: state.stored + pending.size,
    bytes: state.bytes,
    bodiesSkipped: state.bodiesSkipped,
    menusOpened: c.menusOpened,
    formsBlocked: c.formsBlocked,
    startedAt: c.startedAt,
    endedAt: c.endedAt,
    error: c.error,
    result: c.result
  };
}

// ---------- talking to the crawl tab ----------

function cdp(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function evalInPage(tabId, expression) {
  const result = await cdp(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error('page script failed');
  return result.result.value;
}

function waitForLoad(tabId, timeoutMs) {
  return new Promise(resolve => {
    const timer = setTimeout(() => { loadWaiters.delete(tabId); resolve(false); }, timeoutMs);
    loadWaiters.set(tabId, () => { clearTimeout(timer); resolve(true); });
  });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === 'Page.loadEventFired' && loadWaiters.has(source.tabId)) {
    const done = loadWaiters.get(source.tabId);
    loadWaiters.delete(source.tabId);
    done();
  } else if (method === 'Page.javascriptDialogOpening' && crawl && source.tabId === crawl.tabId) {
    // alert and beforeunload only block the page; a confirm() is answered "no"
    const accept = params.type === 'alert' || params.type === 'beforeunload';
    cdp(source.tabId, 'Page.handleJavaScriptDialog', { accept }).catch(() => {});
  }
});

// A closed tab will never fire its load event: wake the crawl up instead of waiting for the timeout
chrome.tabs.onRemoved.addListener(tabId => {
  const done = loadWaiters.get(tabId);
  if (done) { loadWaiters.delete(tabId); done(); }
});

// Tabs and popups the site opens while it is crawled are closed
chrome.tabs.onCreated.addListener(tab => {
  if (crawl && crawl.status === 'running' && tab.openerTabId === crawl.tabId) chrome.tabs.remove(tab.id).catch(() => {});
});

async function prepareCrawlTab(tabId) {
  await cdp(tabId, 'Page.enable');
  await cdp(tabId, 'Page.addScriptToEvaluateOnNewDocument', { source: FORM_GUARD });
  // Best effort: the page behaves as focused even though its window is in the background.
  // Downloads are not blocked with Page.setDownloadBehavior: that setting is not limited to
  // this tab and would reach the downloads of the whole browser profile. Links to files are
  // skipped instead (SKIP_FILE).
  try { await cdp(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }); } catch {}
}

async function loadPage(c, url) {
  const loaded = waitForLoad(c.tabId, CRAWL_LOAD_TIMEOUT_MS);
  let result;
  try {
    result = await cdp(c.tabId, 'Page.navigate', { url });
  } catch (err) {
    loadWaiters.delete(c.tabId);
    return { ok: false, url, error: errorText(err) };
  }
  if (result.errorText) {
    loadWaiters.delete(c.tabId);
    return { ok: false, url, error: result.errorText };
  }
  await loaded;                       // a slow page is still recorded: move on after the timeout
  await crawlSleep(c.options.settleMs);
  const href = await evalInPage(c.tabId, 'location.href').catch(() => url);
  return { ok: true, url: href };
}

// ---------- links and menus ----------

async function pageLinks(c, baseUrl) {
  const raw = await evalInPage(c.tabId, `Array.from(document.querySelectorAll('a[href]'), a => ({
    href: a.href, method: (a.getAttribute('data-method') || 'get').toLowerCase(), download: a.hasAttribute('download') }))`);
  const links = new Set();
  for (const link of raw) {
    const accepted = acceptLink(link, baseUrl, c.origin);
    if (accepted) links.add(accepted);
  }
  return links;
}

async function findMenuTriggers(tabId) {
  return evalInPage(tabId, `(() => {
    document.querySelectorAll('[data-ncp-menu]').forEach(el => el.removeAttribute('data-ncp-menu'));
    const danger = ${MENU_DANGER};
    const triggers = [];
    for (const el of document.querySelectorAll(${JSON.stringify(MENU_TRIGGERS)})) {
      // Inside a form a button can submit it. (button.type is "submit" by default even
      // outside forms, so it cannot be used to tell them apart.)
      if (el.closest('form') || el.disabled || el.matches('input, select, textarea') || el.hasAttribute('formaction')) continue;
      const label = (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 80);
      if (danger.test(label)) continue;
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const index = triggers.length;
      el.setAttribute('data-ncp-menu', String(index));
      const href = el.tagName === 'A' ? el.getAttribute('href') : null;
      triggers.push({ index, x: box.x + box.width / 2, y: box.y + box.height / 2, isLink: !!href && href !== '#' });
      if (triggers.length >= ${MAX_MENU_ACTIONS}) break;
    }
    return triggers;
  })()`);
}

async function openTrigger(tabId, trigger) {
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: trigger.x, y: trigger.y });
  await crawlSleep(MENU_DELAY_MS / 2);
  if (trigger.isLink) return;
  await evalInPage(tabId, `document.querySelector('[data-ncp-menu="${trigger.index}"]')?.click()`);
}

// Links of the current page, plus the ones that appear when its menus are opened
async function collectLinks(c, pageUrl) {
  const links = await pageLinks(c, pageUrl);
  let menusOpened = 0;
  if (c.options.menus) {
    for (const trigger of await findMenuTriggers(c.tabId)) {
      if (c.stopRequested || !crawlAlive(c)) break;
      await openTrigger(c.tabId, trigger);
      menusOpened++;
      await crawlSleep(MENU_DELAY_MS);
      if ((await evalInPage(c.tabId, 'location.href')) !== pageUrl) break;   // a click navigated away
      for (const link of await pageLinks(c, pageUrl)) links.add(link);
    }
  }
  return { links: [...links], menusOpened };
}

// ---------- the crawl ----------

async function visitPage(c, item) {
  c.current = item.url;
  c.currentDepth = item.depth;
  const startedAt = Date.now();
  const nav = await loadPage(c, item.url);
  c.seen.add(normalizeUrl(nav.url));        // a redirect ends on another URL: never queue that one again

  let links = [], menusOpened = 0;
  if (nav.ok && safeOrigin(nav.url) === c.origin) ({ links, menusOpened } = await collectLinks(c, nav.url));
  c.formsBlocked += Number(await evalInPage(c.tabId, 'window.__ncpBlockedForms || 0').catch(() => 0)) || 0;
  c.menusOpened += menusOpened;

  const title = await evalInPage(c.tabId, 'document.title').catch(() => '');
  c.pages.push({ url: nav.url, title, depth: item.depth, parent: item.parent, startedAt, endedAt: Date.now(),
    links: links.length, menusOpened, error: nav.error });

  if (item.depth >= c.options.maxDepth) return;
  for (const link of linksToQueue(links, c.seen, item.depth, c.options.deepLinks)) {
    c.seen.add(link);
    c.queue.push({ url: link, depth: item.depth + 1, parent: nav.url });
  }
}

function safeOrigin(url) {
  try { return new URL(url).origin; } catch { return null; }
}

async function runCrawl(c) {
  try {
    c.queue.push({ url: c.startUrl, depth: 0, parent: null });
    c.seen.add(normalizeUrl(c.startUrl));
    c.status = 'running';
    while (c.queue.length && !c.stopRequested) {
      if (c.pages.length >= c.options.maxPages) { c.reason = 'page limit reached'; break; }
      if (Date.now() - c.startedAt > c.options.maxMinutes * 60000) { c.reason = 'time limit reached'; break; }
      if (!crawlAlive(c)) { c.reason = 'the capture was stopped or its window closed'; break; }
      await visitPage(c, c.queue.shift());
    }
    if (!c.reason) c.reason = c.stopRequested ? 'stopped by you' : 'all reachable pages visited';
  } catch (err) {
    // Closing the crawl window or stopping the capture makes the next command fail. That is
    // how the crawl ends in those cases, not a failure.
    if (c.stopRequested || !crawlAlive(c)) c.reason = c.reason || 'the capture was stopped or its window closed';
    else c.error = errorText(err);
  }
  await finishCrawl(c);
}

function crawlReport(c) {
  const { maxPages, maxDepth, deepLinks, menus, settleMs } = c.options;
  return { startUrl: c.startUrl, options: { maxPages, maxDepth, deepLinks, menus, settle: settleMs }, pages: c.pages };
}

async function finishCrawl(c) {
  c.status = 'finishing';
  c.current = null;
  try {
    if (state.capturing && state.tabId === c.tabId) await finishCapture(true);
  } catch (err) {
    c.error = c.error || errorText(err);
  }
  chrome.windows.remove(c.windowId).catch(() => {});

  if (c.stopRequested === 'discard') {
    await clearCapture();
    c.status = 'cancelled';
  } else if (!c.pages.length) {
    await clearCapture();
    c.status = 'error';
    c.error = c.error || 'No page could be loaded';
  } else {
    state.crawlReport = crawlReport(c);
    await saveState();
    if (c.options.autoExport) {
      try { c.result = await downloadAll('zip'); } catch (err) { c.error = c.error || errorText(err); }
    }
    c.status = c.error ? 'error' : 'done';
  }
  c.endedAt = Date.now();
}

// ---------- entry points used by the message router ----------

async function startCrawl(rawUrl, options) {
  if (crawlRunning()) throw new Error('A crawl is already running');
  if (state.capturing) throw new Error('Stop the current capture before crawling');
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('Not a valid URL: ' + rawUrl); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https pages can be crawled');

  // A crawl is a capture session of its own. Never mix it with, or silently wipe, an earlier capture.
  const existing = state.stored + pending.size;
  if (existing && !(options && options.replace)) {
    throw new Error(`There is a capture with ${existing} requests. Download or clear it before crawling.`);
  }
  await clearCapture();

  const c = {
    status: 'starting', reason: null, startUrl: url.href, host: url.hostname, origin: url.origin,
    options: sanitizeOptions(options), tabId: null, windowId: null, startedAt: Date.now(), endedAt: null,
    pages: [], queue: [], seen: new Set(), current: null, currentDepth: 0,
    menusOpened: 0, formsBlocked: 0, stopRequested: null, error: null, result: null
  };
  crawl = c;
  try {
    const win = await chrome.windows.create({ url: 'about:blank', focused: false, width: 1280, height: 900 });
    c.windowId = win.id;
    c.tabId = win.tabs[0].id;
    await startCapture(c.tabId, { tabUrl: c.startUrl });
    await prepareCrawlTab(c.tabId);
  } catch (err) {
    c.status = 'error';
    c.error = errorText(err);
    c.endedAt = Date.now();
    if (c.windowId) chrome.windows.remove(c.windowId).catch(() => {});
    throw err;
  }
  if (c.options.showProgress) showCrawlProgress();
  runCrawl(c);          // runs on its own; the progress window follows it
}

function requestCrawlStop(mode) {
  if (crawlRunning() && !crawl.stopRequested) crawl.stopRequested = mode;
}

async function showCrawlProgress() {
  if (progressWindowId !== null) {
    try { await chrome.windows.update(progressWindowId, { focused: true }); return; } catch { progressWindowId = null; }
  }
  const win = await chrome.windows.create({ url: chrome.runtime.getURL('crawl.html'), type: 'popup', width: 540, height: 680, focused: true });
  progressWindowId = win.id;
}

chrome.windows.onRemoved.addListener(id => { if (id === progressWindowId) progressWindowId = null; });

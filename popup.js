// Popup controller — talks to background service worker.
const $ = (id) => document.getElementById(id);

const ui = {
  status: $('status'), dot: $('dot'),
  count: $('count'), timer: $('timer'), bytes: $('bytes'), startedAt: $('startedAt'),
  startBtn: $('startBtn'), pauseBtn: $('pauseBtn'), stopBtn: $('stopBtn'), clearBtn: $('clearBtn'),
  dlZip: $('dlZip'), dlJson: $('dlJson'), dlHar: $('dlHar'), dlCsv: $('dlCsv'),
  filter: $('filter'), typeFilter: $('typeFilter'), methodFilter: $('methodFilter'),
  list: $('list'), tabHost: $('tabHost'), openPanel: $('openPanel'),
  targetUrl: $('targetUrl'),
  openSite: $('openSite'), reloadSite: $('reloadSite'), hardReload: $('hardReload'),
  clearCookies: $('clearCookies'), clearCache: $('clearCache'),
  crawlBtn: $('crawlBtn'), crawlShowBtn: $('crawlShowBtn'), crawlMenus: $('crawlMenus'),
  crawlMaxPages: $('crawlMaxPages'), crawlMaxDepth: $('crawlMaxDepth'), crawlDeepLinks: $('crawlDeepLinks'),
};

let timerHandle = null;
let cachedRequests = [];
let lastState = null;

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B','KB','MB','GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
function fmtElapsed(start, end) {
  if (!start) return '00:00';
  const ms = (end || Date.now()) - start;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (h ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}
function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return d.toLocaleTimeString();
}

async function send(type, data = {}) {
  return await chrome.runtime.sendMessage({ target: 'background', type, ...data });
}

async function refreshState() {
  // show extension version + ping background so user sees if SW is stale
  try {
    const m = chrome.runtime.getManifest();
    const ver = document.getElementById('ver');
    if (ver) ver.textContent = 'v' + m.version;
  } catch {}
  const s = await send('GET_STATE');
  if (!s) {
    ui.status.textContent = 'SW not responding — reload extension!';
    return;
  }
  if (s.swVersion && s.swVersion !== chrome.runtime.getManifest().version) {
    ui.status.textContent = `Stale SW (${s.swVersion}) — reload extension!`;
  }
  lastState = s;
  ui.count.textContent = s.count;
  ui.bytes.textContent = fmtBytes(s.bytes);
  ui.startedAt.textContent = fmtTime(s.startTime);
  ui.timer.textContent = fmtElapsed(s.startTime, s.endTime);

  let label = 'Idle', cls = 'idle';
  if (s.crawling) { label = 'Crawling site'; cls = 'rec'; }
  else if (s.capturing && !s.paused) { label = 'Recording'; cls = 'rec'; }
  else if (s.paused) { label = 'Paused'; cls = 'paused'; }
  // Bodies are kept in memory up to a limit; say so instead of silently dropping them
  if (s.bodiesSkipped) label += ` · ${s.bodiesSkipped} bodies skipped (memory limit)`;
  if (s.lostEntries) label += ` · ${s.lostEntries} requests not stored`;
  ui.status.textContent = label;
  ui.dot.className = 'dot ' + cls;

  ui.startBtn.disabled = s.capturing;
  ui.pauseBtn.disabled = !s.capturing;
  ui.stopBtn.disabled  = !s.capturing;
  // A crawl is a capture of its own: only one at a time, and its progress has its own window
  ui.crawlBtn.hidden = !!s.crawling;
  ui.crawlBtn.disabled = s.capturing;
  ui.crawlShowBtn.hidden = !s.crawling;
  ui.pauseBtn.textContent = s.paused ? '▶ Resume' : '‖ Pause';

  // determine the "target" URL — captured tab if available, else current active tab
  let target = s.tabUrl;
  if (!target) {
    try {
      const r = await send('GET_TARGET_URL');
      if (r && r.url) target = r.url;
    } catch {}
  }
  if (target) {
    try { ui.tabHost.textContent = new URL(target).hostname; }
    catch { ui.tabHost.textContent = target.slice(0, 40); }
    ui.targetUrl.textContent = target;
    ui.targetUrl.href = target;
    ui.targetUrl.dataset.url = target;
  } else {
    ui.tabHost.textContent = '-';
    ui.targetUrl.textContent = '(no active tab)';
    ui.targetUrl.removeAttribute('href');
    delete ui.targetUrl.dataset.url;
  }
}

async function refreshList() {
  const { requests } = await send('GET_REQUEST_LIST');
  cachedRequests = requests || [];
  renderList();
}

// The list holds summaries only; the full entry (headers, bodies) is fetched on click
async function fullRequest(summary) {
  const { request } = await send('GET_REQUEST', { id: summary.id });
  return request || summary;
}

function statusClass(code) {
  if (!code) return 'warn';
  if (code >= 500) return 'err';
  if (code >= 400) return 'err';
  if (code >= 300) return 'warn';
  return 'ok';
}

function renderList() {
  const q = ui.filter.value.trim().toLowerCase();
  const tf = ui.typeFilter.value;
  const mf = ui.methodFilter.value;
  ui.list.innerHTML = '';
  const sorted = cachedRequests.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
  let shown = 0;
  for (const e of sorted) {
    if (tf && e.resourceType !== tf) continue;
    if (mf && e.method !== mf) continue;
    if (q) {
      const hay = `${e.method || ''} ${e.url || ''} ${e.responseStatus || ''}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    shown++;
    const row = document.createElement('div');
    row.className = 'row';
    const status = e.failed ? 'ERR' : (e.responseStatus || '…');
    const sc = e.failed ? 'err' : statusClass(e.responseStatus);
    const path = (e.pathname || '') + (e.search || '');
    const host = e.hostname || '';
    row.innerHTML = `
      <span class="m">${e.method || ''}</span>
      <span class="s ${sc}">${status}</span>
      <span class="u" title="${(e.url || '').replace(/"/g,'&quot;')}">${host}${path}</span>
      <span class="t">${e.duration ? Math.round(e.duration) + 'ms' : ''}</span>
    `;
    row.addEventListener('click', async () => toggleDetail(row, await fullRequest(e)));
    ui.list.appendChild(row);
    if (shown >= 200) break; // cap UI
  }
  if (!shown) {
    const empty = document.createElement('div');
    empty.className = 'detail';
    empty.style.textAlign = 'center';
    empty.textContent = cachedRequests.length
      ? 'No requests match your filter.'
      : 'No requests yet — press Start to begin capturing.';
    ui.list.appendChild(empty);
  }
}

function toggleDetail(row, entry) {
  const next = row.nextElementSibling;
  if (next && next.classList.contains('detail')) { next.remove(); return; }
  const d = document.createElement('div');
  d.className = 'detail';
  d.textContent = JSON.stringify(slim(entry), null, 2);
  row.after(d);
}

function slim(e) {
  const out = { ...e };
  if (out.responseBody && out.responseBody.length > 4000) {
    out.responseBody = out.responseBody.slice(0, 4000) + ` …(truncated, ${e.responseBody.length} chars total)`;
  }
  return out;
}

// ---------- handlers ----------
ui.startBtn.addEventListener('click', async () => {
  ui.startBtn.disabled = true;
  const res = await send('START');
  if (!res || !res.ok) alert('Start failed: ' + (res && res.error));
  await refreshAll();
});
ui.pauseBtn.addEventListener('click', async () => {
  if (!lastState) return;
  await send(lastState.paused ? 'RESUME' : 'PAUSE');
  await refreshAll();
});
ui.stopBtn.addEventListener('click', async () => {
  await send('STOP');
  await refreshAll();
});
ui.clearBtn.addEventListener('click', async () => {
  if (lastState && lastState.count && !confirm(`Clear ${lastState.count} captured requests?`)) return;
  await send('CLEAR');
  await refreshAll();
});

async function doDownload(format) {
  try {
    const res = await send('DOWNLOAD', { format });
    if (!res || !res.ok) throw new Error(res && res.error || 'unknown error');
    flash('✓ Download started: ' + (res.filename || ''));
  } catch (e) {
    alert('Download failed: ' + (e && e.message || e));
  }
}

function flash(msg, danger=false) {
  ui.status.textContent = msg;
  ui.status.style.color = danger ? '#ff7a6c' : '#3ddc84';
  setTimeout(() => { ui.status.style.color = ''; refreshState(); }, 2200);
}

async function clearSite(kind) {
  const url = ui.targetUrl.dataset.url;
  if (!url) { alert('No target site — open a tab or start a capture first.'); return; }
  let host;
  try { host = new URL(url).hostname; } catch { host = url; }
  const labels = {
    cookies: `Clear cookies for ${host}?`,
    cache:   `Clear cache for ${host}?`,
    all:     `Clear ALL site data (cookies + cache + localStorage + IndexedDB + serviceWorkers) for ${host}?\n\nYou will be logged out.`
  };
  if (!confirm(labels[kind])) return;
  const type = kind === 'cookies' ? 'CLEAR_SITE_COOKIES'
            : kind === 'cache'   ? 'CLEAR_SITE_CACHE'
            : 'CLEAR_SITE_DATA';
  try {
    const r = await send(type, { url });
    if (!r || !r.ok) throw new Error(r && r.error || 'failed');
    flash(`✓ Cleared ${kind === 'all' ? 'all data' : kind} for ${host}`);
  } catch (e) {
    flash('✗ ' + (e.message || e), true);
  }
}
ui.dlZip .addEventListener('click', () => doDownload('zip'));
ui.dlJson.addEventListener('click', () => doDownload('json'));
ui.dlHar .addEventListener('click', () => doDownload('har'));
ui.dlCsv .addEventListener('click', () => doDownload('csv'));

ui.filter.addEventListener('input', renderList);
ui.typeFilter.addEventListener('change', renderList);
ui.methodFilter.addEventListener('change', renderList);

ui.openPanel.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') });
});

ui.targetUrl.addEventListener('click', async (e) => {
  e.preventDefault();
  if (ui.targetUrl.dataset.url) await send('OPEN_TARGET', { url: ui.targetUrl.dataset.url });
});
ui.openSite  .addEventListener('click', async () => {
  if (ui.targetUrl.dataset.url) await send('OPEN_TARGET', { url: ui.targetUrl.dataset.url });
});
ui.reloadSite.addEventListener('click', async () => { await send('RELOAD_TARGET'); flash('✓ Reloaded'); });
ui.hardReload.addEventListener('click', async () => { await send('RELOAD_TARGET', { bypassCache: true }); flash('✓ Hard reloaded'); });
ui.clearCookies.addEventListener('click', () => clearSite('cookies'));
ui.clearCache  .addEventListener('click', () => clearSite('cache'));

// ---------- capture whole site ----------
const CRAWL_OPTS_KEY = 'ncp_crawl_opts';
const CRAWL_NUMBERS = { maxPages: ui.crawlMaxPages, maxDepth: ui.crawlMaxDepth, deepLinks: ui.crawlDeepLinks };
const CRAWL_UI_DEFAULTS = { maxPages: 200, maxDepth: 5, deepLinks: 1, menus: true };

function readCrawlOptions() {
  const options = { menus: ui.crawlMenus.checked };
  for (const [key, input] of Object.entries(CRAWL_NUMBERS)) options[key] = Number(input.value);
  return options;
}

async function loadCrawlOptions() {
  let saved = {};
  try { saved = (await chrome.storage.local.get(CRAWL_OPTS_KEY))[CRAWL_OPTS_KEY] || {}; } catch {}
  const options = { ...CRAWL_UI_DEFAULTS, ...saved };
  for (const [key, input] of Object.entries(CRAWL_NUMBERS)) input.value = options[key];
  ui.crawlMenus.checked = options.menus;
}

for (const el of [...Object.values(CRAWL_NUMBERS), ui.crawlMenus]) {
  el.addEventListener('change', () => chrome.storage.local.set({ [CRAWL_OPTS_KEY]: readCrawlOptions() }).catch(() => {}));
}

ui.crawlBtn.addEventListener('click', async () => {
  // The site to crawl is the page this window is showing, not the last captured tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let url;
  try {
    url = new URL(tab && tab.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('not a web page');
  } catch {
    alert('Open the site you want to capture in this window first (an http or https page).');
    return;
  }
  const options = readCrawlOptions();
  const existing = lastState ? lastState.count : 0;
  const replaces = existing ? `\n\nThis replaces the ${existing} requests currently captured. Download them first if you need them.` : '';
  const question = `Capture ${url.hostname}?\n\nIt will visit up to ${options.maxPages} pages of this site in a new window, using your session, and download a ZIP. Forms are never submitted.${replaces}\n\nOnly do this on sites you own or are authorized to test.`;
  if (!confirm(question)) return;
  ui.crawlBtn.disabled = true;
  const res = await send('CRAWL_START', { url: url.href, options: { ...options, replace: true } });
  if (!res || !res.ok) alert('Could not start the crawl: ' + (res && res.error));
  await refreshAll();
});
ui.crawlShowBtn.addEventListener('click', () => send('CRAWL_SHOW'));
loadCrawlOptions();

async function refreshAll() {
  await refreshState();
  await refreshList();
}

refreshAll();
timerHandle = setInterval(() => {
  if (lastState && lastState.capturing) {
    ui.timer.textContent = fmtElapsed(lastState.startTime, null);
    refreshAll();
  }
}, 1000);

window.addEventListener('unload', () => { if (timerHandle) clearInterval(timerHandle); });


#!/usr/bin/env node
// Runs "Capture whole site" from the terminal: opens Brave or Chrome with the extension loaded,
// starts the extension's own crawler, waits for it and saves the capture. The crawling itself
// (links, menus, never submitting forms) is done by the extension, in crawl.js; this script
// only launches the browser, keeps the login session, and collects the ZIP.
// Runs with Node 22+ and has no dependencies.
//
//   node tools/crawl-capture.js <startUrl> [options]
//   node tools/crawl-capture.js <startUrl> --login     (log in first; the profile keeps the session)
//
// Options:
//   --browser <path>     Chrome or Brave binary (default: Brave, then Chrome)
//   --profile <dir>      Browser profile, kept between runs so sessions survive
//   --out <dir>          Where the ZIP is saved (default: ./captures)
//   --format <f>         zip | json | har | csv (default: zip)
//   --max-pages <n>      Stop after n pages (default: 200)
//   --max-depth <n>      Follow links up to n clicks from the start page (default: 5)
//   --deep-links <n>     On pages below the start page, follow only n new links (default: 1)
//   --no-menus           Do not open menus (hover and click on navigation triggers)
//   --settle <ms>        Wait after each page load for XHR/fetch to finish (default: 1500)
//   --headless           Run without a visible window (login needs a visible window)
//   --port <n>           Remote debugging port (default: 9333)

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const EXTENSION_DIR = path.resolve(__dirname, '..');
const BROWSERS = [
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];
const POLL_MS = 1000;

// ---------- options ----------

function parseArgs(argv) {
  const opts = {
    startUrl: null, browser: null, profile: null, out: path.resolve('captures'), format: 'zip',
    maxPages: 200, maxDepth: 5, deepLinks: 1, menus: true, settle: 1500, headless: false, login: false, port: 9333
  };
  const numeric = ['maxPages', 'maxDepth', 'deepLinks', 'settle', 'port'];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--login') opts.login = true;
    else if (arg === '--headless') opts.headless = true;
    else if (arg === '--no-menus') opts.menus = false;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (!(key in opts)) throw new Error('unknown option ' + arg);
      const value = argv[++i];
      opts[key] = numeric.includes(key) ? Number(value) : key === 'out' ? path.resolve(value) : value;
    } else opts.startUrl = arg;
  }
  if (!opts.startUrl) throw new Error('usage: crawl-capture.js <startUrl> [options]');
  if (opts.login && opts.headless) throw new Error('--login needs a visible window; remove --headless');
  opts.startUrl = new URL(opts.startUrl).href;
  opts.browser = opts.browser || BROWSERS.find(p => fs.existsSync(p));
  if (!opts.browser) throw new Error('no Brave or Chrome found; pass --browser <path>');
  opts.profile = opts.profile || path.join(os.homedir(), '.network-capture-profiles', new URL(opts.startUrl).hostname);
  return opts;
}

// ---------- browser process ----------

function launchBrowser(opts) {
  const args = [
    `--remote-debugging-port=${opts.port}`,
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${opts.profile}`,
    '--no-first-run', '--no-default-browser-check'
  ];
  if (opts.headless) args.push('--headless=new');
  args.push('about:blank');
  return spawn(opts.browser, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
}

// Extensions.loadUnpacked is only served over --remote-debugging-pipe (fd 3 = commands,
// fd 4 = replies, NUL-terminated JSON). Chrome and Brave both accept it.
function loadExtension(browserProcess, dir) {
  return new Promise((resolve, reject) => {
    browserProcess.once('exit', () => reject(new Error('the browser exited before the extension was loaded')));
    let buffer = '';
    browserProcess.stdio[4].on('data', chunk => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\0')) >= 0) {
        const msg = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (msg.id !== 1) continue;
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result.id);
      }
    });
    browserProcess.stdio[3].write(JSON.stringify({ id: 1, method: 'Extensions.loadUnpacked', params: { path: dir } }) + '\0');
  });
}

// ---------- DevTools protocol over WebSocket ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));
const BROWSER_GONE = 'the browser closed the connection (it probably crashed or ran out of memory); nothing was saved';

async function getJson(port, route) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`);
  return res.json();
}

async function waitFor(fn, label, timeoutMs = 60000) {
  const started = Date.now();
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {}
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for ' + label);
    await sleep(250);
  }
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 0;
  let closed = false;
  const pending = new Map();
  // A dead browser never answers: fail every call that is waiting instead of hanging forever
  ws.onclose = () => {
    closed = true;
    for (const { reject } of pending.values()) reject(new Error(BROWSER_GONE));
    pending.clear();
  };
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  return {
    ready: new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }),
    send(method, params = {}) {
      if (closed) return Promise.reject(new Error(BROWSER_GONE));
      const id = ++nextId;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    // Runs JavaScript in the page and returns its value; promises are awaited
    async eval(expression) {
      const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 500));
      return result.result.value;
    },
    close() { ws.close(); }
  };
}

async function openTarget(port, browserWs, url) {
  await browserWs.send('Target.createTarget', { url });
  return waitFor(async () => {
    const target = (await getJson(port, '/json/list')).find(t => t.url === url && t.type === 'page');
    return target && connect(target.webSocketDebuggerUrl);
  }, 'tab ' + url).then(async client => { await client.ready; return client; });
}

// ---------- the crawl, run by the extension ----------

// Prints the pages the extension has visited since the last call
function printProgress(state, printed) {
  const fresh = Math.min(state.visited - printed, state.recent.length);
  for (const page of state.recent.slice(0, fresh).reverse()) {
    console.log(`  [${++printed}] depth ${page.depth}  menus ${page.menus || 0}  ${page.url}${page.error ? '  (' + page.error + ')' : ''}`);
  }
  return Math.max(printed, state.visited);
}

async function runCrawl(send, opts) {
  await send({
    type: 'CRAWL_START',
    url: opts.startUrl,
    options: {
      maxPages: opts.maxPages, maxDepth: opts.maxDepth, deepLinks: opts.deepLinks,
      menus: opts.menus, settleMs: opts.settle, autoExport: false, showProgress: false, replace: true
    }
  }).then(reply => { if (!reply || !reply.ok) throw new Error(reply && reply.error || 'could not start the crawl'); });

  let printed = 0;
  for (;;) {
    const state = await send({ type: 'CRAWL_STATE' });
    printed = printProgress(state, printed);
    if (!['starting', 'running', 'finishing'].includes(state.status)) return state;
    await sleep(POLL_MS);
  }
}

// ---------- capture export ----------

// Chrome saves downloads under a random name in some modes, so the file is moved to the
// name the extension suggested (network_capture_<domain>_<date>.zip).
async function exportCapture(ctrl, opts) {
  const reply = await ctrl.eval(`chrome.runtime.sendMessage(${JSON.stringify({ type: 'DOWNLOAD', format: opts.format })})`);
  if (!reply || !reply.ok) throw new Error('export failed: ' + (reply && reply.error));
  const item = await waitFor(async () => {
    const [found] = await ctrl.eval(`chrome.downloads.search({ id: ${reply.downloadId} })`);
    return found && found.state === 'complete' ? found : null;
  }, 'download to finish', 600000);
  fs.mkdirSync(opts.out, { recursive: true });
  const target = path.join(opts.out, reply.filename);
  fs.renameSync(item.filename, target);
  // Forget the download in the browser too, so the profile keeps no record of the export
  await ctrl.eval(`chrome.downloads.erase({ id: ${reply.downloadId} })`).catch(() => {});
  return target;
}

// ---------- cleanup ----------

// Caches and crash dumps that a crawl leaves in the profile. Cookies, local storage and
// preferences stay, because they hold the login session.
const PROFILE_TRASH = [
  'Default/Cache', 'Default/Code Cache', 'Default/GPUCache', 'Default/DawnGraphiteCache', 'Default/DawnWebGPUCache',
  'Default/blob_storage', 'Default/Service Worker/CacheStorage', 'Default/Service Worker/ScriptCache',
  'GrShaderCache', 'ShaderCache', 'GraphiteDawnCache', 'Crashpad', 'BrowserMetrics', 'component_crx_cache',
  'extensions_crx_cache'
];

function dirSize(target) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      const full = path.join(target, entry.name);
      total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
    }
  } catch {}
  return total;
}

function cleanProfile(profile) {
  let freed = 0;
  for (const relative of PROFILE_TRASH) {
    const target = path.join(profile, relative);
    if (!fs.existsSync(target)) continue;
    freed += dirSize(target);
    fs.rmSync(target, { recursive: true, force: true });
  }
  if (freed) console.log(`profile caches removed (${(freed / 1048576).toFixed(1)} MiB); the login session is kept`);
}

// A browser killed in the middle of a download leaves a .crdownload file behind
function removePartialDownloads(dir) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.crdownload')) fs.rmSync(path.join(dir, name), { force: true });
    }
  } catch {}
}

// ---------- main ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log('browser  ', opts.browser);
  console.log('profile  ', opts.profile);
  const browserProcess = launchBrowser(opts);
  let browserWs;
  try {
    const version = await waitFor(() => getJson(opts.port, '/json/version'), 'browser to start');
    browserWs = connect(version.webSocketDebuggerUrl);
    await browserWs.ready;
    const extensionId = await loadExtension(browserProcess, EXTENSION_DIR);
    console.log('extension', extensionId);
    await browserWs.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: opts.out });

    const ctrl = await openTarget(opts.port, browserWs, `chrome-extension://${extensionId}/popup.html`);
    const send = msg => ctrl.eval(`chrome.runtime.sendMessage(${JSON.stringify({ target: 'background', ...msg })})`);

    if (opts.login) {
      // The crawl uses the cookies of this browser, so logging in on any tab is enough
      const loginPage = await openTarget(opts.port, browserWs, opts.startUrl);
      await waitForEnter('Log in in the browser window, then press Enter here to start crawling.');
      loginPage.close();
      console.log('crawling with the new session');
    }

    console.log('crawl started');
    const result = await runCrawl(send, opts);
    if (result.status === 'cancelled') throw new Error('the crawl was cancelled; nothing was saved');
    if (result.status === 'error' && !result.visited) throw new Error(result.error);
    if (result.error) console.log('warning:', result.error);
    console.log(`crawled ${result.visited} pages (${result.reason}), ${result.requests} requests, ${(result.bytes / 1048576).toFixed(1)} MiB, ${result.menusOpened} menus opened, ${result.formsBlocked} form submissions blocked`);

    const file = await exportCapture(ctrl, opts);
    console.log('saved', file);
    ctrl.close();
  } finally {
    await closeBrowser(browserWs, browserProcess);
    cleanProfile(opts.profile);
    removePartialDownloads(opts.out);
  }
}

// Closes through the DevTools protocol so the browser flushes cookies to the profile
async function closeBrowser(browserWs, browserProcess) {
  try { if (browserWs) await browserWs.send('Browser.close'); } catch {}
  await waitFor(async () => browserProcess.exitCode !== null || browserProcess.signalCode !== null, 'browser to exit', 15000)
    .catch(() => browserProcess.kill('SIGKILL'));
}

// Waits for the user to press Enter (or for stdin to close, so scripts can skip the pause)
function waitForEnter(message) {
  console.log(message);
  const rl = readline.createInterface({ input: process.stdin });
  return new Promise(resolve => { rl.on('line', resolve); rl.on('close', resolve); })
    .finally(() => rl.close());
}

main().catch(err => {
  console.error('error:', err.message);
  process.exitCode = 1;
});

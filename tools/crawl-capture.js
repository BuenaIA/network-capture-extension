#!/usr/bin/env node
// Crawls a site in a real browser while Network Capture Extension records every request,
// then saves the capture as a ZIP. Runs with Node 22+ and has no dependencies.
//
//   node tools/crawl-capture.js <startUrl> [options]
//   node tools/crawl-capture.js <startUrl> --login     (log in once; the profile keeps the session)
//
// Options:
//   --browser <path>     Chrome or Brave binary (default: Brave, then Chrome)
//   --profile <dir>      Browser profile, kept between runs so sessions survive
//   --out <dir>          Where the ZIP is saved (default: ./captures)
//   --format <f>         zip | json | har | csv (default: zip)
//   --max-pages <n>      Stop after n pages (default: 200)
//   --max-depth <n>      Follow links up to n clicks from the start page (default: 5)
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
// Links that would end the session or point to binary files are not followed
const SKIP_PATH = /(logout|log-out|signout|sign-out|salir|cerrar-sesion)/i;
const SKIP_FILE = /\.(jpe?g|png|gif|webp|svg|ico|css|js|mp3|mp4|webm|woff2?|ttf|zip|gz|exe|dmg)$/i;

// ---------- options ----------

function parseArgs(argv) {
  const opts = {
    startUrl: null, browser: null, profile: null, out: path.resolve('captures'), format: 'zip',
    maxPages: 200, maxDepth: 5, settle: 1500, headless: false, login: false, port: 9333
  };
  const numeric = ['maxPages', 'maxDepth', 'settle', 'port'];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--login') opts.login = true;
    else if (arg === '--headless') opts.headless = true;
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
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method && listeners.has(msg.method)) {
      listeners.get(msg.method).forEach(fn => fn(msg.params));
    }
  };
  return {
    ready: new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }),
    send(method, params = {}) {
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
    // Resolves with the next event of this method, or rejects after timeoutMs
    nextEvent(method, timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for ' + method)), timeoutMs);
        listeners.set(method, [params => { clearTimeout(timer); resolve(params); }]);
      });
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

// ---------- crawl ----------

function normalize(href) {
  const url = new URL(href);
  url.hash = '';
  return url.href;
}

async function extractLinks(page, origin, baseUrl) {
  const hrefs = await page.eval('Array.from(document.querySelectorAll("a[href]"), a => a.href)');
  const links = new Set();
  for (const href of hrefs) {
    let url;
    try { url = new URL(href, baseUrl); } catch { continue; }
    if (url.origin !== origin || SKIP_PATH.test(url.pathname) || SKIP_FILE.test(url.pathname)) continue;
    links.add(normalize(url.href));
  }
  return [...links];
}

async function loadPage(page, url, settle) {
  const loaded = page.nextEvent('Page.loadEventFired', 30000);
  await page.send('Page.navigate', { url });
  await loaded.catch(() => {});  // slow pages are still recorded; move on after the timeout
  await sleep(settle);
  return page.eval('location.href');
}

async function crawl(page, opts) {
  const origin = new URL(opts.startUrl).origin;
  const queue = [{ url: opts.startUrl, depth: 0 }];
  const seen = new Set([normalize(opts.startUrl)]);
  const visited = [];
  while (queue.length && visited.length < opts.maxPages) {
    const { url, depth } = queue.shift();
    const finalUrl = await loadPage(page, url, opts.settle);
    seen.add(normalize(finalUrl));  // redirects end on another URL; never queue that one again
    visited.push(finalUrl);
    console.log(`  [${visited.length}] depth ${depth}  ${finalUrl}`);
    if (depth >= opts.maxDepth) continue;
    for (const link of await extractLinks(page, origin, finalUrl)) {
      if (seen.has(link)) continue;
      seen.add(link);
      queue.push({ url: link, depth: depth + 1 });
    }
  }
  return visited;
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
  return target;
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
    const page = await openTarget(opts.port, browserWs, opts.startUrl);
    await page.send('Page.enable');
    const tabId = await waitFor(() => ctrl.eval(`chrome.tabs.query({ url: ${JSON.stringify(new URL(opts.startUrl).origin + '/*')} }).then(t => t[0] && t[0].id)`), 'tab id');
    const send = msg => ctrl.eval(`chrome.runtime.sendMessage(${JSON.stringify(msg)})`);

    // Capture starts before login, so the login requests are part of the capture too
    console.log('capture started');
    await send({ type: 'START', tabId });
    if (opts.login) {
      await waitForEnter('Log in in the browser window, then press Enter here to start crawling.');
      console.log('crawling with the new session');
    }
    const visited = await crawl(page, opts);
    await send({ type: 'STOP' });
    const state = await send({ type: 'GET_STATE' });
    console.log(`crawled ${visited.length} pages, ${state.count} requests, ${(state.bytes / 1048576).toFixed(1)} MiB`);

    const file = await exportCapture(ctrl, opts);
    console.log('saved', file);
    ctrl.close(); page.close();
  } finally {
    await closeBrowser(browserWs, browserProcess);
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

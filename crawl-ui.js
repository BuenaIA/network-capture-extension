// Progress window of "Capture whole site". The crawl itself runs in the service worker
// (crawl.js); this page only polls its state and sends the stop and cancel requests.

const $ = id => document.getElementById(id);
const send = (type, data = {}) => chrome.runtime.sendMessage({ target: 'background', type, ...data });

const POLL_MS = 500;
const ACTIVE = ['starting', 'running', 'finishing'];

function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

function shortUrl(url) {
  try { const u = new URL(url); return u.pathname + u.search || '/'; } catch { return url; }
}

function renderRecent(pages) {
  const list = $('recent');
  list.replaceChildren();
  for (const page of pages) {
    const li = document.createElement('li');
    if (page.error) li.className = 'err';
    li.title = page.url + (page.error ? ' — ' + page.error : '');
    const depth = document.createElement('span');
    depth.className = 'd';
    depth.textContent = 'L' + page.depth;
    const path = document.createElement('span');
    path.textContent = shortUrl(page.url);
    li.append(depth, path);
    if (page.menus) {
      const menus = document.createElement('span');
      menus.className = 'm';
      menus.textContent = page.menus + ' menus';
      li.append(menus);
    }
    list.append(li);
  }
}

const PHASES = {
  starting: 'Opening the crawl window…',
  running: 'Visiting pages…',
  finishing: 'Stopping and saving the capture…'
};

function render(s) {
  const active = ACTIVE.includes(s.status);
  $('stopBtn').hidden = $('cancelBtn').hidden = !active;
  $('stopBtn').disabled = $('cancelBtn').disabled = s.status !== 'running';
  $('closeBtn').hidden = active;

  if (s.status === 'idle') {
    $('phase').textContent = 'No crawl in progress';
    return;
  }

  $('host').textContent = s.host || '';
  $('visited').textContent = s.visited;
  $('queued').textContent = s.queued;
  $('requests').textContent = s.requests;
  $('bytes').textContent = fmtBytes(s.bytes);
  $('menus').textContent = s.menusOpened;
  $('elapsed').textContent = fmtElapsed((s.endedAt || Date.now()) - s.startedAt);
  $('current').textContent = s.current ? shortUrl(s.current) : '-';
  $('blocked').textContent = s.formsBlocked ? ` (${s.formsBlocked} blocked)` : '';
  renderRecent(s.recent || []);

  // Progress against what is known to be left; the queue grows while pages are visited
  const total = Math.max(1, Math.min(s.maxPages, s.visited + s.queued));
  const fill = $('fill');
  fill.className = 'fill';
  if (s.status === 'starting' || s.status === 'finishing') {
    fill.classList.add('busy');
    $('barText').textContent = '';
  } else {
    fill.style.width = (s.status === 'running' ? Math.min(100, (s.visited / total) * 100) : 100) + '%';
    $('barText').textContent = `${s.visited} of ${total} pages (limit ${s.maxPages})`;
  }
  if (s.status === 'done') fill.classList.add('done');
  if (s.status === 'error') fill.classList.add('error');

  const phase = $('phase');
  if (active) phase.textContent = PHASES[s.status];
  else if (s.status === 'done') phase.textContent = `Done — ${s.reason}`;
  else if (s.status === 'cancelled') phase.textContent = 'Cancelled — nothing was saved';
  else phase.textContent = 'Something went wrong';

  const result = $('result');
  result.hidden = active;
  result.className = 'result';
  if (s.status === 'done' && s.result) {
    result.classList.add('ok');
    result.textContent = `Saved ${s.result.filename} in your Downloads folder. It includes site-schema.md with the map of the pages.`;
  } else if (s.error) {
    result.classList.add('err');
    result.textContent = s.error + (s.visited ? ' The pages captured so far were kept.' : '');
  } else if (s.status === 'done') {
    result.textContent = 'Capture finished. Use the ZIP button in the extension to download it.';
  } else {
    result.hidden = true;
  }
}

let timer = null;
async function refresh() {
  try {
    const state = await send('CRAWL_STATE');
    render(state || { status: 'idle' });
    if (state && !ACTIVE.includes(state.status)) { clearInterval(timer); timer = null; }
  } catch (err) {
    $('phase').textContent = 'The extension is not responding: ' + (err && err.message || err);
  }
}

$('stopBtn').addEventListener('click', async () => { $('stopBtn').disabled = true; await send('CRAWL_STOP'); });
$('cancelBtn').addEventListener('click', async () => {
  if (!confirm('Cancel the crawl and discard what was captured?')) return;
  await send('CRAWL_CANCEL');
});
$('closeBtn').addEventListener('click', () => window.close());

refresh();
timer = setInterval(refresh, POLL_MS);

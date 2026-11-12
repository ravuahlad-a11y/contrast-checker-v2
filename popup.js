// popup.js (v2): runs the scanner in every frame, passes each iframe's
// context from its parent page, and reports any frame that could not be scanned.

const $ = id => document.getElementById(id);
let tabId = null;
let items = [];
const RANK = { fail: 0, review: 1, covered: 2, pass: 3 };

function setStatus(text) { $('status').textContent = text; }

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found.');
  return tab;
}

// Returns [{frameId, result}] for every frame where the function ran.
async function runInAllFrames(fn, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: fn,
    args
  });
  return results.filter(r => r.result !== undefined && r.result !== null)
    .map(r => ({ frameId: r.frameId, result: r.result }));
}

async function ensureScanner() {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['scanner.js'] });
}

async function scan() {
  try {
    const tab = await activeTab();
    tabId = tab.id;
    setStatus('Scanning every frame…');
    await ensureScanner();

    // Step 1: each frame describes its iframes (covered? overlaid? what is behind them?).
    const ctxParts = await runInAllFrames(() => window.__contrastFrameContexts());
    const ctxMap = Object.assign({}, ...ctxParts.map(p => p.result));

    // Step 2: each frame scans its own text, using the context its parent provided.
    const frames = await runInAllFrames(map => window.__contrastScan(map), [ctxMap]);
    const scannedIds = new Set(frames.map(f => f.frameId));
    items = frames.flatMap(f => f.result.items);

    // Step 3: list frames Chrome knows about that returned nothing.
    const all = await chrome.webNavigation.getAllFrames({ tabId });
    const missed = all.filter(f => !scannedIds.has(f.frameId) && f.url && !f.url.startsWith('about:blank'));

    if ($('highlight').checked) {
      await runInAllFrames(on => window.__contrastHighlight(on), [true]);
    }
    render();

    const skipped = frames.filter(f => f.result.skipped).length;
    const covered = items.filter(i => i.status === 'covered').length;
    let msg = `Checked ${items.length} text items across ${frames.length} frame(s).`;
    if (covered) msg += ` ${covered} hidden under other elements (not checked).`;
    if (skipped) msg += ` ${skipped} frame(s) skipped by the parent page.`;
    if (missed.length) msg += ` WARNING: ${missed.length} frame(s) could not be scanned: ${missed.map(m => m.url).join(', ')}`;
    setStatus(msg);
  } catch (err) {
    setStatus('This page cannot be scanned: ' + err.message);
  }
}

function render() {
  const counts = { pass: 0, fail: 0, review: 0 };
  items.forEach(i => { if (i.status in counts) counts[i.status]++; });
  $('nPass').textContent = counts.pass;
  $('nFail').textContent = counts.fail;
  $('nReview').textContent = counts.review;
  $('nTotal').textContent = items.length;
  $('summary').hidden = false;
  $('filterRow').hidden = false;
  renderList();
}

function renderList() {
  const filter = $('filter').value;
  const list = $('list');
  list.replaceChildren();

  const shown = items
    .filter(i => filter === 'all' || i.status === filter)
    .sort((a, b) => RANK[a.status] - RANK[b.status]);

  if (shown.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Nothing to show for this filter.';
    list.appendChild(p);
    return;
  }

  for (const item of shown) {
    const li = document.createElement('li');

    const badge = document.createElement('div');
    badge.className = 'badge ' + item.status;
    badge.textContent = item.ratio === null
      ? item.status
      : `${item.status} · ${item.ratio} : 1 (needs ${item.required} : 1)`;

    const sample = document.createElement('div');
    sample.className = 'sample';
    sample.textContent = `"${item.text}"`;

    li.append(badge, sample);

    if (item.fg) {
      const colors = document.createElement('div');
      colors.className = 'meta';
      const fgSw = document.createElement('span');
      fgSw.className = 'swatch';
      fgSw.textContent = 'text ' + item.fg;
      fgSw.style.color = item.fg;
      fgSw.style.background = item.bg;
      const bgSw = document.createElement('span');
      bgSw.className = 'swatch';
      bgSw.textContent = 'bg ' + item.bg;
      bgSw.style.background = item.bg;
      bgSw.style.color = contrastText(item.bg);
      colors.append(fgSw, ' ', bgSw);
      li.append(colors);
    }

    for (const note of item.notes || []) {
      const n = document.createElement('div');
      n.className = 'note';
      n.textContent = note;
      li.append(n);
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${item.kind} · ${item.size}px · weight ${item.weight} · ${item.selector}`;
    li.append(meta);

    list.appendChild(li);
  }
}

function contrastText(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.5 ? '#000000' : '#ffffff';
}

async function copyReport() {
  const lines = [
    `Contrast report: ${items.length} items`,
    ...items.filter(i => i.status !== 'pass').map(i =>
      `[${i.status.toUpperCase()}] ${i.ratio === null ? '-' : i.ratio + ':1'} (needs ${i.required}:1) ` +
      `${i.fg ? 'text ' + i.fg + ' on ' + i.bg + ' ' : ''}| "${i.text}" | ${i.selector} | ${i.frame}` +
      `${i.notes && i.notes.length ? ' | ' + i.notes.join('; ') : ''}`)
  ];
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    setStatus('Report copied to clipboard.');
  } catch {
    setStatus('Could not copy. Click inside the popup and try again.');
  }
}

async function toggleHighlight() {
  if (tabId === null) return;
  await runInAllFrames(on => window.__contrastHighlight(on), [$('highlight').checked]);
}

async function toggleLive() {
  try {
    const tab = await activeTab();
    tabId = tab.id;
    await ensureScanner();
    await runInAllFrames((on, hl) => window.__contrastLive(on, hl), [$('live').checked, $('highlight').checked]);
    setStatus($('live').checked ? 'Live mode on. The page re-checks itself as it changes.' : 'Live mode off.');
  } catch (err) {
    setStatus('Live mode unavailable here: ' + err.message);
  }
}

$('scan').addEventListener('click', scan);
$('copy').addEventListener('click', copyReport);
$('highlight').addEventListener('change', toggleHighlight);
$('live').addEventListener('change', toggleLive);
$('filter').addEventListener('change', renderList);

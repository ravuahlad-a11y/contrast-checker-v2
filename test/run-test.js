// Runs the v2 scanner in real Chromium, following the same steps as popup.js:
//   1) every frame describes its iframes, 2) every frame scans with that context.
// Usage: node test/run-test.js
const path = require('path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const fixture = 'file://' + path.join(__dirname, 'cases.html');

// [text prefix, expected status, expected ratio or null]
// status 'absent' means the item must NOT be reported at all.
const EXPECT = [
  ['Scrim text under', 'review', null],
  ['Covered by an opaque', 'covered', null],
  ['Sibling dark panel', 'pass', 18.88],
  ['Pseudo element dark', 'review', null],
  ['Frosted glass', 'review', null],
  ['Gradient filled', 'review', null],
  ['Clipped menu item', 'absent', null],
  ['Offscreen helper', 'absent', null],
  ['Save now', 'fail', null],
  ['Faded parent text', 'fail', null],
  ['Dashboard', 'fail', 1.26],
  ['Users', 'fail', 4.29],
  ['Forgot your password?', 'fail', 3.89],
  ['Plain black text', 'pass', 21],
  ['Big grey heading', 'pass', 4.48],
  ['Translucent overlay text', 'fail', null],
  ['Text on a gradient', 'review', null],
  ['Inside framed grey text', 'review', null],
  ['Hidden frame text', 'absent', null],
  ['Shadow DOM grey', 'fail', null],
  ['Closed shadow grey', 'absent', null], // known limitation: closed shadow roots cannot be read
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } });
  await page.goto(fixture);
  await page.waitForTimeout(300);

  for (const frame of page.frames()) {
    await frame.addScriptTag({ path: path.join(root, 'scanner.js') });
  }

  // Step 1: contexts from every frame.
  const ctxMap = {};
  for (const frame of page.frames()) {
    const c = await frame.evaluate(() => window.__contrastFrameContexts());
    Object.assign(ctxMap, c);
  }

  // Step 2: scan every frame with the merged map.
  const items = [];
  const skips = [];
  for (const frame of page.frames()) {
    const r = await frame.evaluate(m => window.__contrastScan(m), ctxMap);
    items.push(...r.items);
    if (r.skipped) skips.push(r.skipped);
  }

  let failures = 0;
  for (const [prefix, status, ratio] of EXPECT) {
    const item = items.find(i => i.text.startsWith(prefix));
    let ok;
    if (status === 'absent') ok = !item;
    else ok = !!item && item.status === status && (ratio === null || Math.abs(item.ratio - ratio) < 0.05);
    if (!ok) failures++;
    const got = item ? `${item.status} ratio=${item.ratio}` : 'absent';
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${prefix.padEnd(26)} got=${got}  expected=${status}${ratio ? ' ' + ratio : ''}`);
  }

  console.log(`\n${items.length} items checked, ${failures} failing expectations`);
  if (skips.length) console.log('Skipped frames:', skips.join(' | '));
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });

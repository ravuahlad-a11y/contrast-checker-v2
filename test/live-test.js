// Live mode: badge updates on change, no feedback loop when idle.
const path = require('path');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } });
  await page.goto('file://' + path.join(__dirname, 'cases.html'));
  await page.addScriptTag({ path: path.join(__dirname, '..', 'scanner.js') });
  await page.evaluate(() => window.__contrastLive(true, true));
  await page.waitForTimeout(1200);
  const before = await page.textContent('#cc-badge');
  await page.evaluate(() => { const p = document.createElement('p'); p.style.cssText = 'background:#fff;color:#ccc;margin:0'; p.textContent = 'Added later'; document.body.appendChild(p); });
  await page.waitForTimeout(1500);
  const after = await page.textContent('#cc-badge');
  const scans = await page.evaluate(async () => {
    let n = 0; const orig = window.__contrastScan; window.__contrastScan = (...a) => { n++; return orig(...a); };
    await new Promise(r => setTimeout(r, 3000)); window.__contrastScan = orig; return n;
  });
  console.log('before:', before); console.log('after: ', after);
  console.log('rescans in 3s idle:', scans, scans === 0 ? 'PASS (no loop)' : 'FAIL');
  await browser.close();
})();

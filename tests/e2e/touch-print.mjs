// Phone checks: print pages stay in the page while the print UI is open (a phone browser returns
// from print() at once and keeps laying the page out for its preview), the table editor can select
// a range by tapping, and object handles are finger-sized.
// Usage: npm run build && npm run e2e:touch   (set QS_URL to test an already-running server instead)
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = 4183;
let server = null;
let url = process.env.QS_URL;
if (!url) {
  server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore', detached: true });
  url = `http://localhost:${PORT}/`;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const exe = existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {};
const browser = await chromium.launch(exe);
const failures = [];
const check = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };

try {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => failures.push('pageerror: ' + e.message));
  await p.addInitScript(() => {
    localStorage.setItem('quillstage.prefs.v1', JSON.stringify({ firstRun: false, presenterView: false }));
    window.print = () => { window.__printed = (window.__printed || 0) + 1; setTimeout(() => window.dispatchEvent(new Event('afterprint')), 50); };
  });
  await p.goto(url, { waitUntil: 'networkidle' });
  await p.waitForFunction(() => window.qs && document.querySelector('.qs-edit-stage'));
  await p.waitForTimeout(500);

  // --- Print: pages survive the early afterprint and every old timer, and go once the user is back.
  await p.evaluate(() => { Promise.resolve(qs.exec('file.quickPrint')).catch((e) => { window.__printErr = String(e); }); });
  await p.waitForFunction(() => window.__printed === 1, null, { timeout: 10000 });
  await p.waitForTimeout(2000);
  const printState = () => p.evaluate(() => ({ root: !!document.querySelector('.qs-print-root .qs-pp-page'), css: !!document.getElementById('qs-print-css') }));
  check('print pages kept while the print UI is open', await printState(), { root: true, css: true });
  await p.touchscreen.tap(200, 880);
  await p.waitForTimeout(900);
  check('print pages removed afterwards', await printState(), { root: false, css: false });
  check('print error', await p.evaluate(() => window.__printErr || null), null);

  // --- Table editor: tap a cell, turn on Extend selection, tap another cell, Merge.
  await p.evaluate(() => qs.exec('insert.table', { rows: 3, cols: 3 }));
  await p.waitForTimeout(200);
  const tableId = await p.evaluate(() => qs.slide.elements.at(-1).id);
  await p.evaluate((id) => { qs.tab.ui.select([id]); void qs.exec('table.editCells'); }, tableId);
  await p.waitForSelector('.ql-dialog textarea');
  const tas = p.locator('.ql-dialog table textarea');
  await tas.nth(0).tap();
  await p.locator('.ql-dialog label:has-text("Extend selection") input').tap();
  await tas.nth(4).tap(); // row 1, column 1
  const outlined = await p.evaluate(() => [...document.querySelectorAll('.ql-dialog table textarea')].map((t) => !!t.style.outline));
  check('tap extends the range', outlined, [true, true, false, true, true, false, false, false, false]);
  await p.locator('.ql-dialog button:has-text("Merge")').tap();
  await p.locator('.ql-dialog button:has-text("Apply")').tap();
  await p.waitForTimeout(200);
  check('merged by touch', await p.evaluate((id) => { const t = qs.slide.elements.find((e) => e.id === id); const c = t.rows[0].cells[0]; return [c.rowSpan || 1, c.colSpan || 1]; }, tableId), [2, 2]);

  // --- Handles: finger-sized on a coarse pointer.
  await p.evaluate((id) => qs.tab.ui.select([id]), tableId);
  await p.waitForTimeout(200);
  const hs = await p.evaluate(() => { const h = document.querySelector('.qs-handle.qs-h-se'); if (!h) return null; return { css: Math.round(h.getBoundingClientRect().width), before: getComputedStyle(h, '::before').content !== 'none' }; });
  check('handles are larger on touch (16 px, with a wider touch target)', hs, { css: 16, before: true });
} finally {
  await browser.close();
  if (server) { try { process.kill(-server.pid); } catch { /* */ } }
}
if (failures.length) { console.error('FAIL\n' + failures.join('\n')); process.exit(1); }
console.log('touch/print e2e: ok');

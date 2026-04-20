const p = require('puppeteer');
(async () => {
  const b = await p.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await b.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1');
  page.on('console', m => console.log('PAGE_CONSOLE', m.type(), m.text()));
  page.on('pageerror', e => console.error('PAGE_ERROR', e && e.message));
  page.on('response', res => { if (res.status() >= 400) console.error('PAGE_RESPONSE_ERROR', res.status(), res.url()); });

  try {
    await page.goto('http://localhost:4000/', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 600));
    try { await page.click('#earningsToggleTitle'); } catch (e) { /* ignore */ }
    await page.waitForSelector('.earnings-grid-rows', { timeout: 8000 });
    await page.waitForSelector('.earnings-grid-header', { timeout: 8000 });

    const metrics1 = await page.evaluate(() => {
      const h = document.querySelector('.earnings-grid-header');
      const r = document.querySelector('.earnings-grid-rows');
      return {
        hScrollLeft: h ? h.scrollLeft : null,
        rScrollLeft: r ? r.scrollLeft : null,
        hClientW: h ? h.clientWidth : null,
        rClientW: r ? r.clientWidth : null,
        hScrollW: h ? h.scrollWidth : null,
        rScrollW: r ? r.scrollWidth : null
      };
    });
    console.log('METRICS_BEFORE', JSON.stringify(metrics1));

    await page.evaluate(() => { const rows = document.querySelector('.earnings-grid-rows'); if (rows) rows.scrollLeft = Math.min(150, rows.scrollWidth || 0); });
    await new Promise(r => setTimeout(r, 400));
    const after1 = await page.evaluate(() => ({
      hScrollLeft: document.querySelector('.earnings-grid-header') ? document.querySelector('.earnings-grid-header').scrollLeft : null,
      rScrollLeft: document.querySelector('.earnings-grid-rows') ? document.querySelector('.earnings-grid-rows').scrollLeft : null
    }));
    console.log('AFTER_ROWS_SCROLL', JSON.stringify(after1));

    await page.evaluate(() => { const hdr = document.querySelector('.earnings-grid-header'); if (hdr) hdr.scrollLeft = Math.min(80, hdr.scrollWidth || 0); });
    await new Promise(r => setTimeout(r, 400));
    const after2 = await page.evaluate(() => ({
      hScrollLeft: document.querySelector('.earnings-grid-header') ? document.querySelector('.earnings-grid-header').scrollLeft : null,
      rScrollLeft: document.querySelector('.earnings-grid-rows') ? document.querySelector('.earnings-grid-rows').scrollLeft : null
    }));
    console.log('AFTER_HEADER_SCROLL', JSON.stringify(after2));

    const screenshotPath = '/app/mobile_check.png';
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log('SCREENSHOT_SAVED', screenshotPath);
    await b.close();
    process.exit(0);
  } catch (e) {
    console.error('NAV_FAIL', e && e.message);
    try { await b.close(); } catch (_) { }
    process.exit(2);
  }
})();

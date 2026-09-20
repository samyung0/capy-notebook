// Run: node lab/knowledge/tests/download-filter.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');

(async () => {
  const html = fs.readFileSync(path.join(__dirname, '../ui.html'), 'utf8');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html.split('<script>')[0]);
    const script = html.split('<script>')[1].split('</script>')[0];
    // Exercise the real page script, with polling disabled and no backend writes.
    await page.addScriptTag({ content: script.replace(/\nrefresh\(\);\s*setInterval\(refresh, 3000\);/, '') });
    await page.evaluate(() => {
      const row = (title, error) => ({ title, last_error: error, pdf_url: 'https://example.test/book.pdf', status: error ? 'failed' : 'downloaded', duplicate_urls: [] });
      state = { scrape: { downloads: [
        row('First blocked book', "HTTPStatusError: Client error '403 Forbidden' for url 'https://one.test/'"),
        row('Second blocked book', "HTTPStatusError: Client error '403 Forbidden' for url 'https://two.test/'"),
        row('Bad file', 'not a PDF'),
        row('Restricted licence', 'NonCommercial licence'),
        row('Downloaded book', null),
      ] } };
      renderDownloads(state.scrape.downloads);
    });
    const filter = page.locator('#downloadErrorFilter');
    await filter.selectOption('error:HTTP 403');
    assert.equal(await page.locator('#downloads .dl').count(), 2);
    await page.evaluate(() => renderDownloads(state.scrape.downloads));
    assert.equal(await filter.inputValue(), 'error:HTTP 403');
    await filter.selectOption('error:not a PDF');
    assert.equal(await page.locator('#downloads b').innerText(), 'Bad file');
    await filter.selectOption('errors');
    assert.equal(await page.locator('#downloads .dl').count(), 4);
    await filter.selectOption('none');
    assert.equal(await page.locator('#downloads b').innerText(), 'Downloaded book');
    await filter.selectOption('error:HTTP 403');
    await page.evaluate(() => renderDownloads([]));
    assert.equal(await filter.inputValue(), 'error:HTTP 403');
    assert.match(await page.locator('#downloads').innerText(), /No downloads match/);
    console.log('Download error filtering and refresh persistence passed.');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

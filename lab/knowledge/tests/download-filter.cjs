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
    await page.route('http://knowledge.test/', (route) => route.fulfill({ contentType: 'text/html', body: html.split('<script>')[0] }));
    await page.goto('http://knowledge.test/');
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
    assert.equal(await page.getByRole('button', { name: 'Reject: non-commercial', exact: true }).count(), 2);
    let submitted;
    await page.route('**/api/downloads/reject-noncommercial', async (route) => {
      submitted = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    await page.evaluate(() => { refresh = async () => {
      state.scrape.downloads[0].status = 'rejected';
      state.scrape.downloads[0].last_error = 'NonCommercial licence (manual review)';
      renderDownloads(state.scrape.downloads);
    }; });
    await page.getByRole('button', { name: 'Reject: non-commercial', exact: true }).first().click();
    await page.waitForFunction(() => document.querySelectorAll('#downloads .dl').length === 1);
    assert.deepEqual(submitted, { pdf_url: 'https://example.test/book.pdf' });
    await page.evaluate(() => { state.scrape.downloads[0].last_error = "HTTPStatusError: Client error '403 Forbidden'"; });
    await page.evaluate(() => renderDownloads(state.scrape.downloads));
    assert.equal(await filter.inputValue(), 'error:HTTP 403');
    await filter.selectOption('error:not a PDF');
    assert.equal(await page.locator('#downloads b').innerText(), 'Bad file');
    await filter.selectOption('errors');
    assert.equal(await page.locator('#downloads .dl').count(), 4);
    await filter.selectOption('none');
    assert.equal(await page.locator('#downloads b').innerText(), 'Downloaded book');
    assert.equal(await page.getByRole('button', { name: 'Reject: non-commercial', exact: true }).count(), 0);
    await filter.selectOption('error:HTTP 403');
    await page.evaluate(() => renderDownloads([]));
    assert.equal(await filter.inputValue(), 'error:HTTP 403');
    assert.match(await page.locator('#downloads').innerText(), /No downloads match/);
    console.log('Download error filtering and refresh persistence passed.');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

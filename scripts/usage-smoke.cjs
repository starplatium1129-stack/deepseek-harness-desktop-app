const { _electron: electron } = require('playwright');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
async function main() {
  const data = process.env.DSH_USAGE_SMOKE_DATA || await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-usage-test-'));
  if (!path.basename(data).startsWith('dsh-usage-test-')) throw Error('Use an isolated usage-test directory');
  console.log('Isolated test data:', data);
  const screenshots = process.env.DSH_SMOKE_SCREENSHOTS || path.join(root, 'docs/screenshots');
  await fs.mkdir(screenshots, { recursive: true });
  if (!process.env.DSH_USAGE_SMOKE_DATA) await promisify(execFile)(process.execPath, [path.join(__dirname, 'usage-seed-fixture.cjs'), data], { windowsHide: true, timeout: 120000, maxBuffer: 2e6 });
  const fixture = JSON.parse(await fs.readFile(path.join(data, 'fixture.json'), 'utf8'));
  const env = { ...process.env, DSH_DESKTOP_TEST_DATA: data }; delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.DSH_SMOKE_EXECUTABLE) env.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;
  const app = await electron.launch({ executablePath: process.env.DSH_SMOKE_EXECUTABLE || require('electron'), args: process.env.DSH_SMOKE_EXECUTABLE ? [] : [root], env, timeout: 60000 });
  try {
    const page = await app.firstWindow(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.locator('#status-short').filter({ hasText: '本地服务已就绪' }).waitFor({ timeout: 180000 });
    await page.locator('#usage').click();
    await page.locator('#usage-total').filter({ hasText: '25.2K' }).waitFor({ timeout: 70000 });
    assert.equal(await page.locator('#usage-sessions').innerText(), '3');
    // Price edits are deliberately restricted to this isolated fixture home.
    await page.evaluate(() => window.desktop.action('usage-prices-save', []));
    await page.locator('#usage-refresh').click();
    await page.locator('#usage-cost').filter({ hasText: '未计价' }).waitFor();
    await page.locator('#usage-pricing-open').click();
    for (const model of ['desktop-usage-test / code-model', 'desktop-usage-test / design-model']) {
      await page.locator('#price-model').selectOption(model);
      for (const [key, value] of Object.entries({ input: '2', cacheRead: '0.5', cacheWrite: '0', output: '8' })) await page.locator(`#price-${key}`).fill(value);
      await page.locator('#price-save').click();
      await page.locator('#price-message').filter({ hasText: '已保存' }).waitFor();
    }
    if (process.env.DSH_PRICE_LIVE_SYNC === '1') {
      for (const source of ['models.dev', 'cc-switch']) {
        await page.locator('#price-source').selectOption(source);
        await page.waitForFunction(() => !document.getElementById('price-sync').disabled);
        const prices = await page.evaluate(() => window.desktop.action('usage-prices'));
        assert.equal(prices.sync.cachedSource, source); assert.equal(prices.sync.lastError, null); assert.ok(prices.sync.count > 0);
        assert.equal(prices.rates.find(r => r.model === 'desktop-usage-test / code-model').input, '2');
      }
      console.log('Live price sources synchronized through the settings dialog; custom rates preserved.');
    }
    await page.screenshot({ path: path.join(screenshots, 'usage-pricing.png'), fullPage: true });
    await page.locator('#usage-pricing-close').click();
    await page.locator('#usage-pricing-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#usage-cost').innerText(), '$0.050400');
    const storedPrices = JSON.parse(await fs.readFile(path.join(data, 'usage-prices.json'), 'utf8'));
    assert.equal(storedPrices.overrides.length, 2);
    await page.locator('#usage-sort').selectOption('cost');
    assert.match(await page.locator('.usage-session').first().innerText(), /12\.6K/);
    await page.locator('#usage-sort').selectOption('recent');
    const read = await page.evaluate(() => window.desktop.action('usage-read'));
    assert.equal(read.unavailable, 0); assert.equal(read.sessions.flatMap(s => s.turns).reduce((sum, t) => sum + (t.usage?.totalTokens || 0), 0), fixture.total);
    assert.equal(await page.locator('#usage-session-list img').count(), 0, 'Titles must stay text');
    await page.locator('#usage-search').fill('界面设计'); assert.equal(await page.locator('.usage-session').count(), 1);
    await page.locator('#usage-search').fill('');
    const model = await page.locator('#usage-model option').nth(1).getAttribute('value');
    await page.locator('#usage-model').selectOption(model); assert.notEqual(await page.locator('#usage-total').innerText(), '25.2K');
    await page.locator('#usage-model').selectOption('');
    await page.locator('.chart-point').last().hover();
    assert.equal(await page.locator('.trend-tooltip').isVisible(), true);
    assert.match(await page.locator('.trend-tooltip').innerText(), /缓存写入/);
    await page.locator('.chart-point').last().click(); assert.match(await page.locator('#usage-chart-detail').innerText(), /已筛选/);
    await page.locator('.chart-point').last().click();
    await page.locator('#usage-legend [data-series="cache"]').click();
    assert.equal(await page.locator('#usage-chart path[data-series="cache"]').count(), 0);
    await page.locator('#usage-legend [data-series="cache"]').click();
    await page.locator('[data-days="1"]').click();
    assert.match(await page.locator('#usage-trend-note').innerText(), /按小时/);
    assert.ok(await page.locator('.chart-point').count() > 1);
    await page.locator('.chart-point').last().focus(); await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator('.trend-tooltip').isVisible(), true);
    await page.locator('.chart-point[aria-label*="25200 tokens"]').focus();
    await page.screenshot({ path: path.join(screenshots, 'usage-hourly.png'), fullPage: true });
    await page.locator('[data-days="7"]').click();
    await page.screenshot({ path: path.join(screenshots, 'usage.png'), fullPage: true });
    await page.locator('.usage-session summary').first().click();
    await page.locator('.usage-session[open] button').click();
    await page.locator('#usage-page').waitFor({ state: 'hidden' });
    const workspace = app.context().pages().find(p => p.url().startsWith('http://127.0.0.1:'));
    assert.ok(workspace, 'Harness workspace exists');
    await workspace.getByText('这是独立验收数据，不是实际模型调用。', { exact: false }).first().waitFor({ timeout: 20000 });
    await page.locator('#usage').click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(880, 650));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'No horizontal overflow at minimum size');
    await page.screenshot({ path: path.join(screenshots, 'usage-narrow.png'), fullPage: true });
    await page.locator('#home').click(); assert.equal(await page.locator('#management-page').isVisible(), true);
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('Usage smoke passed: persisted usage and prices, exact token/cost totals, filters, navigation, XSS, and minimum window layout.');
  } finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

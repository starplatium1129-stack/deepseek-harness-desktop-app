const { _electron: electron } = require('playwright');
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
async function main() {
  const packaged = process.argv.includes('--packaged');
  const executablePath = process.env.DSH_SMOKE_EXECUTABLE || (packaged ? path.join(root, 'release/win-unpacked/DeepSeek Harness Desktop.exe') : require('electron'));
  const data = path.join(root, '.test-data', packaged ? 'packaged-ui' : 'development-ui');
  const env = { ...process.env, DSH_DESKTOP_TEST_DATA: data }; delete env.ELECTRON_RUN_AS_NODE;
  // Remove development tools from the child PATH to exercise bundled runtime startup.
  if (packaged) env.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;
  const app = await electron.launch({ executablePath, args: packaged ? [] : [root], env, timeout: 60000 });
  try {
    const page = await app.firstWindow();
    await page.locator('#status-short').filter({ hasText: /本地服务已就绪|需要处理/ }).waitFor({ timeout: 120000 });
    let state = await page.evaluate(() => window.desktop.state());
    assert.equal(state.phase, 'ready', state.message);
    await page.locator('#home').click();
    await fs.mkdir(path.join(root, 'docs/screenshots'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'docs/screenshots/desktop.png') });
    await page.locator('#check').click();
    await page.locator('#update-message').filter({ hasText: /当前已是|发现上游新版本/ }).waitFor({ timeout: 30000 });
    state = await page.evaluate(() => window.desktop.state());
    console.log('Ready:', state.active, 'Latest:', state.update.version);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    const pages = app.context().pages();
    const workspace = pages.find(p => p.url().startsWith('http://127.0.0.1:'));
    if (!workspace) throw new Error('Harness view missing');
    await workspace.waitForLoadState('domcontentloaded');
    const preview = workspace.getByRole('button', { name: '继续', exact: true });
    if (await preview.isVisible()) await preview.click();
    console.log('Harness UI:', (await workspace.locator('body').innerText()).slice(0,1200));
    assert.equal(await workspace.evaluate(() => typeof window.desktop), 'undefined');
    await page.locator('#workspace').click();
    await workspace.screenshot({ path: path.join(root, 'docs/screenshots/workspace.png') });
    await page.locator('#home').click();
  } finally { await app.close(); }
  console.log('Electron UI smoke passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

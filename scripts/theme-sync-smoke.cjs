const { _electron: electron, expect } = require('playwright/test');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
async function main() {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-theme-sync-'));
  const out = path.join(root, '.test-data/theme-sync'); await fs.mkdir(out, { recursive: true });
  const env = { ...process.env, DSH_DESKTOP_TEST_DATA: data }; delete env.ELECTRON_RUN_AS_NODE;
  const packaged = process.argv.includes('--packaged'), version = require('../package.json').version;
  if (packaged) env.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;
  const launch = () => electron.launch({ executablePath: packaged ? path.join(root, `release/appearance-${version}/win-unpacked/DeepSeek Harness Desktop.exe`) : require('electron'), args: packaged ? [] : [root], env });
  let app = await launch();
  const errors = [];
  try {
    let page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
    await page.locator('#appearance').click(); await page.locator('#appearance-feedback').filter({ hasText: '调整后自动保存' }).waitFor();
    await page.locator('#appearance-mode').selectOption('light'); await expect.poll(() => page.evaluate(async () => (await window.desktop.action('appearance-read')).settings.mode)).toBe('light');
    await page.locator('#status-short').filter({ hasText: /本地服务已就绪|需要处理/ }).waitFor({ timeout: 120000 });
    assert.equal((await page.evaluate(() => window.desktop.state())).phase, 'ready');
    let workspace = app.context().pages().find(p => p.url().startsWith('http://127.0.0.1:')); workspace.on('pageerror', e => errors.push(e.message));
    await page.locator('#workspace').click(); await workspace.locator('.pI_x6G_frame').waitFor();
    for (const name of ['继续','稍后配置']) { const b = workspace.getByRole('button', { name, exact: true }); try { await b.waitFor({ timeout: 2500 }); await b.click(); } catch {} }
    async function coherent(mode, scheme = mode) {
      let stableSince = 0, last;
      await expect.poll(async () => {
        const saved = await page.evaluate(async () => (await window.desktop.action('appearance-read')).settings.mode);
        const desktop = await page.evaluate(() => ({ mode: document.getElementById('appearance-mode').value, scheme: document.documentElement.dataset.scheme }));
        const view = await workspace.evaluate(() => ({ scheme: document.documentElement.dataset.scheme, dark: document.body.hasAttribute('data-ds-dark-theme'), background: document.documentElement.style.getPropertyValue('--wallpaper-color'), color: getComputedStyle(document.body).color }));
        last = { saved, desktop, view };
        const matches = saved === mode && desktop.mode === mode && desktop.scheme === scheme && view.scheme === scheme && view.dark === (scheme === 'dark') && view.background === (scheme === 'dark' ? '#151517' : '#ffffff') && view.color === (scheme === 'dark' ? 'rgb(249, 250, 251)' : 'rgb(15, 17, 21)');
        if (!matches) { stableSince = 0; return false; }
        stableSince ||= Date.now(); return Date.now() - stableSince >= 250;
      }, { timeout: 10000, message: 'Both views must converge and remain coherent' }).toBe(true).catch(error => { console.error('Last theme snapshot:', last); throw error; });
    }
    await coherent('light');
    for (const preset of ['classic', 'glass']) {
      await page.evaluate(preset => window.desktop.action('appearance-save', { preset }), preset);
      for (const [label, mode] of [['深色', 'dark'], ['浅色', 'light'], ['深色', 'dark']]) {
        await workspace.getByRole('button', { name: '设置', exact: true }).click();
        const panel = workspace.locator('.VOzbGW_panel'); await expect(panel).toBeVisible();
        await panel.getByRole('button', { name: label, exact: true }).click(); await coherent(mode);
        await workspace.keyboard.press('Escape'); await expect(panel).not.toBeVisible();
        await expect.poll(() => workspace.evaluate(() => FluidMotion.activeCount)).toBe(0);
        await workspace.screenshot({ path: path.join(out, `${preset}-${mode}.png`) });
      }
    }
    await workspace.getByRole('button', { name: '设置', exact: true }).click();
    await workspace.locator('.VOzbGW_panel').evaluate(panel => {
      for (const label of ['浅色', '深色', '浅色', '深色']) [...panel.querySelectorAll('button')].find(b => b.textContent.trim() === label).click();
    });
    await coherent('dark'); await workspace.keyboard.press('Escape');
    // OS mode is a preference, not a resolved dark/light value; it must stay system in storage.
    await workspace.getByRole('button', { name: '设置', exact: true }).click();
    await workspace.locator('.VOzbGW_panel').getByRole('button', { name: '跟随系统', exact: true }).click();
    await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('system');
    for (const scheme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme: scheme }); await workspace.emulateMedia({ colorScheme: scheme }); await coherent('system', scheme);
    }
    await workspace.keyboard.press('Escape');
    await page.emulateMedia({ colorScheme: null }); await workspace.emulateMedia({ colorScheme: null });
    // Verify the original desktop -> workspace route still works.
    await page.locator('#appearance').click(); await page.locator('#appearance-mode').selectOption('dark');
    await page.locator('#appearance-feedback').filter({ hasText: '已保存' }).waitFor(); await coherent('dark');
    await page.screenshot({ path: path.join(out, 'desktop-dark.png') });
    const stableRevision = (await page.evaluate(() => window.desktop.action('appearance-read'))).revision;
    await page.waitForTimeout(400);
    assert.equal((await page.evaluate(() => window.desktop.action('appearance-read'))).revision, stableRevision, 'theme acknowledgements must not loop');
    await page.locator('#appearance-mode').selectOption('light'); await coherent('light');
    await page.locator('#workspace').click();
    await workspace.getByRole('button', { name: '设置', exact: true }).click();
    await workspace.locator('.VOzbGW_panel').getByRole('button', { name: '深色', exact: true }).click();
    await coherent('dark'); await workspace.keyboard.press('Escape');
    await app.close(); app = await launch(); page = await app.firstWindow();
    await page.locator('#appearance').click(); await page.locator('#appearance-feedback').filter({ hasText: '调整后自动保存' }).waitFor();
    await expect(page.locator('#appearance-mode')).toHaveValue('dark');
    await page.locator('#status-short').filter({ hasText: /本地服务已就绪|需要处理/ }).waitFor({ timeout: 120000 });
    workspace = app.context().pages().find(p => p.url().startsWith('http://127.0.0.1:'));
    await coherent('dark');
    assert.equal(await workspace.evaluate(() => typeof window.desktop), 'undefined');
    assert.deepEqual(await workspace.evaluate(() => Object.keys(window.desktopTheme)), ['report']);
    assert.deepEqual(errors, []); console.log('Bidirectional theme, OS preference, no echo and restart checks passed:', out);
  } finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

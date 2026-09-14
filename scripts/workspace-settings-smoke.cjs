const { _electron: electron, expect } = require('playwright/test');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
async function main() {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-settings-layout-'));
  const out = path.join(root, '.test-data/settings-layout'); await fs.mkdir(out, { recursive: true });
  const env = { ...process.env, DSH_DESKTOP_TEST_DATA: data }; delete env.ELECTRON_RUN_AS_NODE;
  const packaged = process.argv.includes('--packaged'), version = require('../package.json').version;
  if (packaged) env.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;
  const app = await electron.launch({ executablePath: packaged ? path.join(root, `release/appearance-${version}/win-unpacked/DeepSeek Harness Desktop.exe`) : require('electron'), args: packaged ? [] : [root], env });
  try {
    const page = await app.firstWindow(); await page.locator('#appearance').click();
    await page.locator('#appearance-feedback').filter({ hasText: '调整后自动保存' }).waitFor();
    await page.locator('#status-short').filter({ hasText: /本地服务已就绪|需要处理/ }).waitFor({ timeout: 120000 });
    assert.equal((await page.evaluate(() => window.desktop.state())).phase, 'ready');
    await page.locator('#workspace').click();
    const workspace = app.context().pages().find(p => p.url().startsWith('http://127.0.0.1:'));
    await workspace.locator('.pI_x6G_frame').waitFor();
    for (const name of ['继续', '稍后配置']) { const b = workspace.getByRole('button', { name, exact: true }); try { await b.waitFor({ timeout: 2500 }); await b.click(); } catch {} }
    const modes = [
      { preset: 'classic', mode: 'light', motion: 'full', lowEffects: false },
      { preset: 'glass', mode: 'light', motion: 'full', lowEffects: false },
      { preset: 'glass', mode: 'dark', motion: 'full', lowEffects: false },
      { preset: 'glass', mode: 'light', motion: 'reduced', lowEffects: false },
      { preset: 'glass', mode: 'light', motion: 'full', lowEffects: true },
    ];
    for (const settings of modes) {
      const result = await page.evaluate(patch => window.desktop.action('appearance-save', patch), settings); assert.ok(!result.error, result.error);
      assert.equal(await workspace.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--wallpaper').trim()), 'none');
      await workspace.getByRole('button', { name: '设置', exact: true }).click();
      const panel = workspace.locator('.VOzbGW_panel'); await expect(panel).toBeVisible();
      await expect.poll(() => workspace.evaluate(() => FluidMotion.activeCount)).toBe(0);
      for (const section of ['模型', '插件', 'Agent 预设', '通用设置']) {
        await panel.getByRole('button', { name: section, exact: true }).click();
        const rect = await panel.boundingBox(), viewport = await workspace.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        assert.ok(rect.width >= Math.min(790, viewport.width - 52), `${section}: compressed settings width ${rect.width}`);
        assert.ok(Math.abs(rect.x + rect.width / 2 - viewport.width / 2) < 4, `${section}: settings must center on the viewport`);
        assert.ok(rect.y >= -1 && rect.y + rect.height <= viewport.height + 1);
      }
      assert.equal(await workspace.locator('.pI_x6G_sidebarCol').evaluate(el => getComputedStyle(el).backdropFilter), 'none');
      if (settings.preset === 'glass' && !settings.lowEffects) await expect(workspace.locator('.desktop-sidebar-material')).toHaveAttribute('data-liquid', '');
      await workspace.screenshot({ path: path.join(out, `${settings.preset}-${settings.mode}-${settings.motion}-${settings.lowEffects}.png`) });
      await workspace.keyboard.press('Escape'); await expect(panel).not.toBeVisible();
      await expect.poll(() => workspace.locator('[data-fluid-ghost]').count()).toBe(0);
    }
    // Explicit backgrounds remain independent when changing the material preset.
    for (const preset of ['classic', 'glass']) {
      await page.evaluate(patch => window.desktop.action('appearance-save', patch), { preset, background: 'gradient', lowEffects: false });
      assert.match(await workspace.evaluate(() => document.documentElement.style.getPropertyValue('--wallpaper')), /radial-gradient/);
    }
    await page.evaluate(() => window.desktop.action('appearance-save', { background: 'default', preset: 'glass' }));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 680));
    await workspace.getByRole('button', { name: '设置', exact: true }).click();
    await expect.poll(() => workspace.evaluate(() => FluidMotion.activeCount)).toBe(0);
    const narrow = await workspace.locator('.VOzbGW_panel').boundingBox(); assert.ok(narrow.width > 700);
    await workspace.screenshot({ path: path.join(out, 'settings-narrow-neutral.png') });
    console.log('Settings layout, four sections, theme/motion variants and independent backgrounds passed:', out);
  } finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

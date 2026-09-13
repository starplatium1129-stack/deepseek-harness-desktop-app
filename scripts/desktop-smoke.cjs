const { _electron: electron, expect } = require('playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
async function main() {
  const data = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'dsh-desktop-qa-'));
  const output = path.join(root, '.test-data/desktop-qa'); await fs.mkdir(output, { recursive: true });
  const packaged = process.argv.includes('--packaged'), version = require('../package.json').version;
  const env = { ...process.env, DSH_DESKTOP_TEST_DATA: data }; delete env.ELECTRON_RUN_AS_NODE;
  if (packaged) env.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;
  const launch = () => electron.launch({ executablePath: packaged ? path.join(root, `release/appearance-${version}/win-unpacked/DeepSeek Harness Desktop.exe`) : require('electron'), args: packaged ? [] : [root], env, timeout: 60000 });
  let app = await launch();
  const errors = [];
  const press = (chord, workspace = false) => app.evaluate(({ BrowserWindow }, { chord, workspace }) => {
    const w = BrowserWindow.getAllWindows()[0], wc = workspace ? w.contentView.children.find(v => v.webContents && v.webContents !== w.webContents).webContents : w.webContents;
    const parts = chord.split('+'), key = parts.pop(), modifiers = parts.map(p => p.toLowerCase());
    w.focus(); wc.focus(); wc.sendInputEvent({ type: 'keyDown', keyCode: key === 'Equal' ? '=' : key, modifiers }); wc.sendInputEvent({ type: 'keyUp', keyCode: key === 'Equal' ? '=' : key, modifiers });
  }, { chord, workspace });
  try {
    let page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
    await page.locator('#appearance').click();
    await page.locator('#appearance-feedback').filter({ hasText: '调整后自动保存' }).waitFor();
    await page.locator('[data-preset=glass]').click(); await page.locator('#appearance-feedback').filter({ hasText: '已保存' }).waitFor();
    await page.locator('#appearance').focus(); await press('F6');
    await expect(page.locator('#appearance-heading')).toBeFocused();
    await press('F6'); await expect(page.locator('#appearance')).toBeFocused();
    await page.keyboard.press('Home'); await page.keyboard.press('End'); await expect(page.locator('#appearance')).toBeFocused();
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async (_win, options) => { globalThis.__shortcutHelp = options.detail; return { response: 0 }; }; });
    await press('F1'); await expect.poll(() => app.evaluate(() => globalThis.__shortcutHelp || '')).toContain('Alt+F4');
    await page.emulateMedia({ reducedMotion: 'reduce' }); await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
    await expect.poll(() => page.evaluate(() => FluidMotion.activeCount)).toBe(0);
    await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'active' });
    await expect.poll(() => page.evaluate(() => LiquidGlass.surfaceCount)).toBe(0);
    assert.equal(await page.locator('.appearance-layout .card').first().evaluate(el => getComputedStyle(el).backdropFilter), 'none');
    await page.screenshot({ path: path.join(output, 'high-contrast.png') });
    await page.emulateMedia({ forcedColors: 'none' });
    await page.locator('#status-short').filter({ hasText: /本地服务已就绪|需要处理/ }).waitFor({ timeout: 120000 });
    assert.equal((await page.evaluate(() => window.desktop.state())).phase, 'ready');
    await press('Control+3'); await expect(page.locator('#home-heading')).toBeFocused();
    await page.locator('#api-key').fill('unsaved-placeholder');
    await press('Control+4'); await press('Control+3'); await expect(page.locator('#api-key')).toBeFocused();
    await expect(page.locator('#api-key')).toHaveValue('unsaved-placeholder');
    // Rejected input remains editable; no credential is stored.
    await page.locator('#api-key').fill('x'.repeat(4097)); await page.keyboard.press('Enter');
    await expect(page.locator('#error')).toContainText('密钥格式无效'); await expect(page.locator('#api-key')).toHaveValue('x'.repeat(4097)); await page.locator('#api-key').fill('');
    await page.locator('#appearance').click();
    for (const [width, height, factor] of [[760, 560, 1], [1000, 740, 1.25], [760, 560, 2], [1440, 980, 1]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
      await page.evaluate(async factor => { await window.desktop.action('zoom-reset'); const steps = [1,1.1,1.25,1.5,1.75,2]; for (let i = 1; i <= steps.indexOf(factor); i++) await window.desktop.action('zoom-in'); }, factor);
      for (const name of ['home', 'usage', 'appearance']) {
        await page.evaluate(name => window.desktop.action(name), name);
        await expect.poll(() => page.evaluate(() => FluidMotion.activeCount)).toBe(0);
        const overflow = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth }));
        assert.ok(overflow.page <= overflow.viewport + 1, `${name} ${width} @ ${factor}: ${JSON.stringify(overflow)}`);
        assert.equal(await page.locator('header button').evaluateAll(els => els.every(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1; })), true, 'navigation must fit the viewport');
      }
      // CDP full-page screenshots crop incorrectly with Electron page zoom. Capture native pixels.
      const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
      await fs.writeFile(path.join(output, `appearance-${width}-${factor}.png`), Buffer.from(png, 'base64'));
    }
    for (const mode of ['light', 'dark']) {
      await press('Control+4'); await page.locator('#appearance-mode').selectOption(mode);
      await page.locator('#appearance-feedback').filter({ hasText: '已保存' }).waitFor();
      await press('Control+2');
      await expect.poll(() => page.evaluate(() => FluidMotion.activeCount)).toBe(0);
      assert.equal(await page.locator('.metric-primary small').evaluate(el => getComputedStyle(el).color), 'rgb(255, 255, 255)');
      await page.screenshot({ path: path.join(output, `usage-${mode}.png`), fullPage: true });
    }
    await press('Control+2');
    await app.evaluate(({ Menu }) => { globalThis.__menuBuilder = Menu.buildFromTemplate; Menu.buildFromTemplate = items => { globalThis.__editRoles = items.map(i => i.role).filter(Boolean); return { popup() {} }; }; });
    await page.locator('#usage-search').click({ button: 'right' });
    await expect.poll(() => app.evaluate(() => globalThis.__editRoles || [])).toContain('paste');
    await app.evaluate(({ Menu }) => { Menu.buildFromTemplate = globalThis.__menuBuilder; });
    await press('Control+2'); await page.locator('#usage-pricing-open').focus(); await page.keyboard.press('Enter');
    const modal = page.locator('#usage-pricing-dialog'); await expect(modal).toBeVisible();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => page.evaluate(() => FluidMotion.activeCount)).toBe(0);
    assert.equal(await modal.evaluate(el => getComputedStyle(el).transform), 'matrix(1, 0, 0, 1, 0, 0)');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    for (let i = 0; i < 18; i++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => !!document.activeElement.closest('dialog[open]')), true); }
    await press('Control+4'); assert.equal((await page.evaluate(() => window.desktop.state())).page, 'usage');
    await page.keyboard.press('Escape'); await expect(modal).not.toBeVisible(); await expect(page.locator('#usage-pricing-open')).toBeFocused();
    await page.keyboard.press('Enter'); await expect.poll(() => page.evaluate(() => FluidMotion.activeCount)).toBe(0);
    const bounds = await modal.boundingBox(); assert.ok(bounds.width > 400, 'reopened dialog must not use previous collapsed geometry');
    await page.keyboard.press('Escape'); await expect(modal).not.toBeVisible();
    await press('Control+1');
    const workspace = app.context().pages().find(p => p.url().startsWith('http://127.0.0.1:'));
    await workspace.locator('.pI_x6G_frame').waitFor();
    for (const name of ['继续','稍后配置']) { const button = workspace.getByRole('button', { name, exact: true }); try { await button.waitFor({ timeout: 2000 }); await button.click(); } catch {} }
    await workspace.emulateMedia({ reducedMotion: 'reduce' }); await expect(workspace.locator('html')).toHaveAttribute('data-motion', 'reduced');
    await press('F6', true); await expect(page.locator('#workspace')).toBeFocused();
    await press('F6'); await expect.poll(() => workspace.evaluate(() => document.hasFocus())).toBe(true);
    await press('Control+4', true); await expect(page.locator('#appearance-heading')).toBeFocused();
    await press('Control+Equal');
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())).toBe(1.1);
    const sizes = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0], v = w.contentView.children.find(v => v.webContents && v.webContents !== w.webContents); return { a: w.webContents.getZoomFactor(), b: v.webContents.getZoomFactor(), y: v.getBounds().y }; });
    assert.equal(sizes.a, sizes.b); assert.equal(sizes.y, Math.round(58 * sizes.a));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 80, y: 80, width: 1000, height: 740 }));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(true);
    await app.close(); app = await launch(); page = await app.firstWindow();
    const restored = await app.evaluate(({ BrowserWindow }) => ({ ...BrowserWindow.getAllWindows()[0].getNormalBounds(), zoom: BrowserWindow.getAllWindows()[0].webContents.getZoomFactor() }));
    assert.equal(restored.width, 1000); assert.equal(restored.height, 740); assert.equal(restored.zoom, 1.1);
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(true);
    assert.deepEqual(errors, []); console.log('Desktop keyboard, reflow, focus, accessibility and persistence checks passed:', output);
  } catch (error) { console.log('Lifecycle:', await fs.readFile(path.join(data, 'desktop-lifecycle.log'), 'utf8')); throw error; } finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

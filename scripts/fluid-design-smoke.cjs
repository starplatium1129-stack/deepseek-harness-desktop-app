const { _electron: electron, expect } = require('playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');
async function main() {
  const output = path.join(root, '.test-data/fluid-design'); await fs.mkdir(output, { recursive: true });
  const host = path.join(output, 'host.cjs');
  await fs.writeFile(host, `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({width:1240,height:940,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadFile(${JSON.stringify(path.join(root, 'src/design-reference.html'))});});app.on('window-all-closed',()=>app.quit());`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: require('electron'), args: [host], env, recordVideo: { dir: output, size: { width: 1240, height: 940 } } });
  let video;
  try {
    const page = await app.firstWindow(), errors = [];
    video = page.video();
    page.on('pageerror', e => errors.push(e.stack));
    await page.locator('#reference-lens[data-liquid]').waitFor();
    await expect.poll(() => page.evaluate(() => FluidMotion.activeCount)).toBe(0);
    // A/B the actual backdrop filter; an unsupported SVG filter would yield identical pixels.
    const refracted = await page.locator('#reference-lens').screenshot();
    await page.evaluate(() => document.querySelectorAll('feDisplacementMap').forEach(el => el.setAttribute('scale', '0')));
    const flat = await page.locator('#reference-lens').screenshot();
    const a = await sharp(refracted).ensureAlpha().raw().toBuffer({ resolveWithObject: true }), b = await sharp(flat).ensureAlpha().raw().toBuffer();
    let rim = 0, center = 0, nr = 0, nc = 0;
    for (let y = 0; y < a.info.height; y++) for (let x = 0; x < a.info.width; x++) {
      const i = (y * a.info.width + x) * 4, diff = Math.abs(a.data[i] - b[i]) + Math.abs(a.data[i + 1] - b[i + 1]) + Math.abs(a.data[i + 2] - b[i + 2]);
      const d = Math.min(x, y, a.info.width - 1 - x, a.info.height - 1 - y);
      if (d > 2 && d < 18) { rim += diff; nr++; } else if (d > 40) { center += diff; nc++; }
    }
    assert.ok(rim / nr > 1, `Backdrop displacement did not render: rim difference ${rim / nr}`);
    assert.ok(rim / nr > center / nc + .5, 'Distortion should concentrate at the lens edge');
    await page.evaluate(() => document.querySelectorAll('feDisplacementMap').forEach(el => el.setAttribute('scale', '32')));
    await page.screenshot({ path: path.join(output, 'material-light.png'), fullPage: true });
    const bounds = await page.locator('#reference-lens').boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down();
    await page.mouse.move(bounds.x + 40, bounds.y + bounds.height / 2 + 50, { steps: 8 }); await page.mouse.up();
    await expect.poll(() => page.evaluate(() => FluidMotion.activeCount)).toBe(0);
    await page.locator('[data-tab=motion]').click();
    await page.locator('#demo-toggle').click();
    await page.evaluate(() => document.getElementById('demo-toggle').click());
    await expect.poll(() => page.locator('#demo-sidebar').evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(238);
    await page.locator('#demo-open').click();
    await expect(page.locator('#demo-dialog')).toBeVisible();
    await page.evaluate(() => { FluidMotion.closeDialog(document.getElementById('demo-dialog')); FluidMotion.openDialog(document.getElementById('demo-dialog'), document.getElementById('demo-open')); });
    await expect.poll(() => page.evaluate(() => FluidMotion.activeCount)).toBe(0);
    await expect(page.locator('#demo-dialog')).toBeVisible();
    await page.screenshot({ path: path.join(output, 'presentation.png') });
    await page.keyboard.press('Escape'); await expect(page.locator('#demo-dialog')).not.toBeVisible();
    await expect(page.locator('#demo-open')).toBeFocused();
    await page.locator('#reference-scheme').click();
    await page.locator('[data-tab=reading]').click();
    await expect.poll(() => page.evaluate(() => FluidMotion.activeCount)).toBe(0);
    await page.screenshot({ path: path.join(output, 'reading-dark.png'), fullPage: true });
    await page.locator('[data-tab=motion]').click(); await page.locator('#demo-toggle').click(); await page.locator('#reference-motion').click();
    await expect.poll(() => page.evaluate(() => FluidMotion.activeCount)).toBe(0);
    await page.waitForTimeout(200); assert.equal(await page.evaluate(() => FluidMotion.activeCount), 0, 'idle scheduler must sleep');
    if (errors.length) console.log('Invalid resource names:', await page.evaluate(() => performance.getEntriesByType('resource').map(e => e.name).filter(n => { try { new URL(n); return false; } catch { return true; } })));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, edgePixelDifference: rim / nr, centerPixelDifference: center / nc, screenshots: output }));
  } finally { await app.close(); if (video) await video.saveAs(path.join(output, 'fluid-interactions.webm')); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });

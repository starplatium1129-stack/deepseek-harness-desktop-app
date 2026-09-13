const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WindowState, fitWindow, shortcut } = require('../src/window-state.cjs');
const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } }, secondary = { workArea: { x: -1280, y: 0, width: 1280, height: 984 } };
test('window restore keeps valid negative-monitor positions and recovers removed displays', () => {
  const saved = { x: -1200, y: 50, width: 1000, height: 700, maximized: true, zoom: 1.5 };
  assert.equal(fitWindow(saved, [primary, secondary]).x, -1200);
  const recovered = fitWindow(saved, [primary]);
  assert.equal(recovered.x, 0); assert.equal(recovered.zoom, 1.5); assert.equal(recovered.maximized, true);
  assert.ok(recovered.x + recovered.width <= primary.workArea.width);
});
test('small displays and malformed bounds never restore offscreen or unbounded zoom', () => {
  const fit = fitWindow({ width: 999999, height: 999999, x: NaN, zoom: 999 }, [{ workArea: { x: 0, y: 0, width: 640, height: 480 } }]);
  assert.equal(fit.width, 640); assert.equal(fit.height, 480); assert.equal(fit.minWidth, 640); assert.equal(fit.zoom, 1);
});
test('window state persists serially and corrupt optional settings fall back safely', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-window-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new WindowState(dir);
  await Promise.all([store.save({ width: 900 }), store.save({ width: 1100, zoom: 1.25 })]);
  assert.equal((await new WindowState(dir).read()).width, 1100);
  await fs.writeFile(store.file, 'bad json'); assert.equal((await store.read()).zoom, 1);
});
test('desktop shortcuts reserve only documented chords and preserve IME/native keys', () => {
  const key = (key, more = {}) => shortcut({ type: 'keyDown', key, ...more });
  assert.equal(key('2', { control: true }), 'usage'); assert.equal(key(',', { control: true }), 'appearance');
  assert.equal(key('F6', { shift: true }), 'focus-cycle'); assert.equal(key('+', { control: true, shift: true }), 'zoom-in');
  for (const extra of [{ isComposing: true }, { alt: true }, { meta: true }, { isAutoRepeat: true }]) assert.equal(key('1', { control: true, ...extra }), null);
  assert.equal(key('F4', { alt: true }), null); assert.equal(key('a', { control: true }), null); assert.equal(key('ArrowLeft'), null);
});

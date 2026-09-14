const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AppearanceStore, normalize } = require('../src/appearance-store.cjs');
test('material presets never implicitly select a colorful background', async () => {
  const vm = require('node:vm');
  const properties = {}, el = { dataset: {}, style: { setProperty: (k, v) => properties[k] = v } };
  const context = { document: { documentElement: el }, matchMedia: () => ({ matches: false }) };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '../src/appearance-theme.js'), 'utf8'), context);
  for (const preset of ['classic', 'glass']) for (const mode of ['light', 'dark']) {
    context.DesktopAppearance.apply({ settings: normalize({ preset, mode, background: 'default' }) });
    assert.equal(properties['--wallpaper'], 'none');
    assert.equal(properties['--wallpaper-color'], mode === 'dark' ? '#151b29' : '#f5f7fc');
    assert.equal(properties['--wallpaper-overlay'], '0');
    assert.equal(properties['--wallpaper-blur'], '0px');
    el.dataset.appearanceHost = 'workspace';
    context.DesktopAppearance.apply({ settings: normalize({ preset, mode, background: 'default' }) });
    assert.equal(properties['--wallpaper-color'], mode === 'dark' ? '#151517' : '#ffffff');
    delete el.dataset.appearanceHost;
    context.DesktopAppearance.apply({ settings: normalize({ preset, mode, background: 'gradient' }) });
    assert.match(properties['--wallpaper'], /radial-gradient/);
    context.DesktopAppearance.apply({ settings: normalize({ preset, mode, background: 'solid', color: '#343434' }) });
    assert.equal(properties['--wallpaper-color'], '#343434');
  }
});
test('appearance validates persisted values and never accepts renderer filesystem paths', () => {
  const s = normalize({ wallpaper: '../../credential.bin', color: 'url(file:///secret)', blur: 99, darkOverlay: -1, motion: 'bad' });
  assert.equal(s.wallpaper, undefined); assert.equal(s.color, '#a6b8db'); assert.equal(s.blur, 40); assert.equal(s.darkOverlay, 0); assert.equal(s.motion, 'system');
});
test('serialized settings survive reload, preserve independent masks and recover missing images', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-appearance-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new AppearanceStore(directory);
  await Promise.all([store.save({ preset: 'glass' }), store.save({ lightOverlay: 22 }), store.save({ darkOverlay: 71, wallpaper: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg' })]);
  const { settings } = await new AppearanceStore(directory).read();
  assert.equal(settings.preset, 'glass'); assert.equal(settings.lightOverlay, 22); assert.equal(settings.darkOverlay, 71); assert.equal(settings.wallpaper, undefined);
  await store.save({ background: 'image' }); assert.equal((await store.read()).settings.background, 'default');
  await store.reset(); assert.equal((await store.read()).settings.preset, 'classic');
  await fs.writeFile(store.file, '{broken'); assert.equal((await store.read()).settings.mode, 'system');
});

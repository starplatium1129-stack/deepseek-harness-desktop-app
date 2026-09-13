const test = require('node:test');
const assert = require('node:assert/strict');
const { Spring, profiles } = require('../src/fluid-motion.js');
const { lens } = require('../src/liquid-glass.js');
test('retargeting preserves both position and velocity, then reverses continuously', () => {
  const s = new Spring(0).to(200); s.step(.08);
  const x = s.value, v = s.velocity; assert.ok(v > 0);
  s.to(0); assert.equal(s.value, x); assert.equal(s.velocity, v);
  s.step(.001); assert.ok(s.value > x, 'momentum is retained at the reversal');
  s.step(.15); assert.ok(s.velocity < 0);
  for (let i = 0; i < 240; i++) s.step(1 / 120);
  assert.equal(s.value, 0); assert.equal(s.velocity, 0);
});
test('exact integration follows the same trajectory at 60 Hz, 120 Hz and with frame drops', () => {
  for (const profile of Object.values(profiles)) {
    const a = new Spring(0, profile).to(1), b = new Spring(0, profile).to(1), c = new Spring(0, profile).to(1);
    for (let i = 0; i < 12; i++) a.step(1 / 60);
    for (let i = 0; i < 24; i++) b.step(1 / 120);
    c.step(.2);
    assert.ok(Math.abs(a.value - b.value) < 1e-10); assert.ok(Math.abs(a.value - c.value) < 1e-10);
    assert.ok(Math.abs(a.velocity - b.velocity) < 1e-9);
  }
});
test('repeated interruptions settle at latest target without unbounded energy', () => {
  const s = new Spring(238, profiles.sidebar);
  for (let i = 0; i < 80; i++) { s.to(i % 2 ? 238 : 68); s.step(.027); assert.ok(s.value >= 68 && s.value <= 238); }
  s.to(68); s.step(3); assert.equal(s.value, 68); assert.equal(s.settled, true);
});
test('lens preserves flat interior and silhouette, refracts symmetrically within a bounded edge', () => {
  assert.deepEqual(lens(320, 180, 30, 160, 90), [0, 0]);
  assert.deepEqual(lens(320, 180, 30, -1, 90), [0, 0]);
  const l = lens(320, 180, 30, 5, 90), r = lens(320, 180, 30, 315, 90);
  assert.ok(Math.abs(l[0]) > 1); assert.equal(l[0], -r[0]);
  for (let y = 0; y < 180; y += 3) for (let x = 0; x < 320; x += 3) for (const v of lens(320, 180, 30, x, y)) assert.ok(Number.isFinite(v) && Math.abs(v) <= 15);
});

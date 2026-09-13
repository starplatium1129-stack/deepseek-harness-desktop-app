const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { estimate, format, validate, defaults } = require('../src/usage-pricing.js');
const { build, aggregate } = require('../src/usage-model.js');
const { PricingStore } = require('../src/pricing-store.cjs');
const rates = [{ model: 'fixture / model', input: '2', cacheRead: '0.5', cacheWrite: '3', output: '8', basis: 'test' }];
const turn = { model: rates[0].model, usage: { uncachedInputTokens: 1000, cacheReadTokens: 2000, cacheWriteTokens: 100, outputTokens: 500, reasoningTokens: 300, totalTokens: 3600 } };
test('input, cache and output are billed separately; reasoning is not billed twice', () => {
  const cost = estimate(turn, rates);
  assert.equal(format(cost.units), '$0.007300');
  assert.equal(format(cost.components.cacheRead), '$0.001000');
  assert.equal(format(cost.components.cacheWrite), '$0.000300');
});
test('unknown prices, unreported buckets, mixed models are distinct from free usage', () => {
  assert.equal(estimate(turn, []).units, null);
  assert.equal(estimate({ ...turn, usage: null }, rates).units, null);
  const usage = { ...turn.usage }; delete usage.cacheReadTokens;
  assert.equal(estimate({ ...turn, usage }, rates).units, null);
  assert.equal(estimate(turn, [{ ...rates[0], cacheWrite: null }]).units, null);
  assert.equal(estimate(turn, [{ ...rates[0], input: '0', cacheRead: '0', cacheWrite: '0', output: '0' }]).units, '0');
  assert.equal(estimate({ ...turn, model: '多模型（未拆分）' }, [{ ...rates[0], model: '多模型（未拆分）' }]).units, null);
});
test('tiny charges are summed before rounding', () => {
  const tiny = { model: rates[0].model, usage: { uncachedInputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 1 } };
  const price = [{ ...rates[0], input: '0.000001' }];
  const row = { ...tiny, cost: estimate(tiny, price) };
  assert.equal(row.cost.units, '1');
  assert.equal(aggregate(Array(1000).fill(row)).costUnits, '1000');
  assert.equal(format('1000'), '< $0.000001');
  assert.equal(format('999999999999'), '$1.000000');
});
test('filtering and per-session cost totals stay consistent and show unpriced coverage', () => {
  const now = Date.now();
  const snapshot = { sessions: [{ id: 'a', title: 'A', turns: [{ ...turn, startedAt: now, endedAt: now, durationMs: 1000 }] }, { id: 'b', title: 'B', turns: [{ ...turn, model: 'unknown', startedAt: now, endedAt: now }] }] };
  const total = build(snapshot, { now, rates });
  assert.equal(format(total.costUnits), '$0.007300'); assert.equal(total.priced, 1); assert.equal(total.unpriced, 1);
  assert.equal(build(snapshot, { now, model: 'unknown', rates }).priced, 0);
  assert.equal(build(snapshot, { now, sort: 'cost', rates }).sessions[0].id, 'a');
  assert.equal(total.daily.reduce((sum, d) => sum + BigInt(d.costUnits), 0n).toString(), total.costUnits);
});
test('reference prices apply only to exact official provider names, not resellers', () => {
  const fixture = { ...turn, model: 'deepseek-official / deepseek-flash' };
  assert.notEqual(estimate(fixture, defaults).units, null);
  assert.equal(estimate({ ...fixture, model: 'reseller / deepseek-flash' }, defaults).units, null);
});
test('price validation rejects negative, non-finite, duplicate and over-precision values', () => {
  for (const value of ['-1', 'NaN', 'Infinity', '0.0000001', '1e2', '100001', 2]) assert.throws(() => validate([{ ...rates[0], input: value }]));
  assert.throws(() => validate([rates[0], rates[0]]));
  assert.equal(validate([{ ...rates[0], input: '' }])[0].input, null);
});
test('user prices persist separately, override defaults, and preserve a recovery backup', async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-pricing-test-'));
  const store = new PricingStore(data);
  const initial = await store.read(); assert.equal(initial.rates.length, defaults.length);
  await store.save([rates[0]]);
  const reopened = await new PricingStore(data).read(); assert.equal(reopened.rates.find(r => r.model === rates[0].model).input, '2');
  await store.save([{ ...rates[0], input: '5' }]);
  assert.equal(JSON.parse(await fs.readFile(path.join(data, 'usage-prices.json.bak'), 'utf8')).overrides[0].input, '2');
  await assert.rejects(async () => store.save([{ ...rates[0], input: '-1' }]));
  assert.equal((await store.read()).rates.find(r => r.model === rates[0].model).input, '5');
  await fs.writeFile(store.file, '{broken'); await assert.rejects(store.read(), /无法读取/);
});

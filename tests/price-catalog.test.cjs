const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PriceCatalog, parseCcSwitch, parseModelsDev, price } = require('../src/price-catalog.cjs');
const { PricingStore } = require('../src/pricing-store.cjs');
const { resolveRate } = require('../src/usage-pricing.js');
const cc = value => ({ version: 1, models: [{ modelId: 'gpt-example', inputCostPerMillion: value, outputCostPerMillion: '4', cacheReadCostPerMillion: '0.2', cacheCreationCostPerMillion: '0' }], deletedModelIds: [] });
const remote = input => ({ openai: { models: { 'gpt-example': { modalities: { output: ['text'] }, cost: { input, output: 4, cache_read: .2 } } } }, reseller: { models: { 'gpt-example': { cost: { input: 9, output: 12 } } } } });
test('cc-switch v1 imports model prices and respects tombstones', () => {
  const rows = parseCcSwitch(cc('2')); assert.equal(rows[0].input, '2');
  assert.equal(resolveRate('custom-provider / gpt-example', rows).input, '2');
  assert.equal(parseCcSwitch({ ...cc('2'), deletedModelIds: ['gpt-example'] }).length, 0);
  assert.throws(() => parseCcSwitch({ version: 99, models: [] }));
});
test('remote pricing distinguishes providers and never replaces missing rates with free rates', () => {
  const rows = parseModelsDev(remote(2));
  assert.equal(resolveRate('reseller / gpt-example', rows).input, '9');
  assert.equal(resolveRate('custom / gpt-example', rows).input, '2');
  assert.equal(resolveRate('openai / gpt-example', rows).cacheWrite, null);
  assert.equal(price(.00000001), null); assert.throws(() => price(-1));
  assert.throws(() => parseModelsDev({ x: { models: { m: { cost: { input: 1, output: 2, context_over_200k: {} } } } } }));
});
test('local synchronization detects changes, persists cache and leaves source file unchanged', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-catalog-test-')), file = path.join(dir, 'cc.json');
  await fs.writeFile(file, JSON.stringify(cc('2')));
  const catalog = new PriceCatalog(dir, { ccPath: file }); await catalog.configure({ source: 'cc-switch', auto: true });
  await catalog.sync(true); assert.equal((await catalog.read()).rows[0].input, '2');
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), cc('2'));
  await fs.writeFile(file, JSON.stringify(cc('3'))); catalog.lastAttempt = 0;
  await catalog.sync(); assert.equal((await catalog.read()).rows[0].input, '3');
  await fs.writeFile(file, '{partial'); await catalog.sync(true);
  assert.equal((await catalog.read()).rows[0].input, '3'); assert.ok((await catalog.read()).status.lastError);
  const reopened = new PriceCatalog(dir, { ccPath: file }); assert.equal((await reopened.read()).rows[0].input, '3');
});
test('online sync is coalesced and throttled; failed download retains last valid table', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-catalog-test-')); let count = 0, failed = false;
  const catalog = new PriceCatalog(dir, { ccPath: path.join(dir, 'absent'), fetch: async () => { count++; if (failed) throw Error('offline'); return new Response(JSON.stringify(remote(2))); } });
  await Promise.all([catalog.sync(true), catalog.sync(true)]); assert.equal(count, 1);
  await catalog.sync(); assert.equal(count, 1);
  const before = (await catalog.read()).rows; failed = true; await catalog.sync(true);
  assert.deepEqual((await catalog.read()).rows, before); assert.ok((await catalog.read()).status.lastError);
  await catalog.configure({ source: 'models.dev', auto: false }); catalog.lastAttempt = 0;
  await catalog.sync(); assert.equal(count, 2);
});
test('synchronization never overwrites a custom provider price', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-catalog-test-'));
  const store = new PricingStore(dir, { ccPath: path.join(dir, 'absent'), fetch: async () => new Response(JSON.stringify(remote(2))) });
  const custom = { model: 'openai / gpt-example', input: '7', output: '8', cacheRead: '1', cacheWrite: '0' };
  await store.save([custom]); await store.catalog.sync(true);
  assert.equal(resolveRate(custom.model, (await store.read()).rates).input, '7');
  await store.save([]); assert.equal(resolveRate(custom.model, (await store.read()).rates).input, '2');
});

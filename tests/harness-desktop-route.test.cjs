const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHarnessAdapter, validateTask } = require('../collaboration/adapters/harness.cjs');

test('a live desktop without a bridge requires input and never starts a competing SDK', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-desktop-route-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'); await fs.mkdir(home);
  await fs.writeFile(path.join(home, '.desktop-owner.json'), JSON.stringify({ pid: process.pid }));
  const runtimeRoot = path.join(root, 'runtime');
  const entry = path.join(runtimeRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  const sdk = path.join(runtimeRoot, 'node_modules/@deepseek-ai/dsh-sdk-app/cordis.patch.yml');
  const started = path.join(root, 'unexpected-sdk-start');
  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.writeFile(entry, `require('node:fs').writeFileSync(${JSON.stringify(started)}, 'started'); throw new Error('SDK must not start');`);
  await fs.writeFile(path.join(path.dirname(path.dirname(entry)), 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.1' }));
  await fs.mkdir(path.dirname(sdk), { recursive: true }); await fs.writeFile(sdk, '');
  const adapter = createHarnessAdapter({ harnessHome: home, nodePath: process.execPath, runtimeRoot });
  const states = [];
  const result = await adapter.execute({ id: 'bounded', goal: 'do work', acceptance: ['done'], workspace: root, permission: 'read-only', budget: { maxTurns: 1 }, deadlineAt: new Date(Date.now() + 60000).toISOString() }, {
    signal: new AbortController().signal, emit: async () => {}, checkpoint: async () => { throw new Error('No SDK prompt should be admitted'); }, state: async (state, data) => states.push({ state, data }),
  });
  assert.equal(states[0].state, 'needs_input'); assert.equal(states[0].data.code, 'HARNESS_DESKTOP_BRIDGE_REQUIRED');
  assert.match(result.summary, /不会与桌面争用/);
  await assert.rejects(fs.access(started), { code: 'ENOENT' });
});

test('private native entry applies the same finite turn and time bounds as MCP', () => {
  const task = { id: 'bounded', goal: 'do work', workspace: path.resolve('.'), permission: 'read-only', budget: { maxTurns: 1 }, deadlineAt: new Date(Date.now() + 60000).toISOString() };
  assert.throws(() => validateTask({ ...task, budget: { maxTurns: 51 } }), error => error.code === 'INVALID_BUDGET');
  assert.throws(() => validateTask({ ...task, deadlineAt: new Date(Date.now() + 3700000).toISOString() }), error => error.code === 'INVALID_DEADLINE');
});

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { RuntimeManager, copyTree } = require('../src/runtime.cjs');
const root = path.resolve(__dirname, '..');
async function main() {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-update-test-'));
  console.log('Isolated update data:', data);
  const manager = new RuntimeManager(path.join(root, 'runtime'), data);
  manager.on('progress', text => console.log(text));
  try {
    await manager.init();
    // Disposable baseline lets us exercise the real download path even when the
    // current npm release is already bundled. No user's version state is changed.
    manager.state.active = process.env.DSH_UPDATE_FROM || '0.0.0';
    if (process.env.DSH_UPDATE_FIXTURE) {
      const fixture = path.resolve(process.env.DSH_UPDATE_FIXTURE);
      if (!path.basename(fixture).startsWith('dsh-usage-test-')) throw new Error('Use isolated usage fixture data');
      await copyTree(path.join(fixture, 'harness-home'), manager.home);
    }
    await fs.mkdir(manager.home, { recursive: true });
    await fs.writeFile(path.join(manager.home, 'preserve.txt'), 'saved');
    const result = await manager.stage(); console.log(result.message);
    assert.equal(manager.state.pending, manager.available.version);
    await manager.start();
    assert.equal(manager.state.active, manager.available.version);
    assert.equal(await fs.readFile(path.join(manager.home, 'preserve.txt'), 'utf8'), 'saved');
    assert.equal(manager.state.trial, false);
    if (process.env.DSH_UPDATE_FIXTURE) {
      const snapshot = await manager.process.readUsage();
      assert.equal(snapshot.unavailable, 0);
      assert.equal(snapshot.sessions.flatMap(s => s.turns).reduce((sum, t) => sum + (t.usage?.totalTokens || 0), 0), 25200);
      console.log('Existing session history and usage preserved on the new core.');
    }
    await fs.writeFile(path.join(data, 'verified-runtime.json'), JSON.stringify({ version: manager.state.active, runtimeRoot: manager.root(manager.state.active) }));
    console.log('Real registry install, authenticated probe, activation and data preservation passed.');
  } finally { await manager.stop(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

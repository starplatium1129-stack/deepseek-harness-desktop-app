const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { RuntimeManager } = require('../src/runtime.cjs');
const root = path.resolve(__dirname, '..');
async function main() {
  const data = path.join(root, '.test-data', `update-${Date.now()}`);
  const manager = new RuntimeManager(path.join(root, 'runtime'), data);
  manager.on('progress', text => console.log(text));
  try {
    await manager.init();
    // Disposable baseline lets us exercise the real download path even when the
    // current npm release is already bundled. No user's version state is changed.
    manager.state.active = '0.0.0';
    await fs.mkdir(manager.home, { recursive: true });
    await fs.writeFile(path.join(manager.home, 'preserve.txt'), 'saved');
    const result = await manager.stage(); console.log(result.message);
    assert.equal(manager.state.pending, manager.available.version);
    await manager.start();
    assert.equal(manager.state.active, manager.available.version);
    assert.equal(await fs.readFile(path.join(manager.home, 'preserve.txt'), 'utf8'), 'saved');
    assert.equal(manager.state.trial, false);
    console.log('Real registry install, authenticated probe, activation and data preservation passed.');
  } finally { await manager.stop(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

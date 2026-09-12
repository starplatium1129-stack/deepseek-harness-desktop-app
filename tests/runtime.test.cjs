const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { RuntimeManager, HarnessProcess, validVersion, redact, writeJson, recoverOwnedLocks, copyTree } = require('../src/runtime.cjs');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-desktop-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeJson(path.join(root, 'resources/manifest.json'), { harnessVersion: '1.0.0', nodeVersion: process.versions.node });
  await fs.mkdir(path.join(root, 'resources/harness'), { recursive: true });
  const manager = new RuntimeManager(path.join(root, 'resources'), path.join(root, 'data'));
  await manager.init(); return manager;
}
test('rejects path traversal and malformed runtime versions', () => {
  for (const input of ['../oops', '1.0.0/../../x', 'latest', 'v1.0.0', null]) assert.equal(validVersion(input), false);
  assert.equal(validVersion('0.1.5-rc.1'), true);
});
test('redacts startup authentication and common API credentials', () => {
  assert.equal(redact('dsh web: http://127.0.0.1:4000/?token=secret\nsk-secret123 Bearer abc'), 'dsh web: http://127.0.0.1:4000/[private]\n[redacted] Bearer [redacted]');
});
test('failed update restores previous version and matching data; preserves failed data', async t => {
  const m = await fixture(t);
  await fs.mkdir(m.home, { recursive: true }); await fs.writeFile(path.join(m.home, 'session'), 'original');
  m.state.pending = '1.1.0';
  m.launch = async () => {
    if (m.state.active === '1.1.0') { await fs.writeFile(path.join(m.home, 'session'), 'migrated'); throw new Error('broken release'); }
    return 'http://127.0.0.1:4000/';
  };
  await m.start();
  assert.equal(m.state.active, '1.0.0'); assert.equal(await fs.readFile(path.join(m.home, 'session'), 'utf8'), 'original');
  const recovered = (await fs.readdir(m.data)).find(name => name.startsWith('recovered-data-'));
  assert.equal(await fs.readFile(path.join(m.data, recovered, 'session'), 'utf8'), 'migrated');
});
test('successful update preserves snapshot and manual rollback restores it', async t => {
  const m = await fixture(t); await fs.mkdir(m.home, { recursive: true });
  await fs.writeFile(path.join(m.home, 'setting'), 'old'); m.state.pending = '1.1.0';
  m.launch = async () => 'http://127.0.0.1:4000/'; await m.start();
  assert.equal(m.state.active, '1.1.0'); assert.equal(m.state.previous, '1.0.0');
  await fs.writeFile(path.join(m.home, 'setting'), 'new'); await m.restore();
  assert.equal(await fs.readFile(path.join(m.home, 'setting'), 'utf8'), 'old');
});
test('interrupted trial is recovered on next startup', async t => {
  const m = await fixture(t); await fs.mkdir(m.home, { recursive: true });
  await fs.writeFile(path.join(m.home, 'session'), 'damaged');
  await fs.mkdir(path.join(m.data, 'backups/before-123'), { recursive: true });
  await fs.writeFile(path.join(m.data, 'backups/before-123/session'), 'safe');
  m.state = { active: '1.1.0', previous: '1.0.0', snapshot: 'before-123', trial: true };
  m.launch = async () => 'http://127.0.0.1:4000/'; await m.start();
  assert.equal(m.state.active, '1.0.0'); assert.equal(await fs.readFile(path.join(m.home, 'session'), 'utf8'), 'safe');
});
test('startup timeout stops the child it owns', async t => {
  const m = await fixture(t); const entry = path.join(m.resources, 'harness/node_modules/@deepseek-ai/dsh/lib');
  await fs.mkdir(entry, { recursive: true }); await fs.writeFile(path.join(entry, 'bin.js'), 'setInterval(()=>{},1000)');
  const proc = new HarnessProcess(process.execPath, path.join(m.resources, 'harness'), m.home);
  await assert.rejects(proc.start(300), /超时/); assert.equal(proc.child, null);
});
test('only recovers locks owned by a confirmed exited desktop child', async t => {
  const m = await fixture(t); await fs.mkdir(m.home, { recursive: true });
  const { spawnSync } = require('node:child_process');
  const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  await writeJson(path.join(m.home, '.desktop-owner.json'), { pid: exited.pid });
  await fs.writeFile(path.join(m.home, 'owned.lock'), String(exited.pid));
  await fs.writeFile(path.join(m.home, 'other.lock'), 'unrelated');
  await recoverOwnedLocks(m.home);
  await assert.rejects(fs.access(path.join(m.home, 'owned.lock')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(m.home, 'other.lock'), 'utf8'), 'unrelated');
});
test('backs up and restores Windows profile module junctions', async t => {
  const m = await fixture(t);
  const target = path.join(m.data, 'package-source');
  await fs.mkdir(target, { recursive: true }); await fs.writeFile(path.join(target, 'module.txt'), 'content');
  await fs.mkdir(m.home, { recursive: true });
  await fs.symlink(target, path.join(m.home, 'package-link'), process.platform === 'win32' ? 'junction' : 'dir');
  const backup = path.join(m.data, 'junction-backup');
  await copyTree(m.home, backup);
  assert.equal(await fs.readFile(path.join(backup, 'package-link/module.txt'), 'utf8'), 'content');
  assert.equal((await fs.lstat(path.join(backup, 'package-link'))).isSymbolicLink(), true);
});

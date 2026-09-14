const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { NativeChecks } = require('../collaboration/native-checks.cjs');
const { resolveCodex } = require('../collaboration/codex-reviewer.cjs');

test('actual Codex command sandbox permits the workspace and rejects a sibling write without a model turn', { skip: process.platform !== 'win32' }, async t => {
  try { await resolveCodex(); } catch { t.skip('Native Codex CLI unavailable'); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-check-boundary-'));
  const workspace = path.join(root, 'workspace'), temporaryDirectory = path.join(root, 'allowed-temp');
  await fs.mkdir(workspace); await fs.mkdir(temporaryDirectory);
  const client = await NativeChecks.create(workspace);
  t.after(async () => { await client.close(); assert.equal(await fs.realpath(root), root); await fs.rm(root, { recursive: true, force: true }); });
  const code = 'const fs=require("node:fs");fs.writeFileSync("inside.txt","ok");try{fs.writeFileSync(process.argv[1],"must not write");process.exitCode=9;}catch(e){if(!["EPERM","EACCES"].includes(e.code))throw e;console.log("outside write denied");}';
  let result;
  try {
    result = await client.execute(process.execPath, ['-e', code, path.join(root, 'outside.txt')], { cwd: workspace, temporaryDirectory, permission: 'workspace-write', env: {}, timeoutMs: 10000, signal: new AbortController().signal });
  } catch (error) {
    if (/CreateProcessAsUserW failed: 5/.test(error.message)) {
      t.skip('Windows sandbox runner requires privileges unavailable in current environment');
      return;
    }
    throw error;
  }
  assert.equal(result.exitCode, 0, result.stderr); assert.match(result.stdout, /outside write denied/);
  assert.equal(await fs.readFile(path.join(workspace, 'inside.txt'), 'utf8'), 'ok');
  await assert.rejects(fs.access(path.join(root, 'outside.txt')), { code: 'ENOENT' });
});

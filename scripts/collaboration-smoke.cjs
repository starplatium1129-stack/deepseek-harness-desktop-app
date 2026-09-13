// Explicit opt-in: creates a tiny isolated Git fixture and makes two native model turns.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createInterface } = require('node:readline');
const { git } = require('../collaboration/core.cjs');
const exec = promisify(execFile);
async function main() {
  if (!process.argv.includes('--live')) { console.log('Use --live to authorize two bounded native Harness tasks and preserve evidence in .test-data/collaboration-live.'); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-collaboration-mcp-'));
  const repo = path.join(root, 'repo'); await fs.mkdir(repo);
  await git(repo, ['init']); await git(repo, ['config', 'user.email', 'smoke@example.invalid']); await git(repo, ['config', 'user.name', 'Collaboration Smoke']);
  await fs.writeFile(path.join(repo, 'greet.cjs'), "exports.greet = name => `Hello, ${name}!`;\n");
  await fs.writeFile(path.join(repo, 'greet.test.cjs'), "const {test}=require('node:test'); const assert=require('node:assert/strict'); const {greet}=require('./greet.cjs'); test('normal greeting',()=>assert.equal(greet('Ada'),'Hello, Ada!')); test('trim surrounding spaces',()=>assert.equal(greet('  Ada  '),'Hello, Ada!'));\n");
  await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'bounded native collaboration fixture']);
  const dataDir = path.join(root, 'service');
  const packaged = process.argv.includes('--packaged');
  const packagedRuntime = path.resolve(__dirname, '../release/win-unpacked/resources/runtime');
  const cli = process.env.COLLABORATION_SMOKE_CLI || (packaged ? path.join(packagedRuntime, 'collaboration/cli.cjs') : path.resolve(__dirname, '../collaboration/cli.cjs'));
  const serviceNode = packaged ? path.join(packagedRuntime, 'node/node.exe') : process.execPath;
  const child = spawn(serviceNode, [cli, '--allow-root', repo, '--data-dir', dataDir], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let sequence = 0, stderr = ''; const pending = new Map();
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8000); });
  child.on('exit', code => { for (const p of pending.values()) p.reject(new Error(`MCP exited (${code}): ${stderr}`)); pending.clear(); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const p = pending.get(message.id); if (!p) return; pending.delete(message.id);
    if (message.error) p.reject(new Error(message.error.message)); else p.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const call = async (name, args = {}) => {
    const result = await request('tools/call', { name, arguments: args });
    const value = result.structuredContent || JSON.parse(result.content[0].text);
    if (result.isError) throw new Error(value.error); return value;
  };
  async function wait(taskId) {
    let task = await call('get_task', { taskId });
    while (task.lease || !['completed', 'failed', 'cancelled', 'needs_input', 'needs_approval'].includes(task.state)) task = await call('wait_task', { taskId, afterSequence: task.sequence, timeoutMs: 10000 });
    if (task.state !== 'completed') throw new Error(`Native task ${taskId} ended ${task.state}: ${task.error || JSON.stringify(task.events)}`);
    return task;
  }
  async function verifyScope(task) {
    const changed = await git(task.workspace, ['diff', '--name-only', task.baseCommit, '--']);
    if (changed !== 'greet.cjs') throw new Error(`Unexpected changed files: ${changed}`);
    const extra = await git(task.workspace, ['ls-files', '--others', '--exclude-standard']);
    if (extra) throw new Error(`Unexpected untracked files: ${extra}`);
  }
  const report = { at: new Date().toISOString(), transport: 'MCP stdio', packaged, cli, serviceNode, root, dataDir, tests: [] };
  const watchdog = setTimeout(() => { child.stdin.end(); }, 240000);
  try {
    await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'codex-collaboration-review', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    report.executors = await call('list_executors');
    const first = await call('submit_task', {
      executor: 'harness', repository: repo, permission: 'workspace-write', budget: { maxTurns: 6 }, deadlineAt: new Date(Date.now() + 90000).toISOString(), idempotencyKey: 'greet-trim-v1',
      goal: '只修改 greet.cjs：让 greet(name) 对名字前后的空白调用 trim，保留 Hello, NAME! 格式。只使用文件读取和编辑工具，不使用 shell/Bash、不改测试、不委派。测试由审核端执行。',
      acceptance: ['greet("  Ada  ") 返回 "Hello, Ada!"', '原始 greet("Ada") 行为不变', '只修改 greet.cjs'],
    });
    report.first = await wait(first.id);
    await verifyScope(report.first);
    const test1 = await exec(process.execPath, ['--test', 'greet.test.cjs'], { cwd: report.first.workspace, windowsHide: true, timeout: 10000 });
    report.tests.push({ taskId: first.id, command: 'node --test greet.test.cjs', exitCode: 0, stdout: test1.stdout });
    await call('review_task', { taskId: first.id, decision: 'changes_requested', note: '审核端实际运行 node --test greet.test.cjs，2 项通过；定向修订要求空白名字抛出 TypeError。' });
    const second = await call('send_followup', {
      taskId: first.id, idempotencyKey: 'greet-empty-v2', budget: { maxTurns: 10 }, deadlineAt: new Date(Date.now() + 90000).toISOString(),
      goal: '定向修订：只编辑 greet.cjs，保留 trim 后正常名字的 Hello, NAME! 输出；若 trim 后为空字符串则抛出 TypeError。只用文件工具，不运行 shell、不改测试、不委派。',
      acceptance: ['空字符串和纯空白字符串抛出 TypeError', '带空白的正常名字仍通过原测试', '只修改 greet.cjs'],
    });
    report.second = await wait(second.id);
    await verifyScope(report.second);
    const test2 = await exec(process.execPath, ['--test', 'greet.test.cjs'], { cwd: report.second.workspace, windowsHide: true, timeout: 10000 });
    const emptyTest = "const a=require('node:assert/strict');const {greet}=require('./greet.cjs');a.throws(()=>greet(''),TypeError);a.throws(()=>greet('  '),TypeError);console.log('2 empty-name assertions passed');";
    const test3 = await exec(process.execPath, ['-e', emptyTest], { cwd: report.second.workspace, windowsHide: true, timeout: 10000 });
    report.tests.push({ taskId: second.id, command: 'node --test greet.test.cjs', exitCode: 0, stdout: test2.stdout }, { taskId: second.id, command: 'node -e <2 TypeError assertions>', source: emptyTest, exitCode: 0, stdout: test3.stdout });
    report.review = await call('review_task', { taskId: second.id, decision: 'accepted', note: '审核端已检查实际差异，只修改 greet.cjs；node --test 2 项通过，另 2 项空名字 TypeError 断言通过。未合并修改。' });
    report.result = await call('read_result', { taskId: second.id });
    if (report.first.nativeSessionId !== report.second.nativeSessionId) throw new Error('Followup did not retain native session');
    const source = await fs.readFile(path.join(repo, 'greet.cjs'), 'utf8');
    if (source !== "exports.greet = name => `Hello, ${name}!`;\n") throw new Error('Source repository was modified');
    report.passed = true;
  } catch (error) { report.passed = false; report.error = error.message; throw error; }
  finally {
    clearTimeout(watchdog); child.stdin.end();
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); }); lines.close();
    const reportDir = path.resolve(__dirname, '../.test-data/collaboration-live'); await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(path.join(reportDir, 'latest.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed, report: path.join(reportDir, 'latest.json'), dataDir, firstTask: report.first?.id, revisionTask: report.second?.id, error: report.error }, null, 2));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

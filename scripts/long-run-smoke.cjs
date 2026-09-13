// Explicit live acceptance: native Codex coordinates native Harness without
// an active caller connection. No durable Codex sidebar thread or API key copy.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { git, redact } = require('../collaboration/core.cjs');
const { SharedClient } = require('../collaboration/client.cjs');
const { readSharedStatus, connectShared } = require('../collaboration/bridge.cjs');
const exec = promisify(execFile);
async function main() {
  if (!process.argv.includes('--live')) { console.log('Use --live for a bounded native Codex → Harness → checks → Codex → next-task acceptance run.'); return; }
  const reportDir = path.resolve(__dirname, '../.test-data/long-run-live'); await fs.mkdir(reportDir, { recursive: true });
  const repository = await fs.mkdtemp(path.join(reportDir, 'fixture-'));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'long-run-service-'));
  await git(repository, ['init']); await git(repository, ['config', 'user.email', 'smoke@example.invalid']); await git(repository, ['config', 'user.name', 'Native long-run validation']);
  const original = 'exports.greet = name => `Hello, ${name}!`;\n';
  await fs.writeFile(path.join(repository, 'greet.cjs'), original);
  await fs.writeFile(path.join(repository, 'greet.test.cjs'), 'const {test}=require("node:test");const a=require("node:assert/strict");const {greet}=require("./greet.cjs");test("normal",()=>a.equal(greet("Ada"),"Hello, Ada!"));test("trim",()=>a.equal(greet("  Ada  "),"Hello, Ada!"));\n');
  await git(repository, ['add', '.']); await git(repository, ['commit', '-m', 'native long-run fixture']);
  const options = { dataDir, allowedRoots: [repository] };
  const report = { at: new Date().toISOString(), repository, dataDir, nativeCodexReviewer: true, nativeHarnessExecutor: true, passed: false };
  let client, run;
  try {
    client = await SharedClient.connect(options);
    report.serverInfo = client.info.serverInfo;
    run = await client.call('start_run', { repository, goal: '分两阶段完善 greet：第一轮只给名字加 trim，明确不要加入空白名字检查；由 Codex 审核后，后续一轮再加入空名字 TypeError。只修改 greet.cjs，不改测试。',
      acceptance: ['greet("  Ada  ") 与 greet("Ada") 均返回 Hello, Ada!', '空字符串和纯空白名字抛出 TypeError', '只修改 greet.cjs，测试文件保留原样', '先执行并审核仅 trim 的一步，再通过后续任务添加 TypeError，至少两轮执行'],
      permission: 'workspace-write', deadlineAt: new Date(Date.now() + 600000).toISOString(), maxRounds: 4, maxTurnsPerTask: 10, checks: [
        { command: 'node', args: ['--test', 'greet.test.cjs'] },
        { command: 'node', args: ['-e', 'const a=require("node:assert/strict");const {greet}=require("./greet.cjs");a.throws(()=>greet(""),TypeError);a.throws(()=>greet("  "),TypeError);console.log("2 empty-name assertions passed")'] },
      ], idempotencyKey: `native-long-${path.basename(dataDir)}` });
    report.runId = run.id; client.close(); client = null;
    // Observe durable records only. There is no caller MCP session supplying
    // the review decision or requesting the next Harness task during this loop.
    let last = '';
    while (Date.now() < Date.parse(run.deadlineAt) + 30000) {
      const recorded = JSON.parse(await fs.readFile(path.join(dataDir, 'runs', `${run.id}.json`), 'utf8'));
      const progress = `${recorded.state}:${recorded.stage}:${recorded.iteration}`;
      if (progress !== last) { console.log(JSON.stringify({ runId: run.id, state: recorded.state, stage: recorded.stage, round: recorded.iteration })); last = progress; }
      if (['completed', 'blocked', 'paused'].includes(recorded.state)) break;
      const status = await readSharedStatus(options);
      if (status.clientCount !== 0) throw new Error('Acceptance expected zero caller MCP sessions while the coordinator works.');
      report.zeroCallerConnectionObserved = true;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    client = await SharedClient.connect(options);
    run = await client.call('get_run', { runId: run.id });
    while (run.coordinatorActive) run = await client.call('wait_run', { runId: run.id, afterSequence: run.sequence, timeoutMs: 10000 });
    report.run = run;
    if (run.state !== 'completed') throw new Error(`Long run ended ${run.state}: ${run.reason || run.lastDecision?.summary}`);
    if (run.iteration < 2) throw new Error('Native acceptance did not demonstrate a subsequent task.');
    const changed = await git(run.workspace, ['diff', '--name-only', '--']);
    if (changed !== 'greet.cjs' || await git(run.workspace, ['ls-files', '--others', '--exclude-standard'])) throw new Error('Unexpected file changes.');
    const tested = await exec(process.execPath, ['--test', 'greet.test.cjs'], { cwd: run.workspace, windowsHide: true, timeout: 10000 });
    report.finalTest = { exitCode: 0, output: tested.stdout };
    if (await fs.readFile(path.join(repository, 'greet.cjs'), 'utf8') !== original) throw new Error('Original fixture changed.');
    report.passed = true;
  } catch (error) { report.error = redact(error.message); throw error; }
  finally {
    if (client) client.close();
    await fs.writeFile(path.join(reportDir, 'latest.json'), JSON.stringify(report, null, 2));
    // Graceful shutdown only for this isolated validation service, never the
    // registered user daemon or the desktop-owned Harness process.
    try { const status = await readSharedStatus(options); if (!status.busy && !status.clientCount) { const connection = await connectShared({ ...options, operation: 'shutdown' }); connection.socket.destroy(); } } catch {}
    console.log(JSON.stringify({ passed: report.passed, report: path.join(reportDir, 'latest.json'), runId: run?.id, error: report.error }));
  }
}
main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });

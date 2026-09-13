// Exercise the registered server THROUGH Codex App Server, without a Codex
// model turn or any persistent/user-visible Codex task. Native model tasks
// are only dispatched with the explicit --live switch.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createInterface } = require('node:readline');
const { git, redact } = require('../collaboration/core.cjs');
const exec = promisify(execFile);
const repositoryRoot = path.resolve(__dirname, '..');

class CodexClient {
  constructor({ isolated = false } = {}) {
    this.pending = new Map(); this.next = 0;
    const args = ['app-server', '--listen', 'stdio://'];
    if (isolated) {
      const dataDir = path.join(process.env.APPDATA, 'DeepSeek-Harness-Collaboration', 'verification');
      args.push('-c', `mcp_servers.agent-collaboration.args=${JSON.stringify([path.join(repositoryRoot, 'collaboration', 'cli.cjs'), '--shared', '--allow-root', repositoryRoot, '--data-dir', dataDir])}`);
    }
    this.child = spawn(process.env.COLLABORATION_CODEX_EXE || 'codex', args, { cwd: repositoryRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', () => {}); // Native diagnostics can contain unrelated account information.
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      if (Buffer.byteLength(line) > 16 * 1024 * 1024) return this.fail(new Error('Codex response exceeds validation limit.'));
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.method) {
        if (message.id !== undefined) this.child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Verification client does not grant approvals or supply credentials.' } }) + '\n');
        return;
      }
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      message.error ? pending.reject(new Error(redact(message.error.message))) : pending.resolve(message.result);
    });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', code => this.fail(new Error(`Verification Codex App Server exited (${code}).`)));
    this.child.stdin.on('error', error => this.fail(error));
  }
  fail(error) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
  request(method, params, timeout = 90000) {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex request timed out: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }) + '\n');
    });
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'collaboration-integration-verifier', title: 'Local collaboration verification', version: '1.0.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
    this.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    // In-memory protocol fixture: no turn/start, model request or durable sidebar task.
    const started = await this.request('thread/start', { cwd: repositoryRoot, ephemeral: true });
    this.threadId = started.thread.id;
    const status = await this.request('mcpServerStatus/list', { threadId: this.threadId, detail: 'toolsAndAuthOnly', limit: 100 });
    this.server = status.data.find(item => item.name === 'agent-collaboration');
    const required = ['list_executors', 'submit_task', 'get_task', 'wait_task', 'read_result', 'send_followup', 'cancel_task', 'review_task'];
    if (!this.server || this.server.toolsError || required.some(name => !Object.hasOwn(this.server.tools || {}, name))) throw new Error(`Registered collaboration server did not expose the core task tools: ${this.server?.toolsError || 'missing server/catalog'}`);
    return { name: this.server.name, runtimeStatus: this.server.runtimeStatus, toolNames: Object.keys(this.server.tools), authStatus: this.server.authStatus };
  }
  async call(tool, args = {}) {
    const result = await this.request('mcpServer/tool/call', { threadId: this.threadId, server: 'agent-collaboration', tool, arguments: args });
    const value = result.structuredContent || JSON.parse(result.content.find(item => item.type === 'text').text);
    if (result.isError) throw new Error(value.error || 'MCP tool failed'); return value;
  }
  async close() {
    this.child.stdin.end();
    if (this.child.exitCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => { this.child.kill(); resolve(); }, 5000);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    this.lines.close(); this.fail(new Error('Validation connection closed.'));
  }
}

async function run(executor = 'harness', live = false, isolated = false, model) {
  if (!['harness', 'zcode'].includes(executor)) throw new Error('Executor must be harness or zcode.');
  const client = new CodexClient({ isolated }), id = randomUUID();
  const reportDir = path.join(repositoryRoot, '.test-data', 'registered-codex'); await fs.mkdir(reportDir, { recursive: true });
  const report = { at: new Date().toISOString(), transport: 'Registered MCP via actual Codex App Server', isolatedServiceDataOverride: isolated, codexModelTurns: 0, codexThreadPersistence: 'ephemeral', executor, live, ...(model ? { requestedModel: model } : {}), tests: [] };
  async function finishTask(taskId) {
    let task = await client.call('get_task', { taskId });
    let announced;
    while (task.lease || !['completed', 'failed', 'cancelled', 'needs_input', 'needs_approval'].includes(task.state)) {
      if (task.state === 'needs_input' && !task.dispatchUncertain && announced !== task.state) console.log(JSON.stringify({ taskId, state: task.state, deadlineAt: task.deadlineAt, message: '原生应用正在等待用户输入或验证；不会自动刷新或重派。' }));
      announced = task.state;
      task = await client.call('wait_task', { taskId, afterSequence: task.sequence, timeoutMs: 15000 });
    }
    if (task.state !== 'completed') {
      report.failedTask = { id: task.id, state: task.state, errorCode: task.errorCode, error: task.error, workspace: task.workspace, nativeSessionId: task.nativeSessionId };
      throw new Error(`Native ${executor} task ${task.id}: ${task.state}: ${task.error || 'see persisted input/approval event'}`);
    }
    return task;
  }
  async function verify(task, empty = false) {
    const changed = await git(task.workspace, ['diff', '--name-only', task.baseCommit, '--']);
    const extra = await git(task.workspace, ['ls-files', '--others', '--exclude-standard']);
    if (changed !== 'greet.cjs' || extra) throw new Error('Native task changed files outside acceptance scope.');
    const test = await exec(process.execPath, ['--test', 'greet.test.cjs'], { cwd: task.workspace, windowsHide: true, timeout: 10000 });
    report.tests.push({ taskId: task.id, command: 'node --test greet.test.cjs', exitCode: 0, stdout: test.stdout });
    if (empty) {
      const source = "const a=require('node:assert/strict');const {greet}=require('./greet.cjs');a.throws(()=>greet(''),TypeError);a.throws(()=>greet('  '),TypeError);console.log('2 empty-name assertions passed');";
      const result = await exec(process.execPath, ['-e', source], { cwd: task.workspace, windowsHide: true, timeout: 10000 });
      report.tests.push({ taskId: task.id, command: 'node -e <empty-name assertions>', source, exitCode: 0, stdout: result.stdout });
    }
  }
  try {
    report.codex = await client.initialize();
    report.executors = await client.call('list_executors');
    if (live) {
      const repo = path.join(reportDir, `fixture-${id}`); await fs.mkdir(repo);
      await git(repo, ['init']); await git(repo, ['config', 'user.email', 'smoke@example.invalid']); await git(repo, ['config', 'user.name', 'Registered Collaboration Test']);
      await fs.writeFile(path.join(repo, 'greet.cjs'), "exports.greet = name => `Hello, ${name}!`;\n");
      await fs.writeFile(path.join(repo, 'greet.test.cjs'), "const {test}=require('node:test');const assert=require('node:assert/strict');const {greet}=require('./greet.cjs');test('normal',()=>assert.equal(greet('Ada'),'Hello, Ada!'));test('trim',()=>assert.equal(greet('  Ada  '),'Hello, Ada!'));\n");
      await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'registered MCP acceptance fixture']);
      report.repository = repo;
      const budget = { maxTurns: executor === 'zcode' ? null : 10 };
      const executionMs = executor === 'zcode' ? 300000 : 90000;
      const first = await client.call('submit_task', { executor, repository: repo, permission: 'workspace-write', budget, ...(model ? { model } : {}), deadlineAt: new Date(Date.now() + executionMs).toISOString(), idempotencyKey: `registered-${id}-trim`,
        goal: '只编辑 greet.cjs，让 greet(name) 对名字调用 trim，再返回 Hello, NAME!。不改其他文件，不使用 shell 或委派。测试由审核端执行；修改后简洁报告完成。',
        acceptance: ['只修改 greet.cjs', 'greet("  Ada  ") 返回 "Hello, Ada!"', '正常名字行为不变'] });
      report.first = await finishTask(first.id); await verify(report.first);
      await client.call('review_task', { taskId: first.id, decision: 'changes_requested', note: '已检查仅 greet.cjs 改动且审核端 2 项测试通过；定向修订要求空白名字抛出 TypeError。' });
      const second = await client.call('send_followup', { taskId: first.id, idempotencyKey: `registered-${id}-empty`, budget, deadlineAt: new Date(Date.now() + executionMs).toISOString(),
        goal: '定向修订：只编辑 greet.cjs，在 trim 后名字为空时抛出 TypeError；保留其余问候行为。不改测试，不使用 shell，不委派。修改后直接报告；测试由审核端执行。',
        acceptance: ['只修改 greet.cjs', '空字符串和纯空白字符串抛出 TypeError', '带空白的正常名字仍返回 Hello, NAME!'] });
      report.second = await finishTask(second.id); await verify(report.second, true);
      if (report.first.nativeSessionId !== report.second.nativeSessionId) throw new Error('Native session was not retained on revision.');
      await client.call('review_task', { taskId: second.id, decision: 'accepted', note: '实际差异仅 greet.cjs；审核端 node --test 两项通过，另两项空白名字 TypeError 断言通过；原会话续接，未合并。' });
      report.result = await client.call('read_result', { taskId: second.id });
    }
    report.passed = true;
  } catch (error) { report.passed = false; report.error = redact(error.message); throw error; }
  finally {
    await client.close();
    const file = path.join(reportDir, `${executor}-${live ? 'live' : 'connection'}.json`);
    await fs.writeFile(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed, executor, toolNames: report.codex?.toolNames, report: file, firstTask: report.first?.id, revisionTask: report.second?.id, error: report.error }, null, 2));
  }
}
if (require.main === module) {
  const at = process.argv.indexOf('--model');
  const model = at < 0 ? undefined : process.argv[at + 1];
  if (at >= 0 && (!model || model.startsWith('--'))) { console.error('--model requires an explicit native model identifier.'); process.exitCode = 1; }
  else run(process.argv.includes('--zcode') ? 'zcode' : 'harness', process.argv.includes('--live'), process.argv.includes('--isolated'), model).catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
}
module.exports = { CodexClient, run };

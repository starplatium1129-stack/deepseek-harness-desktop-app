'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { git, safe, within } = require('./core.cjs');
const { decideWithCodex, schema } = require('./codex-reviewer.cjs');
const { NativeChecks } = require('./native-checks.cjs');
const { validate } = require('./mcp.cjs');
const terminal = new Set(['completed', 'paused', 'blocked', 'cancelled']);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const text = (value, name, max = 16000) => { if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`${name} 必须是非空、有限文本。`); return value; };
function conditions(items) { if (!Array.isArray(items) || !items.length || items.length > 30) throw new Error('需要 1–30 条验收条件。'); return items.map(value => text(value, '验收条件', 8000)); }
function future(value) { const at = Date.parse(value); if (!Number.isFinite(at) || at <= Date.now() || at > Date.now() + 86400000) throw new Error('长任务截止时间必须在未来 24 小时内。'); return new Date(at).toISOString(); }
async function write(file, value) { const temp = `${file}.${randomUUID()}.tmp`; const handle = await fs.open(temp, 'wx', 0o600); try { await handle.writeFile(JSON.stringify(safe(value), null, 2)); await handle.sync(); } finally { await handle.close(); } await fs.rename(temp, file); }
function decision(value, count, planning) {
  const error = validate(schema, value);
  if (error) throw new Error(`Codex 决策无效：${error}`);
  text(value.summary, '审核说明', 8000);
  if (value.criteria.length !== count || new Set(value.criteria.map(c => c.index)).size !== count || value.criteria.some(c => c.index < 0 || c.index >= count)) throw new Error('审核必须逐条覆盖原始验收条件。');
  for (const c of value.criteria) text(c.evidence, '验收证据', 8000);
  if (planning && value.review !== 'not_applicable') throw new Error('规划回合不能冒充执行审核。');
  if (!planning && value.review === 'not_applicable') throw new Error('执行后必须给出审核结论。');
  if (value.action === 'continue') { if (!value.nextTask || validate(schema.properties.nextTask.anyOf[1], value.nextTask)) throw new Error('继续时必须提供有效的下一任务。'); text(value.nextTask.goal, '下一任务'); conditions(value.nextTask.acceptance); }
  else if (value.nextTask !== null) throw new Error('结束或阻塞时不能附带待执行任务。');
  if (value.action === 'complete' && (planning || value.review !== 'accepted' || value.criteria.some(c => c.status !== 'pass'))) throw new Error('总目标尚未逐条验收，不能完成。');
  return safe(value);
}
function checkSpecs(checks = []) {
  if (!Array.isArray(checks) || checks.length > 10) throw new Error('最多配置 10 个验证命令。');
  return checks.map(check => {
    if (!check || Object.keys(check).some(k => !['command', 'args', 'timeoutMs'].includes(k))) throw new Error('验证命令只接受 command、args、timeoutMs。');
    const command = text(check.command, '验证程序', 4096);
    if (!['node', 'npm'].includes(command) && !(path.isAbsolute(command) && /\.exe$/i.test(command))) throw new Error('验证程序仅支持内置 node/npm 或显式 .exe 路径；不接受 shell 命令字符串。');
    if (!Array.isArray(check.args) || check.args.length > 50 || check.args.some(a => typeof a !== 'string' || a.includes('\0') || a.length > 16000)) throw new Error('验证参数必须为有界字符串数组。');
    const timeoutMs = check.timeoutMs ?? 60000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) throw new Error('验证超时须为 100–300000 毫秒。');
    return { command, args: [...check.args], timeoutMs };
  });
}
async function runChecks(run, task, { signal, resources }) {
  const results = [];
  if (!run.checks.length) return results;
  const tempRoot = path.join(run.controlDirectory, 'verification-tmp'); await fs.mkdir(tempRoot, { recursive: true });
  const temporaryDirectory = await fs.mkdtemp(path.join(tempRoot, 'check-'));
  const client = await NativeChecks.create(task.workspace);
  try {
  for (const check of run.checks) {
    signal.throwIfAborted();
    let command = check.command, args = [...check.args];
    if (command === 'node' || command === 'npm') {
      if (command === 'npm') args.unshift(path.join(resources, 'npm/bin/npm-cli.js'));
      command = path.join(resources, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
    }
    // Windows sandbox accounts can open an explicitly allowed worktree under
    // AppData but cannot enumerate the private ancestors that Node.realpath
    // probes. Use known Node module-resolution flags instead of widening reads.
    const preserveNodePaths = process.platform === 'win32' && [process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean).some(root => within(path.dirname(root), task.workspace));
    const env = { PATH: `${path.join(resources, 'node')}${path.delimiter}${process.env.PATH || ''}`, TEMP: temporaryDirectory, TMP: temporaryDirectory,
      NODE_OPTIONS: preserveNodePaths ? '--preserve-symlinks --preserve-symlinks-main' : null, ELECTRON_RUN_AS_NODE: null, OPENAI_API_KEY: null, CODEX_API_KEY: null, DEEPSEEK_API_KEY: null };
    const timeout = Math.max(1, Math.min(check.timeoutMs, Date.parse(run.deadlineAt) - Date.now()));
    try {
      const output = await client.execute(command, args, { cwd: task.workspace, permission: run.permission, env, timeoutMs: timeout, signal, temporaryDirectory });
      results.push({ command: check.command, args: check.args, exitCode: output.exitCode, sandbox: 'native-codex', networkAccess: false, nodeOptions: env.NODE_OPTIONS, output: safe(`${output.stdout}\n${output.stderr}`).slice(0, 24000) });
    } catch (error) {
      if (signal.aborted) throw error;
      results.push({ command: check.command, args: check.args, exitCode: Number.isInteger(error.code) ? error.code : null, error: safe(error.message).slice(0, 2000), output: safe(`${error.stdout || ''}\n${error.stderr || ''}`).slice(0, 24000) });
    }
  }
  } finally { await client.close(); }
  return results;
}
async function evidence(service, task) {
  const sensitive = name => /(^|[/\\])(?:\.env(?:\..*)?|.*credentials.*|auth\.json|.*\.(?:pem|key|pfx))$/i.test(name);
  const changedPaths = (await git(task.workspace, ['diff', '--name-only', '-z', task.baseCommit, '--'])).split('\0').filter(Boolean);
  if (changedPaths.some(sensitive)) throw new Error('变更涉及敏感配置，暂停自动审核；不会读取其差异。');
  const result = await service.readResult({ taskId: task.id, limit: 64000 });
  const diff = await git(task.workspace, ['diff', '--no-ext-diff', '--no-textconv', '--binary', task.baseCommit, '--']);
  const status = await git(task.workspace, ['status', '--porcelain=v1']);
  const extra = await git(task.workspace, ['ls-files', '--others', '--exclude-standard']);
  const files = [];
  for (const relative of extra.split('\n').filter(Boolean).slice(0, 20)) {
    if (sensitive(relative)) { files.push({ path: relative, omitted: 'potential credential' }); continue; }
    const file = await fs.realpath(path.resolve(task.workspace, relative));
    if (!within(task.workspace, file)) throw new Error('未跟踪文件指向工作树外部。');
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 32000) files.push({ path: relative, omitted: 'not a small text file' });
    else { const bytes = await fs.readFile(file); files.push({ path: relative, sha256: createHash('sha256').update(bytes).digest('hex'), ...(bytes.includes(0) ? { omitted: 'binary' } : { text: safe(bytes.toString('utf8')) }) }); }
  }
  const data = { executorResult: result.text, diff: safe(diff.slice(0, 64000)), status, untracked: files, truncated: result.hasMore || diff.length > 64000 || files.some(f => f.omitted) || extra.split('\n').filter(Boolean).length > 20 };
  return { ...data, digest: hash({ diff, status, files }) };
}

class LongRunManager extends EventEmitter {
  constructor({ service, resources, reviewer = decideWithCodex, verifier = runChecks, managedLifetime = false }) {
    super(); Object.assign(this, { service, resources, reviewer, verifier, managedLifetime });
    this.runs = new Map(); this.active = new Map(); this.serial = Promise.resolve(); this.persistSerial = Promise.resolve(); this.closing = false;
    this.directory = path.join(service.dataDir, 'runs');
  }
  transaction(fn) { const next = this.serial.then(fn); this.serial = next.catch(() => {}); return next; }
  file(id) { return path.join(this.directory, `${id}.json`); }
  view(run) { const { prepared, fingerprint, history, ...rest } = run; const coordinatorActive = this.active.has(run.id); return structuredClone({ ...rest, state: terminal.has(run.state) && coordinatorActive ? 'settling' : run.state, coordinatorActive, history: history.slice(-10) }); }
  lookup(id) { const run = this.runs.get(id); if (!run) throw new Error('长任务不存在。'); return run; }
  save(run, event, data = {}) {
    const operation = this.persistSerial.then(async () => {
      const previous = { time: run.updatedAt, sequence: run.sequence, length: run.history.length };
      run.updatedAt = new Date().toISOString(); run.sequence++;
      run.history.push({ sequence: run.sequence, at: run.updatedAt, event, ...safe(data) });
      try { await write(this.file(run.id), run); }
      catch (error) { run.updatedAt = previous.time; run.sequence = previous.sequence; run.history.splice(previous.length); throw error; }
      this.emit('change', run.id);
    });
    this.persistSerial = operation.catch(() => {}); return operation;
  }
  async init() {
    await fs.mkdir(this.directory, { recursive: true });
    for (const file of await fs.readdir(this.directory)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
      const run = JSON.parse(await fs.readFile(path.join(this.directory, file), 'utf8'));
      if (`${run.id}.json` !== file || !Array.isArray(run.history)) throw new Error('长任务记录损坏。');
      this.runs.set(run.id, run);
      if (!terminal.has(run.state)) { run.state = 'paused'; run.reason = '协调进程曾中断；恢复前核对已持久化子任务，不会自动重派。'; await this.save(run, 'recovery_required'); }
    }
    return this;
  }
  async start(input) {
    return this.transaction(async () => {
      if (this.closing) throw new Error('协调器正在关闭。');
      if (!this.managedLifetime) throw new Error('长任务需要 --shared 共享后台，以免客户端断开后停止协调。');
      text(input.idempotencyKey, '幂等键', 200);
      const fingerprint = hash(input), previous = [...this.runs.values()].find(r => r.idempotencyKey === input.idempotencyKey);
      if (previous) { if (previous.fingerprint !== fingerprint) throw new Error('幂等键已用于不同长任务。'); return this.view(previous); }
      if (this.active.size) throw new Error('当前已有长任务在协调，先完成或暂停它。');
      const repository = await this.service.validateRepository(input.repository);
      const ref = input.baseCommit || 'HEAD'; text(ref, '基准版本', 256); if (ref.startsWith('-')) throw new Error('无效基准版本。');
      const baseCommit = await git(repository, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
      if (!['read-only', 'workspace-write'].includes(input.permission)) throw new Error('必须指定长任务权限。');
      if (!Number.isInteger(input.maxRounds) || input.maxRounds < 1 || input.maxRounds > 20) throw new Error('maxRounds 必须为 1–20。');
      if (!Number.isInteger(input.maxTurnsPerTask) || input.maxTurnsPerTask < 1 || input.maxTurnsPerTask > 50) throw new Error('maxTurnsPerTask 必须为 1–50。');
      const run = { id: randomUUID(), idempotencyKey: input.idempotencyKey, fingerprint, repository, baseCommit,
        goal: text(input.goal, '项目目标'), acceptance: conditions(input.acceptance), permission: input.permission,
        maxRounds: input.maxRounds, maxTurnsPerTask: input.maxTurnsPerTask, deadlineAt: future(input.deadlineAt), checks: checkSpecs(input.checks),
        codexModel: input.codexModel ? text(input.codexModel, 'Codex 模型', 200) : undefined, harnessModel: input.harnessModel ? text(input.harnessModel, 'Harness 模型', 200) : undefined,
        state: 'running', stage: 'planning', iteration: 0, stagnant: 0, taskId: null, sequence: 0, history: [], createdAt: new Date().toISOString(), autoMerge: false };
      run.controlDirectory = path.join(this.directory, run.id);
      const hasGuidance = await git(repository, ['ls-tree', '--name-only', baseCommit, '--', 'AGENTS.md']);
      const guidance = hasGuidance ? await git(repository, ['show', `${baseCommit}:AGENTS.md`]) : null;
      if (guidance) run.projectGuidance = { path: 'AGENTS.md', text: safe(guidance.slice(0, 16000)), truncated: guidance.length > 16000 };
      this.runs.set(run.id, run);
      try { await this.save(run, 'started'); } catch (error) { this.runs.delete(run.id); throw error; }
      this.launch(run); return this.view(run);
    });
  }
  launch(run) {
    const controller = new AbortController();
    const entry = { controller, promise: null }; this.active.set(run.id, entry);
    entry.promise = this.loop(run, controller.signal).catch(async error => {
      const message = safe(controller.signal.aborted ? controller.signal.reason?.message || error.message : error.message || String(error));
      if (signalAborted(controller.signal) && run.taskId) {
        try {
          let task = await this.service.getTask({ taskId: run.taskId });
          if (task.lease || task.state === 'queued') {
            await this.service.cancelTask({ taskId: task.id });
            const stopDeadline = Date.now() + 20000;
            while (task.lease && Date.now() < stopDeadline) task = await this.service.waitTask({ taskId: task.id, afterSequence: task.sequence, timeoutMs: 1000 });
            if (task.lease || task.dispatchUncertain) throw new Error('原生停止尚未确认。');
          }
        } catch { run.state = 'blocked'; run.reason = '原生执行状态未确认，必须核查后才能继续。'; await this.save(run, 'stop_uncertain'); return; }
      }
      run.state = signalAborted(controller.signal) ? 'paused' : 'blocked'; run.reason = message;
      await this.save(run, run.state);
    }).finally(() => { this.active.delete(run.id); this.emit('change', run.id); }).catch(error => { this.emit('diagnostic', safe(error.message)); });
  }
  async loop(run, signal) {
    const deadline = setTimeout(() => this.active.get(run.id)?.controller.abort(new Error('长任务达到总截止时间。')), Math.max(1, Date.parse(run.deadlineAt) - Date.now()));
    try {
      while (!terminal.has(run.state)) {
        signal.throwIfAborted();
        if (Date.now() >= Date.parse(run.deadlineAt)) throw new Error('长任务达到总截止时间。');
        if (run.stage === 'planning') {
          const names = (await git(run.repository, ['ls-tree', '-r', '--name-only', run.baseCommit])).split('\n');
          const plan = decision(await this.reviewer({ phase: 'planning', goal: run.goal, acceptance: run.acceptance, projectGuidance: run.projectGuidance, repositoryFiles: names.slice(0, 300), filesTruncated: names.length > 300, permission: run.permission, remainingRounds: run.maxRounds }, this.reviewOptions(run, signal)), run.acceptance.length, true);
          signal.throwIfAborted(); run.lastDecision = plan;
          if (plan.action === 'blocked') { run.state = 'blocked'; run.reason = plan.summary; await this.save(run, 'blocked'); return; }
          this.prepare(run, plan.nextTask); await this.save(run, 'planned', { decision: plan });
        }
        if (run.stage === 'prepared') {
          signal.throwIfAborted();
          const task = run.prepared.taskId ? await this.service.sendFollowup(run.prepared) : await this.service.submitTask(run.prepared);
          run.taskId = task.id; run.workspace = task.workspace; run.iteration++;
          run.stage = 'executing'; await this.save(run, 'dispatched', { taskId: task.id, iteration: run.iteration });
        }
        if (run.stage === 'executing') {
          let task = await this.service.getTask({ taskId: run.taskId, limit: 1 });
          while (task.lease || !['completed', 'failed', 'cancelled', 'needs_input', 'needs_approval'].includes(task.state)) {
            signal.throwIfAborted();
            task = await this.service.waitTask({ taskId: task.id, afterSequence: task.sequence, timeoutMs: 30000, signal });
            if (task.dispatchUncertain || ['needs_input', 'needs_approval'].includes(task.state)) throw new Error('Harness 需要人工处理；不会自行作答、审批或重派。');
          }
          signal.throwIfAborted();
          if (task.dispatchUncertain || !['completed', 'failed'].includes(task.state) || (task.state === 'failed' && !task.nativeSessionId)) throw new Error(`Harness ${task.state}：${task.error || '执行未完成，需核查后恢复。'}`);
          run.stage = 'reviewing'; await this.save(run, 'execution_completed', { taskId: task.id });
        }
        if (run.stage === 'reviewing') {
          const task = await this.service.getTask({ taskId: run.taskId, limit: 1 });
          if (!['completed', 'failed', 'cancelled'].includes(task.state) || task.dispatchUncertain || task.lease) throw new Error('子任务状态未确认，不能继续审核。');
          const observed = await evidence(this.service, task);
          const checks = await this.verifier(run, task, { signal, resources: this.resources });
          signal.throwIfAborted();
          const reviewedEvidence = await evidence(this.service, task);
          if (observed.digest !== reviewedEvidence.digest) throw new Error('验证命令改变了待审核代码；请将缓存和输出排除或核查改动。');
          run.lastChecks = checks;
          const review = decision(await this.reviewer({ phase: 'review', goal: run.goal, acceptance: run.acceptance, projectGuidance: run.projectGuidance, permission: run.permission, resumeContext: run.resumeContext, taskState: task.state, taskError: task.error, taskGoal: task.goal, taskAcceptance: task.acceptance,
            iteration: run.iteration, remainingRounds: run.maxRounds - run.iteration, evidence: observed, checks, previousDecisions: run.history.filter(e => e.decision).slice(-3).map(e => e.decision) }, this.reviewOptions(run, signal)), run.acceptance.length, false);
          signal.throwIfAborted();
          if ((await evidence(this.service, task)).digest !== observed.digest) throw new Error('审核期间代码发生变化，不能接受过期审核结果。');
          if (task.state !== 'completed' && review.review !== 'changes_requested') throw new Error('未完成的执行只能请求修订或阻塞，不能验收通过。');
          if (review.action === 'complete' && (observed.truncated || checks.some(c => c.exitCode !== 0))) throw new Error('证据被截断或检查未通过，拒绝提前完成。');
          const reviewDirectory = path.join(this.directory, run.id, 'reviews'); await fs.mkdir(reviewDirectory, { recursive: true });
          run.reviewEvidence = path.join(reviewDirectory, `${run.iteration}.json`);
          await write(run.reviewEvidence, { taskId: task.id, evidence: observed, checks, decision: review });
          await this.service.reviewTask({ taskId: task.id, decision: review.review, note: review.summary });
          run.lastDecision = review; run.stagnant = run.lastDigest === observed.digest ? run.stagnant + 1 : 0; run.lastDigest = observed.digest;
          await this.save(run, 'reviewed', { taskId: task.id, decision: review });
          if (review.action === 'complete') { run.state = 'completed'; run.stage = 'finished'; await this.save(run, 'completed'); return; }
          if (review.action === 'blocked') { run.state = 'blocked'; run.reason = review.summary; await this.save(run, 'blocked'); return; }
          if (run.iteration >= run.maxRounds || run.stagnant >= 2) { run.state = 'blocked'; run.limitReached = run.stagnant >= 2 ? 'stagnation' : 'rounds'; run.reason = run.stagnant >= 2 ? '连续三轮没有新的代码证据，停止无效循环。' : '已达到总轮次预算，项目目标尚未全部验收。'; await this.save(run, 'budget_or_stagnation'); return; }
          this.prepare(run, review.nextTask); await this.save(run, 'next_step_prepared');
        }
      }
    } finally { clearTimeout(deadline); }
  }
  reviewOptions(run, signal) { return { directory: path.join(this.directory, run.id, 'reviewer'), signal, deadlineAt: run.deadlineAt, model: run.codexModel }; }
  prepare(run, task) {
    const common = { goal: task.goal, acceptance: task.acceptance, budget: { maxTurns: run.maxTurnsPerTask }, deadlineAt: new Date(Math.min(Date.parse(run.deadlineAt), Date.now() + 3600000)).toISOString(), idempotencyKey: `run-${run.id}-round-${run.iteration + 1}` };
    run.prepared = run.taskId ? { ...common, taskId: run.taskId } : { ...common, executor: 'harness', repository: run.repository, baseCommit: run.baseCommit, permission: run.permission, ...(run.harnessModel ? { model: run.harnessModel } : {}) };
    run.stage = 'prepared';
  }
  get({ runId }) { return this.view(this.lookup(runId)); }
  list({ limit = 20 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit 必须为 1–100。');
    return [...this.runs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit).map(run => {
      const item = this.view(run); return { id: item.id, goal: item.goal, repository: item.repository, state: item.state, stage: item.stage, iteration: item.iteration, maxRounds: item.maxRounds, updatedAt: item.updatedAt, coordinatorActive: item.coordinatorActive, summary: item.lastDecision?.summary || item.reason };
    });
  }
  async wait({ runId, afterSequence, timeoutMs = 30000, signal }) {
    const run = this.lookup(runId), cursor = afterSequence ?? run.sequence;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60000 || !Number.isInteger(cursor) || cursor < 0) throw new Error('无效等待参数。');
    const doneState = () => terminal.has(run.state) && !this.active.has(run.id);
    if (!doneState() && run.sequence <= cursor && !signal?.aborted) await new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.off('change', change); signal?.removeEventListener('abort', done); resolve(); };
      const change = id => { if (id === runId) done(); }; const timer = setTimeout(done, timeoutMs);
      this.on('change', change); signal?.addEventListener('abort', done, { once: true });
      if (run.sequence > cursor || doneState() || signal?.aborted) done();
    });
    return this.view(run);
  }
  async pause({ runId }) {
    const run = this.lookup(runId), active = this.active.get(run.id);
    if (active && terminal.has(run.state)) {
      // Do not replace a terminal state while its final record is flushing.
      // A blocked run may still own a live human-input request; stop that after
      // the coordinator has settled, using the branch below.
      if (run.state !== 'blocked') return this.view(run);
      await active.promise; return this.pause({ runId });
    }
    if (active) { run.state = 'pausing'; active.controller.abort(new Error('用户暂停长任务。')); return this.view(run); }
    if (run.taskId) {
      let task = await this.service.getTask({ taskId: run.taskId, limit: 1 });
      if (task.dispatchUncertain) throw new Error('原生停止状态未知，不能把暂停当作取消回执。');
      if (task.lease || task.state === 'queued') {
        run.state = 'pausing'; await this.save(run, 'pause_requested');
        await this.service.cancelTask({ taskId: task.id });
        const until = Date.now() + 20000;
        while (task.lease && Date.now() < until) task = await this.service.waitTask({ taskId: task.id, afterSequence: task.sequence, timeoutMs: 1000 });
        run.state = task.lease || task.dispatchUncertain ? 'blocked' : 'paused';
        run.reason = run.state === 'blocked' ? '原生停止尚未确认。' : '用户暂停长任务，原生执行已停止。';
        await this.save(run, run.state);
      }
    }
    return this.view(run);
  }
  async resume({ runId, deadlineAt, note }) {
    return this.transaction(async () => {
      const run = this.lookup(runId);
      if (!['paused', 'blocked'].includes(run.state) || this.active.size) throw new Error('仅能在协调器空闲时恢复暂停/阻塞的长任务。');
      if (run.limitReached || (run.stage === 'prepared' && run.iteration >= run.maxRounds)) throw new Error('总预算或停滞条件已触发，需要重新制定目标。');
      await this.service.validateRepository(run.repository);
      if (run.taskId) { const task = await this.service.getTask({ taskId: run.taskId, limit: 1 }); if (task.dispatchUncertain || task.lease || !['completed', 'failed', 'cancelled'].includes(task.state)) throw new Error('最近子任务状态未确认；请核查，不能自动重派。'); if (task.state !== 'completed') run.stage = 'reviewing'; }
      run.deadlineAt = future(deadlineAt || run.deadlineAt); run.state = 'running'; delete run.reason;
      if (note !== undefined) run.resumeContext = text(note, '恢复说明', 4000);
      if (run.stage === 'prepared' && Date.parse(run.prepared.deadlineAt) <= Date.now() && ![...this.service.tasks.values()].some(t => t.idempotencyKey === run.prepared.idempotencyKey)) {
        run.prepared.deadlineAt = new Date(Math.min(Date.parse(run.deadlineAt), Date.now() + 3600000)).toISOString();
      }
      await this.save(run, 'resumed'); this.launch(run); return this.view(run);
    });
  }
  async close() { this.closing = true; for (const item of this.active.values()) item.controller.abort(new Error('协调器正在退出，长任务已暂停。')); await Promise.allSettled([...this.active.values()].map(item => item.promise)); }
}
function signalAborted(signal) { return signal.aborted; }
module.exports = { LongRunManager, decision, checkSpecs, evidence, runChecks };

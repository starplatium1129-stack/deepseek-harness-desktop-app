const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { EventEmitter } = require('node:events');
const exec = promisify(execFile);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const ATTENTION = new Set(['needs_input', 'needs_approval']);
const within = (root, file) => { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
function redact(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '').replace(/\bsk-[\w-]+/g, '[redacted]')
    .replace(/(Bearer\s+)\S+/gi, '$1[redacted]').replace(/([?&](?:token|key|access_token)=)[^\s&]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|password|secret|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]');
}
function safe(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(safe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /^(api[_-]?key|password|secret|authorization|accessToken)$/i.test(k) ? '[redacted]' : safe(v)]));
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  return value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
}
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
async function atomic(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temp, file);
}
async function git(cwd, args) {
  try { return (await exec('git', ['--no-pager', '-c', 'core.hooksPath=', ...args], { cwd, windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 })).stdout.trimEnd(); }
  catch (e) { if (e.code === 'ENOENT') throw new Error('协作任务需要可用的 Git 来创建隔离 worktree；当前 PATH 中没有 Git。'); throw e; }
}
function textField(value, name, max = 32000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`${name} 必须是非空文本（最多 ${max} 字符）。`);
  return value;
}
function acceptance(value) {
  if (!Array.isArray(value) || !value.length || value.length > 30) throw new Error('至少提供一条验收条件，最多 30 条。');
  return value.map(v => textField(v, 'acceptance', 8000));
}
function budget(value = { maxTurns: 8 }) {
  if (!value || Object.keys(value).some(k => k !== 'maxTurns') || (value.maxTurns !== null && (!Number.isInteger(value.maxTurns) || value.maxTurns < 1 || value.maxTurns > 50))) throw new Error('budget.maxTurns 必须为 1–50，或显式 null 表示仅限制执行时限；不支持金额或 token 预算。');
  return { maxTurns: value.maxTurns };
}
function deadline(value) {
  const time = value ? Date.parse(value) : Date.now() + 300000;
  if (!Number.isFinite(time) || time <= Date.now() || time > Date.now() + 3600000) throw new Error('deadlineAt 必须在未来一小时内。');
  return new Date(time).toISOString();
}

class CollaborationService extends EventEmitter {
  constructor({ dataDir, allowedRoots, adapters = [], concurrency = 2 }) {
    super();
    if (!path.isAbsolute(dataDir || '')) throw new Error('dataDir 必须是绝对路径。');
    if (!Array.isArray(allowedRoots) || !allowedRoots.length || allowedRoots.some(r => !path.isAbsolute(r))) throw new Error('必须显式配置工作目录白名单 allowedRoots。');
    Object.assign(this, { dataDir, allowedRoots, concurrency: Math.max(1, Math.min(4, concurrency)) });
    this.adapters = new Map(adapters.map(a => [a.id, a])); this.tasks = new Map(); this.active = new Map();
    this.serial = Promise.resolve(); this.closing = false; this.instance = randomUUID();
  }
  transaction(fn) { const next = this.serial.then(fn); this.serial = next.catch(() => {}); return next; }
  file(id) { return path.join(this.dataDir, 'tasks', `${id}.json`); }
  async init() {
    this.allowedRoots = await Promise.all(this.allowedRoots.map(r => fs.realpath(r)));
    await fs.mkdir(path.join(this.dataDir, 'tasks'), { recursive: true });
    this.dataDir = await fs.realpath(this.dataDir);
    this.lockFile = path.join(this.dataDir, 'service.lock');
    const lock = { pid: process.pid, instance: this.instance };
    try { await fs.writeFile(this.lockFile, JSON.stringify(lock), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const recoveryFile = `${this.lockFile}.recovery`;
      let recovery;
      try { recovery = await fs.open(recoveryFile, 'wx', 0o600); }
      catch (e) { if (e.code === 'EEXIST') throw new Error('服务锁正在恢复；若上次恢复进程被终止，请核实后清理 service.lock.recovery。'); throw e; }
      try {
        let owner;
        try { owner = JSON.parse(await fs.readFile(this.lockFile, 'utf8')); }
        catch (e) { if (e.code !== 'ENOENT') throw new Error('协作服务锁损坏，请检查服务状态后处理。'); }
        if (owner) {
          if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('协作服务锁的进程标识无效。');
          try { process.kill(owner.pid, 0); throw new Error('这个数据目录已经有协作服务在运行。'); }
          catch (e) { if (e.code !== 'ESRCH') throw e; }
          await fs.unlink(this.lockFile);
        }
        await fs.writeFile(this.lockFile, JSON.stringify(lock), { flag: 'wx', mode: 0o600 });
      } finally { await recovery.close(); await fs.unlink(recoveryFile); }
    }
    this.ownsLock = true;
    try {
      for (const file of await fs.readdir(path.join(this.dataDir, 'tasks'))) {
        if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
        const task = JSON.parse(await fs.readFile(path.join(this.dataDir, 'tasks', file), 'utf8'));
        if (`${task.id}.json` !== file || !Array.isArray(task.events)) throw new Error(`任务记录损坏：${file}`);
        this.tasks.set(task.id, task);
        if (task.state === 'running' || task.lease) {
          // A lost connection is not proof the native side did nothing. Never resubmit.
          task.lease = null; task.state = 'needs_input'; task.dispatchUncertain = true;
          await this.record(task, 'recovery_required', { message: '服务中断，执行结果尚未核实；请检查原生会话和工作目录。不会自动重新派发。' });
        }
      }
      this.schedule(); return this;
    } catch (e) { await this.releaseLock(); throw e; }
  }
  async releaseLock() {
    if (!this.ownsLock) return;
    try { const lock = JSON.parse(await fs.readFile(this.lockFile, 'utf8')); if (lock.instance === this.instance) await fs.unlink(this.lockFile); }
    finally { this.ownsLock = false; }
  }
  async record(task, type, data = {}) {
    const previous = { updatedAt: task.updatedAt, sequence: task.sequence || 0 };
    task.updatedAt = new Date().toISOString();
    task.sequence = (task.sequence || 0) + 1;
    task.events.push({ sequence: task.sequence, at: task.updatedAt, type, data: safe(data) });
    try { await atomic(this.file(task.id), task); }
    catch (e) { task.events.pop(); Object.assign(task, previous); throw e; }
    this.emit('change', task.id);
  }
  lookup(id) { const task = this.tasks.get(id); if (!task) throw new Error('任务不存在。'); return task; }
  view(task) { const { events, result, fingerprint, ...rest } = task; return structuredClone(rest); }
  async listExecutors() {
    return Promise.all([...this.adapters.values()].map(async a => { try { return await a.describe(); } catch (e) { return { id: a.id, available: false, reason: redact(e.message), capabilities: {} }; } }));
  }
  async validateRepository(repository) {
    textField(repository, 'repository', 4096);
    if (!path.isAbsolute(repository)) throw new Error('repository 必须是绝对路径。');
    const real = await fs.realpath(repository);
    if (!this.allowedRoots.some(root => within(root, real))) throw new Error('仓库不在配置的工作目录白名单内。');
    const top = await fs.realpath(await git(real, ['rev-parse', '--show-toplevel']));
    if (!this.allowedRoots.some(root => within(root, top))) throw new Error('Git 仓库根目录不在工作目录白名单内。');
    return top;
  }
  async submitTask(input) {
    input = structuredClone(input);
    return this.transaction(async () => {
      if (this.closing) throw new Error('服务正在退出。');
      textField(input.idempotencyKey, 'idempotencyKey', 200);
      const fingerprint = digest(input);
      const previous = [...this.tasks.values()].find(t => t.idempotencyKey === input.idempotencyKey);
      if (previous) { if (previous.fingerprint !== fingerprint) throw new Error('同一个幂等键不能用于不同请求。'); return this.view(previous); }
      const adapter = this.adapters.get(input.executor); if (!adapter) throw new Error('未知执行器。');
      if (!['read-only', 'workspace-write'].includes(input.permission)) throw new Error('必须显式选择 read-only 或 workspace-write 权限。');
      const repository = await this.validateRepository(input.repository);
      const ref = input.baseCommit || 'HEAD'; textField(ref, 'baseCommit', 256);
      if (ref.startsWith('-')) throw new Error('无效的基准提交。');
      const baseCommit = await git(repository, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
      const context = input.context || [];
      if (!Array.isArray(context) || context.length > 30) throw new Error('context 最多 30 条。');
      for (const entry of context) {
        if (!entry || (!entry.path && !entry.excerpt)) throw new Error('context 需要 path 或 excerpt。');
        if (entry.excerpt) textField(entry.excerpt, 'context.excerpt', 16000);
        if (entry.path) {
          textField(entry.path, 'context.path', 4096);
          const target = await fs.realpath(path.resolve(repository, entry.path));
          if (!within(repository, target)) throw new Error('上下文文件必须在任务仓库内。');
          entry.path = path.relative(repository, target);
        }
      }
      const parent = input.parentTaskId ? this.lookup(input.parentTaskId) : null;
      const depth = parent ? parent.depth + 1 : 0; if (depth > 4) throw new Error('委派深度最多为 4。');
      if (parent && (parent.permission === 'read-only' && input.permission !== parent.permission || repository !== parent.repository)) throw new Error('子任务不能扩大父任务的权限或工作目录。');
      const id = randomUUID(), now = new Date().toISOString();
      const task = { id, parentTaskId: parent?.id || null, depth, idempotencyKey: input.idempotencyKey, fingerprint,
        executor: input.executor, goal: textField(input.goal, 'goal'), acceptance: acceptance(input.acceptance), context: safe(context),
        repository, baseCommit, workspace: path.join(this.dataDir, 'worktrees', id), permission: input.permission,
        model: input.model ? textField(input.model, 'model', 200) : undefined, budget: budget(input.budget), deadlineAt: deadline(input.deadlineAt),
        state: 'queued', review: { decision: 'pending' }, createdAt: now, updatedAt: now, sequence: 0, events: [], lease: null };
      if (parent && (Date.parse(task.deadlineAt) > Date.parse(parent.deadlineAt) || (parent.budget.maxTurns !== null && (task.budget.maxTurns === null || task.budget.maxTurns > parent.budget.maxTurns)))) throw new Error('子任务不能扩大父任务的预算或截止时间。');
      this.tasks.set(id, task);
      try { await this.record(task, 'queued', { executor: task.executor }); } catch (e) { this.tasks.delete(id); throw e; }
      this.schedule(); return this.view(task);
    });
  }
  schedule() { if (!this.closing) setImmediate(() => { void this.pump().catch(error => this.emit('diagnostic', redact(error.message))); }); }
  async pump() {
    return this.transaction(async () => {
      if (this.closing) return;
      for (const task of this.tasks.values()) {
        if (this.active.size >= this.concurrency) break;
        if (task.state !== 'queued' || [...this.active.keys()].some(id => this.tasks.get(id).workspace === task.workspace)) continue;
        const adapterLimit = this.adapters.get(task.executor)?.maxConcurrentTasks;
        if (Number.isInteger(adapterLimit) && [...this.active.keys()].filter(id => this.tasks.get(id).executor === task.executor).length >= Math.max(1, adapterLimit)) continue;
        const controller = new AbortController();
        const slot = { controller, promise: null }; this.active.set(task.id, slot);
        task.state = 'running'; task.lease = { owner: this.instance, heartbeatAt: new Date().toISOString() };
        try { await this.record(task, 'running'); }
        catch (e) { this.active.delete(task.id); task.state = 'queued'; task.lease = null; throw e; }
        slot.promise = this.execute(task, controller).catch(e => this.emit('diagnostic', redact(e.message))).finally(() => { this.active.delete(task.id); this.schedule(); });
      }
    });
  }
  async execute(task, controller) {
    let timer, heartbeat;
    const emit = (type, data) => this.transaction(() => this.record(task, type, data));
    try {
      const remaining = Date.parse(task.deadlineAt) - Date.now();
      if (remaining <= 0) throw new Error('任务已超过执行期限。');
      timer = setTimeout(() => { task.stopReason = 'deadline'; controller.abort(new Error('任务已超过执行期限。')); }, remaining);
      heartbeat = setInterval(() => { void this.transaction(async () => {
        if (task.lease) { task.lease.heartbeatAt = new Date().toISOString(); await atomic(this.file(task.id), task); }
      }).catch(() => {}); }, 10000);
      await this.validateRepository(task.repository);
      if (!task.workspaceReady) {
        await fs.mkdir(path.dirname(task.workspace), { recursive: true });
        if (!within(this.dataDir, await fs.realpath(path.dirname(task.workspace)))) throw new Error('隔离目录已被替换到协作数据目录外。');
        await git(task.repository, ['worktree', 'add', '--detach', task.workspace, task.baseCommit]);
        await this.transaction(async () => { task.workspaceReady = true; await this.record(task, 'workspace_ready', { path: task.workspace, baseCommit: task.baseCommit }); });
      }
      if (!within(path.join(this.dataDir, 'worktrees'), await fs.realpath(task.workspace))) throw new Error('任务工作目录已被替换到隔离目录外。');
      if (controller.signal.aborted) throw controller.signal.reason;
      const adapter = this.adapters.get(task.executor);
      if (!adapter) throw new Error('执行器当前不可用。');
      const description = await adapter.describe();
      if (!description.available) throw new Error(description.reason || '执行器当前不可用。');
      await emit('executor', description);
      const result = await adapter.execute(structuredClone(this.view(task)), {
        signal: controller.signal, emit,
        checkpoint: fields => this.transaction(async () => {
          if (typeof fields.nativeSessionId === 'string') task.nativeSessionId = fields.nativeSessionId;
          task.nativeCheckpoint = safe(fields); await this.record(task, 'checkpoint', fields);
        }),
        state: (state, data) => this.transaction(async () => {
          if (!ATTENTION.has(state) && !(state === 'running' && ATTENTION.has(task.state) && task.lease)) throw new Error('适配器返回无效的等待状态。');
          task.state = state; await this.record(task, state, data);
        }),
      });
      await this.transaction(async () => {
        task.result = safe(result || { summary: '', unfinished: ['执行器没有返回结果。'] });
        if (result?.nativeSessionId) task.nativeSessionId = result.nativeSessionId;
      });
      if (controller.signal.aborted) throw controller.signal.reason;
      await this.transaction(async () => { if (!ATTENTION.has(task.state)) task.state = 'completed'; });
    } catch (e) {
      await this.transaction(async () => {
        task.error = redact(e.message || e);
        if (typeof e.code === 'string' && /^[A-Z0-9_]{1,64}$/i.test(e.code)) task.errorCode = e.code;
        if (e.dispatchUncertain) task.dispatchUncertain = true;
        if (task.dispatchUncertain) task.state = 'needs_input';
        else if (task.stopReason === 'cancel') task.state = 'cancelled';
        else if (!ATTENTION.has(task.state) || controller.signal.aborted) task.state = 'failed';
        await this.record(task, 'execution_error', { message: task.error });
      });
    } finally {
      clearTimeout(timer); clearInterval(heartbeat);
      let evidence;
      try { if (task.workspaceReady) evidence = await this.collectEvidence(task); }
      catch (e) { evidence = { error: redact(e.message) }; }
      await this.transaction(async () => {
        task.evidence = evidence || null; task.lease = null;
        if (task.stopReason === 'cancel' && task.state === 'cancelled' && !task.dispatchUncertain) task.cancelAcknowledgedAt = new Date().toISOString();
        await this.record(task, 'execution_stopped', { state: task.state, review: task.review.decision, evidence: task.evidence });
      });
    }
  }
  async collectEvidence(task) {
    const artifactDir = path.join(this.dataDir, 'artifacts', task.id); await fs.mkdir(artifactDir, { recursive: true });
    const [head, status, diff] = await Promise.all([
      git(task.workspace, ['rev-parse', 'HEAD']), git(task.workspace, ['status', '--porcelain=v1', '-uall']),
      git(task.workspace, ['diff', '--no-ext-diff', '--no-textconv', '--binary', task.baseCommit, '--']),
    ]);
    const names = (await git(task.workspace, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
    const untracked = [];
    for (const name of names.slice(0, 200)) {
      const file = path.join(task.workspace, name), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) { untracked.push({ path: name, bytes: stat.size, omitted: '非普通文件或大于 8 MiB' }); continue; }
      const content = await fs.readFile(file);
      const info = { path: name, bytes: stat.size, sha256: createHash('sha256').update(content).digest('hex') };
      if (/(?:^|[\\/])(?:\.env(?:\..*)?|credential[^\\/]*|[^\\/]*\.(?:pem|key|p12|pfx))$/i.test(name)) info.snapshotOmitted = '可能包含凭据，仅记录哈希，不复制';
      else {
        const snapshot = path.join(artifactDir, 'files', name);
        if (!within(artifactDir, snapshot)) throw new Error('无效的产物路径。');
        await fs.mkdir(path.dirname(snapshot), { recursive: true }); await fs.writeFile(snapshot, content, { mode: 0o600 }); info.snapshot = snapshot;
      }
      untracked.push(info);
    }
    const patch = path.join(artifactDir, 'changes.patch'); await fs.writeFile(patch, redact(diff), { mode: 0o600 });
    return { baseCommit: task.baseCommit, headCommit: head, status: redact(status), patch, untracked, untrackedTruncated: names.length > 200,
      tests: { source: 'executor_report', entries: task.result?.tests || [], verifiedByService: false } };
  }
  async getTask({ taskId, afterSequence = 0, limit = 100 }) {
    const task = this.lookup(taskId);
    if (!Number.isInteger(afterSequence) || afterSequence < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('无效的事件分页参数。');
    const events = task.events.filter(e => e.sequence > afterSequence).slice(0, limit);
    return { ...this.view(task), events: structuredClone(events), nextSequence: events.at(-1)?.sequence || afterSequence, hasMore: events.at(-1)?.sequence < task.sequence };
  }
  async waitTask({ taskId, afterSequence, timeoutMs = 30000, signal }) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60000) throw new Error('timeoutMs 必须在 0–60000 内。');
    const task = this.lookup(taskId), cursor = afterSequence ?? task.sequence;
    if (!Number.isInteger(cursor) || cursor < 0) throw new Error('无效的事件游标。');
    const doneState = () => (TERMINAL.has(task.state) || ATTENTION.has(task.state)) && !task.lease;
    if (!doneState() && task.sequence <= cursor && timeoutMs && !signal?.aborted) await new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.off('change', listener); signal?.removeEventListener('abort', done); resolve(); };
      const listener = id => { if (id === taskId) done(); }; const timer = setTimeout(done, timeoutMs);
      this.on('change', listener);
      signal?.addEventListener('abort', done, { once: true });
      if (task.sequence > cursor || doneState() || signal?.aborted) done();
    });
    return this.getTask({ taskId, afterSequence: cursor });
  }
  async readResult({ taskId, offset = 0, limit = 16000 }) {
    const task = this.lookup(taskId);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 64000) throw new Error('无效的结果分页参数。');
    const text = JSON.stringify({ result: task.result || null, evidence: task.evidence || null, error: task.error || null }, null, 2);
    return { taskId, state: task.state, review: structuredClone(task.review), text: text.slice(offset, offset + limit), nextOffset: Math.min(text.length, offset + limit), totalChars: text.length, hasMore: offset + limit < text.length };
  }
  async cancelTask({ taskId }) {
    return this.transaction(async () => {
      const task = this.lookup(taskId);
      if (task.dispatchUncertain) throw new Error('原生执行状态未知，无法确认取消；请先在原生软件中检查该会话。');
      if (TERMINAL.has(task.state) && !this.active.has(task.id)) return this.view(task);
      task.stopReason = 'cancel'; task.cancelRequestedAt ||= new Date().toISOString();
      const active = this.active.get(task.id);
      if (active) active.controller.abort(new Error('用户取消任务。'));
      else { task.state = 'cancelled'; task.cancelAcknowledgedAt = new Date().toISOString(); }
      await this.record(task, 'cancel_requested', { acknowledged: !active }); return this.view(task);
    });
  }
  async reviewTask({ taskId, decision, note }) {
    return this.transaction(async () => {
      const task = this.lookup(taskId);
      if (!['accepted', 'changes_requested'].includes(decision)) throw new Error('无效的审核结论。');
      if (!TERMINAL.has(task.state) || this.active.has(task.id)) throw new Error('执行结束后才能审核。');
      if (decision === 'accepted' && task.state !== 'completed') throw new Error('只有已完成任务可以验收通过。');
      task.review = { decision, note: textField(note, 'note', 8000), at: new Date().toISOString() };
      await this.record(task, 'reviewed', task.review); return this.view(task);
    });
  }
  async sendFollowup(input) {
    return this.transaction(async () => {
      textField(input.idempotencyKey, 'idempotencyKey', 200);
      const fingerprint = digest({ followup: input });
      const previous = [...this.tasks.values()].find(t => t.idempotencyKey === input.idempotencyKey);
      if (previous) { if (previous.fingerprint !== fingerprint) throw new Error('同一个幂等键不能用于不同请求。'); return this.view(previous); }
      const parent = this.lookup(input.taskId);
      if (parent.dispatchUncertain) throw new Error('原生会话状态尚未核实，不能盲目追加指令。');
      if (this.active.has(parent.id) || !TERMINAL.has(parent.state)) throw new Error('请等待父任务结束后提交修订。');
      if (!parent.workspaceReady) throw new Error('原任务尚未准备工作目录，请创建新任务。');
      // Directed serial revisions do not add another delegated agent layer.
      // Older records counted them as depth; infer the revision chain from its
      // persisted queued event rather than silently dropping the delegation cap.
      let origin = parent, revision = 0;
      const seen = new Set();
      while (origin.parentTaskId && origin.events?.some(e => e.type === 'queued' && e.data?.followupTo === origin.parentTaskId)) {
        if (seen.has(origin.id)) throw new Error('修订链损坏。');
        seen.add(origin.id); revision++;
        origin = this.lookup(origin.parentTaskId);
      }
      if (revision >= 49) throw new Error('同一任务最多执行 50 轮，请审核并结束该任务后建立新的目标。');
      if ([...this.tasks.values()].some(t => t.workspace === parent.workspace && (t.state === 'queued' || this.active.has(t.id) || t.dispatchUncertain))) throw new Error('同一工作目录已有待执行任务。');
      const id = randomUUID(), now = new Date().toISOString();
      const task = { id, parentTaskId: parent.id, depth: origin.depth, revision: revision + 1, idempotencyKey: input.idempotencyKey, fingerprint,
        executor: parent.executor, repository: parent.repository, baseCommit: parent.baseCommit, workspace: parent.workspace, workspaceReady: true,
        goal: textField(input.goal, 'goal'), acceptance: acceptance(input.acceptance || parent.acceptance), context: parent.context,
        permission: parent.permission, model: parent.model, nativeSessionId: parent.nativeSessionId,
        budget: budget(input.budget || parent.budget), deadlineAt: deadline(input.deadlineAt),
        state: 'queued', review: { decision: 'pending' }, createdAt: now, updatedAt: now, sequence: 0, events: [], lease: null };
      this.tasks.set(id, task);
      try { await this.record(task, 'queued', { followupTo: parent.id }); } catch (e) { this.tasks.delete(id); throw e; }
      this.schedule(); return this.view(task);
    });
  }
  hasPersistentResources() {
    for (const adapter of this.adapters.values()) {
      try { if (typeof adapter.hasPersistentResources === 'function' && adapter.hasPersistentResources()) return true; }
      catch { return true; } // Unknown native-window state is not permission to close it.
    }
    return false;
  }
  startRun(input) { if (!this.longRuns) throw new Error('长任务协调器尚未初始化。'); return this.longRuns.start(input); }
  getRun(input) { if (!this.longRuns) throw new Error('长任务协调器尚未初始化。'); return this.longRuns.get(input); }
  listRuns(input) { if (!this.longRuns) throw new Error('长任务协调器尚未初始化。'); return this.longRuns.list(input); }
  waitRun(input) { if (!this.longRuns) throw new Error('长任务协调器尚未初始化。'); return this.longRuns.wait(input); }
  pauseRun(input) { if (!this.longRuns) throw new Error('长任务协调器尚未初始化。'); return this.longRuns.pause(input); }
  resumeRun(input) { if (!this.longRuns) throw new Error('长任务协调器尚未初始化。'); return this.longRuns.resume(input); }
  async close() {
    const checkResources = () => {
      if (this.hasPersistentResources()) throw Object.assign(new Error('原生窗口仍由用户使用；请先在原应用中关闭窗口，再退出或重启协作服务。'), { code: 'PERSISTENT_NATIVE_RESOURCES' });
    };
    checkResources();
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      await this.serial; checkResources();
      await this.longRuns?.close();
      for (const [id, slot] of this.active) { const task = this.tasks.get(id); task.stopReason = 'shutdown'; task.dispatchUncertain = true; slot.controller.abort(new Error('协作服务退出；请核实原生会话状态。')); }
      await Promise.allSettled([...this.active.values()].map(s => s.promise)); await this.serial;
      checkResources();
      for (const adapter of this.adapters.values()) if (typeof adapter.close === 'function') { checkResources(); await adapter.close(); }
      await this.releaseLock();
    })().catch(cause => {
      this.closePromise = null;
      // Only resume dispatch while this core still owns its persistence lock.
      if (this.ownsLock) { this.closing = false; if (this.longRuns) this.longRuns.closing = false; this.schedule(); }
      throw cause;
    });
    return this.closePromise;
  }
}
module.exports = { CollaborationService, within, redact, safe, git };

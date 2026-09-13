const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CollaborationService, git, safe } = require('../collaboration/core.cjs');

async function setup(t, execute, concurrency = 2) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-collab-'));
  const repo = path.join(root, 'repo'); await fs.mkdir(repo);
  await git(repo, ['init']); await git(repo, ['config', 'user.email', 'test@example.invalid']); await git(repo, ['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(repo, 'hello.txt'), 'original\n'); await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'initial']);
  const adapter = { id: 'test', describe: async () => ({ id: 'test', available: true, capabilities: {} }), execute };
  const options = { dataDir: path.join(root, 'data'), allowedRoots: [repo], adapters: [adapter], concurrency };
  const service = await new CollaborationService(options).init();
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const input = { executor: 'test', repository: repo, goal: 'Change hello', acceptance: ['Result exists'], permission: 'workspace-write', idempotencyKey: 'first', budget: { maxTurns: 3 } };
  return { root, repo, service, input, options };
}
async function finished(service, taskId) {
  let current = await service.getTask({ taskId });
  for (let n = 0; n < 30; n++) {
    if (['completed', 'failed', 'cancelled', 'needs_input', 'needs_approval'].includes(current.state) && !current.lease) return current;
    current = await service.waitTask({ taskId, afterSequence: current.sequence, timeoutMs: 1000 });
  }
  throw new Error('task did not stop');
}
test('isolates writes, fingerprints idempotency, records evidence and keeps review separate', async t => {
  let runs = 0;
  const { service, input, repo } = await setup(t, async (task, ctx) => {
    runs++; await ctx.checkpoint({ nativeSessionId: 'native-1' }); await ctx.emit('text', { text: 'working' });
    await fs.writeFile(path.join(task.workspace, 'hello.txt'), 'changed\n');
    await fs.writeFile(path.join(task.workspace, 'artifact.txt'), 'evidence');
    return { summary: 'done', nativeSessionId: 'native-1', tests: [{ command: 'reported command', status: 'passed' }] };
  });
  const [a, b] = await Promise.all([service.submitTask(input), service.submitTask(input)]);
  assert.equal(a.id, b.id); await assert.rejects(service.submitTask({ ...input, goal: 'different' }), /幂等键/);
  const done = await finished(service, a.id);
  assert.equal(done.state, 'completed'); assert.equal(runs, 1); assert.equal(done.review.decision, 'pending');
  assert.equal(await fs.readFile(path.join(repo, 'hello.txt'), 'utf8'), 'original\n');
  assert.match(await fs.readFile(done.evidence.patch, 'utf8'), /\+changed/);
  assert.equal(done.evidence.untracked[0].path, 'artifact.txt'); assert.equal(done.evidence.tests.verifiedByService, false);
  assert.equal(await fs.readFile(done.evidence.untracked[0].snapshot, 'utf8'), 'evidence');
  const allEvents = (await service.getTask({ taskId: a.id })).events;
  assert.deepEqual(allEvents.map(e => e.sequence), Array.from({ length: done.sequence }, (_, i) => i + 1));
  await service.reviewTask({ taskId: a.id, decision: 'accepted', note: 'Reviewed actual diff' });
  assert.equal((await service.getTask({ taskId: a.id })).review.decision, 'accepted');
});
test('followup inherits native session, existing changes and authority without duplicate dispatch', async t => {
  const { service, input } = await setup(t, async (task, ctx) => {
    if (task.parentTaskId) {
      assert.equal(task.nativeSessionId, 'native-2'); assert.equal(await fs.readFile(path.join(task.workspace, 'hello.txt'), 'utf8'), 'first');
      await fs.writeFile(path.join(task.workspace, 'hello.txt'), 'revised');
    } else { await fs.writeFile(path.join(task.workspace, 'hello.txt'), 'first'); await ctx.checkpoint({ nativeSessionId: 'native-2' }); }
    return { summary: 'done', nativeSessionId: 'native-2' };
  });
  const a = await service.submitTask(input); await finished(service, a.id);
  await service.reviewTask({ taskId: a.id, decision: 'changes_requested', note: 'Use revised wording' });
  const followup = { taskId: a.id, goal: 'Revise wording', idempotencyKey: 'revision' };
  const b = await service.sendFollowup(followup); assert.equal(b.id, (await service.sendFollowup(followup)).id);
  const done = await finished(service, b.id); assert.equal(done.parentTaskId, a.id); assert.equal(done.permission, a.permission);
  assert.equal(await fs.readFile(path.join(done.workspace, 'hello.txt'), 'utf8'), 'revised');
});
test('cancel stops owned execution, queued cancellation does not dispatch, waiting is cancellable', async t => {
  let started; const ready = new Promise(r => { started = r; });
  const { service, input } = await setup(t, async (_task, ctx) => {
    started(); await new Promise(resolve => { if (ctx.signal.aborted) resolve(); else ctx.signal.addEventListener('abort', resolve, { once: true }); });
    throw ctx.signal.reason;
  }, 1);
  const a = await service.submitTask(input); await ready;
  const b = await service.submitTask({ ...input, idempotencyKey: 'queued' });
  await service.cancelTask({ taskId: b.id }); assert.equal((await service.getTask({ taskId: b.id })).state, 'cancelled');
  const controller = new AbortController();
  const wait = service.waitTask({ taskId: a.id, timeoutMs: 60000, signal: controller.signal }); controller.abort(); await wait;
  assert.equal(service.listenerCount('change'), 0);
  await service.cancelTask({ taskId: a.id }); const done = await finished(service, a.id);
  assert.equal(done.state, 'cancelled'); assert.ok(done.cancelAcknowledgedAt);
});
test('deadline and adapter failures are explicit; sensitive events are redacted', async t => {
  const { service, input } = await setup(t, async (_task, ctx) => {
    await ctx.emit('text', { text: 'Bearer abc sk-test-secret', apiKey: 'private' }); throw new Error('model unavailable');
  });
  const a = await service.submitTask(input); const done = await finished(service, a.id);
  assert.equal(done.state, 'failed'); assert.match(done.error, /model unavailable/);
  assert.doesNotMatch(JSON.stringify(done.events), /abc|sk-test-secret|private/);
  const timeout = await service.submitTask({ ...input, idempotencyKey: 'expired', deadlineAt: new Date(Date.now() + 1).toISOString() }).catch(() => null);
  if (timeout) assert.equal((await finished(service, timeout.id)).state, 'failed');
});
test('lost native execution recovers as uncertain and is never replayed', async t => {
  let runs = 0;
  const { service, input, options } = await setup(t, async () => { runs++; return { summary: 'done' }; });
  const a = await service.submitTask(input); await finished(service, a.id); await service.close();
  const file = path.join(options.dataDir, 'tasks', `${a.id}.json`); const record = JSON.parse(await fs.readFile(file, 'utf8'));
  record.state = 'running'; record.lease = { owner: 'lost', heartbeatAt: '2000-01-01' }; record.nativeSessionId = 'native-lost';
  await fs.writeFile(file, JSON.stringify(record));
  const resumed = await new CollaborationService(options).init(); t.after(() => resumed.close());
  const recovered = await resumed.getTask({ taskId: a.id });
  assert.equal(recovered.state, 'needs_input'); assert.equal(recovered.dispatchUncertain, true); assert.equal(runs, 1);
  await assert.rejects(resumed.sendFollowup({ taskId: a.id, goal: 'retry', idempotencyKey: 'retry' }), /尚未核实/);
  await assert.rejects(resumed.cancelTask({ taskId: a.id }), /无法确认取消/);
  await resumed.close();
});
test('workspace allowlist, budgets, depth and single-owner locking fail closed', async t => {
  const { root, service, input, options } = await setup(t, async () => ({ summary: 'done' }));
  await assert.rejects(new CollaborationService(options).init(), /已经有协作服务/);
  await assert.rejects(service.submitTask({ ...input, repository: root }), /白名单/);
  await assert.rejects(service.submitTask({ ...input, permission: 'yolo' }), /权限/);
  await assert.rejects(service.submitTask({ ...input, budget: { maxTurns: 51 } }), /maxTurns/);
  await assert.rejects(service.submitTask({ ...input, budget: { maxTurns: 1, dollars: 100 } }), /maxTurns/);
  await assert.rejects(service.submitTask({ ...input, context: [{ path: '../data/service.lock' }] }), /仓库内/);
  assert.deepEqual(safe({ authorization: 'private', nested: ['secret=x'] }), { authorization: '[redacted]', nested: ['secret=[redacted]'] });
});

test('native input can remain live without busy polling and resume only after native confirmation', async t => {
  let resume, inputSeen;
  const seen = new Promise(resolve => { inputSeen = resolve; });
  const { service, input } = await setup(t, async (_task, ctx) => {
    const continuing = new Promise(resolve => { resume = resolve; });
    await ctx.state('needs_input', { reason: 'Complete native verification in its own window' }); inputSeen();
    await continuing;
    await ctx.state('running', { reason: 'Native application confirmed verification' });
    return { summary: 'done' };
  });
  const task = await service.submitTask(input); await seen;
  const before = await service.getTask({ taskId: task.id });
  assert.equal(before.state, 'needs_input'); assert.ok(before.lease);
  let answered = false;
  const waiting = service.waitTask({ taskId: task.id, afterSequence: before.sequence, timeoutMs: 1000 }).then(result => { answered = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(answered, false);
  resume(); await waiting;
  assert.equal((await finished(service, task.id)).state, 'completed');
});

test('executor concurrency limit serializes native windows across different worktrees', async t => {
  let unblock, started, calls = 0;
  const ready = new Promise(resolve => { started = resolve; });
  const { service, input } = await setup(t, async () => {
    calls++;
    if (calls === 1) { const hold = new Promise(resolve => { unblock = resolve; }); started(); await hold; }
    return { summary: 'done' };
  });
  service.adapters.get('test').maxConcurrentTasks = 1;
  const first = await service.submitTask(input); await ready;
  const second = await service.submitTask({ ...input, idempotencyKey: 'second' });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(calls, 1); assert.equal((await service.getTask({ taskId: second.id })).state, 'queued');
  unblock(); await finished(service, first.id); await finished(service, second.id); assert.equal(calls, 2);
});

test('unconfirmed native stop never becomes a successful cancellation receipt', async t => {
  let started; const ready = new Promise(resolve => { started = resolve; });
  const { service, input } = await setup(t, async (_task, ctx) => {
    started();
    await new Promise(resolve => ctx.signal.addEventListener('abort', resolve, { once: true }));
    throw Object.assign(new Error('Native stop could not be confirmed'), { dispatchUncertain: true });
  });
  const task = await service.submitTask(input); await ready;
  await service.cancelTask({ taskId: task.id }); const done = await finished(service, task.id);
  assert.equal(done.state, 'needs_input'); assert.equal(done.dispatchUncertain, true);
  assert.ok(done.cancelRequestedAt); assert.equal(done.cancelAcknowledgedAt, undefined);
});

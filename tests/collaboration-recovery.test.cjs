'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CollaborationService, git, within } = require('../collaboration/core.cjs');

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

async function temporaryDirectory(t, beforeCleanup = async () => {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-collab-recovery-'));
  t.after(async () => {
    await beforeCleanup();
    const target = path.resolve(root);
    assert.ok(within(path.resolve(os.tmpdir()), target) && path.basename(target).startsWith('dsh-collab-recovery-'));
    await fs.rm(target, { recursive: true, force: true });
  });
  return root;
}

async function fixture(t, execute = async () => ({ summary: 'done' })) {
  let service;
  const root = await temporaryDirectory(t, async () => { await service?.close(); });
  const repository = path.join(root, 'repo'); await fs.mkdir(repository);
  await git(repository, ['init']);
  await git(repository, ['config', 'user.email', 'recovery-test@example.invalid']);
  await git(repository, ['config', 'user.name', 'Recovery Test']);
  await fs.writeFile(path.join(repository, 'hello.txt'), 'initial\n');
  await git(repository, ['add', '.']); await git(repository, ['commit', '-m', 'initial']);
  const options = { dataDir: path.join(root, 'data'), allowedRoots: [repository], adapters: [{ id: 'test', describe: async () => ({ id: 'test', available: true }), execute }] };
  service = await new CollaborationService(options).init();
  // Drain the initialization pump, then dispatch explicitly to place filesystem
  // failures precisely before native execution rather than racing a callback.
  await nextTurn(); await service.serial; service.schedule = () => {};
  const input = { executor: 'test', repository, goal: 'Inspect hello', acceptance: ['Return evidence'], permission: 'read-only', budget: { maxTurns: 2 }, idempotencyKey: 'initial' };
  return { root, service, input, options };
}

async function stopped(service, taskId) {
  let current = await service.getTask({ taskId });
  for (let attempts = 0; attempts < 20; attempts++) {
    if (['completed', 'failed', 'cancelled', 'needs_input'].includes(current.state) && !current.lease && !service.active.has(taskId)) return current;
    current = await service.waitTask({ taskId, afterSequence: current.sequence, timeoutMs: 500 });
    await nextTurn();
  }
  throw new Error('Execution did not stop within the test deadline');
}

test('failed initial persistence leaves no ghost task and the same key can be retried', async t => {
  const { root, service, input } = await fixture(t);
  const originalFile = service.file.bind(service);
  service.file = id => path.join(root, 'missing-directory', `${id}.json`);
  await assert.rejects(service.submitTask(input), { code: 'ENOENT' });
  assert.equal(service.tasks.size, 0);
  assert.equal(service.active.size, 0);
  service.file = originalFile;
  const task = await service.submitTask(input);
  assert.equal(task.state, 'queued');
  assert.equal(task.sequence, 1);
  assert.equal((await service.submitTask(input)).id, task.id);
  assert.equal(JSON.parse(await fs.readFile(originalFile(task.id), 'utf8')).id, task.id);
});

test('failed running checkpoint releases the execution slot and restores the persisted queue cursor', async t => {
  let executions = 0;
  const { root, service, input } = await fixture(t, async () => { executions++; return { summary: 'done' }; });
  const task = await service.submitTask(input);
  const originalFile = service.file.bind(service);
  service.file = id => path.join(root, 'missing-directory', `${id}.json`);
  await assert.rejects(service.pump(), { code: 'ENOENT' });
  assert.equal(service.active.size, 0);
  const queued = await service.getTask({ taskId: task.id });
  assert.equal(queued.state, 'queued'); assert.equal(queued.lease, null);
  assert.equal(queued.sequence, 1); assert.equal(queued.events.length, 1);
  assert.equal(executions, 0);
  service.file = originalFile;
  const persisted = JSON.parse(await fs.readFile(originalFile(task.id), 'utf8'));
  assert.equal(persisted.state, 'queued'); assert.equal(persisted.sequence, queued.sequence);
  await service.pump();
  assert.equal((await stopped(service, task.id)).state, 'completed');
  assert.equal(executions, 1);
});

test('failed followup persistence rolls back idempotency and can be retried once', async t => {
  let executions = 0;
  const { root, service, input } = await fixture(t, async () => { executions++; return { summary: 'done' }; });
  const parent = await service.submitTask(input); await service.pump(); await stopped(service, parent.id);
  const followup = { taskId: parent.id, goal: 'Inspect the same file again', idempotencyKey: 'revision' };
  const originalFile = service.file.bind(service);
  service.file = id => path.join(root, 'missing-directory', `${id}.json`);
  await assert.rejects(service.sendFollowup(followup), { code: 'ENOENT' });
  assert.equal(service.tasks.size, 1);
  assert.equal([...service.tasks.values()].some(task => task.idempotencyKey === 'revision'), false);
  service.file = originalFile;
  const task = await service.sendFollowup(followup);
  assert.equal((await service.sendFollowup(followup)).id, task.id);
  assert.equal(task.parentTaskId, parent.id);
  await service.pump(); assert.equal((await stopped(service, task.id)).state, 'completed');
  assert.equal(executions, 2);
});

test('concurrent stale-lock recovery grants exactly one owner using a confirmed exited PID', async t => {
  let instances = [];
  const root = await temporaryDirectory(t, async () => { for (const service of instances) await service.close(); }), dataDir = path.join(root, 'data');
  await fs.mkdir(dataDir);
  const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
  assert.equal(exited.status, 0); assert.ok(Number.isInteger(exited.pid));
  assert.throws(() => process.kill(exited.pid, 0), { code: 'ESRCH' });
  const lockFile = path.join(dataDir, 'service.lock');
  await fs.writeFile(lockFile, JSON.stringify({ pid: exited.pid, instance: 'previous-exited-owner' }));
  instances = [0, 1].map(() => new CollaborationService({ dataDir, allowedRoots: [root] }));
  const outcomes = await Promise.allSettled(instances.map(service => service.init()));
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  const failure = outcomes.find(outcome => outcome.status === 'rejected');
  assert.match(failure.reason.message, /锁正在恢复|已经有协作服务/);
  const owner = instances.find(service => service.ownsLock);
  assert.equal(instances.filter(service => service.ownsLock).length, 1);
  assert.equal(JSON.parse(await fs.readFile(lockFile, 'utf8')).instance, owner.instance);
  await owner.close();
  await assert.rejects(fs.access(lockFile), { code: 'ENOENT' });
  await assert.rejects(fs.access(`${lockFile}.recovery`), { code: 'ENOENT' });
});

test('default factory inspection does not load, rewrite, lock or execute a persisted queue', async t => {
  const { createDefaultService } = require('../collaboration/index.cjs');
  let executions = 0, inspected;
  const { service, input, options } = await fixture(t, async () => { executions++; return { summary: 'done' }; });
  const task = await service.submitTask(input);
  const taskFile = service.file(task.id), before = await fs.readFile(taskFile, 'utf8');
  // Inspection must also work while the normal service owns the data lock.
  const lockFile = path.join(options.dataDir, 'service.lock'), ownerBefore = await fs.readFile(lockFile, 'utf8');
  try {
    inspected = await createDefaultService({ ...options, inspectOnly: true });
    assert.equal(inspected.tasks.size, 0);
    assert.equal(Boolean(inspected.ownsLock), false);
    assert.equal((await inspected.listExecutors())[0].id, 'test');
    await nextTurn(); await inspected.serial;
    assert.equal(executions, 0);
    assert.equal(await fs.readFile(taskFile, 'utf8'), before);
    assert.equal(await fs.readFile(lockFile, 'utf8'), ownerBefore);
  } finally { await inspected?.close(); }
  assert.equal(await fs.readFile(lockFile, 'utf8'), ownerBefore, 'inspection close cannot release the live owner lock');
});

test('an active native execution is actually aborted at its deadline and persists failure', async t => {
  let started = false, aborted = false, abortReason;
  const { service, input } = await fixture(t, async (_task, context) => {
    started = true;
    await new Promise(resolve => context.signal.addEventListener('abort', () => {
      aborted = true; abortReason = context.signal.reason; resolve();
    }, { once: true }));
    throw abortReason;
  });
  const deadlineAt = new Date(Date.now() + 2000).toISOString();
  const task = await service.submitTask({ ...input, deadlineAt });
  await service.pump();
  const done = await stopped(service, task.id);
  assert.equal(started, true, 'the task must reach the native executor before its deadline');
  assert.equal(aborted, true);
  assert.match(abortReason.message, /执行期限/);
  assert.equal(done.state, 'failed'); assert.equal(done.stopReason, 'deadline');
  assert.equal(done.lease, null); assert.match(done.error, /执行期限/);
  const persisted = JSON.parse(await fs.readFile(service.file(task.id), 'utf8'));
  assert.equal(persisted.state, 'failed'); assert.equal(persisted.stopReason, 'deadline');
});

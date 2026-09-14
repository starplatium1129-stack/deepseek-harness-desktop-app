'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CollaborationService, git } = require('../collaboration/core.cjs');
const { tools, validate } = require('../collaboration/mcp.cjs');
const dispatcher = { client: 'codex', threadId: 'original-codex', hostId: 'local' };
async function setup(t, execute = async () => ({ summary: 'done' })) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatcher-test-'));
  const repository = path.join(root, 'repo'); await fs.mkdir(repository);
  await git(repository, ['init']); await git(repository, ['config', 'user.name', 'Test']); await git(repository, ['config', 'user.email', 'test@example.invalid']);
  await fs.writeFile(path.join(repository, 'a.txt'), 'original'); await git(repository, ['add', '.']); await git(repository, ['commit', '-m', 'fixture']);
  const options = { dataDir: path.join(root, 'data'), allowedRoots: [repository], adapters: [{ id: 'test', describe: async () => ({ available: true }), execute }] };
  let service = await new CollaborationService(options).init();
  t.after(async () => { await service.close(); await fs.rm(root, { force: true, recursive: true }); });
  return { get service() { return service; }, async restart() { await service.close(); service = await new CollaborationService(options).init(); return service; },
    input: { executor: 'test', repository, dispatcher, goal: 'bounded fixture', acceptance: ['done'], permission: 'workspace-write', budget: { maxTurns: 2 }, deadlineAt: new Date(Date.now() + 120000).toISOString(), idempotencyKey: 'initial' } };
}
async function stopped(service, id, limit = 10000) {
  const end = Date.now() + limit;
  while (true) {
    const task = await service.getTask({ taskId: id });
    if (!task.lease && !service.active.has(id) && task.state !== 'queued') return task;
    if (Date.now() >= end) throw new Error('fixture failed to settle');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
test('origin discovery, progress replay, exclusive claim and receipts survive restart', async t => {
  const f = await setup(t, async (_task, ctx) => { await ctx.emit('text', { text: 'progress' }); return { summary: 'done' }; });
  const a = await f.service.submitTask(f.input); const done = await stopped(f.service, a.id);
  assert.deepEqual(done.dispatcher, dispatcher);
  const page = f.service.listDispatcherTasks({ dispatcher }); assert.equal(page.tasks[0].taskId, a.id);
  assert.equal(f.service.listDispatcherTasks({ dispatcher: { ...dispatcher, threadId: 'other' } }).tasks.length, 0);
  assert.equal((await f.service.getTask({ taskId: a.id, afterSequence: done.sequence })).events.length, 0);
  assert.ok(done.events.some(e => e.type === 'text'));
  const input = { taskId: a.id, dispatcher, eventSequence: done.events.find(e => e.type === 'execution_stopped').sequence, idempotencyKey: 'send-once' };
  const claims = await Promise.all([f.service.claimDelivery(input), f.service.claimDelivery(input)]);
  assert.equal(claims.filter(c => c.shouldSend).length, 1);
  const claim = claims[0]; assert.match(claim.prompt, new RegExp(claim.id));
  await assert.rejects(f.service.claimDelivery({ ...input, dispatcher: { ...dispatcher, threadId: 'other' } }), /派发会话/);
  await f.restart();
  assert.equal((await f.service.claimDelivery({ ...input, idempotencyKey: 'another-key' })).shouldSend, false);
  assert.equal(f.service.listDispatcherTasks({ dispatcher }).tasks[0].deliveries[0].state, 'claimed');
  const receipt = { taskId: a.id, dispatcher, deliveryId: claim.id };
  await f.service.resolveDelivery({ ...receipt, state: 'uncertain' });
  await f.service.resolveDelivery({ ...receipt, state: 'received' });
  assert.equal((await f.service.resolveDelivery({ ...receipt, state: 'sent' })).state, 'received');
  await f.restart(); assert.equal(f.service.listDispatcherTasks({ dispatcher }).tasks[0].deliveries[0].state, 'received');
});
test('main-agent review gates revisions and stale completion cannot dispatch twice even with a new key', async t => {
  const f = await setup(t); const a = await f.service.submitTask(f.input); await stopped(f.service, a.id);
  const next = { taskId: a.id, goal: 'next step', idempotencyKey: 'next' };
  await assert.rejects(f.service.sendFollowup(next), /先审核/);
  await f.service.reviewTask({ taskId: a.id, decision: 'accepted', note: 'Fixture independently inspected' });
  const b = await f.service.sendFollowup(next); await stopped(f.service, b.id);
  assert.deepEqual(b.dispatcher, dispatcher); assert.equal((await f.service.sendFollowup(next)).id, b.id);
  await f.restart(); await assert.rejects(f.service.sendFollowup({ ...next, idempotencyKey: 'duplicate-next' }), /已有后续修订/);
});
test('failed and cancelled native tasks return deliverable evidence without acceptance', async t => {
  const f = await setup(t, async () => { throw new Error('native failure'); });
  const a = await f.service.submitTask(f.input); const failed = await stopped(f.service, a.id); assert.equal(failed.state, 'failed');
  const claim = await f.service.claimDelivery({ taskId: a.id, dispatcher, eventSequence: failed.sequence, idempotencyKey: 'failed' });
  assert.equal(claim.taskState, 'failed'); assert.equal(failed.review.decision, 'pending');
  const b = await f.service.submitTask({ ...f.input, idempotencyKey: 'cancel' }); await f.service.cancelTask({ taskId: b.id });
  const cancelled = await stopped(f.service, b.id); assert.equal(cancelled.state, 'cancelled');
  assert.equal((await f.service.claimDelivery({ taskId: b.id, dispatcher, eventSequence: cancelled.sequence, idempotencyKey: 'cancelled' })).shouldSend, true);
});
test('attention and recovery events are routable; invalid progress claims and failed persistence never grant send', async t => {
  const f = await setup(t, async (_task, ctx) => { await ctx.state('needs_input', { message: 'Need a choice' }); return {}; });
  const a = await f.service.submitTask(f.input); const task = await stopped(f.service, a.id);
  const args = { taskId: a.id, dispatcher, idempotencyKey: 'attention', eventSequence: task.events.find(e => e.type === 'needs_input').sequence };
  await assert.rejects(f.service.claimDelivery({ ...args, eventSequence: 1 }), /结束/);
  const persist = f.service.persistDelivery;
  f.service.persistDelivery = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(f.service.claimDelivery(args), /disk/);
  assert.equal(f.service.lookup(a.id).deliveries, undefined);
  f.service.persistDelivery = persist; assert.equal((await f.service.claimDelivery(args)).shouldSend, true);
  await f.service.transaction(async () => { const live = f.service.lookup(a.id); live.state = 'running'; live.lease = { owner: 'lost' }; await f.service.record(live, 'fixture-interrupted'); });
  await f.restart(); const recovered = await f.service.getTask({ taskId: a.id });
  assert.equal(recovered.dispatchUncertain, true);
  assert.equal((await f.service.claimDelivery({ ...args, eventSequence: recovered.sequence, idempotencyKey: 'recovery' })).shouldSend, true);
});
test('MCP exposes routing and rejects incomplete origin and invalid receipt values', () => {
  assert.equal(tools.length, 17);
  const schema = tools.find(t => t.name === 'list_dispatcher_tasks').inputSchema;
  assert.equal(validate(schema, { dispatcher }), null);
  assert.ok(validate(schema, { dispatcher: { client: 'codex' } }));
  assert.ok(validate(tools.find(t => t.name === 'resolve_delivery').inputSchema, { taskId: 'x', dispatcher, deliveryId: 'x', state: 'accepted' }));
});

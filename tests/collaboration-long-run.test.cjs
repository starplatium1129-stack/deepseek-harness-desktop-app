const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { CollaborationService, git } = require('../collaboration/core.cjs');
const { LongRunManager, decision, checkSpecs, runChecks } = require('../collaboration/long-run.cjs');
const { resolveCodex } = require('../collaboration/codex-reviewer.cjs');

const resources = path.resolve(__dirname, '../runtime');
const proposal = goal => ({ action: 'continue', review: 'not_applicable', summary: 'Plan one bounded step.', criteria: [{ index: 0, status: 'unknown', evidence: 'No execution evidence yet.' }], nextTask: { goal, acceptance: ['Update counter.txt only.'] } });
const review = (complete, goal) => ({ action: complete ? 'complete' : 'continue', review: 'accepted', summary: 'Reviewed actual file evidence.', criteria: [{ index: 0, status: complete ? 'pass' : 'fail', evidence: complete ? 'Counter reached the requested value and checks passed.' : 'More increments remain.' }], nextTask: complete ? null : { goal, acceptance: ['Update counter.txt only.'] } });
// The state-machine tests execute only the known inline fixture checks. Native
// sandbox enforcement is exercised separately below; no model is called here.
async function fixtureChecks(run, task) {
  return Promise.all(run.checks.map(async check => {
    try { const result = await promisify(execFile)(process.execPath, check.args, { cwd: task.workspace, windowsHide: true, timeout: check.timeoutMs, maxBuffer: 65536 }); return { exitCode: 0, output: result.stdout }; }
    catch (error) { return { exitCode: Number.isInteger(error.code) ? error.code : null, output: error.stdout, error: error.message }; }
  }));
}
async function setup(t, reviewer, action, verifier = fixtureChecks) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'long-run-test-')), repo = path.join(root, 'repo'); await fs.mkdir(repo);
  await git(repo, ['init']); await git(repo, ['config', 'user.name', 'Coordinator test']); await git(repo, ['config', 'user.email', 'test@example.invalid']);
  await fs.writeFile(path.join(repo, 'counter.txt'), '0'); await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'initial']);
  let executions = 0;
  const service = await new CollaborationService({ dataDir: path.join(root, 'data'), allowedRoots: [repo], adapters: [{ id: 'harness', describe: async () => ({ available: true }), execute: async (task, ctx) => {
    executions++; await ctx.checkpoint({ nativeSessionId: 'same-native-session' });
    if (action) return action(task, ctx, executions);
    await fs.writeFile(path.join(task.workspace, 'counter.txt'), String(executions)); return { summary: 'Executor claims done.' };
  } }] }).init();
  service.longRuns = await new LongRunManager({ service, resources, reviewer, verifier, managedLifetime: true }).init();
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const input = { repository: repo, goal: 'Increment to the required final value.', acceptance: ['Reach final counter value.'], permission: 'workspace-write', maxRounds: 8, maxTurnsPerTask: 2,
    deadlineAt: new Date(Date.now() + 60000).toISOString(), checks: [{ command: 'node', args: ['-e', 'const a=require("node:assert/strict");const fs=require("node:fs");a.ok(Number(fs.readFileSync("counter.txt","utf8"))>0)'] }], idempotencyKey: 'run' };
  return { service, manager: service.longRuns, input, root, repo, executions: () => executions };
}
async function settled(manager, id) {
  for (let n = 0; n < 100; n++) {
    const run = manager.get({ runId: id });
    if (['completed', 'blocked', 'paused'].includes(run.state) && !manager.active.has(id)) return run;
    await manager.wait({ runId: id, afterSequence: run.sequence, timeoutMs: 1000 });
  }
  throw new Error('Coordinator fixture failed to settle');
}

test('six rounds automatically dispatch, verify, review and continue in one worktree/native session', async t => {
  const f = await setup(t, async bundle => bundle.phase === 'planning' ? proposal('Set counter to 1.') : review(bundle.iteration === 6, `Set counter to ${bundle.iteration + 1}.`));
  const run = await f.manager.start(f.input);
  assert.equal((await f.manager.start(f.input)).id, run.id);
  const done = await settled(f.manager, run.id);
  assert.equal(done.state, 'completed'); assert.equal(done.iteration, 6); assert.equal(f.executions(), 6);
  const tasks = [...f.service.tasks.values()];
  assert.equal(new Set(tasks.map(t => t.workspace)).size, 1); assert.ok(tasks.every(t => t.depth === 0));
  assert.ok(tasks.every(t => t.nativeSessionId === 'same-native-session' && t.review.decision === 'accepted'));
  assert.equal(await fs.readFile(path.join(done.workspace, 'counter.txt'), 'utf8'), '6');
  assert.equal(await fs.readFile(path.join(f.repo, 'counter.txt'), 'utf8'), '0');
  assert.equal(done.lastChecks[0].exitCode, 0); assert.equal(done.autoMerge, false);
});

test('failed actual checks override an agent claim that the overall goal is complete', async t => {
  const f = await setup(t, async bundle => bundle.phase === 'planning' ? proposal('Set counter.') : review(true));
  const run = await f.manager.start({ ...f.input, checks: [{ command: 'node', args: ['-e', 'process.exit(3)'] }] });
  const done = await settled(f.manager, run.id);
  assert.equal(done.state, 'blocked'); assert.match(done.reason, /检查未通过/); assert.equal(done.lastChecks[0].exitCode, 3);
  assert.equal((await f.service.getTask({ taskId: done.taskId })).review.decision, 'pending');
});

test('bounded rounds and unchanged evidence stop continuing decisions without another dispatch', async t => {
  const f = await setup(t, async b => b.phase === 'planning' ? proposal('Inspect.') : review(false, 'Inspect again.'), async () => ({ summary: 'No change.' }));
  const run = await f.manager.start({ ...f.input, checks: [] }); const done = await settled(f.manager, run.id);
  assert.equal(done.state, 'blocked'); assert.equal(f.executions(), 3); assert.match(done.reason, /没有新的代码证据/);
  await assert.rejects(f.manager.resume({ runId: run.id }), /停滞/);
});

test('pause during Codex review settles, then resume reviews the same completed child without replay', async t => {
  let reviewing, reviewCount = 0;
  const observed = new Promise(resolve => { reviewing = resolve; });
  const f = await setup(t, async (bundle, options) => {
    if (bundle.phase === 'planning') return proposal('Set counter.');
    if (++reviewCount === 1) { reviewing(); await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true })); options.signal.throwIfAborted(); }
    return review(true);
  });
  const run = await f.manager.start(f.input); await observed;
  await f.manager.pause({ runId: run.id }); assert.equal((await settled(f.manager, run.id)).state, 'paused');
  await f.manager.resume({ runId: run.id }); assert.equal((await settled(f.manager, run.id)).state, 'completed');
  assert.equal(f.executions(), 1); assert.equal(reviewCount, 2);
});

test('restart converts in-flight coordination to paused; completed child can be reviewed without redispatch', async t => {
  const f = await setup(t, async b => b.phase === 'planning' ? proposal('Set counter.') : review(true));
  const run = await f.manager.start(f.input); const done = await settled(f.manager, run.id);
  const file = f.manager.file(run.id), saved = JSON.parse(await fs.readFile(file, 'utf8'));
  saved.state = 'running'; saved.stage = 'executing'; await fs.writeFile(file, JSON.stringify(saved));
  await f.manager.close();
  f.service.longRuns = await new LongRunManager({ service: f.service, resources, reviewer: async () => review(true), verifier: fixtureChecks, managedLifetime: true }).init();
  assert.equal(f.service.longRuns.get({ runId: run.id }).state, 'paused');
  await f.service.longRuns.resume({ runId: run.id });
  assert.equal((await settled(f.service.longRuns, run.id)).state, 'completed'); assert.equal(f.executions(), 1);
  assert.equal(done.workspace, f.service.longRuns.get({ runId: run.id }).workspace);
});

test('invalid decisions, scope expansion in a next task and shell strings cannot become actions', () => {
  assert.throws(() => decision({ ...review(true), criteria: [] }, 1, false), /覆盖/);
  assert.throws(() => decision({ ...proposal('next'), nextTask: { goal: 'next', acceptance: ['ok'], permission: 'danger-full-access' } }, 1, true), /有效/);
  assert.throws(() => checkSpecs([{ command: 'node && erase', args: [] }]), /shell/);
});

test('a known cancelled child is reviewed on explicit resume before another bounded task', async t => {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = await setup(t, async bundle => {
    if (bundle.phase === 'planning') return proposal('Set counter.');
    if (bundle.taskState === 'cancelled') return { ...review(false, 'Complete the existing partial change.'), review: 'changes_requested' };
    return review(true);
  }, async (task, ctx, number) => {
    await fs.writeFile(path.join(task.workspace, 'counter.txt'), String(number));
    if (number === 1) { entered(); await new Promise(resolve => ctx.signal.addEventListener('abort', resolve, { once: true })); ctx.signal.throwIfAborted(); }
    return { summary: 'done' };
  });
  const run = await f.manager.start(f.input); await ready;
  await f.manager.pause({ runId: run.id }); const paused = await settled(f.manager, run.id);
  assert.equal(paused.state, 'paused'); assert.equal((await f.service.getTask({ taskId: paused.taskId })).state, 'cancelled');
  await f.manager.resume({ runId: run.id, note: 'Continue from the confirmed stopped partial work.' });
  const done = await settled(f.manager, run.id); assert.equal(done.state, 'completed'); assert.equal(f.executions(), 2);
});

test('pausing a run blocked on live native input also stops that owned child', async t => {
  const f = await setup(t, async () => proposal('Inspect.'), async (_task, ctx) => {
    await ctx.state('needs_input', { message: 'Human input required.' });
    await new Promise(resolve => ctx.signal.addEventListener('abort', resolve, { once: true })); ctx.signal.throwIfAborted();
  });
  const run = await f.manager.start({ ...f.input, checks: [] });
  const blocked = await settled(f.manager, run.id); assert.equal(blocked.state, 'blocked');
  assert.ok((await f.service.getTask({ taskId: blocked.taskId })).lease);
  const paused = await f.manager.pause({ runId: run.id }); assert.equal(paused.state, 'paused');
  const stopped = await f.service.getTask({ taskId: blocked.taskId }); assert.equal(stopped.lease, null); assert.equal(stopped.state, 'cancelled');
});

test('last-round review may resume after pause without enlarging the execution budget', async t => {
  let arrived, calls = 0; const ready = new Promise(resolve => { arrived = resolve; });
  const f = await setup(t, async (bundle, options) => {
    if (bundle.phase === 'planning') return proposal('Set counter.');
    if (++calls === 1) { arrived(); await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true })); options.signal.throwIfAborted(); }
    return review(true);
  });
  const run = await f.manager.start({ ...f.input, maxRounds: 1 }); await ready;
  await f.manager.pause({ runId: run.id }); await settled(f.manager, run.id);
  await f.manager.resume({ runId: run.id }); assert.equal((await settled(f.manager, run.id)).state, 'completed'); assert.equal(f.executions(), 1);
});

test('verification timeout stops its owned process tree and cannot be accepted as success', { skip: process.platform !== 'win32' }, async t => {
  try { await resolveCodex(); } catch { t.skip('Native Codex CLI is unavailable'); return; }
  const f = await setup(t, async b => b.phase === 'planning' ? proposal('Set counter.') : review(true), undefined, runChecks);
  const code = 'const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});require("node:fs").writeFileSync(require("node:path").join(process.env.TEMP,"test-pids.json"),JSON.stringify({parent:process.pid,child:c.pid}));setInterval(()=>{},1000);';
  const run = await f.manager.start({ ...f.input, checks: [{ command: 'node', args: ['-e', code], timeoutMs: 500 }] });
  const done = await settled(f.manager, run.id); assert.equal(done.state, 'blocked');
  assert.match(done.lastChecks[0].error, /超过时限|timed out/);
  const temporary = path.join(done.controlDirectory, 'verification-tmp');
  const dirs = await fs.readdir(temporary); const ids = JSON.parse(await fs.readFile(path.join(temporary, dirs[0], 'test-pids.json'), 'utf8'));
  for (const pid of [ids.parent, ids.child]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

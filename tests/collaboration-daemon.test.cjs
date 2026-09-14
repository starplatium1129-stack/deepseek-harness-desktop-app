'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const { CollaborationService, git } = require('../collaboration/core.cjs');
const { startDaemon, readOwner, canonicalRoots, endpointFor, IPC_VERSION } = require('../collaboration/daemon.cjs');
const { authenticate, connectShared, readSharedStatus, restartShared } = require('../collaboration/bridge.cjs');
const { parseArgs } = require('../collaboration/cli.cjs');
const cli = path.resolve(__dirname, '../collaboration/cli.cjs');

function reader(stream) {
  let buffer = '';
  const messages = [], waiters = new Map();
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
      messages.push(message);
      const waiter = waiters.get(message.id);
      if (waiter) { clearTimeout(waiter.timer); waiters.delete(message.id); waiter.resolve(message); }
    }
  });
  return id => {
    const existing = messages.find(message => message.id === id);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`Timed out waiting for MCP ${id}`)); }, 15000);
      waiters.set(id, { resolve, timer });
    });
  };
}

function client(t, dataDir, repo, extra = []) {
  const child = spawn(process.execPath, [cli, '--shared', '--data-dir', dataDir, '--allow-root', repo, ...extra], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostic = '', sequence = 0;
  const wait = reader(child.stdout);
  child.stderr.on('data', chunk => { diagnostic += chunk; });
  child.stdin.on('error', () => {});
  const exited = new Promise((resolve, reject) => { child.once('exit', code => resolve(code)); child.once('error', reject); });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await exited; } });
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  return {
    child, exited,
    get diagnostic() { return diagnostic; },
    async ready() {
      const id = ++sequence;
      send({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'shared-test', version: '1' } } });
      const response = await wait(id);
      assert.equal(response.result.serverInfo.name, 'deepseek-harness-collaboration');
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },
    async call(name, args = {}) {
      const id = ++sequence;
      send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
      const response = await wait(id);
      assert.equal(response.result?.isError, false, JSON.stringify(response));
      return JSON.parse(response.result.content[0].text);
    },
    async close() { child.stdin.end(); assert.equal(await exited, 0, diagnostic); },
  };
}

async function fixture(t, execute, idleMs = 30000, { beforeClose = () => {}, signals, error, extendService = async () => {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-shared-test-'));
  const repo = path.join(root, 'repo'), dataDir = path.join(root, 'data');
  await fs.mkdir(repo);
  await git(repo, ['init']); await git(repo, ['config', 'user.email', 'test@example.invalid']); await git(repo, ['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(repo, 'hello.txt'), 'original\n'); await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'initial']);
  let dispatches = 0, closes = 0, factoryOptions;
  const adapter = { id: 'test', describe: async () => ({ id: 'test', available: true, capabilities: {} }), execute: async (...args) => { dispatches++; return execute(...args); } };
  const factory = options => new CollaborationService({ ...options, adapters: [adapter] }).init();
  const daemon = await startDaemon({ dataDir, allowedRoots: [repo], idleMs, signals, error, createService: async options => {
    factoryOptions = options;
    const service = await factory(options), original = service.close.bind(service);
    await extendService(service);
    service.close = async () => { closes++; return original(); };
    return service;
  } });
  t.after(async () => { await beforeClose(); await daemon.close({ force: true }); await fs.rm(root, { recursive: true, force: true }); });
  const submit = { executor: 'test', repository: repo, goal: 'Write hello', acceptance: ['hello contains changed'], permission: 'workspace-write', budget: { maxTurns: 2 }, deadlineAt: new Date(Date.now() + 60000).toISOString(), idempotencyKey: 'shared-task' };
  return { root, repo, dataDir, daemon, submit, factory, factoryOptions, get dispatches() { return dispatches; }, get closes() { return closes; } };
}

async function waitUntil(predicate, limit = 10000) {
  const end = Date.now() + limit;
  while (!await predicate()) {
    if (Date.now() >= end) throw new Error('Condition did not become true');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('two real MCP clients share one task; EOF preserves native execution and explicit cancellation works', async t => {
  let release, started = false;
  const f = await fixture(t, async (task, ctx) => {
    started = true;
    await new Promise(resolve => { release = resolve; ctx.signal.addEventListener('abort', resolve, { once: true }); });
    if (ctx.signal.aborted) throw ctx.signal.reason;
    await fs.writeFile(path.join(task.workspace, 'hello.txt'), 'changed\n');
    return { summary: 'shared task finished', nativeSessionId: 'test-native' };
  });
  const a = client(t, f.dataDir, f.repo), b = client(t, f.dataDir, f.repo);
  await Promise.all([a.ready(), b.ready()]);
  assert.equal(f.daemon.clientCount, 2);
  const submitted = await a.call('submit_task', f.submit);
  await waitUntil(() => started);
  assert.equal((await b.call('get_task', { taskId: submitted.id })).state, 'running');
  assert.equal((await b.call('submit_task', f.submit)).id, submitted.id);
  await a.close();
  assert.equal(f.closes, 0);
  assert.equal((await b.call('get_task', { taskId: submitted.id })).state, 'running');
  await assert.rejects(f.daemon.close(), /active tasks/);
  release();
  await waitUntil(async () => { const task = await b.call('get_task', { taskId: submitted.id }); return task.state === 'completed' && !task.lease; });
  assert.equal(f.dispatches, 1);
  assert.equal(await fs.readFile(path.join(f.repo, 'hello.txt'), 'utf8'), 'original\n');
  const cancelled = await b.call('submit_task', { ...f.submit, idempotencyKey: 'cancel-this' });
  await b.call('cancel_task', { taskId: cancelled.id });
  await waitUntil(async () => { const task = await b.call('get_task', { taskId: cancelled.id }); return task.state === 'cancelled' && !task.lease && !f.daemon.service.active.has(cancelled.id); });
  await b.close();
  assert.equal(f.closes, 0);
  await f.daemon.close();
  assert.equal(f.closes, 1);
  await assert.rejects(fs.access(path.join(f.dataDir, 'service.lock')), { code: 'ENOENT' });
});

test('a coordinator-only phase survives zero clients past idle timeout and blocks restart', async t => {
  const { LongRunManager } = require('../collaboration/long-run.cjs');
  let entered; const reviewing = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, async () => { throw new Error('No native task should dispatch.'); }, 100, { extendService: async service => {
    service.longRuns = await new LongRunManager({ service, resources: path.resolve(__dirname, '../runtime'), managedLifetime: true,
      reviewer: async (_bundle, { signal }) => { entered(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); signal.throwIfAborted(); },
    }).init();
  } });
  // A real start_run request owns an IPC connection during baseline validation.
  // Keep that connection here too, then disconnect once the coordinator starts.
  const roots = await canonicalRoots([f.repo]);
  const owner = await readOwner(path.join(f.dataDir, 'ipc', 'owner.json'), roots);
  const { socket } = await authenticate(owner, roots);
  const run = await f.daemon.service.startRun({ repository: f.repo, goal: 'Plan a bounded change.', acceptance: ['Evidence required.'], permission: 'workspace-write', maxRounds: 1, maxTurnsPerTask: 1, checks: [], deadlineAt: new Date(Date.now() + 60000).toISOString(), idempotencyKey: 'coordinator-idle' });
  await reviewing; socket.destroy(); await new Promise(resolve => setTimeout(resolve, 250));
  const options = { dataDir: f.dataDir, allowedRoots: [f.repo] }, status = await readSharedStatus(options);
  assert.equal(status.clientCount, 0); assert.equal(status.activeCount, 0); assert.equal(status.coordinatorCount, 1); assert.equal(status.busy, true);
  await assert.rejects(restartShared(options), /busy/);
  await f.daemon.service.pauseRun({ runId: run.id });
  await waitUntil(() => f.daemon.service.longRuns.active.size === 0);
  assert.equal(f.dispatches, 0);
});

test('unauthenticated IPC and any expansion or reduction of owner roots are rejected', async t => {
  const f = await fixture(t, async () => ({ summary: 'unused' }));
  const roots = await canonicalRoots([f.repo]);
  const owner = await readOwner(path.join(f.dataDir, 'ipc', 'owner.json'), roots);
  await assert.rejects(authenticate({ ...owner, token: '0'.repeat(64) }, roots), /Authentication failed/);
  await assert.rejects(authenticate(owner, await canonicalRoots([f.root])), /Allowed roots/);
  await assert.rejects(authenticate(owner, []), /Allowed roots/);
  await assert.rejects(connectShared({ dataDir: f.dataDir, allowedRoots: [f.root] }), /owner configuration/);
  assert.equal(f.daemon.clientCount, 0); assert.equal(f.dispatches, 0);
  const socket = net.createConnection(f.daemon.endpoint);
  await new Promise((resolve, reject) => { socket.once('data', resolve); socket.once('error', reject); });
  const response = new Promise((resolve, reject) => { socket.once('data', chunk => resolve(JSON.parse(chunk.toString()))); socket.once('error', reject); });
  socket.write(JSON.stringify({ version: IPC_VERSION, operation: 'connect' }) + '\n');
  assert.equal((await response).ok, false); socket.destroy();
});

test('daemon keeps work alive with zero clients beyond idle timeout, then shuts down exactly once', async t => {
  let release, started = false;
  const f = await fixture(t, async (_task, ctx) => {
    started = true;
    await new Promise(resolve => { release = resolve; ctx.signal.addEventListener('abort', resolve, { once: true }); });
    return { summary: 'finished after clients left' };
  }, 100);
  // Establish an IPC connection immediately so a slow Windows CLI startup cannot
  // consume this deliberately short test idle lifetime.
  const roots = await canonicalRoots([f.repo]);
  const owner = await readOwner(path.join(f.dataDir, 'ipc', 'owner.json'), roots);
  const { socket } = await authenticate(owner, roots);
  const submitted = await f.daemon.service.submitTask(f.submit);
  await waitUntil(() => started);
  socket.destroy();
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(f.closes, 0); assert.equal(f.daemon.hasWork(), true);
  release(); await f.daemon.done;
  assert.equal(f.closes, 1);
  const record = JSON.parse(await fs.readFile(path.join(f.dataDir, 'tasks', `${submitted.id}.json`), 'utf8'));
  assert.equal(record.state, 'completed');
});

test('owner shutdown is authenticated and refused while another MCP client is connected', async t => {
  const f = await fixture(t, async () => ({ summary: 'unused' }));
  const roots = await canonicalRoots([f.repo]);
  const owner = await readOwner(path.join(f.dataDir, 'ipc', 'owner.json'), roots);
  const { socket } = await authenticate(owner, roots);
  await assert.rejects(authenticate(owner, roots, 'shutdown'), /busy/);
  socket.destroy(); await waitUntil(() => f.daemon.clientCount === 0);
  const stopped = await authenticate(owner, roots, 'shutdown'); stopped.socket.destroy();
  await f.daemon.done; assert.equal(f.closes, 1);
});

test('shared daemon restart preserves uncertain native execution without automatic redispatch', async t => {
  const f = await fixture(t, async (_task, ctx) => {
    await ctx.checkpoint({ nativeSessionId: 'native-may-have-executed' });
    await new Promise(resolve => ctx.signal.addEventListener('abort', resolve, { once: true }));
    throw ctx.signal.reason;
  });
  const task = await f.daemon.service.submitTask(f.submit);
  await waitUntil(() => f.daemon.service.tasks.get(task.id)?.nativeSessionId);
  await f.daemon.close({ force: true });
  const restarted = await startDaemon({ dataDir: f.dataDir, allowedRoots: [f.repo], createService: f.factory });
  t.after(() => restarted.close({ force: true }));
  const recovered = await restarted.service.getTask({ taskId: task.id });
  assert.equal(recovered.state, 'needs_input'); assert.equal(recovered.dispatchUncertain, true); assert.equal(f.dispatches, 1);
  await restarted.close();
});

test('two CLI bridges auto-start one owned daemon and an authenticated stop releases its lock', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-shared-autostart-'));
  const dataDir = path.join(root, 'data');
  t.after(async () => {
    try { const connection = await connectShared({ dataDir, allowedRoots: [root], operation: 'shutdown' }); connection.socket.destroy(); } catch {}
    await waitUntil(async () => { try { await fs.access(path.join(dataDir, 'service.lock')); return false; } catch { return true; } }).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  const a = client(t, dataDir, root), b = client(t, dataDir, root);
  await Promise.all([a.ready(), b.ready()]);
  const lock = JSON.parse(await fs.readFile(path.join(dataDir, 'service.lock'), 'utf8'));
  assert.ok(Number.isInteger(lock.pid)); assert.notEqual(lock.pid, a.child.pid); assert.notEqual(lock.pid, b.child.pid);
  assert.equal((await a.call('list_executors')).length, 2);
  await a.close();
  assert.equal((await b.call('list_executors')).length, 2);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'service.lock'), 'utf8')), lock);
  await b.close();
  const connection = await connectShared({ dataDir, allowedRoots: [root], operation: 'shutdown' }); connection.socket.destroy();
  await waitUntil(async () => { try { await fs.access(path.join(dataDir, 'service.lock')); return false; } catch { return true; } });
  assert.equal(a.diagnostic + b.diagnostic, '');
});

test('shared CLI modes preserve explicit opt-in and reject incompatible options', () => {
  assert.equal(parseArgs(['--allow-root', path.resolve(__dirname)]).shared, false);
  assert.equal(parseArgs(['--shared', '--allow-root', path.resolve(__dirname)]).shared, true);
  assert.throws(() => parseArgs(['--shared', '--list-executors', '--allow-root', path.resolve(__dirname)]), /separate modes/);
  assert.throws(() => parseArgs(['--shared', '--shared-idle-ms', '0', '--allow-root', path.resolve(__dirname)]), /integer/);
  assert.equal(parseArgs(['--shared-status', '--allow-root', path.resolve(__dirname)]).sharedStatus, true);
  assert.equal(parseArgs(['--shared-restart', '--allow-root', path.resolve(__dirname)]).sharedRestart, true);
  assert.throws(() => parseArgs(['--shared-status', '--shared-restart', '--allow-root', path.resolve(__dirname)]), /separate modes/);
});

test('authenticated restart closes multiple idle clients, preserves owner/data and retains idempotency', async t => {
  const f = await fixture(t, async () => ({ summary: 'persisted before reload' }));
  const options = { dataDir: f.dataDir, allowedRoots: [f.repo] };
  const a = client(t, f.dataDir, f.repo), b = client(t, f.dataDir, f.repo);
  await Promise.all([a.ready(), b.ready()]);
  const submitted = await a.call('submit_task', f.submit);
  await waitUntil(async () => { const task = await b.call('get_task', { taskId: submitted.id }); return task.state === 'completed' && !task.lease; });
  const status = await readSharedStatus(options);
  assert.deepEqual(status, { pid: process.pid, clientCount: 2, activeCount: 0, queuedCount: 0, inflightCount: 0, coordinatorCount: 0, persistentResources: false, busy: false, closing: false, managementVersion: 1 });
  const ownerFile = path.join(f.dataDir, 'ipc', 'owner.json');
  const ownerDigest = value => createHash('sha256').update(value).digest('hex');
  const beforeOwner = ownerDigest(await fs.readFile(ownerFile));
  const result = await restartShared(options);
  assert.equal(result.restarted, true); assert.equal(result.previousPid, process.pid); assert.notEqual(result.pid, process.pid);
  assert.equal(await a.exited, 0); assert.equal(await b.exited, 0);
  assert.equal(ownerDigest(await fs.readFile(ownerFile)), beforeOwner);
  const c = client(t, f.dataDir, f.repo); await c.ready();
  assert.equal((await c.call('get_task', { taskId: submitted.id })).state, 'completed');
  assert.equal((await c.call('submit_task', f.submit)).id, submitted.id);
  assert.equal(f.dispatches, 1);
  await c.close();
  const stopped = await connectShared({ ...options, operation: 'shutdown' }); stopped.socket.destroy();
  await waitUntil(async () => { try { await fs.access(path.join(f.dataDir, 'service.lock')); return false; } catch { return true; } });
});

test('restart refuses active work, queued work and in-flight tool requests without closing clients', async t => {
  let started = false;
  const f = await fixture(t, async (_task, ctx) => {
    started = true;
    await new Promise(resolve => { if (ctx.signal.aborted) resolve(); else ctx.signal.addEventListener('abort', resolve, { once: true }); });
    return { summary: 'cancelled by explicit tool' };
  });
  f.daemon.service.concurrency = 1;
  const options = { dataDir: f.dataDir, allowedRoots: [f.repo] };
  const a = client(t, f.dataDir, f.repo); await a.ready();
  const first = await a.call('submit_task', f.submit); await waitUntil(() => started);
  const second = await a.call('submit_task', { ...f.submit, idempotencyKey: 'queued-for-restart-test' });
  const status = await readSharedStatus(options);
  assert.equal(status.activeCount, 1); assert.equal(status.queuedCount, 1); assert.equal(status.busy, true);
  await assert.rejects(restartShared(options), /active or queued tasks/);
  assert.equal((await a.call('get_task', { taskId: first.id })).state, 'running');
  await a.call('cancel_task', { taskId: second.id });
  await assert.rejects(restartShared(options), /active or queued tasks/);
  await a.call('cancel_task', { taskId: first.id });
  await waitUntil(() => f.daemon.service.active.size === 0);
  let release;
  f.daemon.service.listExecutors = () => new Promise(resolve => { release = resolve; });
  const pending = a.call('list_executors');
  await waitUntil(() => Boolean(release));
  assert.equal((await readSharedStatus(options)).inflightCount, 1);
  await assert.rejects(restartShared(options), /in-flight requests/);
  release([{ id: 'test', available: true }]);
  assert.equal((await pending)[0].id, 'test');
  assert.equal(f.closes, 0); await a.close();
});

test('native persistent resources survive client disconnect, idle timeout and repeated graceful signals', async t => {
  let nativeWindowOpen = true, adapterCloses = 0;
  const signals = new EventEmitter();
  const f = await fixture(t, async () => ({ summary: 'unused' }), 100, {
    beforeClose: () => { nativeWindowOpen = false; }, signals, error: { write() {} },
  });
  assert.equal(f.factoryOptions.managedLifetime, true);
  const adapter = f.daemon.service.adapters.get('test');
  adapter.hasPersistentResources = () => nativeWindowOpen;
  adapter.close = async () => { adapterCloses++; };
  const roots = await canonicalRoots([f.repo]);
  const owner = await readOwner(path.join(f.dataDir, 'ipc', 'owner.json'), roots);
  const { socket } = await authenticate(owner, roots); socket.destroy();
  await new Promise(resolve => setTimeout(resolve, 250));
  const status = await readSharedStatus({ dataDir: f.dataDir, allowedRoots: [f.repo] });
  assert.equal(status.clientCount, 0); assert.equal(status.activeCount, 0); assert.equal(status.queuedCount, 0);
  assert.equal(status.persistentResources, true); assert.equal(status.busy, true); assert.equal(f.closes, 0);
  await assert.rejects(authenticate(owner, roots, 'shutdown'), /native window/);
  await assert.rejects(authenticate(owner, roots, 'restart'), /native window/);
  signals.emit('SIGTERM'); signals.emit('SIGINT'); signals.emit('SIGTERM');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signals.listenerCount('SIGTERM'), 1); assert.equal(signals.listenerCount('SIGINT'), 1);
  assert.equal(adapterCloses, 0); assert.equal(f.closes, 0);
  await assert.rejects(f.daemon.service.close(), { code: 'PERSISTENT_NATIVE_RESOURCES' });
  assert.equal(f.daemon.service.closing, false); assert.equal(f.daemon.service.ownsLock, true);
  nativeWindowOpen = false;
  await f.daemon.done;
  assert.equal(adapterCloses, 1);
  await f.daemon.service.close(); assert.equal(adapterCloses, 1);
  await assert.rejects(fs.access(path.join(f.dataDir, 'service.lock')), { code: 'ENOENT' });
});

test('a user-closed native resource permits restart and closes the adapter exactly once', async t => {
  let nativeWindowOpen = true, adapterCloses = 0;
  const f = await fixture(t, async () => ({ summary: 'unused' }), 30000, { beforeClose: () => { nativeWindowOpen = false; } });
  const adapter = f.daemon.service.adapters.get('test');
  adapter.hasPersistentResources = () => nativeWindowOpen;
  adapter.close = async () => { adapterCloses++; };
  const options = { dataDir: f.dataDir, allowedRoots: [f.repo] };
  const a = client(t, f.dataDir, f.repo); await a.ready();
  await assert.rejects(restartShared(options), /native window/);
  assert.equal((await a.call('list_executors')).length, 1);
  assert.equal(adapterCloses, 0);
  nativeWindowOpen = false;
  const replacement = await restartShared(options);
  assert.equal(replacement.restarted, true); assert.equal(adapterCloses, 1); assert.equal(await a.exited, 0);
  assert.equal((await readSharedStatus(options)).persistentResources, false);
  const stopped = await connectShared({ ...options, operation: 'shutdown' }); stopped.socket.destroy();
  await waitUntil(async () => { try { await fs.access(path.join(f.dataDir, 'service.lock')); return false; } catch { return true; } });
});

test('a native resource appearing during shutdown leaves the listener, lock and adapters alive', async t => {
  let nativeWindowOpen = false, adapterCloses = 0, release;
  const f = await fixture(t, async () => ({ summary: 'unused' }), 30000, { beforeClose: () => { nativeWindowOpen = false; release?.(); } });
  const adapter = f.daemon.service.adapters.get('test');
  adapter.hasPersistentResources = () => nativeWindowOpen;
  adapter.close = async () => { adapterCloses++; };
  const pending = f.daemon.service.transaction(() => new Promise(resolve => { release = resolve; }));
  await waitUntil(() => Boolean(release));
  const closing = f.daemon.close({ force: true });
  nativeWindowOpen = true; release(); await pending;
  await assert.rejects(closing, { code: 'PERSISTENT_NATIVE_RESOURCES' });
  assert.equal(f.daemon.service.closing, false); assert.equal(f.daemon.service.ownsLock, true); assert.equal(adapterCloses, 0);
  const status = await readSharedStatus({ dataDir: f.dataDir, allowedRoots: [f.repo] });
  assert.equal(status.closing, false); assert.equal(status.persistentResources, true);
  nativeWindowOpen = false; await f.daemon.close(); assert.equal(adapterCloses, 1);
});

test('bridge never transmits the secret and refuses an impersonated local service before MCP', async t => {
  const owner = { token: randomBytes(32).toString('hex'), endpointId: randomBytes(24).toString('hex') };
  const roots = [path.resolve(__dirname)];
  let captured;
  const server = net.createServer(socket => {
    socket.on('error', () => {});
    socket.write(JSON.stringify({ version: IPC_VERSION, challenge: randomBytes(32).toString('hex') }) + '\n');
    socket.once('data', chunk => {
      captured = chunk.toString();
      socket.end(JSON.stringify({ ok: true, proof: '0'.repeat(64) }) + '\n');
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpointFor(owner), resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(authenticate(owner, roots), /identity could not be authenticated/);
  assert.ok(captured); assert.equal(captured.includes(owner.token), false);
  assert.equal(Object.hasOwn(JSON.parse(captured), 'token'), false);
});

test('actual Codex first-start daemon survives its launching client and serves another client', {
  skip: process.platform !== 'win32' || process.env.COLLABORATION_CODEX_INTEROP_TEST !== '1',
  timeout: 120000,
}, async t => {
  const { CodexClient } = require('../scripts/codex-collaboration-smoke.cjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-codex-interop-'));
  // CODEX_HOME is a protected configuration boundary. Keep service data outside
  // it, as in the real installation; never copy the user's credentials/config.
  const cfgHome = path.join(root, 'codex-home'), dataDir = path.join(root, 'data'), repo = path.join(root, 'repo');
  await fs.mkdir(cfgHome); await fs.mkdir(repo);
  const nativeLive = process.env.COLLABORATION_CODEX_LIVE_INTEROP_TEST === '1';
  if (nativeLive) {
    await git(repo, ['init']); await git(repo, ['config', 'user.email', 'interop@example.invalid']); await git(repo, ['config', 'user.name', 'Interop']);
    await fs.writeFile(path.join(repo, 'hello.txt'), 'original\n'); await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'interop fixture']);
  }
  const config = 'sandbox_mode="danger-full-access"\n[mcp_servers.agent-collaboration]\ncommand=' + JSON.stringify(process.execPath) + '\nargs=' + JSON.stringify([cli, '--shared', '--data-dir', dataDir, '--allow-root', repo]) + '\nstartup_timeout_sec=30\ntool_timeout_sec=75\n';
  await fs.writeFile(path.join(cfgHome, 'config.toml'), config);
  const priorHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = cfgHome;
  const a = new CodexClient(); let b;
  if (priorHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorHome;
  t.after(async () => {
    await Promise.all([a.close(), b?.close()]);
    try { const connection = await connectShared({ dataDir, allowedRoots: [repo], operation: 'shutdown' }); connection.socket.destroy(); } catch {}
  });
  await a.initialize(); assert.equal((await a.call('list_executors')).length, 2);
  const owner = JSON.parse(await fs.readFile(path.join(dataDir, 'service.lock'), 'utf8'));
  process.env.CODEX_HOME = cfgHome;
  b = new CodexClient();
  if (priorHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorHome;
  await b.initialize(); assert.equal((await b.call('list_executors')).length, 2);
  let submitted;
  if (nativeLive) {
    submitted = await a.call('submit_task', { executor: 'harness', repository: repo, permission: 'workspace-write', budget: { maxTurns: 3 }, deadlineAt: new Date(Date.now() + 60000).toISOString(), idempotencyKey: 'actual-codex-disconnect',
      goal: '只使用文件编辑工具，将 hello.txt 内容替换为 shared-daemon-ok 加换行。不使用 shell，不委派，不改其他文件。完成后简洁报告。', acceptance: ['hello.txt 的完整内容为 shared-daemon-ok 加换行', '没有其他文件改动'] });
    await waitUntil(async () => (await a.call('get_task', { taskId: submitted.id })).state === 'running');
  }
  await a.close();
  assert.doesNotThrow(() => process.kill(owner.pid, 0));
  assert.equal((await b.call('list_executors')).length, 2);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'service.lock'), 'utf8')), owner);
  if (nativeLive) {
    let task = await b.call('get_task', { taskId: submitted.id });
    while (task.lease || !['completed', 'failed', 'cancelled', 'needs_input', 'needs_approval'].includes(task.state)) task = await b.call('wait_task', { taskId: task.id, afterSequence: task.sequence, timeoutMs: 15000 });
    assert.equal(task.state, 'completed', JSON.stringify(task));
    assert.equal(await fs.readFile(path.join(task.workspace, 'hello.txt'), 'utf8'), 'shared-daemon-ok\n');
    assert.equal(await fs.readFile(path.join(repo, 'hello.txt'), 'utf8'), 'original\n');
    assert.equal(await git(task.workspace, ['diff', '--name-only', task.baseCommit]), 'hello.txt');
    assert.equal(await git(task.workspace, ['ls-files', '--others', '--exclude-standard']), '');
    await b.call('review_task', { taskId: task.id, decision: 'accepted', note: '审核端实际读取 hello.txt 并核对仅此文件改动；发起 Codex 客户端退出后任务继续完成，原始仓库未改变。' });
    await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ passed: true, daemonPid: owner.pid, taskId: task.id, nativeSessionId: task.nativeSessionId, workspace: task.workspace }, null, 2));
    t.diagnostic(`Native disconnect acceptance evidence: ${path.join(root, 'result.json')}`);
  }
  await b.close();
  const stopped = await connectShared({ dataDir, allowedRoots: [repo], operation: 'shutdown' }); stopped.socket.destroy();
  await waitUntil(async () => { try { await fs.access(path.join(dataDir, 'service.lock')); return false; } catch { return true; } });
  if (!nativeLive) await fs.rm(root, { recursive: true, force: true });
});

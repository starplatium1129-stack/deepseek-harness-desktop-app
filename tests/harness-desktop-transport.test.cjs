'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const { startDesktopServer } = require('../collaboration/harness-desktop-server.cjs');
const { desktopBridgeStatus, executeOnDesktop, descriptorPath, readDescriptor, endpointFor, proof, equalProof, createChannel, VERSION, MAX_FRAME_BYTES } = require('../collaboration/harness-desktop-client.cjs');
const { privateDirectory } = require('../collaboration/daemon.cjs');

const windows = { skip: process.platform !== 'win32' };
function task(extra = {}) { return { id: 'task-fixture', goal: 'Read fixture only.', workspace: path.resolve(__dirname), permission: 'read-only', budget: { maxTurns: 2 }, deadlineAt: new Date(Date.now() + 60000).toISOString(), ...extra }; }
function context(extra = {}) { return { signal: new AbortController().signal, checkpoint: async () => {}, emit: async () => {}, state: async () => {}, ...extra }; }
async function until(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Fixture did not reach expected state'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function fixture(t, execute) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-desktop-transport-'));
  let dispatches = 0, disposed = 0;
  const server = await startDesktopServer({}, { runtimeRoot: root, harnessHome: root }, { runner: { execute: async (submitted, callbacks) => {
    dispatches++; await callbacks.emit('executor_ready', { executor: 'harness', nativeDesktop: true, modelRequestStarted: false }); return execute(submitted, callbacks);
  }, dispose: async () => { disposed++; } } });
  t.after(async () => { await server.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, server, get dispatches() { return dispatches; }, get disposed() { return disposed; } };
}
async function rawClient(root) {
  const owner = await readDescriptor(root), socket = net.createConnection(endpointFor(owner)), channel = createChannel(socket);
  const [challenge] = await once(channel, 'frame');
  const request = { version: VERSION, clientNonce: randomBytes(32).toString('hex'), operation: 'connect' };
  const reply = once(channel, 'frame');
  await channel.send({ ...request, proof: proof(owner, request, challenge.challenge, 'client') });
  const [message] = await reply;
  assert.equal(equalProof(message.proof, proof(owner, request, challenge.challenge, 'server')), true);
  channel.setLimit(MAX_FRAME_BYTES);
  return { socket, channel, owner };
}
async function fakePeer(t, handler) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-desktop-peer-'));
  await privateDirectory(path.join(root, '.desktop-collaboration'));
  const owner = { version: VERSION, pid: process.pid, endpointId: randomBytes(24).toString('hex'), token: randomBytes(32).toString('hex') };
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    const channel = createChannel(socket), challenge = randomBytes(32).toString('hex');
    handler({ socket, channel, owner, challenge });
    void channel.send({ version: VERSION, challenge });
  });
  await new Promise(resolve => server.listen(endpointFor(owner), resolve));
  await fs.writeFile(descriptorPath(root), JSON.stringify(owner), { mode: 0o600 });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}

test('desktop pipe publishes authenticated status and persists checkpoint before fixture dispatch', windows, async t => {
  let persisted = false, admitted = false;
  const events = [];
  const f = await fixture(t, async (_task, callbacks) => {
    await callbacks.checkpoint({ nativeSessionId: 'collaboration-fixture', nativeStartSeq: 2, nativeDesktop: true });
    assert.equal(persisted, true); admitted = true;
    await callbacks.emit('native_event', { text: 'fixture output' });
    return { summary: 'fixture done', nativeSessionId: 'collaboration-fixture', nativeDesktop: true };
  });
  const status = await desktopBridgeStatus(f.root);
  assert.equal(status.available, true); assert.equal(status.pid, process.pid); assert.equal(f.dispatches, 0);
  assert.deepEqual(Object.keys(status).sort(), ['activeCount', 'available', 'nativeDesktop', 'nativeProtocol', 'pid']);
  const result = await executeOnDesktop(task(), context({
    checkpoint: async data => { await fs.writeFile(path.join(f.root, 'durable-checkpoint.json'), JSON.stringify(data)); persisted = true; },
    emit: async (event, data) => events.push({ event, data }),
  }), { harnessHome: f.root });
  assert.equal(result.summary, 'fixture done'); assert.equal(admitted, true); assert.equal(f.disposed, 0);
  assert.equal(events[0].event, 'executor_ready'); assert.equal(events[1].event, 'native_event');
  await f.server.close(); assert.equal(f.disposed, 1); assert.equal((await desktopBridgeStatus(f.root)).available, false);
});

test('failed durable checkpoint cancels only delegated run and never acknowledges prompt', windows, async t => {
  let admitted = false, cancelled = false;
  const f = await fixture(t, async (_task, callbacks) => {
    callbacks.signal.addEventListener('abort', () => { cancelled = true; }, { once: true });
    await callbacks.checkpoint({ nativeSessionId: 'collaboration-fixture' }); admitted = true;
    return { summary: 'must not happen' };
  });
  await assert.rejects(executeOnDesktop(task(), context({ checkpoint: async () => { throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' }); } }), { harnessHome: f.root }), error => error.code === 'ENOSPC' && !error.dispatchUncertain);
  await until(() => cancelled && f.server.activeCount === 0);
  assert.equal(admitted, false); assert.equal(f.disposed, 0);
  assert.equal((await desktopBridgeStatus(f.root)).available, true);
});

test('one client abort cannot cancel another connection or dispose the desktop runner', windows, async t => {
  const active = new Set(), cancelled = new Set(); let release;
  const f = await fixture(t, async (submitted, callbacks) => {
    await callbacks.checkpoint({ nativeSessionId: `collaboration-${submitted.id}` });
    active.add(submitted.id);
    await new Promise(resolve => {
      if (submitted.id === 'second') release = resolve;
      callbacks.signal.addEventListener('abort', () => { cancelled.add(submitted.id); resolve(); }, { once: true });
    });
    callbacks.signal.throwIfAborted();
    return { summary: 'second completed' };
  });
  const controller = new AbortController();
  const first = executeOnDesktop(task({ id: 'first' }), context({ signal: controller.signal }), { harnessHome: f.root });
  const rejected = assert.rejects(first, { code: 'CANCELLED', state: 'cancelled' });
  const second = executeOnDesktop(task({ id: 'second' }), context(), { harnessHome: f.root });
  await until(() => active.size === 2);
  controller.abort(); await rejected; await until(() => cancelled.has('first'));
  assert.equal(cancelled.has('second'), false); assert.equal(f.disposed, 0);
  release(); assert.equal((await second).summary, 'second completed');
});

test('human input state and known native errors remain definitive responses', windows, async t => {
  const states = [];
  const f = await fixture(t, async (_task, callbacks) => {
    await callbacks.checkpoint({ nativeSessionId: 'collaboration-fixture' });
    await callbacks.state('needs_input', { reason: 'fixture user question' });
    throw Object.assign(new Error('fixture user question'), { code: 'NEEDS_INPUT', state: 'needs_input' });
  });
  await assert.rejects(executeOnDesktop(task(), context({ state: async (...args) => states.push(args) }), { harnessHome: f.root }), error => error.code === 'NEEDS_INPUT' && error.state === 'needs_input' && !error.dispatchUncertain);
  assert.equal(states[0][0], 'needs_input');
});

test('a foreign connection cannot acknowledge or cancel an owned run', windows, async t => {
  let admitted = false, aborted = false;
  const f = await fixture(t, async (_task, callbacks) => {
    callbacks.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    await callbacks.checkpoint({ nativeSessionId: 'collaboration-fixture' });
    assert.equal(aborted, false); admitted = true;
    return { summary: 'owned run completed' };
  });
  const a = await rawClient(f.root), b = await rawClient(f.root), c = await rawClient(f.root);
  t.after(() => { a.socket.destroy(); b.socket.destroy(); c.socket.destroy(); });
  const requestId = randomBytes(24).toString('hex');
  const checkpoint = new Promise(resolve => a.channel.on('frame', message => { if (message.type === 'checkpoint') resolve(message); }));
  await a.channel.send({ type: 'run', requestId, task: task() });
  const point = await checkpoint;
  const bClosed = once(b.channel, 'closed');
  await b.channel.send({ type: 'checkpoint-ack', requestId, checkpointId: point.checkpointId }); await bClosed;
  const cClosed = once(c.channel, 'closed');
  await c.channel.send({ type: 'cancel', requestId }); await cClosed;
  assert.equal(admitted, false); assert.equal(aborted, false);
  const completed = new Promise(resolve => a.channel.on('frame', message => { if (message.type === 'result') resolve(message); }));
  await a.channel.send({ type: 'checkpoint-ack', requestId, checkpointId: point.checkpointId });
  assert.equal((await completed).data.summary, 'owned run completed'); assert.equal(admitted, true);
});

test('server rejects unauthenticated input and over-limit authenticated frames before runner use', windows, async t => {
  const f = await fixture(t, async () => { throw new Error('must never execute'); });
  const owner = await readDescriptor(f.root), socket = net.createConnection(endpointFor(owner));
  socket.on('error', () => {}); const closed = once(socket, 'close');
  socket.resume();
  socket.write(JSON.stringify({ type: 'run', requestId: randomBytes(24).toString('hex'), task: task() }) + '\n');
  await closed; assert.equal(f.dispatches, 0);
  const client = await rawClient(f.root), closedAgain = once(client.channel, 'closed');
  client.socket.write(' '.repeat(MAX_FRAME_BYTES + 1));
  await closedAgain; assert.equal(f.dispatches, 0);
});

test('client refuses spoofed server proof without sending task content or credential', windows, async t => {
  const frames = [];
  const root = await fakePeer(t, ({ channel }) => {
    channel.on('frame', request => {
      frames.push(request);
      void channel.send({ ok: true, proof: '0'.repeat(64) });
    });
  });
  await assert.rejects(executeOnDesktop(task({ goal: 'sensitive fixture content' }), context(), { harnessHome: root }), { code: 'HARNESS_DESKTOP_AUTH_FAILED' });
  assert.equal(frames.length, 1); assert.equal(frames[0].operation, 'connect');
  assert.equal(Object.hasOwn(frames[0], 'token'), false); assert.equal(Object.hasOwn(frames[0], 'task'), false);
  assert.equal(JSON.stringify(frames).includes('sensitive fixture content'), false);
});

test('transport loss after checkpoint acknowledgment is uncertain and never reconnects or replays', windows, async t => {
  let runs = 0, acknowledged = 0;
  const root = await fakePeer(t, ({ socket, channel, owner, challenge }) => {
    channel.on('frame', message => {
      if (message.operation) {
        channel.setLimit(MAX_FRAME_BYTES);
        void channel.send({ ok: true, proof: proof(owner, message, challenge, 'server') });
      } else if (message.type === 'run') {
        runs++;
        void channel.send({ type: 'checkpoint', requestId: message.requestId, checkpointId: 'b'.repeat(48), data: { nativeSessionId: 'collaboration-fixture' } });
      } else if (message.type === 'checkpoint-ack') { acknowledged++; socket.destroy(); }
    });
  });
  await assert.rejects(executeOnDesktop(task(), context(), { harnessHome: root }), error => error.code === 'HARNESS_DESKTOP_DISCONNECTED' && error.dispatchUncertain === true);
  assert.equal(runs, 1); assert.equal(acknowledged, 1);
});

test('private descriptor does not replace a live owner and teardown leaves replacement metadata intact', windows, async t => {
  const f = await fixture(t, async () => ({ summary: 'unused' }));
  await assert.rejects(startDesktopServer({}, { runtimeRoot: f.root, harnessHome: f.root }, { runner: { execute: async () => {}, dispose: async () => {} } }), { code: 'HARNESS_DESKTOP_ALREADY_RUNNING' });
  const replacement = { ...(await readDescriptor(f.root)), endpointId: 'e'.repeat(48) };
  await fs.writeFile(descriptorPath(f.root), JSON.stringify(replacement));
  await f.server.close(); assert.equal((await readDescriptor(f.root)).endpointId, replacement.endpointId);
});

test('desktop adapter rechecks the native version before a live bridge can dispatch', windows, async t => {
  const f = await fixture(t, async () => { throw new Error('unverified version must never dispatch'); });
  const runtime = path.join(f.root, 'runtime'), nativePackage = path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh');
  const sdk = path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh-sdk-app');
  await fs.mkdir(path.join(nativePackage, 'lib'), { recursive: true }); await fs.mkdir(sdk, { recursive: true });
  await fs.writeFile(path.join(nativePackage, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '99.0.0' }));
  await fs.writeFile(path.join(nativePackage, 'lib', 'bin.js'), ''); await fs.writeFile(path.join(sdk, 'cordis.patch.yml'), '');
  const { createHarnessAdapter } = require('../collaboration/adapters/harness.cjs');
  const adapter = createHarnessAdapter({ runtimeRoot: runtime, harnessHome: f.root, nodePath: process.execPath });
  assert.equal((await desktopBridgeStatus(f.root)).available, true);
  await assert.rejects(adapter.execute(task(), context()), { code: 'HARNESS_VERSION_UNVERIFIED' });
  assert.equal(f.dispatches, 0);
  await f.server.close();
  await fs.writeFile(path.join(nativePackage, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.1' }));
  await fs.writeFile(path.join(f.root, '.desktop-owner.json'), JSON.stringify({ pid: process.pid }));
  const description = await adapter.describe();
  assert.equal(description.readiness, 'needs_input'); assert.equal(description.desktopBridge, false);
  assert.match(description.reason, /协作桥尚未就绪/);
  const states = [];
  const blocked = await adapter.execute(task(), context({ state: async state => states.push(state) }));
  assert.deepEqual(states, ['needs_input']); assert.match(blocked.summary, /协作桥尚未就绪/);
});

test('cancellation waits for native cleanup even with an outstanding checkpoint callback', windows, async t => {
  let checkpointReceived = false, cleanupStarted = false, releaseCleanup, settled = false;
  const cleanupGate = new Promise(resolve => { releaseCleanup = resolve; });
  const f = await fixture(t, async (_task, callbacks) => {
    try { await callbacks.checkpoint({ nativeSessionId: 'collaboration-fixture' }); }
    finally { cleanupStarted = true; await cleanupGate; }
    throw new Error('must never reach prompt');
  });
  const controller = new AbortController();
  const operation = executeOnDesktop(task(), context({ signal: controller.signal, checkpoint: async () => { checkpointReceived = true; await new Promise(() => {}); } }), { harnessHome: f.root });
  operation.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(operation, error => error.code === 'CANCELLED' && !error.dispatchUncertain);
  await until(() => checkpointReceived); controller.abort(); await until(() => cleanupStarted);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  releaseCleanup(); await rejected; await until(() => f.server.activeCount === 0);
});

for (const outcome of ['timeout', 'disconnect', 'deadline']) {
  test(`cancel ${outcome} without native terminal acknowledgment stays uncertain`, windows, async t => {
    let checkpointReceived = false, cancelReceived = false;
    const root = await fakePeer(t, ({ socket, channel, owner, challenge }) => {
      channel.on('frame', message => {
        if (message.operation) {
          channel.setLimit(MAX_FRAME_BYTES); void channel.send({ ok: true, proof: proof(owner, message, challenge, 'server') });
        } else if (message.type === 'run') {
          void channel.send({ type: 'checkpoint', requestId: message.requestId, checkpointId: 'd'.repeat(48), data: { nativeSessionId: 'collaboration-fixture' } });
        } else if (message.type === 'cancel') { cancelReceived = true; if (outcome === 'disconnect') socket.destroy(); }
      });
    });
    const controller = new AbortController();
    const operation = executeOnDesktop(task(outcome === 'deadline' ? { deadlineAt: new Date(Date.now() + 200).toISOString() } : {}), context({ signal: controller.signal, checkpoint: async () => { checkpointReceived = true; } }), { harnessHome: root, cancelTimeoutMs: 50 });
    const rejected = assert.rejects(operation, error => error.code === 'HARNESS_DESKTOP_STOP_UNCONFIRMED' && error.state === 'needs_input' && error.dispatchUncertain === true);
    await until(() => checkpointReceived); if (outcome !== 'deadline') controller.abort();
    await rejected; assert.equal(cancelReceived, true);
  });
}

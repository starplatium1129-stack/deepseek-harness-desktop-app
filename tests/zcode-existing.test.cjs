'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CdpPipe, RendererTransport, RendererTaskLease, PersistentRendererHost, selectZCodeMainProcesses, assertExistingWindowAvailable, nativeEnvironment } = require('../collaboration/adapters/zcode-renderer.cjs');
const { createZCodeAdapter } = require('../collaboration/adapters/zcode.cjs');

test('existing mode refuses exclusive lifetime before inspecting or launching a native process', async () => {
  let inspected = false;
  await assert.rejects(assertExistingWindowAvailable('unused', { processInventory: async () => { inspected = true; return []; } }), { code: 'zcode_existing_requires_managed_lifetime' });
  assert.equal(inspected, false);
  let created = false;
  const host = new PersistentRendererHost({ createTransport: () => { created = true; } });
  await assert.rejects(host.acquire('unused', os.tmpdir()), { code: 'zcode_existing_requires_managed_lifetime' });
  assert.equal(created, false);
});

test('an already open unmanaged original ZCode is refused without stopping it', async () => {
  const options = { managedLifetime: true, processInventory: async () => [{ pid: 1234 }] };
  await assert.rejects(assertExistingWindowAvailable('unused', options), { code: 'zcode_existing_app_running' });
  await assertExistingWindowAvailable('unused', options, 1234);
  await assert.rejects(assertExistingWindowAvailable('unused', { ...options, processInventory: async () => [{ pid: 1234 }, { pid: 5678 }] }, 1234), { code: 'zcode_existing_app_running' });
});

test('native CLI and helper descendants without --type do not appear as separate user windows', async () => {
  const nativeTree = [
    { pid: 100, parentPid: 50, chromiumSubprocess: false },
    { pid: 101, parentPid: 100, chromiumSubprocess: true },
    { pid: 102, parentPid: 101, chromiumSubprocess: false }, // windows-helper.js
    { pid: 103, parentPid: 101, chromiumSubprocess: false }, // zcode.cjs app-server
    { pid: 104, parentPid: 103, chromiumSubprocess: false }, // native tool worker
  ];
  assert.deepEqual(selectZCodeMainProcesses(nativeTree), [{ pid: 100 }]);
  const options = { managedLifetime: true, processInventory: async () => selectZCodeMainProcesses(nativeTree) };
  await assertExistingWindowAvailable('unused', options, 100);
  nativeTree.push({ pid: 200, parentPid: 60, chromiumSubprocess: false });
  await assert.rejects(assertExistingWindowAvailable('unused', options, 100), { code: 'zcode_existing_app_running' });
  assert.deepEqual(selectZCodeMainProcesses([{ pid: 300, parentPid: 999, chromiumSubprocess: false }]), [{ pid: 300 }]);
});

test('existing mode preserves all original profile and application environment values', () => {
  const env = { APPDATA: 'native-appdata', ZCODE_DESKTOP_USER_DATA_DIR: 'native-user-data', ZCODE_DESKTOP_SESSION_DATA_DIR: 'native-session-data',
    ZCODE_DESKTOP_APPLICATION_NAME: 'native-name', ZCODE_DATA_BASE_DIR: 'native-data', ELECTRON_RUN_AS_NODE: '1' };
  const result = nativeEnvironment({ profileMode: 'existing', env }, 'controller-only');
  for (const key of ['APPDATA', 'ZCODE_DESKTOP_USER_DATA_DIR', 'ZCODE_DESKTOP_SESSION_DATA_DIR', 'ZCODE_DESKTOP_APPLICATION_NAME', 'ZCODE_DATA_BASE_DIR']) assert.equal(result[key], env[key]);
  assert.equal(result.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(result.ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT, undefined);
});

class FakePersistentTransport extends EventEmitter {
  constructor(options) { super(); this.options = options; this.calls = []; this.live = false; this.nextSession = 1; this.idle = true; }
  hasPersistentResources() { return this.live; }
  async start() { this.calls.push('start'); this.live = true; }
  async prepareExistingTask(workspace, guard) { this.calls.push({ prepare: workspace, guard }); this.options = { ...this.options, workspace, ...guard }; }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'session/create') return { session: { sessionId: `sess-${this.nextSession++}` } };
    if (method === 'session/resume') return { session: { sessionId: params.sessionId } };
    return { accepted: true };
  }
  async operation(method) { this.calls.push(method); return { stopped: this.idle }; }
  async finishExistingTask() { this.calls.push('release-task-subscriptions'); this.options.deadline = undefined; this.options.signal = undefined; }
  write() { throw new Error('No synthetic native responses.'); }
  async close() { if (this.live) throw Object.assign(new Error('Native window remains open.'), { code: 'zcode_existing_window_open' }); this.calls.push('close-controller'); }
  userClosed() { this.live = false; this.calls.push('user-closed-native-window'); this.emit('persistentClosed'); }
}

test('two task leases reuse one host while ordinary task completion never closes the native window', async () => {
  let base, creates = 0;
  const host = new PersistentRendererHost({ managedLifetime: true, createTransport: options => { creates++; return (base = new FakePersistentTransport(options)); } });
  const first = await host.acquire('unused', os.tmpdir(), { deadline: Date.now() + 300000 });
  const session = (await first.request('session/create', {})).session.sessionId;
  await first.request('session/send', { sessionId: session, inputId: 'first', content: 'fixture' });
  await first.close();
  assert.equal(host.hasPersistentResources(), true);
  await assert.rejects(host.close(), { code: 'zcode_existing_window_open' });
  const second = await host.acquire('unused', os.tmpdir(), { nativeSessionId: session, deadline: Date.now() + 300000 });
  await assert.rejects(second.request('session/resume', { sessionId: 'another-task' }), { code: 'invalid_session' });
  await second.request('session/resume', { sessionId: session });
  assert.equal(base.calls.find(item => item.method === 'session/resume').params.requireIdle, true);
  await assert.rejects(second.request('session/send', { sessionId: 'another-task', inputId: 'wrong' }), { code: 'invalid_session' });
  await second.close();
  assert.equal(creates, 1);
  assert.equal(base.calls.filter(item => item === 'start').length, 1);
  assert.equal(base.calls.filter(item => item === 'release-task-subscriptions').length, 2);
  assert.equal(base.calls.includes('close-controller'), false);
  await assert.rejects(first.request('session/read', { sessionId: session }), { code: 'zcode_transport_closed' });
  base.userClosed();
  assert.equal(host.hasPersistentResources(), false);
  await host.close();
  assert.equal(creates, 1); // User exit did not trigger a new process or task replay.
});

test('busy native sessions are not preempted by an existing-mode task', async () => {
  let base;
  const host = new PersistentRendererHost({ managedLifetime: true, createTransport: options => (base = new FakePersistentTransport(options)) });
  const lease = await host.acquire('unused', os.tmpdir(), {});
  const session = (await lease.request('session/create', {})).session.sessionId;
  base.idle = false;
  await assert.rejects(lease.request('session/send', { sessionId: session, inputId: 'new' }), { code: 'zcode_session_busy' });
  await lease.close();
  assert.equal(base.calls.some(item => item.method === 'session/send' || item.method === 'session/stop'), false);
  assert.equal(host.hasPersistentResources(), true);
  base.userClosed(); await host.close();
});

test('a cancelled task releases its lease and reuses the owned host in another workspace with native helpers', async t => {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-existing-cancel-test-'));
  t.after(() => fs.rm(profileDir, { recursive: true, force: true }));
  const oldWorkspace = path.join(profileDir, 'old'), nextWorkspace = path.join(profileDir, 'next');
  const calls = [], abort = new AbortController();
  let base, starts = 0;
  const host = new PersistentRendererHost({ managedLifetime: true,
    processInventory: async () => selectZCodeMainProcesses([
      { pid: 100, parentPid: 50 }, { pid: 101, parentPid: 100, chromiumSubprocess: true },
      { pid: 102, parentPid: 101 }, { pid: 103, parentPid: 102 },
    ]),
    createTransport: options => {
      base = new RendererTransport(options);
      base.start = async () => { starts++; base.profileDir = profileDir; base.child = { pid: 100, exitCode: null, signalCode: null }; base.sessionId = 'owned-cdp'; };
      base.evaluate = async () => ({ ready: true, sameListenerConnection: true });
      base.operation = async (method, params) => {
        calls.push({ method, params });
        if (method === 'session/create') return { session: { sessionId: 'owned-native' } };
        if (method === 'bridge/stopState') return { stopped: true };
        return { accepted: true };
      };
      base.forwardWorkspace = async workspace => {
        await assertExistingWindowAvailable('unused', base.options, base.child.pid);
        calls.push({ forwardWorkspace: workspace, ownedPid: base.child.pid });
      };
      base.bindWorkspaceTarget = async () => { calls.push({ bindWorkspace: base.options.workspace }); };
      return base;
    },
  });
  const first = await host.acquire('unused', oldWorkspace, { deadline: Date.now() + 300000, signal: abort.signal });
  const sessionId = (await first.request('session/create')).session.sessionId;
  await first.request('session/send', { sessionId, inputId: 'cancelled-input' });
  abort.abort();
  await first.close();
  assert.equal(base.stopConfirmed, true); assert.equal(host.hasPersistentResources(), true);
  assert.equal(host.activeLease, undefined); assert.equal(base.options.signal, undefined);
  const second = await host.acquire('unused', nextWorkspace, { deadline: Date.now() + 300000 });
  assert.equal(starts, 1); assert.equal(second.base, first.base);
  assert.equal(base.options.workspace, nextWorkspace);
  assert.deepEqual(calls.find(item => item.forwardWorkspace), { forwardWorkspace: nextWorkspace, ownedPid: 100 });
  assert.equal(calls.filter(item => item.method === 'session/send').length, 1);
  await second.close();
  assert.equal(host.hasPersistentResources(), true); assert.equal(starts, 1);
  assert.equal(calls.some(item => item.method === 'Browser.close'), false);
  base.child.exitCode = 0;
  await base.cleanupExistingExit(); await host.close();
});

test('existing task finish clears only its observation and guard, never browser or process lifetime', async () => {
  const transport = new RendererTransport({ profileMode: 'existing', managedLifetime: true, deadline: Date.now() + 300000, signal: new AbortController().signal });
  transport.child = { pid: 1234, exitCode: null, signalCode: null };
  transport.sendAttempted = true; transport.terminalSeen = true;
  const calls = [];
  transport.cdp = { close: () => calls.push('pipe.close'), request: async method => calls.push(method) };
  transport.operation = async method => { calls.push(method); return {}; };
  transport.release = async () => calls.push('controller-marker-released');
  await transport.finishExistingTask();
  assert.deepEqual(calls, ['bridge/releaseTask']);
  assert.equal(transport.hasPersistentResources(), true);
  assert.equal(transport.options.deadline, undefined); assert.equal(transport.options.signal, undefined);
  await assert.rejects(transport.close(), { code: 'zcode_existing_window_open' });
  assert.deepEqual(calls, ['bridge/releaseTask']);
  transport.child.exitCode = 0;
  await transport.cleanupExistingExit(); await transport.close();
  assert.deepEqual(calls, ['bridge/releaseTask', 'pipe.close', 'controller-marker-released']);
  assert.equal(transport.hasPersistentResources(), false);
});

test('native child exit immediately fails the active lease even when pipe EOF has not arrived', { timeout: 5000 }, async t => {
  // A disposable Node child provides a real ChildProcess exit event. These
  // separate CDP fixture streams deliberately stay open until exit cleanup.
  const child = spawn(process.execPath, ['-e', 'process.stdin.once("data", () => process.exit(0))'], {
    windowsHide: true, shell: false, stdio: ['pipe', 'ignore', 'ignore'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  t.after(() => { if (child.exitCode === null && !child.signalCode) child.kill(); });
  const reader = new PassThrough(), writer = new PassThrough();
  t.after(() => { reader.destroy(); writer.destroy(); });
  let pipeEof = false, cleanup, disconnected;
  reader.on('end', () => { pipeEof = true; });
  const transport = new RendererTransport({ profileMode: 'existing', managedLifetime: true, deadline: Date.now() + 300000 });
  transport.child = child; transport.cdp = new CdpPipe(reader, writer);
  transport.cdp.on('failure', cause => { if (!transport.closed) transport.emit('failure', cause); });
  transport.sendAttempted = true; transport.activeSessionId = 'fixture-session';
  const calls = [];
  transport.release = async () => calls.push('controller-marker-released');
  transport.operation = async method => { calls.push(method); throw new Error('An exited native process must not receive more operations.'); };
  transport.on('persistentClosed', () => calls.push('persistent-closed'));
  const owner = {};
  const lease = new RendererTaskLease(owner, transport, os.tmpdir(), {});
  owner.activeLease = lease;
  lease.on('failure', cause => { calls.push('lease-failed'); disconnected = cause; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => { cleanup = transport.cleanupExistingExit(); resolve(); });
  });
  child.stdin.end('exit');
  await exited;
  assert.equal(pipeEof, false);
  assert.equal(disconnected?.code, 'zcode_renderer_disconnected');
  assert.equal(calls[0], 'lease-failed');
  assert.equal(transport.hasPersistentResources(), false);
  await cleanup;
  await assert.rejects(lease.close(), { code: 'zcode_shutdown_uncertain', dispatchUncertain: true });
  await transport.close();
  assert.deepEqual(calls, ['lease-failed', 'controller-marker-released', 'persistent-closed']);
  assert.equal(owner.activeLease, undefined);
  assert.equal(child.exitCode, 0);
});

test('changing workspace resets only bridge state, forwards the official open command and rebinds PJt', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-existing-switch-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const oldWorkspace = path.join(root, 'old'), newWorkspace = path.join(root, 'new');
  const transport = new RendererTransport({ profileMode: 'existing', managedLifetime: true, workspace: oldWorkspace });
  transport.profileDir = root; transport.sessionId = 'owned-cdp-session'; transport.hasPersistentResources = () => true;
  const calls = [];
  transport.operation = async (method, params) => { calls.push({ method, params }); return {}; };
  transport.forwardWorkspace = async workspace => calls.push({ forwardWorkspace: workspace });
  transport.bindWorkspaceTarget = async () => calls.push({ bindWorkspace: transport.options.workspace });
  await transport.prepareExistingTask(newWorkspace, { deadline: Date.now() + 300000 });
  assert.deepEqual(calls.map(item => item.method || Object.keys(item)[0]), ['bridge/resetWorkspace', 'forwardWorkspace', 'bindWorkspace', 'bridge/beginTask']);
  assert.equal(calls[1].forwardWorkspace, newWorkspace); assert.equal(calls[2].bindWorkspace, newWorkspace);
});

test('existing-mode recovery never starts a user window or resumes another persisted task', async () => {
  let started = false;
  const adapter = createZCodeAdapter({ profileMode: 'existing', managedLifetime: true, transportFactory: () => { started = true; } });
  const value = await adapter.recover({ nativeSessionId: 'old-task-session', workspace: os.tmpdir() });
  assert.equal(value.state, 'unknown'); assert.equal(started, false); assert.equal(adapter.hasPersistentResources(), false);
});

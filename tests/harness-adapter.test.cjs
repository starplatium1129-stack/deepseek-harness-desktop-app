const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createHarnessAdapter, buildPatch } = require('../collaboration/adapters/harness.cjs');
const { modelSelection, summarize, allowedTools, resumeOwnershipFailure } = require('../collaboration/harness-worker.cjs');

function task(extra = {}) {
  return { id: 'task-test', goal: 'Read a file.', workspace: path.resolve(__dirname), acceptance: ['Report the actual result.'], context: [], permission: 'read-only', deadlineAt: new Date(Date.now() + 60000).toISOString(), budget: { maxTurns: 2 }, ...extra };
}
function context(extra = {}) { return { signal: new AbortController().signal, emit: async () => {}, checkpoint: async () => {}, state: async () => {}, ...extra }; }
async function fakeRuntime(t, handler) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-adapter-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const entry = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  const sdk = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-sdk-app', 'cordis.patch.yml');
  await fs.mkdir(path.dirname(entry), { recursive: true }); await fs.writeFile(entry, '');
  const manifest = path.join(path.dirname(path.dirname(entry)), 'package.json');
  await fs.writeFile(manifest, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.1' }));
  await fs.mkdir(path.dirname(sdk), { recursive: true }); await fs.writeFile(sdk, '');
  const captured = {};
  const adapter = createHarnessAdapter({ runtimeRoot: root, nodePath: process.execPath, harnessHome: root, startupTimeoutMs: 500, shutdownTimeoutMs: 10,
    spawn: (command, args, options) => {
      Object.assign(captured, { command, args, options });
      const child = captured.child = new EventEmitter();
      Object.assign(child, { exitCode: null, signalCode: null, connected: true, pid: 123 });
      child.send = (message, callback) => {
        callback?.();
        if (message.type === 'shutdown') { child.exitCode = 0; child.connected = false; queueMicrotask(() => child.emit('exit', 0)); }
        else handler?.(message, child);
      };
      setImmediate(() => child.emit('message', { type: 'ready', data: { provider: 'native', model: 'saved-model' } }));
      return child;
    },
  });
  return { adapter, captured, manifest };
}

test('describe and execute refuse an unverified native package version before spawning', async t => {
  const { adapter, captured, manifest } = await fakeRuntime(t);
  const known = await adapter.describe(); assert.equal(known.available, true); assert.equal(known.nativeVersion, '0.1.5-rc.1');
  await fs.writeFile(manifest, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0' }));
  const unknown = await adapter.describe();
  assert.equal(unknown.available, false); assert.match(unknown.reason, /尚未通过协作兼容性验证/); assert.equal(unknown.nativeVersion, '0.2.0');
  await assert.rejects(adapter.execute(task(), context()), { code: 'HARNESS_VERSION_UNVERIFIED' });
  assert.equal(captured.child, undefined);
});

test('Harness refuses implicit elevated permissions and unbounded steps before spawning', async () => {
  const adapter = createHarnessAdapter();
  await assert.rejects(adapter.execute(task({ permission: 'danger-full-access' }), context()), { code: 'INVALID_PERMISSION' });
  await assert.rejects(adapter.execute(task({ budget: { maxTurns: null } }), context()), { code: 'INVALID_BUDGET' });
  await assert.rejects(adapter.execute(task({ nativeSessionId: '../../user-session' }), context()), { code: 'INVALID_SESSION' });
});
test('overlay pins sandbox, ask policy and disables unbudgeted delegation', () => {
  const patch = buildPatch('runtime', 'read-only', 'workspace');
  assert.equal(patch.find(row => row.id === 'sandbox-policy').config.mode, 'read-only');
  assert.deepEqual(patch.find(row => row.id === 'approval').config, { policy: 'ask' });
  assert.ok(patch.find(row => row.id === 'subagent').disabled);
  assert.ok(patch.find(row => row.id === 'workflow-worker-thread').disabled);
  assert.ok(patch.find(row => row.id === 'session-title-llm').disabled);
  assert.deepEqual(Object.keys(patch.find(row => row.id === 'permission').config.presets), ['read-only', 'workspace-write']);
});
test('native tool whitelist excludes shell, background work, web and custom MCP in both permission modes', () => {
  assert.deepEqual(allowedTools('read-only'), ['read', 'glob', 'grep', 'read_image', 'ask_user_question']);
  assert.deepEqual(allowedTools('workspace-write'), ['read', 'glob', 'grep', 'read_image', 'ask_user_question', 'edit', 'write']);
  for (const permission of ['read-only', 'workspace-write']) for (const tool of ['pwsh', 'bash', 'job_list', 'job_kill', 'web_fetch', 'skill', 'mcp__collaboration__submit_task']) assert.equal(allowedTools(permission).includes(tool), false);
});
test('native session checkpoint is durable before prompt acknowledgement', async t => {
  let persisted = false;
  const { adapter, captured } = await fakeRuntime(t, (message, child) => {
    if (message.type === 'run') child.emit('message', { type: 'checkpoint', data: { nativeSessionId: 'collaboration-test', nativeStartSeq: 3 } });
    if (message.type === 'checkpoint-ack') {
      assert.equal(persisted, true);
      child.emit('message', { type: 'result', data: { summary: 'Done', nativeSessionId: 'collaboration-test' } });
    }
  });
  const result = await adapter.execute(task(), context({ checkpoint: async () => { await new Promise(resolve => setImmediate(resolve)); persisted = true; } }));
  assert.equal(result.nativeSessionId, 'collaboration-test');
  assert.equal(captured.options.windowsHide, true);
  assert.equal(captured.options.env.DSH_PERMISSION_MODE, 'read-only');
  assert.equal(captured.child.exitCode, 0);
});
test('approval reaches needs_approval and has no automatic grant path', async t => {
  const received = [], states = [];
  const { adapter } = await fakeRuntime(t, (message, child) => {
    received.push(message.type);
    if (message.type === 'run') {
      child.emit('message', { type: 'state', state: 'needs_approval', data: { toolName: 'pwsh', reason: 'outside workspace' } });
      child.emit('message', { type: 'result', data: { summary: 'Needs approval', nativeSessionId: 'collaboration-test' } });
    }
  });
  await assert.rejects(adapter.execute(task(), context({ state: async state => states.push(state) })), { code: 'NEEDS_APPROVAL', state: 'needs_approval' });
  assert.deepEqual(states, ['needs_approval']);
  assert.deepEqual(received, ['run']);
});
test('abort stops only the owned worker and recovery remains unknown', async t => {
  const controller = new AbortController();
  const { adapter, captured } = await fakeRuntime(t, message => { if (message.type === 'run') controller.abort(); });
  await assert.rejects(adapter.execute(task(), context({ signal: controller.signal })), { code: 'CANCELLED' });
  assert.equal(captured.child.exitCode, 0);
  assert.equal((await adapter.recover(task())).state, 'unknown');
});
test('a failed durable checkpoint prevents any prompt acknowledgement', async t => {
  let acknowledged = false;
  const { adapter } = await fakeRuntime(t, (message, child) => {
    if (message.type === 'run') child.emit('message', { type: 'checkpoint', data: { nativeSessionId: 'collaboration-test' } });
    if (message.type === 'checkpoint-ack') acknowledged = true;
  });
  await assert.rejects(adapter.execute(task(), context({ checkpoint: async () => { throw new Error('disk full'); } })), /disk full/);
  assert.equal(acknowledged, false);
});
test('transport exit after prompt admission is uncertain, while exit before admission is not', async t => {
  for (const admitted of [false, true]) {
    const { adapter } = await fakeRuntime(t, (message, child) => {
      if (message.type === 'run' && admitted) child.emit('message', { type: 'checkpoint', data: { nativeSessionId: 'collaboration-test' } });
      if ((!admitted && message.type === 'run') || message.type === 'checkpoint-ack') { child.exitCode = 1; child.connected = false; child.emit('exit', 1); }
    });
    await assert.rejects(adapter.execute(task(), context()), error => { assert.equal(error.code, 'HARNESS_EXITED'); assert.equal(error.dispatchUncertain === true, admitted); return true; });
  }
});
test('IPC disconnect after prompt acknowledgement is uncertain', async t => {
  const { adapter } = await fakeRuntime(t, (message, child) => {
    if (message.type === 'run') child.emit('message', { type: 'checkpoint', data: { nativeSessionId: 'collaboration-test' } });
    if (message.type === 'checkpoint-ack') { child.connected = false; child.exitCode = 1; child.emit('disconnect'); }
  });
  await assert.rejects(adapter.execute(task(), context()), { code: 'HARNESS_IPC_FAILED', dispatchUncertain: true });
});
test('explicit native budget and credential failures do not become uncertain after dispatch', async t => {
  for (const code of ['BUDGET_EXCEEDED', 'MISSING_CREDENTIAL']) {
    const { adapter } = await fakeRuntime(t, (message, child) => {
      if (message.type === 'run') child.emit('message', { type: 'checkpoint', data: { nativeSessionId: 'collaboration-test' } });
      if (message.type === 'checkpoint-ack') child.emit('message', { type: 'error', code, message: code });
    });
    await assert.rejects(adapter.execute(task(), context()), error => { assert.equal(error.code, code); assert.equal(error.dispatchUncertain, undefined); return true; });
  }
});
test('explicit abort after native prompt admission stays cancelled', async t => {
  const controller = new AbortController();
  const { adapter } = await fakeRuntime(t, (message, child) => {
    if (message.type === 'run') child.emit('message', { type: 'checkpoint', data: { nativeSessionId: 'collaboration-test' } });
    if (message.type === 'checkpoint-ack') controller.abort();
  });
  await assert.rejects(adapter.execute(task(), context({ signal: controller.signal })), error => { assert.equal(error.code, 'CANCELLED'); assert.equal(error.dispatchUncertain, undefined); return true; });
});
test('saved provider route and final durable assistant message are preserved', () => {
  const current = { provider: 'saved', model: 'current', reasoningEffort: 'high' };
  assert.deepEqual(modelSelection(current), current);
  assert.deepEqual(modelSelection(current, 'custom/model/v2'), { provider: 'custom', model: 'model/v2' });
  const events = [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'old' }] } } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'new' }] } } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } }];
  assert.deepEqual(summarize({ seq: events.length, eventAt: index => events[index] }, 1), { summary: 'new', reason: { kind: 'completed' } });
});
test('native resume ownership conflict needs an explicit handoff before any prompt', async t => {
  const nativeSessionId = 'collaboration-owned';
  const failure = resumeOwnershipFailure({ name: 'SessionAlreadyOwnedError', sessionId: nativeSessionId }, nativeSessionId);
  assert.equal(failure.code, 'HARNESS_SESSION_OWNED');
  assert.equal(resumeOwnershipFailure({ name: 'SessionAlreadyOwnedError', sessionId: 'collaboration-unrelated' }, nativeSessionId), undefined);
  assert.equal(resumeOwnershipFailure(new Error('already owned by an active write handle'), nativeSessionId), undefined);
  const received = [], states = [];
  const { adapter } = await fakeRuntime(t, (message, child) => {
    received.push(message.type);
    if (message.type === 'run') {
      child.emit('message', { type: 'state', state: 'needs_input', data: { nativeSessionId, code: failure.code, promptDispatched: false } });
      child.emit('message', { type: 'error', ...failure });
    }
  });
  await assert.rejects(adapter.execute(task({ nativeSessionId }), context({ state: async (state, data) => states.push({ state, data }) })), error => {
    assert.equal(error.code, 'HARNESS_SESSION_OWNED'); assert.equal(error.state, 'needs_input'); assert.equal(error.dispatchUncertain, undefined); return true;
  });
  assert.deepEqual(received, ['run']);
  assert.deepEqual(states, [{ state: 'needs_input', data: { nativeSessionId, code: 'HARNESS_SESSION_OWNED', promptDispatched: false } }]);
});

const bundledNode = path.resolve(__dirname, '..', 'runtime', 'node', process.platform === 'win32' ? 'node.exe' : 'node');
const nativeRuntime = path.resolve(__dirname, '..', 'runtime', 'harness');
test('bundled native runtime boots and reports missing credentials without sending a model request', { skip: !existsSync(bundledNode) || !existsSync(nativeRuntime), timeout: 45000 }, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-native-noauth-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const workspace = path.join(home, 'workspace'); await fs.mkdir(workspace);
  const adapter = createHarnessAdapter({ nodePath: bundledNode, runtimeRoot: nativeRuntime, harnessHome: home, probe: true, extraEnv: { DEEPSEEK_API_KEY: '' } });
  const description = await adapter.describe();
  assert.equal(description.available, true, description.reason);
  assert.equal(description.native.modelRequestStarted, false);
  let nativeId;
  await assert.rejects(adapter.execute(task({ workspace, budget: { maxTurns: 1 }, goal: 'Reply OK without tools.' }), context({ checkpoint: async value => { nativeId = value.nativeSessionId; } })), { code: 'MISSING_CREDENTIAL' });
  assert.match(nativeId, /^collaboration-/);
});

test('native cancellation at durable checkpoint exits the owned worker before any model turn', { skip: !existsSync(bundledNode) || !existsSync(nativeRuntime), timeout: 45000 }, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-native-cancel-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const workspace = path.join(home, 'workspace'); await fs.mkdir(workspace);
  const controller = new AbortController(); let child, nativeId, assistantEvents = 0, turns = 0;
  const adapter = createHarnessAdapter({ nodePath: bundledNode, runtimeRoot: nativeRuntime, harnessHome: home, extraEnv: { DEEPSEEK_API_KEY: '' }, spawn: (...args) => (child = require('node:child_process').spawn(...args)) });
  await assert.rejects(adapter.execute(task({ workspace }), context({ signal: controller.signal,
    checkpoint: async value => { nativeId = value.nativeSessionId; await fs.writeFile(path.join(home, 'checkpoint.json'), JSON.stringify(value)); controller.abort(); },
    emit: async (type, data) => { if (type === 'native_event' && data.event.type === 'assistant/message') assistantEvents++; if (type === 'native_event' && data.event.type === 'turn/start') turns++; },
  })), { code: 'CANCELLED' });
  assert.match(nativeId, /^collaboration-/);
  assert.equal(assistantEvents, 0); assert.equal(turns, 0);
  assert.equal(child.exitCode, 0);
});

test('native external write ownership blocks resume and normal owner shutdown permits it without model calls', { skip: !existsSync(bundledNode) || !existsSync(nativeRuntime), timeout: 60000 }, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-native-ownership-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const workspace = path.join(home, 'workspace'); await fs.mkdir(workspace);
  const children = [], states = [], observed = { turns: 0, assistants: 0 };
  const adapter = createHarnessAdapter({ nodePath: bundledNode, runtimeRoot: nativeRuntime, harnessHome: home, extraEnv: { DEEPSEEK_API_KEY: '' }, spawn: (...args) => {
    const child = require('node:child_process').spawn(...args); children.push(child); return child;
  } });
  const observe = async (type, data) => {
    if (type !== 'native_event') return;
    if (data.event.type === 'turn/start') observed.turns++;
    if (data.event.type === 'assistant/message') observed.assistants++;
  };
  const ownerController = new AbortController();
  let published, releaseCheckpoint, nativeSessionId;
  const ready = new Promise(resolve => { published = resolve; });
  const held = new Promise(resolve => { releaseCheckpoint = resolve; });
  // The first real SDK worker owns the durable session but cannot dispatch a
  // prompt while its checkpoint awaits this fixture's explicit release.
  const ownerResult = adapter.execute(task({ id: 'task-owner', workspace }), context({ signal: ownerController.signal, emit: observe, checkpoint: async value => {
    nativeSessionId = value.nativeSessionId; published(); await held;
  } })).then(() => new Error('Owner unexpectedly completed.'), error => error);
  try {
    await Promise.race([ready, ownerResult.then(error => { throw error; })]);
    await assert.rejects(adapter.execute(task({ id: 'task-contender', workspace, nativeSessionId }), context({ emit: observe,
      checkpoint: async () => { throw new Error('A competing writer must not reach prompt admission.'); },
      state: async (state, data) => states.push({ state, data }),
    })), error => {
      assert.equal(error.code, 'HARNESS_SESSION_OWNED'); assert.equal(error.state, 'needs_input'); assert.equal(error.dispatchUncertain, undefined); return true;
    });
    assert.equal(states.length, 1);
    assert.equal(states[0].state, 'needs_input');
    assert.equal(states[0].data.nativeSessionId, nativeSessionId);
    assert.equal(states[0].data.promptDispatched, false);
    assert.equal(children[0].exitCode, null, 'The contender must preserve the live owner.');
  } finally {
    ownerController.abort(); releaseCheckpoint();
    assert.equal((await ownerResult).code, 'CANCELLED');
  }
  assert.equal(children[0].exitCode, 0);
  const resumedController = new AbortController(); let resumedId;
  await assert.rejects(adapter.execute(task({ id: 'task-resumed', workspace, nativeSessionId }), context({ signal: resumedController.signal, emit: observe,
    checkpoint: async value => { resumedId = value.nativeSessionId; resumedController.abort(); },
  })), { code: 'CANCELLED' });
  assert.equal(resumedId, nativeSessionId, 'Normal owner shutdown must release the same durable session for resume.');
  assert.deepEqual(observed, { turns: 0, assistants: 0 });
  assert.equal(children.length, 3);
  for (const child of children) assert.equal(child.exitCode, 0);
});

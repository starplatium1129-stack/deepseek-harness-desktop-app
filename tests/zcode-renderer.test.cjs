'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { CdpPipe, RendererTransport, rendererBootstrap, rendererOperation, acquireProfile } = require('../collaboration/adapters/zcode-renderer.cjs');

test('private CDP pipe frames fragmented null-terminated responses and rejects malformed frames', async () => {
  const reader = new PassThrough(), writer = new PassThrough();
  const pipe = new CdpPipe(reader, writer); const failures = [];
  pipe.on('failure', e => failures.push(e.code));
  let request; writer.once('data', data => { request = JSON.parse(data.toString().slice(0, -1)); });
  const result = pipe.request('Target.getTargets');
  reader.write('{"id":' + request.id + ',"result":'); reader.write('{"targetInfos":[]}}\0');
  assert.deepEqual(await result, { targetInfos: [] });
  reader.write('not-json\0');
  assert.deepEqual(failures, ['zcode_renderer_protocol']);
  assert.equal(pipe.closed, true);
});

test('CDP request timeouts are not retried and closure rejects pending calls', async () => {
  const reader = new PassThrough(), writer = new PassThrough();
  const pipe = new CdpPipe(reader, writer); pipe.on('failure', () => {});
  let sends = 0; writer.on('data', () => sends++);
  await assert.rejects(pipe.request('Runtime.evaluate', {}, undefined, 5), { code: 'zcode_renderer_timeout' });
  assert.equal(sends, 1);
  const pending = pipe.request('Target.getTargets'); pipe.close();
  await assert.rejects(pending, { code: 'zcode_renderer_disconnected' });
});

test('a persistent collaboration profile is exclusive and release preserves its data', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-profile-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'profile-fixture'), 'keep-native-browser-data');
  const release = await acquireProfile(root);
  await assert.rejects(acquireProfile(root), { code: 'zcode_profile_busy' });
  await release();
  const second = await acquireProfile(root); await second();
  assert.equal(await fs.readFile(path.join(root, 'profile-fixture'), 'utf8'), 'keep-native-browser-data');
});

test('stale profile recovery is exclusive and a surviving owned child prevents takeover', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-profile-race-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
  const stalePid = child.pid; await new Promise(resolve => child.once('exit', resolve));
  const file = path.join(root, 'collaboration-owner.json');
  await fs.writeFile(file, JSON.stringify({ pid: stalePid, nonce: 'stale', phase: 'reserved' }));
  const attempts = await Promise.allSettled([acquireProfile(root), acquireProfile(root)]);
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(item => item.status === 'rejected').reason.code, 'zcode_profile_busy');
  await attempts.find(item => item.status === 'fulfilled').value();
  await fs.writeFile(file, JSON.stringify({ pid: stalePid, nonce: 'orphan-owner', childPid: process.pid, phase: 'running' }));
  await assert.rejects(acquireProfile(root), { code: 'zcode_profile_busy' });
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).nonce, 'orphan-owner');
});

function bootstrapContext({ listener = true, workspace = '/owned', nearest = true } = {}) {
  const globalServices = { zcodeAgentService: {}, zcodeSessionService: {} };
  const scopedServices = { zcodeAgentService: {}, zcodeSessionService: {} };
  const provider = { memoizedProps: { value: nearest ? scopedServices : null }, return: { memoizedProps: { services: globalServices } } };
  const fiber = { type: { name: listener ? 'PJt' : 'DifferentComponent' }, memoizedProps: { workspacePath: workspace }, return: provider };
  const root = { '__reactContainer$fixture': { child: fiber } };
  const window = {};
  const context = vm.createContext({ window, document: { querySelector: () => root }, localStorage: { getItem: key => {
    assert.equal(key, 'zcode-v4-client-id:v1'); return 'native-stable-client';
  } } });
  return { context, window, scopedServices, globalServices };
}

test('renderer bootstrap requires the real workspace verification listener and its nearest service provider', () => {
  const fixture = bootstrapContext();
  const result = vm.runInContext(`(${rendererBootstrap.toString()})('/owned')`, fixture.context);
  assert.equal(result.ready, true);
  assert.equal(fixture.window.__deepseekZCodeRenderer.services, fixture.scopedServices);
  assert.notEqual(fixture.window.__deepseekZCodeRenderer.services, fixture.globalServices);
  const missing = bootstrapContext({ listener: false });
  assert.equal(vm.runInContext(`(${rendererBootstrap.toString()})('/owned')`, missing.context).ready, false);
  const other = bootstrapContext({ workspace: '/other' });
  assert.equal(vm.runInContext(`(${rendererBootstrap.toString()})('/owned')`, other.context).ready, false);
});

function operationFixture({ preferredModel = 'native/model', draftModel, thoughtLevel, selectedKeys = {}, runtimeModel = {} } = {}) {
  const requests = []; let eventListener, workspaceVerificationListener;
  const value = { session: { sessionId: 'sess_owned' }, settings: { mode: { current: 'build' }, model: { current: { providerId: 'native', modelId: 'model' } } }, runtime: { eventSeq: 4 } };
  const sessions = { createSession: async params => { requests.push({ method: 'createSession', params }); value.settings.model.current = params.model; return value; }, readSession: async () => value,
    setModel: async params => { requests.push({ method: 'setModel', params }); value.settings.model.current = params.model; return value; },
    resolveRuntimeModelForV4: async params => { requests.push({ method: 'resolveRuntimeModel', params }); return runtimeModel; },
    closeDeferredDraftSession: async params => requests.push({ method: 'closeDeferred', params }),
    promoteDeferredDraftSession: async params => requests.push({ method: 'promote', params }) };
  const agent = {
    helloConversationV4: async () => ({ protocolVersion: 3, connectionId: 'native-connection', clientMode: 'desktop-continuous', capabilities: { binaryFrames: false }, auth: { userId: 'private-user-not-returned' } }),
    initializeConversationV4: async params => requests.push({ method: 'initialize', params }),
    onDynamicWorkspaceProviderRuntimeHeadersRequest: params => callback => { workspaceVerificationListener = callback; requests.push({ method: 'observe-verification', params }); return { dispose() {} }; },
    onDynamicSessionEvent: () => callback => { eventListener = callback; return { dispose() {} }; },
    subscribeConversationV4: async params => requests.push({ method: 'subscribe', params }),
    sendConversationCommandV4: async params => {
      requests.push({ method: 'command', params });
      eventListener({ type: 'session.event', event: { sessionId: 'sess_owned', seq: 5, type: 'turn.started', payload: { inputId: 'different-native-input' } } });
      eventListener({ type: 'session.event', event: { sessionId: 'sess_owned', seq: 6, type: 'turn.completed', payload: { inputId: 'different-native-input', resultType: 'success', response: 'Native success', runtimeModel: { apiKey: 'must-not-return' } } } });
      return { status: 'accepted', result: { type: 'inputAccepted', inputId: 'different-native-input' } };
    },
  };
  const preferences = {
    h: { getState: () => ({ getWorkspaceState: (workspace, identity) => {
      requests.push({ method: 'draftPreference', params: { workspace, identity } });
      return { draftPreferredModel: draftModel, draftPreferredThoughtLevel: thoughtLevel };
    } }) },
    E: (provider, workspace, identity) => { requests.push({ method: 'savedPreference', params: { provider, workspace, identity } }); return preferredModel ? { model: preferredModel, thoughtLevel } : null; },
    O: text => text.startsWith('custom:') ? { providerId: 'builtin:zai-start-plan', modelName: text.slice('custom:builtin:zai-start-plan:'.length) } : null,
  };
  const window = { __deepseekZCodeRenderer: { modelPreferences: preferences, services: { zcodeAgentService: agent, zcodeSessionService: sessions,
    settingService: { get: async () => ({ modelProviderFamilySelectedKeys: selectedKeys, unrelatedPrivateSetting: 'never-return-settings' }) } }, workspace: '/owned', clientId: 'native-stable-client', sessions: new Set(), events: [], subscriptions: new Map(), inputMap: new Map(), heldEvents: [], sending: false } };
  const document = { querySelectorAll: () => [] };
  const context = vm.createContext({ window, document, getComputedStyle: e => e.style });
  const run = (method, params = {}) => vm.runInContext(`(${rendererOperation.toString()})(${JSON.stringify({ method, params })})`, context);
  return { run, requests, window, document, signalVerification: request => workspaceVerificationListener(request) };
}

test('new native sessions use the saved UI model and pass the native runtime model opaquely', async () => {
  const runtimeModel = Object.defineProperties({}, {
    provider: { get() { throw new Error('Opaque provider data must not be inspected.'); } },
    toJSON: { value() { throw new Error('Opaque runtime model must not be serialized.'); } },
  });
  const selectedKeys = { zai: 'coding-plan:builtin:zai-start-plan' };
  const fixture = operationFixture({ preferredModel: 'builtin:zai-start-plan/GLM-5.3-Flash', thoughtLevel: 'high', selectedKeys, runtimeModel });
  fixture.window.__deepseekZCodeRenderer.workspaceIdentity = 'owned-workspace-identity';
  const result = await fixture.run('session/create', { mode: 'build', toolAllowlist: ['Read', 'Edit'], toolDenylist: ['Bash'] });
  const resolved = fixture.requests.find(item => item.method === 'resolveRuntimeModel').params;
  const created = fixture.requests.find(item => item.method === 'createSession').params;
  assert.equal(resolved.model.providerId, 'builtin:zai-start-plan'); assert.equal(resolved.model.modelId, 'GLM-5.3-Flash');
  assert.equal(resolved.workspaceIdentity, 'owned-workspace-identity'); assert.equal(resolved.thoughtLevel, 'high');
  assert.equal(resolved.modelProviderFamilySelectedKeys, selectedKeys);
  assert.equal(created.runtimeModel, runtimeModel); assert.equal(created.modelProviderFamilySelectedKeys, selectedKeys);
  assert.equal(created.model, resolved.model); assert.equal(created.persistence, 'deferred');
  assert.deepEqual(Array.from(created.toolAllowlist), ['Read', 'Edit']); assert.deepEqual(Array.from(created.toolDenylist), ['Bash']);
  assert.equal(result.settings.model.current.modelId, 'GLM-5.3-Flash');
  assert.equal(JSON.stringify(result).includes('runtimeModel'), false);
  assert.equal(JSON.stringify(result).includes('never-return-settings'), false);
  assert.equal(fixture.requests.some(item => item.method === 'command'), false);
});

test('workspace UI draft preference takes priority and explicit model overrides UI preferences', async () => {
  const fixture = operationFixture({ preferredModel: 'native/saved', draftModel: 'custom:builtin:zai-start-plan:GLM-5.3-Flash' });
  await fixture.run('session/create', { mode: 'build' });
  assert.equal(fixture.requests.find(item => item.method === 'createSession').params.model.modelId, 'GLM-5.3-Flash');
  assert.equal(fixture.requests.some(item => item.method === 'savedPreference'), false);
  const explicit = operationFixture({ preferredModel: 'native/saved', draftModel: 'native/draft' });
  await explicit.run('session/create', { mode: 'build', model: { providerId: 'builtin:zai-start-plan', modelId: 'GLM-5.3-Flash' } });
  assert.equal(explicit.requests.find(item => item.method === 'createSession').params.model.modelId, 'GLM-5.3-Flash');
  assert.equal(explicit.requests.some(item => item.method === 'savedPreference' || item.method === 'draftPreference'), false);
});

test('an absent UI preference never silently selects the first registry model', async () => {
  const fixture = operationFixture({ preferredModel: null });
  await assert.rejects(fixture.run('session/create', { mode: 'build' }), /no explicit native model preference/);
  assert.equal(fixture.requests.some(item => ['resolveRuntimeModel', 'createSession', 'command'].includes(item.method)), false);
});

test('a native model fallback is rejected and its deferred draft is closed before dispatch', async () => {
  const fixture = operationFixture({ preferredModel: 'builtin:zai-start-plan/GLM-5.3-Flash' });
  fixture.window.__deepseekZCodeRenderer.services.zcodeSessionService.createSession = async () => ({
    session: { sessionId: 'wrong-model-draft' }, settings: { model: { current: { providerId: 'builtin:zai-start-plan', modelId: 'GLM-5.3' } } },
  });
  await assert.rejects(fixture.run('session/create', { mode: 'build' }), /different provider or model/);
  assert.equal(fixture.requests.find(item => item.method === 'closeDeferred').params.sessionId, 'wrong-model-draft');
  assert.equal(fixture.window.__deepseekZCodeRenderer.sessions.size, 0);
  assert.equal(fixture.requests.some(item => item.method === 'command'), false);
});

test('explicit model changes resolve inside the renderer for only the owned session', async () => {
  const runtimeModel = { nativeOpaqueValue: 'never-return-runtime' }, selectedKeys = { zai: 'coding-plan:builtin:zai-start-plan' };
  const fixture = operationFixture({ runtimeModel, selectedKeys });
  await fixture.run('session/create', { mode: 'build' });
  const result = await fixture.run('session/setModel', { sessionId: 'sess_owned', model: { providerId: 'builtin:zai-start-plan', modelId: 'GLM-5.3-Flash' } });
  const resolved = fixture.requests.filter(item => item.method === 'resolveRuntimeModel').at(-1).params;
  const changed = fixture.requests.find(item => item.method === 'setModel').params;
  assert.equal(resolved.sessionId, 'sess_owned'); assert.equal(changed.runtimeModel, runtimeModel);
  assert.equal(changed.modelProviderFamilySelectedKeys, selectedKeys); assert.equal(result.settings.model.current.modelId, 'GLM-5.3-Flash');
  assert.equal(JSON.stringify(result).includes('never-return-runtime'), false);
  const calls = fixture.requests.length;
  await assert.rejects(fixture.run('session/setModel', { sessionId: 'unowned', model: { providerId: 'other', modelId: 'model' } }), /outside/);
  assert.equal(fixture.requests.length, calls);
});

test('V4 preserves native client identity and buffers early events until accepted input mapping is known', async () => {
  const fixture = operationFixture();
  const hello = await fixture.run('bridge/initialize');
  assert.equal(hello.connectionId, 'native-connection'); assert.equal(JSON.stringify(hello).includes('private-user'), false);
  assert.equal(fixture.requests[0].params.clientId, 'native-stable-client');
  await fixture.run('session/create', { mode: 'build', toolAllowlist: ['Read', 'Write'], toolDenylist: ['Bash'] });
  assert.equal(fixture.requests.find(item => item.method === 'createSession').params.persistence, 'deferred');
  assert.equal(fixture.requests.some(item => item.method === 'promote'), false);
  await fixture.run('session/subscribe', { sessionId: 'sess_owned' });
  assert.equal(fixture.requests.some(item => item.method === 'subscribe'), false);
  const sent = await fixture.run('session/send', { sessionId: 'sess_owned', inputId: 'external-input', content: 'Finite fixture task.', toolDenylist: ['Bash'] });
  assert.equal(sent.accepted, true);
  const command = fixture.requests.find(item => item.method === 'command').params;
  assert.equal(command.envelope.type, 'sendText');
  assert.deepEqual(Array.from(command.envelope.payload.toolDisallowlist), ['Bash']);
  assert.equal(command.envelope.payload.runtimeProviderHeaders, undefined);
  assert.ok(fixture.requests.findIndex(item => item.method === 'promote') > fixture.requests.findIndex(item => item.method === 'command'));
  const polled = await fixture.run('bridge/poll');
  assert.equal(polled.events[0].params.payload.inputId, 'external-input');
  assert.equal(polled.events[0].params.payload.nativeInputId, 'different-native-input');
  assert.equal(polled.events[1].params.payload.response, 'Native success');
  assert.equal(JSON.stringify(polled).includes('must-not-return'), false);
  await assert.rejects(fixture.run('session/send', { sessionId: 'unowned', inputId: 'other', content: 'must not send' }), /outside/);
});

test('an accepted V4 ACK without authoritative input ID is not guessed or retried', async () => {
  const fixture = operationFixture();
  await fixture.run('session/create', { mode: 'build' });
  let sends = 0;
  fixture.window.__deepseekZCodeRenderer.services.zcodeAgentService.sendConversationCommandV4 = async () => { sends++; return { status: 'accepted', result: { type: 'inputDisposition', delivery: 'started' } }; };
  const result = await fixture.run('session/send', { sessionId: 'sess_owned', inputId: 'external', content: 'test' });
  assert.equal(result.accepted, false);
  assert.match(result.nativeAck.message, /dispatch is uncertain/);
  assert.equal(sends, 1);
  assert.equal(fixture.window.__deepseekZCodeRenderer.inputMap.size, 0);
});

test('failed native ACK retains only safe error details and pre-ACK event diagnostics', async () => {
  const fixture = operationFixture();
  await fixture.run('session/create', { mode: 'build' });
  fixture.window.__deepseekZCodeRenderer.heldEvents.push({ sessionId: 'sess_owned', type: 'turn.failed', seq: 9,
    payload: { error: { code: 'foreign_key', message: 'FOREIGN KEY constraint failed' }, runtimeProviderHeaders: { authorization: 'never-forward' } } });
  fixture.window.__deepseekZCodeRenderer.services.zcodeAgentService.sendConversationCommandV4 = async () => ({
    commandId: 'external', status: 'failed', reasonCode: 'fault.command.executionFailed', message: 'FOREIGN KEY constraint failed; Authorization: Bearer secret-fixture; "apiKey":"hidden-fixture"',
    revisionAtDecision: 3, headers: { authorization: 'never-forward' }, rawProvider: { apiKey: 'never-forward' },
  });
  const result = await fixture.run('session/send', { sessionId: 'sess_owned', inputId: 'external', content: 'fixture' });
  assert.equal(result.accepted, false);
  assert.equal(result.nativeAck.reasonCode, 'fault.command.executionFailed');
  assert.match(result.nativeAck.message, /FOREIGN KEY constraint failed/);
  assert.equal(JSON.stringify(result).includes('secret-fixture'), false);
  assert.equal(JSON.stringify(result).includes('hidden-fixture'), false);
  assert.equal(JSON.stringify(result).includes('never-forward'), false);
  assert.equal(result.heldNativeEvents[0].errorMessage, 'FOREIGN KEY constraint failed');
  assert.equal(fixture.requests.some(item => item.method === 'promote'), false);
});

test('accepted input is not resent or failed when only native index promotion fails', async () => {
  const fixture = operationFixture();
  await fixture.run('session/create', { mode: 'build' }); await fixture.run('session/subscribe', { sessionId: 'sess_owned' });
  fixture.window.__deepseekZCodeRenderer.services.zcodeSessionService.promoteDeferredDraftSession = async () => { throw new Error('Index sync failed'); };
  const result = await fixture.run('session/send', { sessionId: 'sess_owned', inputId: 'external', content: 'fixture' });
  assert.equal(result.accepted, true);
  assert.equal(fixture.requests.filter(item => item.method === 'command').length, 1);
  const polled = await fixture.run('bridge/poll');
  assert.ok(polled.events.some(item => item.method === 'bridge/diagnostic' && item.params.inputAlreadyAccepted === true));
});

test('V4 admission uses the task remaining deadline instead of the general 30 second CDP timeout', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-send-deadline-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const transport = new RendererTransport({ workspace: root });
  transport.profileDir = root; transport.remaining = () => 240000;
  transport.evaluate = async () => ({ ready: true, sameListenerConnection: true });
  let actualTimeout;
  transport.operation = async (method, params, timeout) => { actualTimeout = timeout; return { accepted: true, nativeInputId: params.inputId }; };
  assert.equal((await transport.request('session/send', { sessionId: 'sess_owned', inputId: 'external', content: 'fixture' })).accepted, true);
  assert.equal(actualTimeout, 240000);
});

test('native verifier pending keeps the request alive; hidden mount points are not an interactive challenge', async () => {
  const fixture = operationFixture();
  fixture.window.__deepseekZCodeRenderer.verificationPending = true;
  const result = await fixture.run('bridge/poll');
  assert.equal(result.verificationPending, true); assert.equal(result.interactive, false);
  assert.equal(fixture.requests.length, 0);
});

test('workspace verification observation ignores other sessions and never answers or starts the SDK', async () => {
  const fixture = operationFixture();
  await fixture.run('bridge/initialize');
  await fixture.run('session/create', { mode: 'build' });
  fixture.signalVerification({ sessionId: 'another-session', requestId: 'unowned' });
  assert.equal((await fixture.run('bridge/poll')).verificationPending, undefined);
  fixture.signalVerification({ sessionId: 'sess_owned', requestId: 'owned-request', runtimeProviderHeaders: { token: 'must-not-read-or-return' } });
  const result = await fixture.run('bridge/poll');
  assert.equal(result.verificationPending, true);
  assert.equal(result.interactive, false);
  assert.equal(result.events[0].params.phase, 'native-verification-pending');
  assert.equal(result.events[0].params.source, 'workspace');
  assert.equal(JSON.stringify(result).includes('must-not-read-or-return'), false);
  assert.equal(fixture.requests.some(item => /command|respond/i.test(item.method)), false);
});

test('persistent task boundaries remove old task authority without changing native SDK services', async () => {
  const fixture = operationFixture();
  await fixture.run('bridge/initialize');
  await fixture.run('session/create', { mode: 'build' });
  await fixture.run('bridge/beginTask', { nativeSessionId: 'declared-followup' });
  await assert.rejects(fixture.run('session/read', { sessionId: 'sess_owned' }), /outside/);
  assert.equal(fixture.window.__deepseekZCodeRenderer.sessions.has('declared-followup'), true);
  await fixture.run('bridge/releaseTask');
  await assert.rejects(fixture.run('session/read', { sessionId: 'declared-followup' }), /outside/);
  assert.equal(fixture.requests.some(item => /command|respond/i.test(item.method)), false);
});

test('existing resume checks native idle state before changing permissions or materializing a session', async () => {
  const fixture = operationFixture(); let resumed = false;
  fixture.window.__deepseekZCodeRenderer.services.zcodeSessionService.readSession = async () => ({ session: { status: 'running' }, runtime: { activeTurnId: 'user-turn' } });
  fixture.window.__deepseekZCodeRenderer.services.zcodeSessionService.resumeSession = async () => { resumed = true; };
  const result = await fixture.run('session/resume', { sessionId: 'declared-followup', requireIdle: true });
  assert.equal(result.nativeSessionBusy, true); assert.equal(resumed, false);
});

test('visible SDK popup outside the mount slot is observed together with only its public error code', async () => {
  const fixture = operationFixture();
  fixture.window.__deepseekZCodeRenderer.verificationPending = true;
  const popup = { getBoundingClientRect: () => ({ width: 360, height: 240 }), style: { display: 'block', visibility: 'visible', opacity: '1' }, parentElement: null };
  const error = { ...popup, getBoundingClientRect: () => ({ width: 80, height: 16 }), textContent: 'error: public-code-42' };
  fixture.document.querySelectorAll = selector => { assert.match(selector, /\[id\^="aliyunCaptcha-"\]/); return [popup]; };
  fixture.document.getElementById = id => { assert.equal(id, 'aliyunCaptcha-sliding-errorCode'); return error; };
  const result = await fixture.run('bridge/poll');
  assert.equal(result.interactive, true); assert.equal(result.publicErrorCode, 'public-code-42');
  popup.parentElement = { style: { display: 'block', visibility: 'visible', opacity: '0' }, parentElement: null };
  assert.equal((await fixture.run('bridge/poll')).interactive, false);
});

test('owned renderer shutdown asks native V4 to stop before closing the browser', async () => {
  const transport = new RendererTransport({}); const calls = [];
  transport.sendAttempted = true; transport.activeSessionId = 'sess_owned';
  transport.operation = async method => { calls.push(method); return method === 'bridge/stopState' ? { stopped: true } : { accepted: true }; };
  transport.cdp = { closed: false, request: async method => { calls.push(method); }, close: () => calls.push('pipe.close') };
  transport.release = async () => calls.push('profile.release');
  await transport.close();
  assert.deepEqual(calls, ['session/stop', 'bridge/stopState', 'Browser.close', 'pipe.close', 'profile.release']);
});

test('renderer shutdown waits for the owned browser to exit before releasing the profile', async () => {
  const transport = new RendererTransport({}); const calls = [];
  const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
  transport.child = child;
  transport.cdp = { closed: false, request: async method => {
    calls.push(method);
    setTimeout(() => { calls.push('owned-process-exited'); child.exitCode = 0; child.emit('exit', 0); }, 20);
  }, close: () => calls.push('pipe.close') };
  transport.release = async () => calls.push('profile.release');
  await transport.close();
  assert.deepEqual(calls, ['Browser.close', 'owned-process-exited', 'pipe.close', 'profile.release']);
});

test('unconfirmed native cancellation preserves the profile lock and reports uncertain dispatch', async () => {
  const transport = new RendererTransport({}); let released = false;
  transport.sendAttempted = true; transport.activeSessionId = 'sess_owned';
  transport.operation = async () => ({ accepted: false });
  transport.cdp = { closed: false, request: async () => {}, close() {} };
  transport.release = async () => { released = true; };
  await assert.rejects(transport.close(), { code: 'zcode_shutdown_uncertain', dispatchUncertain: true });
  assert.equal(released, false);
});

test('renderer terminal ownership follows the acknowledged input and its started turn', async () => {
  for (const matching of [false, true]) {
    const transport = new RendererTransport({});
    transport.activeSessionId = 'sess_owned'; transport.activeExternalInputId = 'external-input';
    transport.operation = async () => {
      transport.closed = true;
      return { events: [
        { method: 'session/event', params: { sessionId: 'sess_owned', type: 'turn.completed', turnId: 'other-turn', payload: { inputId: 'different-input' } } },
        { method: 'session/event', params: { sessionId: 'sess_owned', type: 'turn.started', turnId: 'owned-turn', payload: { inputId: 'external-input' } } },
        { method: 'session/event', params: { sessionId: 'sess_owned', type: 'turn.completed', turnId: 'owned-turn', payload: { inputId: 'different-input' } } },
        { method: 'session/event', params: { sessionId: 'sess_owned', type: 'turn.completed', turnId: 'other-turn', payload: { inputId: 'external-input' } } },
        ...(matching ? [
          { method: 'session/event', params: { sessionId: 'sess_owned', type: 'turn.completed', turnId: 'owned-turn', payload: { resultType: 'success' } } },
        ] : []),
      ] };
    };
    await transport.poll();
    assert.equal(transport.terminalSeen === true, matching);
  }
});

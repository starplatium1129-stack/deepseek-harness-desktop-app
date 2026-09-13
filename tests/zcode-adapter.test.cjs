'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createZCodeAdapter } = require('../collaboration/adapters/zcode.cjs');

function task(overrides = {}) {
  return { id: 't-zcode-test', goal: 'Inspect the supplied excerpt.', acceptance: ['Report observed facts.'],
    context: [{ excerpt: 'Example fixture.' }], workspace: os.tmpdir(), permission: 'read-only',
    deadlineAt: new Date(Date.now() + 30000).toISOString(), budget: { maxTurns: null }, ...overrides };
}

function context(controller = new AbortController()) {
  return { signal: controller.signal, events: [], checkpoints: [], states: [],
    async emit(type, data) { this.events.push({ type, data }); },
    async checkpoint(data) { this.checkpoints.push(data); },
    async state(state, data) { this.states.push({ state, data }); } };
}

class FakeTransport extends EventEmitter {
  constructor(options = {}) {
    super(); this.options = options; this.requests = []; this.writes = []; this.closed = false; this.mode = 'plan';
  }
  write(message) { this.writes.push(message); }
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'session/create') {
      if (this.options.createError) throw this.options.createError;
      this.mode = params.mode;
      this.emit('message', { id: 'runtime-preferences-1', method: 'session/requestRuntimePreferences', params: { scope: 'runtime-materialization' } });
      return { session: { sessionId: 'sess_fixture' } };
    }
    if (method === 'session/read') return { settings: { mode: { current: this.options.modeMismatch ? 'yolo' : this.mode } } };
    if (method === 'session/setMode') this.mode = params.mode;
    if (method === 'session/subscribe') return { eventSeq: 12 };
    if (method === 'session/list') return { sessions: this.options.sessions || [] };
    if (method === 'session/send') {
      const sid = params.sessionId;
      const event = (seq, type, payload) => this.emit('message', {
        method: 'session/event', params: { sessionId: sid, seq, type, payload },
      });
      setImmediate(() => {
        event(11, 'turn.completed', { resultType: 'success' }); // historical event must not end the task
        event(13, 'turn.started', { inputId: params.inputId });
        event(14, 'model.streaming', { kind: 'text_delta', delta: 'Observed fixture.' });
        event(14, 'model.streaming', { kind: 'text_delta', delta: ' duplicate' });
        if (this.options.disconnect) {
          this.emit('failure', Object.assign(new Error('Native process disconnected.'), { code: 'zcode_process_exit' }));
        } else if (this.options.interaction) {
          this.emit('message', { id: 99, method: this.options.interaction,
            params: { sessionId: sid, toolName: 'Write', input: { file_path: '/outside.txt' }, options: [{ optionId: 'allow', kind: 'allow_once' }] } });
        } else if (this.options.failure) event(15, 'turn.failed', { error: { code: 'quota_exceeded', message: 'Quota exhausted.' } });
        else if (!this.options.hang) event(15, 'turn.completed', { response: this.options.completionResponse, resultType: this.options.resultType || 'success', usage: { totalTokens: 17 } });
      });
      return { accepted: true };
    }
    return {};
  }
  async close() { this.closed = true; }
}

function adapter(transport) { return createZCodeAdapter({ transportFactory: () => transport }); }

test('ZCode refuses a model-turn cap before creating a process or session', async () => {
  let connected = false;
  const value = createZCodeAdapter({ transportFactory: () => { connected = true; } });
  await assert.rejects(value.execute(task({ budget: { maxTurns: 8 } }), context()), { code: 'unsupported_budget' });
  await assert.rejects(value.execute(task({ budget: {} }), context()), { code: 'unsupported_budget' });
  assert.equal(connected, false);
});

test('ZCode sends one native turn with explicit permissions and checkpoints before dispatch', async () => {
  const transport = new FakeTransport();
  const ctx = context();
  const result = await adapter(transport).execute(task(), ctx);
  assert.equal(result.summary, 'Observed fixture.');
  assert.equal(result.nativeSessionId, 'sess_fixture');
  assert.deepEqual(result.tests, []);
  assert.equal(result.accepted, undefined);
  assert.equal(result.usage.totalTokens, 17);
  const create = transport.requests.find(item => item.method === 'session/create').params;
  assert.equal(create.mode, 'plan');
  assert.deepEqual(create.toolAllowlist, ['Read', 'Glob', 'Grep']);
  assert.ok(create.toolDenylist.includes('Bash'));
  assert.ok(create.toolDenylist.includes('Agent'));
  assert.deepEqual(create.mcpServers, []);
  assert.equal(create.titleGenerationEnabled, false);
  assert.equal(transport.writes[0].result.askUserQuestionAutoResolutionEnabled, false);
  assert.ok(ctx.checkpoints.some(item => item.dispatchState === 'sending'));
  assert.equal(transport.requests.filter(item => item.method === 'session/send').length, 1);
  assert.equal(transport.closed, true);
});

test('ZCode resumes native session and reapplies build permissions on a follow-up', async () => {
  const transport = new FakeTransport();
  const result = await adapter(transport).execute(task({ nativeSessionId: 'sess_old', permission: 'workspace-write', model: 'provider/model' }), context());
  assert.equal(result.nativeSessionId, 'sess_old');
  assert.equal(transport.requests.some(item => item.method === 'session/create'), false);
  assert.deepEqual(transport.requests.find(item => item.method === 'session/setMode').params, { sessionId: 'sess_old', mode: 'build' });
  assert.deepEqual(transport.requests.find(item => item.method === 'session/setModel').params.model, { providerId: 'provider', modelId: 'model' });
  assert.ok(transport.requests[0].params.toolAllowlist.includes('Write'));
});

test('ZCode uses the canonical terminal response when the streaming projection is incomplete', async () => {
  const result = await adapter(new FakeTransport({ completionResponse: 'Final native result.' })).execute(task(), context());
  assert.equal(result.summary, 'Final native result.');
});

test('ZCode does not send a task when the native permission mode differs', async () => {
  const transport = new FakeTransport({ modeMismatch: true });
  await assert.rejects(adapter(transport).execute(task(), context()), { code: 'zcode_permission_mismatch' });
  assert.equal(transport.requests.some(item => item.method === 'session/send'), false);
  assert.equal(transport.closed, true);
});

for (const [interaction, expected] of [['interaction/requestPermission', 'needs_approval'], ['interaction/requestUserInput', 'needs_input'], ['interaction/requestProviderRuntimeHeaders', 'needs_input']]) {
  test(`ZCode persists ${expected} without authorizing the native request`, async () => {
    const transport = new FakeTransport({ interaction });
    const ctx = context();
    const result = await adapter(transport).execute(task(), ctx);
    assert.equal(result.state, expected);
    assert.equal(ctx.states[0].state, expected);
    assert.equal(transport.writes.some(item => item.id === 99), false);
    assert.ok(transport.requests.some(item => item.method === 'session/stop'));
    assert.equal(transport.closed, true);
  });
}

test('ZCode reports model configuration missing as needs_input without sending a prompt', async () => {
  const transport = new FakeTransport({ createError: Object.assign(new Error('Model config is missing.'), { code: 'model_config_missing' }) });
  const ctx = context();
  const result = await adapter(transport).execute(task(), ctx);
  assert.equal(result.state, 'needs_input');
  assert.equal(ctx.states[0].data.code, 'model_config_missing');
  assert.equal(transport.requests.some(item => item.method === 'session/send'), false);
});

test('safe native diagnostics queued before failed dispatch are drained before execute rejects', async () => {
  const transport = new FakeTransport();
  const request = transport.request.bind(transport);
  transport.request = async (method, params) => {
    if (method !== 'session/send') return request(method, params);
    transport.emit('message', { method: 'bridge/diagnostic', params: { phase: 'v4-send-ack', ack: { status: 'failed', message: 'FOREIGN KEY constraint failed' } } });
    throw Object.assign(new Error('FOREIGN KEY constraint failed'), { code: 'zcode_native_command_failed', dispatchUncertain: true });
  };
  const ctx = context();
  ctx.emit = async function (type, data) { await new Promise(resolve => setTimeout(resolve, 10)); this.events.push({ type, data }); };
  await assert.rejects(adapter(transport).execute(task(), ctx), { code: 'zcode_native_command_failed', dispatchUncertain: true });
  assert.equal(ctx.events.find(item => item.type === 'native_diagnostic').data.ack.message, 'FOREIGN KEY constraint failed');
});

test('native interactive verification keeps the original request alive and resumes only on native model evidence', async () => {
  const transport = new FakeTransport({ hang: true });
  const nativeRequest = transport.request.bind(transport);
  transport.request = async (method, params) => {
    const value = await nativeRequest(method, params);
    if (method === 'session/send') setTimeout(() => {
      transport.emit('message', { id: 100, method: 'interaction/nativeVerification', params: { keepNativeRequestAlive: true } });
      setTimeout(() => {
        assert.equal(transport.closed, false);
        assert.equal(transport.requests.some(item => item.method === 'session/stop'), false);
        transport.emit('message', { method: 'session/event', params: { sessionId: params.sessionId, seq: 16, type: 'model.streaming', payload: { inputId: params.inputId, kind: 'text_delta', delta: 'Continued.' } } });
        transport.emit('message', { method: 'session/event', params: { sessionId: params.sessionId, seq: 17, type: 'turn.completed', payload: { inputId: params.inputId, resultType: 'success', response: 'Native verification completed and model responded.' } } });
      }, 10);
    }, 5);
    return value;
  };
  const ctx = context();
  const result = await adapter(transport).execute(task(), ctx);
  assert.equal(result.summary, 'Native verification completed and model responded.');
  assert.deepEqual(ctx.states.map(item => item.state), ['needs_input', 'running']);
  assert.equal(transport.writes.some(item => item.id === 100), false);
});

test('ZCode desktop bridge only forwards public snapshot and native task events', () => {
  const { safeSnapshot, nativeEvent } = require('../collaboration/adapters/zcode-desktop-bridge.cjs');
  const snapshot = safeSnapshot({ session: { sessionId: 'sess_owned', secret: 'never-forward' },
    settings: { mode: { current: 'plan' }, apiKey: 'never-forward', model: { current: { providerId: 'native', modelId: 'test' },
      available: [{ ref: { providerId: 'native', modelId: 'test' }, label: 'Test', apiKey: 'never-forward' }] } },
    runtime: { eventSeq: 3, credentials: 'never-forward' } });
  assert.equal(JSON.stringify(snapshot).includes('never-forward'), false);
  assert.equal(snapshot.settings.model.available[0].label, 'Test');
  assert.equal(nativeEvent({ type: 'providerRuntimeHeaders.request', request: { token: 'never-forward' } }), undefined);
  assert.equal(nativeEvent({ type: 'session.event', event: { type: 'provider.updated', apiKey: 'never-forward' } }), undefined);
  const event = nativeEvent({ type: 'session.event', event: { type: 'turn.completed', sessionId: 'sess_owned', payload: {
    response: 'Finished.', usage: { totalTokens: 25 }, runtimeModel: { apiKey: 'never-forward' }, authorization: 'never-forward',
  } } });
  assert.equal(event.payload.response, 'Finished.');
  assert.equal(event.payload.usage.totalTokens, 25);
  assert.equal(JSON.stringify(event).includes('never-forward'), false);
});

test('ZCode desktop pipe rejects an unauthenticated peer before accepting its owned helper', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-pipe-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cliPath = path.join(root, 'resources', 'glm', 'zcode.cjs');
  await fs.mkdir(path.dirname(cliPath), { recursive: true });
  await fs.writeFile(cliPath, "process.stdout.write('0.16.5\\n');");
  await fs.writeFile(path.join(root, 'resources', 'app.asar'), 'fixture');
  const bridgePath = path.join(root, 'fake-desktop.cjs');
  await fs.writeFile(bridgePath, `
    const net = require('net');
    const options = JSON.parse(process.argv[2]);
    const bad = net.createConnection(options.transportPipe);
    bad.on('connect', () => bad.write(JSON.stringify({method:'bridge/hello',params:{token:'0'.repeat(64)}})+'\\n'));
    bad.on('close', () => {
      const socket = net.createConnection(options.transportPipe);
      socket.on('connect', () => socket.write(JSON.stringify({method:'bridge/hello',params:{token:process.env.COLLABORATION_ZCODE_PIPE_TOKEN}})+'\\n'));
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf('\\n')) >= 0) {
          const request = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
          const write = value => socket.write(JSON.stringify(value)+'\\n');
          let result = {};
          if(request.method==='session/create') result={session:{sessionId:'sess_pipe'}};
          if(request.method==='session/read') result={settings:{mode:{current:'plan'}}};
          if(request.method==='session/subscribe') result={eventSeq:0};
          if(request.method==='session/send') result={accepted:true};
          write({id:request.id,result});
          if(request.method==='session/send') {
            write({method:'session/event',params:{sessionId:'sess_pipe',seq:1,type:'turn.started',payload:{inputId:request.params.inputId}}});
            write({method:'session/event',params:{sessionId:'sess_pipe',seq:2,type:'turn.completed',payload:{resultType:'success',response:'Authenticated native pipe fixture.'}}});
          }
        }
      });
    });
    setInterval(()=>{},1000);
  `);
  const result = await createZCodeAdapter({ cliPath, nodePath: process.execPath,
    nativeSurface: 'desktop-host', desktopExecutable: process.execPath, desktopArguments: [bridgePath] }).execute(task({ workspace: root }), context());
  assert.equal(result.summary, 'Authenticated native pipe fixture.');
});

test('ZCode propagates quota errors and unsuccessful terminal statuses', async () => {
  await assert.rejects(adapter(new FakeTransport({ failure: true })).execute(task(), context()), { code: 'quota_exceeded' });
  await assert.rejects(adapter(new FakeTransport({ resultType: 'error_max_budget' })).execute(task(), context()), { code: 'zcode_turn_failed' });
});

test('ZCode marks lost delivery after session/send as uncertain instead of retryable failure', async () => {
  const transport = new FakeTransport({ disconnect: true });
  await assert.rejects(adapter(transport).execute(task(), context()), { code: 'zcode_process_exit', dispatchUncertain: true, nativeSessionId: 'sess_fixture' });
  assert.equal(transport.requests.filter(item => item.method === 'session/send').length, 1);
  assert.equal(transport.closed, true);
});

test('ZCode respects AbortSignal and deadline, stopping only the owned transport', async () => {
  for (const bySignal of [true, false]) {
    const transport = new FakeTransport({ hang: true });
    const controller = new AbortController();
    const promise = adapter(transport).execute(task({ deadlineAt: new Date(Date.now() + (bySignal ? 30000 : 30)).toISOString() }), context(controller));
    if (bySignal) setTimeout(() => controller.abort(), 20);
    await assert.rejects(promise, { code: 'cancelled' });
    assert.ok(transport.requests.some(item => item.method === 'session/stop'));
    assert.equal(transport.closed, true);
  }
});

test('ZCode recovery does not mistake persisted idle sessions for completion or replay work', async () => {
  const transport = new FakeTransport({ sessions: [{ sessionId: 'sess_old', status: 'idle' }] });
  const result = await adapter(transport).recover(task({ nativeSessionId: 'sess_old' }));
  assert.equal(result.state, 'unknown');
  assert.equal(result.nativeSessionFound, true);
  assert.deepEqual(transport.requests.map(item => item.method), ['session/list']);
});

test('ZCode CLI discovery accepts an installation root and explicit override fails without fallback', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-discovery-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cliPath = path.join(root, 'ZCode', 'resources', 'glm', 'zcode.cjs');
  await fs.mkdir(path.dirname(cliPath), { recursive: true });
  await fs.writeFile(cliPath, "process.stdout.write('0.16.5\\n');");
  const found = await createZCodeAdapter({ installationRoots: [root], nodePath: process.execPath }).describe();
  assert.equal(found.available, true);
  assert.equal(found.cliPath, cliPath);
  assert.equal(found.capabilities.maxModelTurns, false);
  assert.equal(found.capabilities.guiSessionVisibility, 'unknown');
  const missing = await createZCodeAdapter({ cliPath: path.join(root, 'missing.cjs'), installationRoots: [root] }).describe();
  assert.equal(missing.available, false);
});

test('ZCode stdio closes an owned process on invalid NDJSON instead of hanging', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-transport-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cliPath = path.join(root, 'zcode.cjs');
  await fs.writeFile(cliPath, "if(process.argv.includes('--version')){process.stdout.write('0.16.5\\n');}else{process.stdin.once('data',()=>process.stdout.write('invalid-json\\n'));setInterval(()=>{},1000);}");
  const value = createZCodeAdapter({ cliPath, nodePath: process.execPath });
  await assert.rejects(value.execute(task(), context()), { code: 'zcode_protocol_error' });
});

test('ZCode refuses an unverified native CLI version before launching app-server', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-version-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cliPath = path.join(root, 'zcode.cjs');
  await fs.writeFile(cliPath, "process.stdout.write('99.0.0\\n');");
  const value = createZCodeAdapter({ cliPath, nodePath: process.execPath });
  assert.equal((await value.describe()).capabilities.protocolCompatible, false);
  await assert.rejects(value.execute(task(), context()), { code: 'zcode_version_unsupported' });
});

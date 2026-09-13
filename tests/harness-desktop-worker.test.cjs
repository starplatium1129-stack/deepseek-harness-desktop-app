const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { createDesktopRunner, DESKTOP_INJECT } = require('../collaboration/harness-desktop-worker.cjs');

function task(workspace, extra = {}) {
  return { id: 'desktop-task', goal: 'Inspect the delegated workspace.', workspace, permission: 'read-only', acceptance: [], context: [], deadlineAt: new Date(Date.now() + 45000).toISOString(), budget: { maxTurns: 1 }, ...extra };
}
function callbacks(extra = {}) { return { signal: new AbortController().signal, emit: async () => {}, state: async () => {}, checkpoint: async () => {}, ...extra }; }

test('desktop runner rejects malformed permissions and budgets without calling native services', async () => {
  const runner = createDesktopRunner({}, { runtimeRoot: 'unused' });
  await assert.rejects(runner.execute(task(__dirname, { permission: 'danger-full-access' }), callbacks()), { code: 'INVALID_PERMISSION' });
  await assert.rejects(runner.execute(task(__dirname, { budget: { maxTurns: 0 } }), callbacks()), { code: 'INVALID_BUDGET' });
  await assert.rejects(runner.execute(task(__dirname, { nativeSessionId: 'ordinary-user-session' }), callbacks()), { code: 'INVALID_SESSION' });
  await runner.dispose();
  assert.ok(DESKTOP_INJECT.includes('sessionController'));
});

const bundledNode = path.resolve(__dirname, '../runtime/node', process.platform === 'win32' ? 'node.exe' : 'node');
const runtimeRoot = path.resolve(__dirname, '../runtime/harness');
const available = existsSync(bundledNode) && existsSync(runtimeRoot);

async function nativeWebFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-desktop-native-test-'));
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace);
  const helper = path.join(root, 'fixture.cjs');
  await fs.writeFile(helper, `
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { createDesktopRunner, DESKTOP_INJECT } = require(${JSON.stringify(path.resolve(__dirname, '../collaboration/harness-desktop-worker.cjs'))});
exports.inject = [...DESKTOP_INJECT, 'systemPrompt'];
exports.apply = (ctx, config) => {
  const runner = createDesktopRunner(ctx, config);
  const controllers = new Map();
  let fixtureSequence = [], fixtureCalls = 0, fixtureRegistration, blockedProviders = 0;
  const send = message => new Promise(resolve => process.send(message, () => resolve()));
  const snapshot = async id => {
    const agent = ctx.agents.get(id);
    if (!agent) return { exists: false };
    const { assembleContextFor } = await import(pathToFileURL(path.join(config.runtimeRoot, 'node_modules/@deepseek-ai/dsh-agent/lib/index.js')).href);
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent, new AbortController().signal));
    return { exists: true, id: agent.id, status: agent.status, mode: ctx.sandboxPolicy.resolve({ session: agent.session }).mode, approval: ctx.approval.effectivePolicy(agent.session), toolNames: assembly.tools.map(tool => tool.name), model: assembly.variables.model, provider: assembly.variables.provider, deniedShell: Boolean(ctx.tools.guardReason({ name: 'pwsh', agent })), pending: [...agent.inbox.nextTurn, ...agent.inbox.nextStep].map(message => message.id), turns: agent.session.snapshotEvents().filter(event => event.type === 'turn/start').length, assistants: agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').length, fixtureCalls, blockedProviders };
  };
  const receive = message => {
    if (message?.type !== 'fixture') return;
    void (async () => {
      const { requestId, action, task, sessionId } = message;
      if (action === 'configure-controlled-adapter') {
        fixtureSequence = [...message.steps]; fixtureCalls = 0;
        if (!fixtureRegistration) {
          const { LlmAdapter } = await import(pathToFileURL(path.join(config.runtimeRoot, 'node_modules/@deepseek-ai/dsh-llm/lib/index.js')).href);
          class ControlledAdapter extends LlmAdapter {
            async resolveModel(provider, id) { return { provider, id, name: 'Offline controlled fixture', inputModalities: ['text'] }; }
            async *stream(options) {
              if (!options.tools?.length) { yield { type: 'text-delta', index: 0, text: 'Controlled fixture title' }; yield { type: 'finish', reason: { kind: 'stop' } }; return; }
              const step = fixtureSequence.shift(); fixtureCalls++;
              if (!step) throw new Error('Controlled fixture stream exhausted.');
              if (step.tool) {
                yield { type: 'tool-call-delta', index: 0, id: 'controlled-call-' + fixtureCalls, name: step.tool, argumentsDelta: JSON.stringify(step.arguments) };
                yield { type: 'finish', reason: { kind: 'tool-calls' } };
              } else { yield { type: 'text-delta', index: 0, text: step.text }; yield { type: 'finish', reason: { kind: 'stop' } }; }
            }
          }
          fixtureRegistration = ctx.llm.registerAdapter(['desktop-controlled-fixture'], new ControlledAdapter());
          ctx.on('llm/stream', (options, next) => { if (options.provider !== 'desktop-controlled-fixture') { blockedProviders++; throw new Error('Offline fixture refuses every real model provider.'); } return next(); }, { prepend: true });
        }
        await ctx.agentDefaultModel.saveSelection({ provider: 'desktop-controlled-fixture', model: 'controlled' });
        await send({ requestId, type: 'configured' });
      }
      else if (action === 'create') { await ctx.sessionController.create({ sessionId, cwd: message.workspace }); await send({ requestId, type: 'snapshot', data: await snapshot(sessionId) }); }
      else if (action === 'snapshot') await send({ requestId, type: 'snapshot', data: await snapshot(sessionId) });
      else if (action === 'pre-step') {
        const { agentEvents } = await import(pathToFileURL(path.join(config.runtimeRoot, 'node_modules/@deepseek-ai/dsh-agent/lib/index.js')).href);
        const agent = ctx.agents.get(sessionId);
        const decision = await agentEvents(ctx, agent).waterfall('agent/pre-step', { messages: [], turn: 1, step: message.step, signal: new AbortController().signal }, () => Promise.resolve({ kind: 'enter', messages: [] }));
        await send({ requestId, type: 'decision', kind: decision.kind });
      }
      else if (action === 'policy') {
        const agent = ctx.agents.get(sessionId);
        if (message.sandbox) {
          const { setSandboxMode } = await import(pathToFileURL(path.join(config.runtimeRoot, 'node_modules/@deepseek-ai/dsh-sandbox-policy/lib/index.js')).href);
          setSandboxMode(agent.session, message.sandbox);
        }
        if (message.approval) {
          const { setApprovalPolicy } = await import(pathToFileURL(path.join(config.runtimeRoot, 'node_modules/@deepseek-ai/dsh-user-approval/lib/index.js')).href);
          setApprovalPolicy(agent.session, message.approval);
        }
        await ctx.sessions.flush(agent.session);
        await send({ requestId, type: 'snapshot', data: await snapshot(sessionId) });
      }
      else if (action === 'enqueue') {
        const { createUserMessage } = await import(pathToFileURL(path.join(config.runtimeRoot, 'node_modules/@deepseek-ai/dsh-llm/lib/index.js')).href);
        ctx.agents.get(sessionId).inbox.append('next-turn', createUserMessage({ content: [{ type: 'text', text: 'User input retained by the fixture; never dispatch it.' }], source: { kind: 'user' } }));
        await send({ requestId, type: 'snapshot', data: await snapshot(sessionId) });
      } else if (action === 'cancel') controllers.get(message.runId)?.abort();
      else if (action === 'run') {
        const controller = new AbortController(); controllers.set(requestId, controller);
        try {
          const result = await runner.execute(task, { signal: controller.signal,
            emit: async () => {}, state: async (state, data) => send({ requestId, type: 'state', state, data }),
            checkpoint: async data => { await send({ requestId, type: 'checkpoint', data, snapshot: await snapshot(data.nativeSessionId) }); if (message.failCheckpoint) throw new Error('fixture durable checkpoint failed'); if (!message.admitControlled) await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true })); },
          });
          await send({ requestId, type: 'result', data: result });
        } catch (error) { await send({ requestId, type: 'error', code: error.code, message: error.message, dispatchUncertain: error.dispatchUncertain }); }
        finally { controllers.delete(requestId); }
      } else if (action === 'shutdown') { await runner.dispose(); ctx.get('appExit')?.(0); }
    })().catch(error => send({ requestId: message.requestId, type: 'fixture-error', message: String(error.message) }));
  };
  process.on('message', receive);
  ctx.effect(() => async () => { process.removeListener('message', receive); await runner.dispose(); });
  setImmediate(async () => { await ctx.get('loader')?.await(); await send({ type: 'ready' }); });
};
`);
  const patch = path.join(root, 'patch.json');
  const harnessHome = path.join(root, 'home');
  const plugins = [{ id: 'desktop-fixture', name: pathToFileURL(helper).href, config: { runtimeRoot } }];
  if (options.bridge) plugins.push({ id: 'desktop-transport-fixture', name: pathToFileURL(path.resolve(__dirname, '../collaboration/harness-desktop-server.cjs')).href, config: { runtimeRoot, harnessHome } });
  await fs.writeFile(patch, JSON.stringify([{ insert: plugins }]));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(NODE_OPTIONS|ELECTRON_RUN_AS_NODE|DSH_.*|npm_.*|pnpm_.*|DEEPSEEK_API_KEY)$/i.test(key)));
  const child = spawn(bundledNode, [path.join(runtimeRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: workspace, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...env, DSH_HOME: harnessHome, DEEPSEEK_API_KEY: '' },
  });
  const queue = [], waiters = [];
  child.on('message', message => {
    const index = waiters.findIndex(waiter => waiter.match(message));
    if (index < 0) queue.push(message); else { const [waiter] = waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(message); }
  });
  const next = (match, timeout = 30000) => {
    const index = queue.findIndex(match);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve, timer: setTimeout(() => { const at = waiters.indexOf(waiter); if (at >= 0) waiters.splice(at, 1); reject(new Error('Native Web fixture response timed out.')); }, timeout) };
      waiters.push(waiter);
    });
  };
  let count = 0;
  const send = message => { const requestId = message.requestId || `fixture-${++count}`; child.send({ type: 'fixture', ...message, requestId }); return requestId; };
  t.after(async () => {
    if (child.exitCode === null) {
      send({ action: 'shutdown' });
      await new Promise(resolve => { const timer = setTimeout(() => { child.kill(); resolve(); }, 8000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    }
    for (const waiter of waiters) clearTimeout(waiter.timer);
    await fs.rm(root, { recursive: true, force: true });
  });
  await next(message => message.type === 'ready');
  const rpc = async message => { const requestId = send(message); const response = await next(response => response.requestId === requestId); assert.notEqual(response.type, 'fixture-error', response.message); return response; };
  return { child, workspace, harnessHome, send, next, rpc };
}

test('native Web worker borrows its existing Agent, scopes tool/policy guards and restores it after cancellation', { skip: !available, timeout: 60000 }, async t => {
  const fixture = await nativeWebFixture(t);
  const nativeSessionId = 'collaboration-web-existing';
  const before = (await fixture.rpc({ action: 'create', sessionId: nativeSessionId, workspace: fixture.workspace })).data;
  assert.equal(before.exists, true); assert.equal(before.deniedShell, false);
  assert.ok(before.toolNames.includes('read')); assert.ok(before.toolNames.includes('pwsh'));
  for (let index = 0; index < 2; index++) {
    const requestId = fixture.send({ action: 'run', task: task(fixture.workspace, { id: `desktop-borrow-${index}`, nativeSessionId }) });
    const checkpoint = await fixture.next(message => message.requestId === requestId && ['checkpoint', 'error', 'fixture-error'].includes(message.type));
    assert.equal(checkpoint.type, 'checkpoint', checkpoint.message);
    assert.equal(checkpoint.data.nativeSessionId, nativeSessionId);
    assert.equal(checkpoint.snapshot.mode, 'read-only'); assert.equal(checkpoint.snapshot.approval, 'ask');
    assert.equal(checkpoint.snapshot.deniedShell, true);
    assert.deepEqual(checkpoint.snapshot.toolNames.sort(), ['ask_user_question', 'glob', 'grep', 'read', 'read_image']);
    fixture.send({ action: 'cancel', runId: requestId });
    const result = await fixture.next(message => message.requestId === requestId && ['error', 'result', 'fixture-error'].includes(message.type));
    assert.equal(result.code, 'CANCELLED'); assert.equal(result.dispatchUncertain, undefined);
    const after = (await fixture.rpc({ action: 'snapshot', sessionId: nativeSessionId })).data;
    assert.equal(after.exists, true); assert.equal(after.id, nativeSessionId);
    assert.equal(after.mode, before.mode); assert.equal(after.approval, before.approval);
    assert.equal(after.deniedShell, false); assert.deepEqual(after.toolNames.sort(), before.toolNames.sort());
    assert.equal(after.turns, 0); assert.equal(after.assistants, 0);
  }
  assert.equal(fixture.child.exitCode, null, 'Task cancellation must not stop the desktop runtime.');
});

test('native Web worker refuses pending user input without consuming it', { skip: !available, timeout: 60000 }, async t => {
  const fixture = await nativeWebFixture(t);
  const nativeSessionId = 'collaboration-web-pending';
  await fixture.rpc({ action: 'create', sessionId: nativeSessionId, workspace: fixture.workspace });
  const queued = (await fixture.rpc({ action: 'enqueue', sessionId: nativeSessionId })).data;
  assert.equal(queued.pending.length, 1);
  const requestId = fixture.send({ action: 'run', task: task(fixture.workspace, { nativeSessionId }) });
  const state = await fixture.next(message => message.requestId === requestId && message.type === 'state');
  assert.equal(state.state, 'needs_input'); assert.equal(state.data.promptDispatched, false);
  const result = await fixture.next(message => message.requestId === requestId && ['error', 'fixture-error'].includes(message.type));
  assert.equal(result.code, 'HARNESS_SESSION_BUSY');
  const after = (await fixture.rpc({ action: 'snapshot', sessionId: nativeSessionId })).data;
  assert.deepEqual(after.pending, queued.pending); assert.equal(after.turns, 0); assert.equal(after.assistants, 0);
});

test('native Web checkpoint failure admits no model turn and preserves the created native Agent', { skip: !available, timeout: 60000 }, async t => {
  const fixture = await nativeWebFixture(t);
  const requestId = fixture.send({ action: 'run', failCheckpoint: true, task: task(fixture.workspace) });
  const checkpoint = await fixture.next(message => message.requestId === requestId && ['checkpoint', 'error', 'fixture-error'].includes(message.type));
  assert.equal(checkpoint.type, 'checkpoint', checkpoint.message);
  const error = await fixture.next(message => message.requestId === requestId && ['error', 'fixture-error'].includes(message.type));
  assert.match(error.message, /fixture durable checkpoint failed/); assert.equal(error.dispatchUncertain, undefined);
  const after = (await fixture.rpc({ action: 'snapshot', sessionId: checkpoint.data.nativeSessionId })).data;
  assert.equal(after.exists, true); assert.equal(after.turns, 0); assert.equal(after.assistants, 0); assert.equal(after.deniedShell, false);
});

test('native Web pre-step budget stops at the configured limit without a model call', { skip: !available, timeout: 60000 }, async t => {
  const fixture = await nativeWebFixture(t);
  const requestId = fixture.send({ action: 'run', task: task(fixture.workspace, { budget: { maxTurns: 1 } }) });
  const checkpoint = await fixture.next(message => message.requestId === requestId && ['checkpoint', 'error', 'fixture-error'].includes(message.type));
  assert.equal(checkpoint.type, 'checkpoint', checkpoint.message);
  const nativeSessionId = checkpoint.data.nativeSessionId;
  assert.equal((await fixture.rpc({ action: 'pre-step', sessionId: nativeSessionId, step: 1 })).kind, 'enter');
  assert.equal((await fixture.rpc({ action: 'pre-step', sessionId: nativeSessionId, step: 2 })).kind, 'reject');
  fixture.send({ action: 'cancel', runId: requestId });
  const error = await fixture.next(message => message.requestId === requestId && ['error', 'fixture-error'].includes(message.type));
  assert.equal(error.code, 'BUDGET_EXCEEDED');
  const after = (await fixture.rpc({ action: 'snapshot', sessionId: nativeSessionId })).data;
  assert.equal(after.turns, 0); assert.equal(after.assistants, 0); assert.equal(after.deniedShell, false);
});

test('native Web model override is scoped and later desktop input is retained', { skip: !available, timeout: 60000 }, async t => {
  const fixture = await nativeWebFixture(t);
  const nativeSessionId = 'collaboration-web-model';
  const before = (await fixture.rpc({ action: 'create', sessionId: nativeSessionId, workspace: fixture.workspace })).data;
  const requestId = fixture.send({ action: 'run', task: task(fixture.workspace, { nativeSessionId, model: { provider: before.provider, model: 'deepseek-v4-pro' } }) });
  const checkpoint = await fixture.next(message => message.requestId === requestId && ['checkpoint', 'error', 'fixture-error'].includes(message.type));
  assert.equal(checkpoint.type, 'checkpoint', checkpoint.message);
  assert.equal(checkpoint.snapshot.model, 'deepseek-v4-pro');
  assert.equal(checkpoint.snapshot.provider, before.provider);
  const queued = (await fixture.rpc({ action: 'enqueue', sessionId: nativeSessionId })).data;
  fixture.send({ action: 'cancel', runId: requestId });
  const state = await fixture.next(message => message.requestId === requestId && message.type === 'state');
  assert.equal(state.state, 'needs_input'); assert.equal(state.data.promptDispatched, false);
  const result = await fixture.next(message => message.requestId === requestId && ['error', 'fixture-error'].includes(message.type));
  assert.equal(result.code, 'HARNESS_DESKTOP_INPUT');
  const after = (await fixture.rpc({ action: 'snapshot', sessionId: nativeSessionId })).data;
  assert.deepEqual(after.pending, queued.pending); assert.equal(after.model, before.model); assert.equal(after.provider, before.provider);
  assert.equal(after.turns, 0); assert.equal(after.assistants, 0); assert.equal(after.deniedShell, false);
});

test('native Web deadline releases a pending durable checkpoint without dispatching a prompt', { skip: !available, timeout: 60000 }, async t => {
  const fixture = await nativeWebFixture(t);
  const requestId = fixture.send({ action: 'run', task: task(fixture.workspace, { deadlineAt: new Date(Date.now() + 2000).toISOString() }) });
  const checkpoint = await fixture.next(message => message.requestId === requestId && ['checkpoint', 'error', 'fixture-error'].includes(message.type));
  assert.equal(checkpoint.type, 'checkpoint', checkpoint.message);
  const error = await fixture.next(message => message.requestId === requestId && ['error', 'fixture-error'].includes(message.type), 5000);
  assert.equal(error.code, 'DEADLINE_EXCEEDED');
  const after = (await fixture.rpc({ action: 'snapshot', sessionId: checkpoint.data.nativeSessionId })).data;
  assert.equal(after.exists, true); assert.equal(after.turns, 0); assert.equal(after.assistants, 0); assert.equal(after.deniedShell, false);
});

test('authenticated Windows pipe reaches the existing native Web Agent and cancellation restores it', { skip: !available || process.platform !== 'win32', timeout: 60000 }, async t => {
  const { desktopBridgeStatus, executeOnDesktop } = require('../collaboration/harness-desktop-client.cjs');
  const fixture = await nativeWebFixture(t, { bridge: true });
  const nativeSessionId = 'collaboration-web-authenticated';
  const before = (await fixture.rpc({ action: 'create', sessionId: nativeSessionId, workspace: fixture.workspace })).data;
  const status = await desktopBridgeStatus(fixture.harnessHome);
  assert.equal(status.available, true, status.reason); assert.equal(status.pid, fixture.child.pid);
  const controller = new AbortController(); let checkpointId, executor;
  await assert.rejects(executeOnDesktop(task(fixture.workspace, { nativeSessionId }), callbacks({ signal: controller.signal,
    emit: async (type, data) => { if (type === 'executor_ready') executor = data; },
    checkpoint: async data => { checkpointId = data.nativeSessionId; controller.abort(); },
  }), { harnessHome: fixture.harnessHome }), { code: 'CANCELLED' });
  assert.equal(checkpointId, nativeSessionId); assert.equal(executor.pid, fixture.child.pid); assert.equal(executor.nativeDesktop, true);
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await desktopBridgeStatus(fixture.harnessHome)).activeCount === 0) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal((await desktopBridgeStatus(fixture.harnessHome)).activeCount, 0);
  const after = (await fixture.rpc({ action: 'snapshot', sessionId: nativeSessionId })).data;
  assert.equal(after.exists, true); assert.equal(after.mode, before.mode); assert.equal(after.approval, before.approval);
  assert.equal(after.deniedShell, false); assert.equal(after.turns, 0); assert.equal(after.assistants, 0);
  assert.equal(fixture.child.exitCode, null);
});

test('native Web preserves each user-changed policy dimension and restores the other independently', { skip: !available, timeout: 60000 }, async t => {
  const fixture = await nativeWebFixture(t);
  const nativeSessionId = 'collaboration-web-policy-dimensions';
  await fixture.rpc({ action: 'create', sessionId: nativeSessionId, workspace: fixture.workspace });
  for (const dimension of ['sandbox', 'approval']) {
    await fixture.rpc({ action: 'policy', sessionId: nativeSessionId, sandbox: 'read-only', approval: 'never' });
    const requestId = fixture.send({ action: 'run', task: task(fixture.workspace, { id: `policy-${dimension}`, nativeSessionId, permission: 'workspace-write' }) });
    const checkpoint = await fixture.next(message => message.requestId === requestId && ['checkpoint', 'error', 'fixture-error'].includes(message.type));
    assert.equal(checkpoint.type, 'checkpoint', checkpoint.message);
    assert.equal(checkpoint.snapshot.mode, 'workspace-write'); assert.equal(checkpoint.snapshot.approval, 'ask');
    await fixture.rpc({ action: 'policy', sessionId: nativeSessionId, [dimension]: dimension === 'sandbox' ? 'read-only' : 'never' });
    const error = await fixture.next(message => message.requestId === requestId && ['error', 'fixture-error'].includes(message.type));
    assert.equal(error.code, 'HARNESS_DESKTOP_POLICY_CHANGED');
    const after = (await fixture.rpc({ action: 'snapshot', sessionId: nativeSessionId })).data;
    assert.equal(after.mode, 'read-only', 'Changing approval must not retain a temporary workspace-write sandbox.');
    assert.equal(after.approval, 'never', 'Changing sandbox must not retain a temporary ask override.');
    assert.equal(after.turns, 0); assert.equal(after.assistants, 0); assert.equal(after.deniedShell, false);
  }
});

test('offline controlled native Web loop completes real file tools and continues the same Agent', { skip: !available, timeout: 60000 }, async t => {
  const fixture = await nativeWebFixture(t, { bridge: process.platform === 'win32' });
  const nativeSessionId = 'collaboration-web-controlled-loop';
  const file = path.join(fixture.workspace, 'greet.cjs');
  await fs.writeFile(file, 'exports.greet = name => name;\n');
  for (let round = 0; round < 3; round++) {
    const before = round === 0 ? 'name => name' : `name => name.trim() /* round ${round} */`;
    const after = `name => name.trim() /* round ${round + 1} */`;
    await fixture.rpc({ action: 'configure-controlled-adapter', steps: [
      { tool: 'read', arguments: { file_path: 'greet.cjs' } },
      { tool: 'glob', arguments: { pattern: '**/*' } },
      { tool: 'read', arguments: { file_path: 'greet.cjs' } },
      { tool: 'edit', arguments: { file_path: 'greet.cjs', old_string: before, new_string: after } },
      { tool: 'read', arguments: { file_path: 'greet.cjs' } },
      { text: `CONTROLLED_FIXTURE_COMPLETED_${round + 1}` },
    ] });
    if (round === 0) await fixture.rpc({ action: 'create', sessionId: nativeSessionId, workspace: fixture.workspace });
    const input = task(fixture.workspace, { id: `controlled-round-${round}`, nativeSessionId, permission: 'workspace-write', budget: { maxTurns: 8 }, model: { provider: 'desktop-controlled-fixture', model: 'controlled' } });
    let result;
    if (process.platform === 'win32') {
      const { executeOnDesktop } = require('../collaboration/harness-desktop-client.cjs');
      result = await executeOnDesktop(input, callbacks(), { harnessHome: fixture.harnessHome });
    } else {
      const requestId = fixture.send({ action: 'run', task: input, admitControlled: true });
      const response = await fixture.next(message => message.requestId === requestId && ['result', 'error', 'fixture-error'].includes(message.type));
      assert.equal(response.type, 'result', response.message); result = response.data;
    }
    assert.equal(result.nativeSessionId, nativeSessionId); assert.equal(result.summary, `CONTROLLED_FIXTURE_COMPLETED_${round + 1}`);
    assert.equal(await fs.readFile(file, 'utf8'), `exports.greet = ${after};\n`);
    const snapshot = (await fixture.rpc({ action: 'snapshot', sessionId: nativeSessionId })).data;
    assert.equal(snapshot.exists, true); assert.equal(snapshot.status, 'idle'); assert.equal(snapshot.deniedShell, false);
    assert.equal(snapshot.fixtureCalls, 6); assert.equal(snapshot.blockedProviders, 0);
    assert.equal(snapshot.turns, round + 1); assert.equal(snapshot.assistants, 6 * (round + 1));
    assert.equal(fixture.child.exitCode, null, 'Full native tool/completion flow must preserve its hosting Web process.');
  }
});

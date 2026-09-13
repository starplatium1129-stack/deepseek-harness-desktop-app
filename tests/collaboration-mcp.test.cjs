'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const { createMcpServer, tools, validate } = require('../collaboration/mcp.cjs');
const { parseArgs, main } = require('../collaboration/cli.cjs');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'collaboration', 'cli.cjs');
const initialize = (id = 1, protocolVersion = '2025-11-25') => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 'test-client', version: '1.0' } } });
const call = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function createReader(output) {
  let buffer = '';
  const messages = [], waiters = [];
  output.setEncoding('utf8');
  output.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      const message = JSON.parse(line); // Any diagnostic on stdout fails the test.
      messages.push(message);
      for (const waiter of [...waiters]) if (waiter.test(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer); waiter.resolve(message);
      }
    }
  });
  return {
    messages,
    waitFor(predicate) {
      const test = typeof predicate === 'function' ? predicate : message => message.id === predicate;
      const existing = messages.find(test);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { test, resolve };
        waiter.timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('Timed out waiting for protocol response')); }, 3000);
        waiters.push(waiter);
      });
    },
  };
}

function fixture(t, methods = {}, options = {}) {
  const input = new PassThrough(), output = new PassThrough(), error = new PassThrough();
  let closes = 0;
  const service = { listExecutors: async () => [{ id: 'fake', available: true }], close: async () => { closes++; }, ...methods };
  const reader = createReader(output);
  const server = createMcpServer({ service, input, output, error, ...options });
  t.after(() => server.close());
  return { input, output, error, server, reader, get closes() { return closes; },
    send(message) { input.write(JSON.stringify(message) + '\n'); },
    async ready(protocolVersion) {
      input.write(JSON.stringify(initialize(1, protocolVersion)) + '\n');
      const result = await reader.waitFor(1);
      input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      return result;
    },
  };
}

test('stdio negotiates initialization, lists schemas and calls a read-only tool', async t => {
  const f = fixture(t);
  f.send(call(0, 'list_executors'));
  assert.equal((await f.reader.waitFor(0)).error.code, -32002);
  const initialized = await f.ready();
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  assert.deepEqual(initialized.result.capabilities, { tools: { listChanged: false } });
  f.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const listed = (await f.reader.waitFor(2)).result.tools;
  assert.deepEqual(listed.map(tool => tool.name), ['list_dispatcher_tasks', 'claim_delivery', 'resolve_delivery', 'list_executors', 'submit_task', 'get_task', 'wait_task', 'read_result', 'send_followup', 'cancel_task', 'review_task', 'start_run', 'get_run', 'list_runs', 'wait_run', 'pause_run', 'resume_run']);
  assert.ok(listed.every(tool => !('method' in tool) && tool.inputSchema.additionalProperties === false));
  const schema = listed.find(tool => tool.name === 'submit_task').inputSchema;
  assert.ok(schema.required.includes('permission'));
  assert.ok(schema.required.includes('idempotencyKey'));
  f.send(call(3, 'list_executors'));
  assert.deepEqual(JSON.parse((await f.reader.waitFor(3)).result.content[0].text), [{ id: 'fake', available: true }]);
  f.send({ jsonrpc: '2.0', id: 4, method: 'ping' });
  assert.deepEqual((await f.reader.waitFor(4)).result, {});
});

test('tool requests wait for initialized notification and negotiate an older supported version', async t => {
  const f = fixture(t, { getTask: async () => ({ status: 'completed' }) });
  f.send(initialize(1, '2024-11-05'));
  assert.equal((await f.reader.waitFor(1)).result.protocolVersion, '2024-11-05');
  f.send(call(2, 'get_task', { taskId: 't' }));
  assert.equal((await f.reader.waitFor(2)).error.code, -32002);
  f.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  f.send(call(3, 'get_task', { taskId: 't' }));
  assert.equal('structuredContent' in (await f.reader.waitFor(3)).result, false);
});

test('unsupported protocol proposals negotiate the latest implemented version', async t => {
  const f = fixture(t);
  assert.equal((await f.ready('2026-07-28')).result.protocolVersion, '2025-11-25');
});

test('valid calls preserve task bounds and rejected arguments never reach the service', async t => {
  const submitted = [];
  const f = fixture(t, { submitTask: async args => { submitted.push(args); return { taskId: 't' }; } });
  await f.ready();
  const args = { executor: 'fake', goal: '检查中文内容', acceptance: ['Return evidence'], repository: root, permission: 'read-only', deadlineAt: new Date(Date.now() + 60000).toISOString(), budget: { maxTurns: 2 }, idempotencyKey: 'test-key' };
  f.send(call(2, 'submit_task', args));
  assert.deepEqual((await f.reader.waitFor(2)).result.structuredContent, { taskId: 't' });
  assert.deepEqual(submitted, [args]);
  const invalid = [
    { ...args, permission: 'yolo' }, { ...args, budget: { maxTurns: 51 } },
    { ...args, budget: { maxTurns: 1.5 } }, { ...args, repository: undefined },
    { ...args, context: [{}] }, { ...args, deadlineAt: 'tomorrow' },
    { ...args, context: [{ excerpt: 'ok', permission: 'yolo' }] }, { ...args, surprise: true },
  ];
  for (let i = 0; i < invalid.length; i++) {
    f.send(call(10 + i, 'submit_task', invalid[i]));
    assert.equal((await f.reader.waitFor(10 + i)).result.isError, true);
  }
  assert.equal(submitted.length, 1);
  assert.equal(validate(tools.find(tool => tool.name === 'submit_task').inputSchema, { ...args, budget: { maxTurns: null } }), null);
});

test('wait_task stays concurrent with cancel_task even at the ordinary request limit', async t => {
  let resolveWait;
  const f = fixture(t, {
    waitTask: () => new Promise(resolve => { resolveWait = resolve; }),
    cancelTask: async ({ taskId }) => { resolveWait({ taskId, status: 'cancelled' }); return { taskId, status: 'cancelled' }; },
  }, { maxPending: 1 });
  await f.ready();
  f.send(call(2, 'wait_task', { taskId: 't', timeoutMs: 60000 }));
  await nextTurn();
  f.send(call(3, 'get_task', { taskId: 't' }));
  assert.equal((await f.reader.waitFor(3)).error.code, -32000);
  f.send(call(4, 'cancel_task', { taskId: 't' }));
  assert.equal((await f.reader.waitFor(4)).result.structuredContent.status, 'cancelled');
  assert.equal((await f.reader.waitFor(2)).result.structuredContent.status, 'cancelled');
});

test('MCP cancellation aborts only the wait, releases capacity, and never cancels native work', async t => {
  let nativeCancellations = 0, aborted = false;
  const f = fixture(t, {
    waitTask: ({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve({ stopped: true }); }, { once: true })),
    cancelTask: async () => { nativeCancellations++; },
  }, { maxPending: 1 });
  await f.ready();
  f.send(call(2, 'wait_task', { taskId: 't' }));
  await nextTurn();
  f.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
  await nextTurn();
  f.send(call(3, 'list_executors'));
  assert.equal((await f.reader.waitFor(3)).result.isError, false);
  assert.equal(aborted, true);
  assert.equal(nativeCancellations, 0);
  assert.equal(f.reader.messages.some(message => message.id === 2), false);
});

test('service failures are tool errors with redacted diagnostic text', async t => {
  const f = fixture(t, { readResult: async () => { throw Object.assign(new Error('API failed: token=hidden Bearer abc sk-secret'), { code: 'EXECUTOR_FAILED' }); } });
  await f.ready(); f.send(call(2, 'read_result', { taskId: 't' }));
  const result = (await f.reader.waitFor(2)).result;
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, 'EXECUTOR_FAILED');
  assert.doesNotMatch(result.content[0].text, /hidden|Bearer abc|sk-secret/);
});

test('cancelling a run wait never pauses its background coordinator', async t => {
  let aborted = false, pauses = 0;
  const f = fixture(t, {
    waitRun: ({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve({ state: 'running' }); }, { once: true })),
    pauseRun: async () => { pauses++; return { state: 'paused' }; },
  }, { maxPending: 1 });
  await f.ready(); f.send(call(2, 'wait_run', { runId: 'r', timeoutMs: 60000 })); await nextTurn();
  f.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } }); await nextTurn();
  assert.equal(aborted, true); assert.equal(pauses, 0);
  f.send(call(3, 'pause_run', { runId: 'r' })); assert.equal((await f.reader.waitFor(3)).result.isError, false); assert.equal(pauses, 1);
});

test('UTF-8 split across byte chunks works; invalid JSON and unknown methods are protocol errors', async t => {
  const f = fixture(t);
  const frame = Buffer.from(JSON.stringify({ ...initialize(), params: { ...initialize().params, clientInfo: { name: '中文客户端', version: '1' } } }) + '\n');
  for (let i = 0; i < frame.length; i++) f.input.write(frame.subarray(i, i + 1));
  assert.equal((await f.reader.waitFor(1)).result.protocolVersion, '2025-11-25');
  f.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  f.input.write('{broken\n');
  assert.equal((await f.reader.waitFor(message => message.error?.code === -32700)).id, null);
  f.send({ jsonrpc: '2.0', id: 2, method: 'unavailable' });
  assert.equal((await f.reader.waitFor(2)).error.code, -32601);
  f.send(call(3, 'unavailable'));
  assert.equal((await f.reader.waitFor(3)).error.code, -32602);
  f.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_executors', arguments: [] } });
  assert.equal((await f.reader.waitFor(4)).error.code, -32602);
});

test('oversized unterminated frames close cleanly and cannot reach the service', async t => {
  const f = fixture(t, {}, { maxFrameBytes: 32 });
  f.input.write(Buffer.alloc(33, 65));
  assert.equal((await f.reader.waitFor(message => message.error?.code === -32600)).id, null);
  await f.server.done;
  assert.equal(f.closes, 1);
  await f.server.close();
  assert.equal(f.closes, 1);
});

test('oversized result returns a bounded actionable error', async t => {
  const f = fixture(t, { getTask: async () => ({ data: 'x'.repeat(4096) }) }, { maxOutputBytes: 1024 });
  await f.ready(); f.send(call(2, 'get_task', { taskId: 't' }));
  const response = await f.reader.waitFor(2);
  assert.equal(response.error.code, -32603);
  assert.match(response.error.message, /smaller page/);
});

test('nonserializable backend results fail one request without crashing the transport', async t => {
  const circular = {}; circular.self = circular;
  const f = fixture(t, { getTask: async () => circular });
  await f.ready(); f.send(call(2, 'get_task', { taskId: 't' }));
  assert.equal((await f.reader.waitFor(2)).result.isError, true);
  f.send(call(3, 'list_executors'));
  assert.equal((await f.reader.waitFor(3)).result.isError, false);
});

test('CLI requires explicit absolute roots, keeps independent data, and has a safe help mode', async () => {
  assert.throws(() => parseArgs([]), /--allow-root/);
  assert.throws(() => parseArgs(['--allow-root', '.']), /absolute/);
  assert.throws(() => parseArgs(['--allow-root', root, '--surprise']), /Unknown argument/);
  assert.throws(() => parseArgs(['--allow-root', root, '--data-dir']), /absolute/);
  const parsed = parseArgs(['--allow-root', root, '--allow-root', root], { APPDATA: path.join(root, 'profile') });
  assert.deepEqual(parsed.allowedRoots, [root]);
  assert.equal(parsed.dataDir, path.join(root, 'profile', 'DeepSeek-Harness-Collaboration'));
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', windowsHide: true });
  assert.equal(help.status, 0); assert.match(help.stdout, /--allow-root/); assert.equal(help.stderr, '');
  const missing = spawnSync(process.execPath, [cli], { encoding: 'utf8', windowsHide: true });
  assert.equal(missing.status, 2); assert.equal(missing.stdout, ''); assert.match(missing.stderr, /--allow-root/);
});

test('CLI list-executors inspects without dispatching or reading stdin and always closes', async () => {
  let closes = 0, created;
  const output = new PassThrough(), error = new PassThrough();
  let data = ''; output.on('data', chunk => { data += chunk; });
  const result = await main(['--allow-root', root, '--list-executors'], {
    output, error,
    createService: async args => { created = args; return { listExecutors: async () => [{ id: 'fake', available: false }], close: async () => { closes++; } }; },
  });
  assert.equal(result, 0);
  assert.deepEqual(created.allowedRoots, [root]);
  assert.equal(created.inspectOnly, true);
  assert.deepEqual(JSON.parse(data), [{ id: 'fake', available: false }]);
  assert.equal(closes, 1);
});

test('real subprocess exchanges initialize/list/call and cancels a concurrent wait over stdio', async t => {
  const program = `
    const { main } = require(${JSON.stringify(cli)});
    let resolveWait;
    const service = {
      listExecutors: async () => [{ id: 'protocol-test', available: true }],
      waitTask: ({ taskId, signal }) => new Promise(resolve => {
        resolveWait = () => resolve({ taskId, status: 'cancelled' });
        signal.addEventListener('abort', resolveWait, { once: true });
      }),
      cancelTask: async ({ taskId }) => { resolveWait(); return { taskId, status: 'cancelled' }; },
      close: async () => {},
    };
    main(['--allow-root', ${JSON.stringify(root)}], { createService: async () => service }).then(code => { process.exitCode = code; });
  `;
  const child = spawn(process.execPath, ['-e', program], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const reader = createReader(child.stdout);
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const exited = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  send(initialize()); await reader.waitFor(1);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal((await reader.waitFor(2)).result.tools.length, tools.length);
  send(call(3, 'list_executors'));
  assert.equal(JSON.parse((await reader.waitFor(3)).result.content[0].text)[0].id, 'protocol-test');
  send(call(4, 'wait_task', { taskId: 'protocol-task', timeoutMs: 60000 }));
  // A ping round trip proves the wait frame was received before cancelling it.
  send({ jsonrpc: '2.0', id: 5, method: 'ping' }); await reader.waitFor(5);
  send(call(6, 'cancel_task', { taskId: 'protocol-task' }));
  assert.equal((await reader.waitFor(6)).result.structuredContent.status, 'cancelled');
  assert.equal((await reader.waitFor(4)).result.structuredContent.status, 'cancelled');
  child.stdin.end();
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.equal(stderr, '');
});

test('oversized input terminates a real stdio subprocess without requiring input EOF', async t => {
  const program = `const { createMcpServer } = require(${JSON.stringify(path.join(root, 'collaboration', 'mcp.cjs'))}); createMcpServer({ service: { close: async () => {} }, maxFrameBytes: 16 });`;
  const child = spawn(process.execPath, ['-e', program], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const reader = createReader(child.stdout);
  child.stderr.resume();
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Oversized input did not close server')), 3000);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  child.stdin.write('x'.repeat(32));
  assert.equal((await reader.waitFor(message => message.error)).error.code, -32600);
  assert.deepEqual(await exited, { code: 0, signal: null });
});

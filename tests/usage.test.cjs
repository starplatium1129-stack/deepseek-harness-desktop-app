const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');
const { summarizeSession, collectUsage, normalizeUsageEvent } = require('../integrations/usage.cjs');
const { redact } = require('../integrations/usage-redact.cjs');
const { build } = require('../src/usage-model.js');
const { HarnessProcess } = require('../src/runtime.cjs');
const fold = import(pathToFileURL(path.resolve(__dirname, '../runtime/harness/node_modules/@deepseek-ai/dsh-token-meter/lib/types/client.js')).href).then(m => m.deriveTurnTokenUsage);
const stamp = new Date(2026, 8, 13, 10).getTime();
function events(turn = 1, reason = 'completed') {
  const data = { turn, step: 1 };
  const usage = { inputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 0, outputTokens: 50, reasoningTokens: 20, totalTokens: 350 };
  return [
    { type: 'turn/start', time: stamp, data: { turn } },
    { type: 'step/start', time: stamp + 100, data },
    { type: 'assistant/message', time: stamp + 200, data: { ...data, usage, stream: [], message: { source: { provider: 'test', model: 'model-a' }, content: ['private text'] } } },
    { type: 'step/end', time: stamp + 300, data },
    { type: 'turn/end', time: stamp + 400, data: { turn, reason: { kind: reason } } },
  ];
}
const snap = log => ({ session: { id: 'session-1' }, inheritedEventCount: 0, events: log });
test('upstream fold is reused: cache and reasoning are not double counted', async () => {
  const summary = summarizeSession(snap(events()), await fold);
  assert.equal(summary.turns[0].usage.totalTokens, 350);
  const dashboard = build({ sessions: [summary] }, { now: stamp, days: 1 });
  assert.equal(dashboard.total, 350); assert.equal(dashboard.cacheRate, 2 / 3);
  assert.equal(dashboard.sessions[0].turns.length, 1);
  assert.equal(dashboard.input + dashboard.cache + dashboard.output + dashboard.other, 350);
  assert.equal(JSON.stringify(summary).includes('private text'), false);
});
test('fork inherited turns are excluded; reported failed turns remain counted', async () => {
  const summary = summarizeSession({ ...snap([...events(1), ...events(2, 'error')]), inheritedEventCount: 5 }, await fold);
  assert.equal(summary.turns.length, 1); assert.equal(summary.turns[0].turn, 2);
  assert.equal(summary.turns[0].usage.totalTokens, 350); assert.equal(summary.turns[0].status, 'error');
});
test('missing usage and interrupted open turns stay unknown', async () => {
  const log = events(); delete log[2].data.usage;
  const summary = summarizeSession(snap([...log, ...events(2).slice(0, 2)]), await fold);
  assert.equal(summary.turns[0].usage, null); assert.equal(summary.turns[1].usage, null);
  assert.equal(summary.turns[1].status, 'running');
  const result = build({ sessions: [summary] }, { now: stamp });
  assert.equal(result.unknown, 2); assert.equal(result.known, 0); assert.equal(result.cacheRate, null);
});
test('repeat refresh is stable; date, model and title filters have defined scope', async () => {
  const summary = summarizeSession(snap(events()), await fold);
  summary.title = 'Build settings';
  const snapshot = { sessions: [summary] };
  const params = { now: stamp, days: 7 };
  assert.deepEqual(build(snapshot, params), build(snapshot, params));
  assert.equal(build(snapshot, { ...params, model: 'other' }).total, 0);
  assert.equal(build(snapshot, { ...params, search: 'missing' }).sessions.length, 0);
  assert.equal(build(snapshot, { ...params, search: 'missing' }).total, 350);
  assert.equal(build(snapshot, { now: stamp + 86400000, days: 1 }).total, 0);
});
test('queries dispose observations and report unreadable or omitted sessions', async () => {
  let disposed = 0;
  const query = {
    async listSessions() { return ['a', 'b', 'c'].map(id => ({ header: { id } })); },
    async observeSession(id) { if (id === 'b') throw Error('broken'); return { header: { id }, events: events(), inheritedEventCount: 0, [Symbol.dispose]() { disposed++; } }; },
  };
  const result = await collectUsage(query, await fold, { maxSessions: 2 });
  assert.equal(result.sessions.length, 1); assert.equal(result.unavailable, 1); assert.equal(result.omitted, 1); assert.equal(disposed, 1);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(collectUsage(query, await fold, { signal: abort.signal }), { name: 'AbortError' });
});
test('known token snapshots with missing cache do not show a misleading cache ratio', async () => {
  const log = events(); delete log[2].data.usage.cacheReadTokens;
  const summary = summarizeSession(snap(log), await fold);
  const result = build({ sessions: [summary] }, { now: stamp });
  assert.equal(result.total, 350); assert.equal(result.cacheRate, null); assert.equal(result.other, 200);
});
test('contradictory exact totals are refused by upstream rather than fabricated', async () => {
  const log = events(); log[2].data.usage.totalTokens = 10;
  const summary = summarizeSession(snap(log), await fold);
  assert.equal(summary.turns[0].usage, null);
});
test('omitted zero cache counters do not erase hits from later steps in the same turn', async () => {
  const first = events(), second = events();
  delete first[2].data.usage.cacheReadTokens; delete first[2].data.usage.cacheWriteTokens;
  first[2].data.usage.totalTokens = 150;
  for (const event of second) if (event.data.step) event.data = { ...event.data, step: 2 };
  delete second[2].data.usage.cacheWriteTokens;
  const log = [...first.slice(0, -1), ...second.slice(1)];
  const result = summarizeSession(snap(log), await fold);
  assert.equal(result.turns[0].usage.cacheReadTokens, 200);
  assert.equal(result.turns[0].usage.cacheWriteTokens, 0);
  assert.equal(result.turns[0].usage.totalTokens, 500);
  assert.equal(first[2].data.usage.cacheReadTokens, undefined, 'Original events remain immutable');
  assert.equal(build({ sessions: [result] }, { now: stamp }).cacheRate, .5);
});
test('cache rate shows coverage for known rows instead of hiding all known hits', async () => {
  const complete = summarizeSession(snap(events()), await fold);
  const incomplete = events(2); delete incomplete[2].data.usage.cacheReadTokens;
  const missing = summarizeSession(snap(incomplete), await fold);
  const result = build({ sessions: [{ ...complete, turns: [...complete.turns, ...missing.turns] }] }, { now: stamp });
  assert.equal(result.cacheRate, 2 / 3); assert.equal(result.cacheKnown, 1); assert.equal(result.cacheUnknown, 1);
  assert.equal(normalizeUsageEvent(incomplete[2]), incomplete[2], 'Positive unexplained remainder stays unknown');
});
test('titles are sanitized before entering the dashboard', async () => {
  const summary = summarizeSession(snap([...events(), { type: 'session/title', data: { title: 'key=sk-secret123 api_key=private' } }]), await fold, redact);
  assert.equal(summary.title.includes('secret123'), false); assert.equal(summary.title.includes('private'), false);
});
test('private IPC matches requests, coalesces reads and removes listeners after success', async () => {
  const host = new HarnessProcess('', '', '');
  const child = host.child = new EventEmitter(); child.connected = true;
  let request;
  child.send = (message, callback) => { request = message; callback(); };
  const promise = host.readUsage(); assert.equal(host.readUsage(), promise);
  child.emit('message', { type: 'desktop:usage-result', id: 'wrong', snapshot: { sessions: ['wrong'] } });
  child.emit('message', { type: 'desktop:usage-result', id: request.id, snapshot: { sessions: [] } });
  assert.deepEqual(await promise, { sessions: [] });
  assert.equal(child.listenerCount('message'), 0); assert.equal(child.listenerCount('exit'), 0);
});
test('private IPC rejects promptly if Harness disconnects', async () => {
  const host = new HarnessProcess('', '', ''); const child = host.child = new EventEmitter(); child.connected = true; child.send = (_message, callback) => callback();
  const promise = host.readUsage(); child.emit('disconnect');
  await assert.rejects(promise, /停止/); assert.equal(child.listenerCount('message'), 0);
});

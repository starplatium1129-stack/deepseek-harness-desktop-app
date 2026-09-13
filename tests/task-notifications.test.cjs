const test = require('node:test');
const assert = require('node:assert/strict');
const { registerTaskNotifications } = require('../integrations/task-notifications.cjs');
function setup(transport) {
  let listener;
  registerTaskNotifications({ on(name, callback) { assert.equal(name, 'session/event'); listener = callback; } }, transport);
  return listener;
}
const end = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } });
test('completion is deduplicated per session, with no conversation content sent', () => {
  const messages = [], listener = setup({ connected: true, send(message, callback) { messages.push(message); callback(); } });
  const session = { header: {}, secret: 'private text' };
  listener(session, end(1)); listener(session, end(1)); listener(session, end(0));
  listener(session, end(2)); listener({ header: {} }, end(1));
  assert.deepEqual(messages, Array(3).fill({ type: 'desktop:task-completed' }));
});
test('failure, cancellation, intermediate events and subagents do not report completion', () => {
  const messages = [], listener = setup({ connected: true, send: message => messages.push(message) });
  for (const kind of ['error', 'aborted', 'blocked', 'max-tokens']) listener({ header: {} }, end(1, kind));
  listener({ header: {} }, { type: 'step/end' });
  listener({ header: {} }, end('invalid'));
  listener({ header: { parentSession: 'parent' } }, end(1));
  assert.equal(messages.length, 0);
});
test('missing or disconnected IPC never interrupts the task', () => {
  for (const transport of [{}, { connected: false, send() { throw Error(); } }, { connected: true, send() { throw Error(); } }]) {
    assert.doesNotThrow(() => setup(transport)({ header: {} }, end(1)));
  }
});

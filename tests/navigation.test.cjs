const test = require('node:test');
const assert = require('node:assert/strict');
const { commitNavigation } = require('../src/navigation.cjs');
function setup(executeJavaScript) {
  const calls = [], state = { page: 'home' };
  const view = { setVisible(value) { this.visible = value; calls.push('visible'); }, webContents: { isDestroyed: () => false, focus() { calls.push('focus'); }, executeJavaScript } };
  return { calls, state, view, win: { webContents: { focus() {} } }, publish: patch => { calls.push('publish'); Object.assign(state, patch); } };
}
test('a renderer that never settles cannot block native workspace visibility', () => {
  const ctx = setup(() => new Promise(() => {}));
  commitNavigation({ ...ctx, page: 'workspace', previous: 'home', generation: 1, keyboard: false });
  assert.equal(ctx.view.visible, true); assert.equal(ctx.state.page, 'workspace');
  assert.deepEqual(ctx.calls, ['visible', 'publish', 'focus']);
});
test('animation failure does not prevent keyboard focus or page state', () => {
  const ctx = setup(() => { throw new Error('renderer disposed'); });
  assert.doesNotThrow(() => commitNavigation({ ...ctx, page: 'workspace', previous: 'home', generation: 2, keyboard: true }));
  assert.equal(ctx.state.focusRequest, 2); assert.equal(ctx.view.visible, true);
});
test('rapid reversal remains committed to the last page with an old animation pending', () => {
  const ctx = setup(() => new Promise(() => {}));
  commitNavigation({ ...ctx, page: 'workspace', previous: 'home', generation: 1 });
  commitNavigation({ ...ctx, page: 'appearance', previous: 'workspace', generation: 2 });
  assert.equal(ctx.state.page, 'appearance'); assert.equal(ctx.view.visible, false);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const RendererFeedback = require('../src/renderer-feedback.js');

function element(textContent = '', action = '') {
  const listeners = new Map(), attributes = new Map(), classes = new Set();
  return {
    textContent, value: '', hidden: true, disabled: false, readOnly: false, dataset: action ? { action } : {},
    classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value), toggle() {} },
    addEventListener(type, listener) { listeners.set(type, listener); },
    emit(type) { return listeners.get(type)?.({ target: this }); },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); },
    focus() { this.focused = true; }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const elements = {
    check: element('', 'check'), download: element('', 'download'),
    'save-key': element(), 'api-key': element(),
    'key-message': element('默认密钥说明'), 'update-message': element('默认更新说明'),
    error: element(), 'error-message': element(), 'error-dismiss': element()
  };
  const responses = {}, calls = [];
  const document = {
    getElementById: id => elements[id],
    querySelectorAll: selector => selector === '[data-action]' ? [elements.check, elements.download] : []
  };
  const window = {
    desktop: {
      action(name, value) { calls.push({ name, value }); return responses[name].promise; },
      onState() {},
      state: () => new Promise(() => {})
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8'), { document, window, RendererFeedback, Error, Math, Date });
  return { calls, elements, responses };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('update controls lock their shared scope before the first request settles', async () => {
  const f = fixture(), request = deferred(); f.responses.check = request;
  f.elements.check.emit('click'); f.elements.check.emit('click');
  assert.equal(f.calls.filter(call => call.name === 'check').length, 1);
  assert.equal(f.elements.check.disabled, true); assert.equal(f.elements.download.disabled, true);
  request.resolve({}); await settle();
  assert.equal(f.elements.check.disabled, false); assert.equal(f.elements.download.disabled, false);
});

test('credential requests lock editing, preserve newer text and classify system failures correctly', async () => {
  const f = fixture(), first = deferred(); f.responses['save-key'] = first;
  f.elements['api-key'].value = 'submitted-key'; f.elements['save-key'].emit('click'); f.elements['save-key'].emit('click');
  assert.equal(f.calls.filter(call => call.name === 'save-key').length, 1);
  assert.equal(f.elements['api-key'].readOnly, true); assert.equal(f.elements['api-key'].getAttribute('aria-busy'), 'true');
  f.elements['api-key'].value = 'newer-unsaved-key'; first.resolve({}); await settle();
  assert.equal(f.elements['api-key'].value, 'newer-unsaved-key');
  assert.equal(f.elements['api-key'].readOnly, false); assert.equal(f.elements['api-key'].getAttribute('aria-busy'), null);

  const second = deferred(); f.responses['save-key'] = second; f.elements['save-key'].emit('click');
  second.resolve({ error: '系统凭据加密当前不可用。' }); await settle();
  assert.equal(f.elements['api-key'].getAttribute('aria-invalid'), null);
  assert.match(f.elements['key-message'].textContent, /系统凭据加密当前不可用/);
  f.elements['api-key'].value = 'edited-after-system-error'; f.elements['api-key'].emit('input');
  assert.match(f.elements['key-message'].textContent, /系统凭据加密当前不可用/);
});

test('key validation remains until the edited value actually satisfies the rule', () => {
  const f = fixture(), input = f.elements['api-key'];
  input.value = ''; f.elements['save-key'].emit('click');
  assert.match(f.elements['key-message'].textContent, /请输入/);
  input.value = 'x'.repeat(5000); input.emit('input');
  assert.match(f.elements['key-message'].textContent, /不能超过 4096/);
  input.value = 'x'.repeat(4097); input.emit('input');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  input.value = 'x'.repeat(4096); input.emit('input');
  assert.equal(input.getAttribute('aria-invalid'), null);
});

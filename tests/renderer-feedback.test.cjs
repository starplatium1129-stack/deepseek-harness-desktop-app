const test = require('node:test');
const assert = require('node:assert/strict');
const { create, describeFailure, scopeFor } = require('../src/renderer-feedback.js');

function element(textContent = '') {
  const classes = new Set(), attributes = new Map();
  let text = textContent, writes = 0;
  return {
    get textContent() { return text; },
    set textContent(value) { text = value; writes++; },
    get writes() { return writes; },
    hidden: true, dataset: {}, focused: false,
    classList: {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
      contains: value => classes.has(value)
    },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: name => attributes.get(name) ?? null,
    removeAttribute: name => attributes.delete(name),
    focus() { this.focused = true; }
  };
}

function fixture() {
  const elements = {
    'key-message': element('默认密钥说明'),
    'update-message': element('默认更新说明'),
    'api-key': element(),
    error: element(),
    'error-message': element()
  };
  return { elements, feedback: create({ getElementById: id => elements[id] }) };
}

test('action failures explain impact and recovery without exposing extra state', () => {
  assert.equal(describeFailure('save-key', '密钥格式无效。'), '保存失败：密钥格式无效。 输入内容已保留，请检查后重试。');
  assert.equal(describeFailure('check', '连接中断。'), '检查失败：连接中断。 当前版本不受影响，请稍后重试。');
  assert.equal(describeFailure('download', '校验失败。'), '下载验证失败：校验失败。 当前版本不受影响，请重新下载。');
  assert.equal(scopeFor('save-key'), 'key-message');
  assert.equal(scopeFor('check'), 'update-message');
  assert.equal(scopeFor('download'), 'update-message');
  assert.equal(scopeFor('home'), '');
});

test('validation errors survive state refreshes and unrelated actions until input is corrected', () => {
  const { elements, feedback } = fixture();
  feedback.render({ keyMessage: '已使用 Windows 加密保存。', updateMessage: '当前已是最新版本。' });
  feedback.validation('save-key', 'API Key 不能超过 4096 个字符。');
  assert.equal(elements['key-message'].getAttribute('role'), 'alert');
  assert.equal(elements['api-key'].getAttribute('aria-invalid'), 'true');
  assert.match(elements['key-message'].textContent, /不能超过/);

  feedback.render({ keyMessage: '后台状态刷新不应覆盖错误。' });
  feedback.begin('home');
  assert.match(elements['key-message'].textContent, /不能超过/);

  feedback.clearValidation('save-key');
  assert.equal(elements['key-message'].textContent, '后台状态刷新不应覆盖错误。');
  assert.equal(elements['key-message'].getAttribute('role'), 'status');
  assert.equal(elements['api-key'].getAttribute('aria-invalid'), null);
});

test('credential operation failures do not mark valid input invalid or clear on editing', () => {
  const { elements, feedback } = fixture();
  feedback.render({ keyMessage: '普通帮助文本' });
  feedback.failure('save-key', '系统凭据加密当前不可用。');
  assert.equal(elements['api-key'].getAttribute('aria-invalid'), null);
  assert.equal(elements['key-message'].dataset.errorKind, 'operation');
  feedback.clearValidation('save-key');
  assert.match(elements['key-message'].textContent, /系统凭据加密当前不可用/);
  feedback.begin('save-key');
  assert.equal(elements['key-message'].textContent, '普通帮助文本');
});

test('unchanged status renders do not rewrite live regions', () => {
  const { elements, feedback } = fixture();
  feedback.render({ keyMessage: '已保存。', updateMessage: '已是最新版本。' });
  const keyWrites = elements['key-message'].writes, updateWrites = elements['update-message'].writes;
  feedback.render({ keyMessage: '已保存。', updateMessage: '已是最新版本。', zoom: 1.25 });
  assert.equal(elements['key-message'].writes, keyWrites);
  assert.equal(elements['update-message'].writes, updateWrites);
});

test('update errors share one persistent region and clear only when that flow retries', () => {
  const { elements, feedback } = fixture();
  feedback.render({ updateMessage: '手动检查更新。' });
  feedback.failure('check', '无法连接。');
  feedback.render({ updateMessage: '准备下载。' });
  feedback.begin('home');
  assert.match(elements['update-message'].textContent, /无法连接/);
  feedback.begin('download');
  assert.equal(elements['update-message'].textContent, '准备下载。');
  assert.equal(elements['update-message'].getAttribute('role'), 'status');
});

test('generic errors remain visible across unrelated actions and can be dismissed', () => {
  const { elements, feedback } = fixture();
  const trigger = element();
  feedback.failure('restart', '请等待当前操作完成。', trigger);
  assert.equal(elements.error.hidden, false);
  assert.equal(elements.error.dataset.action, 'restart');
  feedback.begin('home');
  assert.equal(elements.error.hidden, false);
  feedback.begin('restart');
  assert.equal(elements.error.hidden, true);
  assert.equal(trigger.focused, false);

  feedback.failure('logs', '无法打开日志。', trigger);
  feedback.dismiss();
  assert.equal(elements.error.hidden, true);
  assert.equal(elements['error-message'].textContent, '');
  assert.equal(trigger.focused, true);
});

test('empty key validation is inline and persistent', () => {
  const { elements, feedback } = fixture();
  feedback.validation('save-key', '请输入 API Key 后再保存。');
  const writes = elements['key-message'].writes;
  feedback.validation('save-key', '请输入 API Key 后再保存。');
  assert.equal(elements['key-message'].writes, writes);
  feedback.render({ keyMessage: '普通帮助文本' });
  assert.equal(elements['key-message'].textContent, '请输入 API Key 后再保存。');
  assert.equal(elements['api-key'].getAttribute('aria-invalid'), 'true');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { acceptsThemeEvent } = require('../src/appearance-adapter.cjs');
test('theme bridge accepts only the current loopback main frame and known preferences', () => {
  const origin = 'http://127.0.0.1:12345', frame = { url: origin + '/' };
  const contents = { mainFrame: frame, getURL: () => origin + '/', isDestroyed: () => false };
  const event = { sender: contents, senderFrame: frame };
  assert.equal(acceptsThemeEvent(event, contents, origin, 'dark'), true);
  for (const mode of ['../credential.bin', {}, null, 'automatic']) assert.equal(acceptsThemeEvent(event, contents, origin, mode), false);
  assert.equal(acceptsThemeEvent({ ...event, sender: {} }, contents, origin, 'dark'), false);
  assert.equal(acceptsThemeEvent({ ...event, senderFrame: { url: frame.url } }, contents, origin, 'dark'), false);
  frame.url = 'https://example.com'; assert.equal(acceptsThemeEvent(event, contents, origin, 'dark'), false);
});
test('public theme events repaint immediately, report upstream choices once, and do not echo desktop changes', () => {
  const dom = new Map(), events = new Map(), reports = [], paints = [];
  let preference = 'light';
  const context = { window: {
    __desktopAppearance: { settings: { mode: 'light', preset: 'glass' } },
    DesktopAppearance: { apply: payload => paints.push(payload.settings.mode) },
    desktopTheme: { report: mode => reports.push(mode) },
    addEventListener: (name, fn) => dom.set(name, fn), removeEventListener: name => dom.delete(name),
    __ModuleLoader__: { load: plugin => plugin.factory().apply({
      uiWorkspace: { openSession() {} },
      settingsScope: { bind: () => ({ getSnapshot: () => ({ status: 'ready', revision: 0, value: { preference: 'light' } }), subscribe: () => () => {} }) },
      theme: { getTheme: () => ({ preference }), setTheme: mode => { preference = mode; events.get('theme/change')?.({ preference }); } },
      on: (name, fn) => events.set(name, fn),
    }) },
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../integrations/client.js'), 'utf8'), context);
  assert.deepEqual(reports, []);
  preference = 'dark'; events.get('theme/change')({ preference });
  assert.equal(paints.at(-1), 'dark'); assert.deepEqual(reports, ['dark']);
  events.get('theme/change')({ preference }); assert.deepEqual(reports, ['dark']);
  dom.get('desktop:appearance')({ detail: { mode: 'light' } });
  assert.equal(preference, 'light'); assert.equal(paints.at(-1), 'light'); assert.deepEqual(reports, ['dark']);
  preference = 'system'; events.get('theme/change')({ preference }); assert.deepEqual(reports, ['dark', 'system']);
  events.get('dispose')(); assert.equal(dom.size, 0);
});
test('startup waits for the namespace and ignores adoption of its unchanged pre-write value', () => {
  const dom = new Map(), events = new Map(), reports = [], writes = [];
  let preference = 'system', scopeListener, saved = { status: 'loading', revision: undefined, value: undefined };
  const context = { window: {
    __desktopAppearance: { settings: { mode: 'dark' } }, DesktopAppearance: { apply() {} }, desktopTheme: { report: mode => reports.push(mode) },
    addEventListener: (name, fn) => dom.set(name, fn), removeEventListener() {},
    __ModuleLoader__: { load: plugin => plugin.factory().apply({
      uiWorkspace: { openSession() {} },
      settingsScope: { bind: () => ({ getSnapshot: () => saved, subscribe: fn => { scopeListener = fn; return () => {}; } }) },
      theme: { getTheme: () => ({ preference }), setTheme: mode => { writes.push(mode); preference = mode; events.get('theme/change')?.({ preference }); } },
      on: (name, fn) => events.set(name, fn),
    }) },
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../integrations/client.js'), 'utf8'), context);
  assert.deepEqual(writes, []);
  saved = { status: 'ready', revision: 0, value: { preference: 'system' } }; scopeListener();
  assert.deepEqual(writes, ['dark']); assert.deepEqual(reports, []);
  preference = 'system'; events.get('theme/change')({ preference }); assert.deepEqual(reports, []);
  saved = { status: 'ready', revision: 1, value: { preference: 'dark' } }; preference = 'dark'; scopeListener();
  assert.deepEqual(reports, []);
  preference = 'light'; events.get('theme/change')({ preference }); assert.deepEqual(reports, ['light']);
});

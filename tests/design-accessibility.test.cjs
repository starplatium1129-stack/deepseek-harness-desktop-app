const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = name => fs.readFileSync(path.join(__dirname, '../src', name), 'utf8');
const appearance = src('appearance.css');
const desktop = src('desktop.css');

function variables(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = appearance.match(new RegExp(`${escaped}\\{([^}]*)\\}`))[1];
  return Object.fromEntries([...block.matchAll(/--([\w-]+):([^;}]+)/g)].map(match => [match[1], match[2].trim()]));
}

function rgb(hex) {
  return hex.match(/[\da-f]{2}/gi).map(value => parseInt(value, 16) / 255);
}

function luminance(hex) {
  const [r, g, b] = rgb(hex).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126 * r + .7152 * g + .0722 * b;
}

function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + .05) / (values[1] + .05);
}

test('semantic action, data and error colors meet normal-text contrast targets', () => {
  const light = variables(':root'), dark = variables(':root[data-scheme=dark]');
  const pairs = [
    [light['action-text'], '#ffffff'],
    [light.muted, '#ffffff'],
    [light['data-value'], '#ffffff'],
    [light['error-text'], light['error-surface']],
    [dark['action-text'], dark.surface],
    [dark.muted, dark.surface],
    [dark['data-value'], '#191e2a'],
    [dark['error-text'], dark['error-surface']]
  ];
  for (const [foreground, background] of pairs) assert.ok(contrast(foreground, background) >= 4.5, `${foreground} on ${background}`);
});

test('trend legend palettes remain readable in both color schemes', () => {
  const colors = scheme => Object.fromEntries([...desktop.matchAll(new RegExp(`:root\\[data-scheme=${scheme}\\] \\.trend-(\\w+)\\{color:(#[\\da-f]{6})\\}`, 'g'))].map(match => [match[1], match[2]]));
  const light = colors('light'), dark = colors('dark');
  for (const name of ['cost', 'creation', 'cache', 'input', 'output', 'other']) {
    assert.ok(contrast(light[name], '#ffffff') >= 4.5, `${name} ${light[name]} on light reading surface`);
    assert.ok(contrast(dark[name], '#202735') >= 4.5, `${name} ${dark[name]} on dark reading surface`);
  }
});

test('final desktop layer maps audited elements to semantic colors', () => {
  assert.match(desktop, /\.text-button\{color:var\(--action-text\)\}/);
  assert.match(desktop, /#key-state\{color:var\(--muted\)\}/);
  assert.doesNotMatch(desktop, /label span\{color:/);
  assert.match(desktop, /\.session-amount,\.turn-buckets dd\{color:var\(--data-value\)\}/);
  assert.match(desktop, /\.inline-error\{color:var\(--error-text\)!important\}/);
  assert.match(desktop, /html\[data-appearance\] :is\(\.grid>\.card,\.status-card,\.usage-card,\.metric:not\(\.metric-primary\),\.appearance-layout>\.card\)\{background:var\(--reading-surface\)!important;backdrop-filter:none!important\}/);
  assert.match(desktop, /footer\{[^}]*background:var\(--reading-surface\)/);
});

test('inactive trend controls stay fully opaque and retain a non-color state cue', () => {
  const rule = desktop.match(/\.trend-legend\[aria-pressed=false\]\{([^}]*)\}/)[1];
  assert.match(rule, /opacity:1/);
  assert.match(rule, /text-decoration:line-through/);
});

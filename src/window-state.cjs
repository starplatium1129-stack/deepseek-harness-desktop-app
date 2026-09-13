const fs = require('node:fs/promises');
const path = require('node:path');
const zoomSteps = [.75, .9, 1, 1.1, 1.25, 1.5, 1.75, 2];
function normalize(raw = {}) {
  if (!raw || typeof raw !== 'object') raw = {};
  const state = { width: 1320, height: 880, maximized: raw.maximized === true, zoom: zoomSteps.includes(raw.zoom) ? raw.zoom : 1 };
  for (const key of ['width', 'height']) if (Number.isFinite(raw[key]) && raw[key] > 0) state[key] = Math.round(Math.min(10000, raw[key]));
  for (const key of ['x', 'y']) if (Number.isFinite(raw[key]) && Math.abs(raw[key]) < 100000) state[key] = Math.round(raw[key]);
  return state;
}
function fitWindow(raw, displays) {
  const s = normalize(raw), areas = displays.map(d => d.workArea);
  if (!areas.length) throw new Error('No display available');
  const center = { x: (s.x ?? areas[0].x) + s.width / 2, y: (s.y ?? areas[0].y) + s.height / 2 };
  const area = areas.find(a => center.x >= a.x && center.x < a.x + a.width && center.y >= a.y && center.y < a.y + a.height) || areas[0];
  const minWidth = Math.min(760, area.width), minHeight = Math.min(560, area.height);
  const width = Math.min(area.width, Math.max(minWidth, s.width)), height = Math.min(area.height, Math.max(minHeight, s.height));
  const x = Math.max(area.x, Math.min(area.x + area.width - width, s.x ?? area.x + (area.width - width) / 2));
  const y = Math.max(area.y, Math.min(area.y + area.height - height, s.y ?? area.y + (area.height - height) / 2));
  return { ...s, x: Math.round(x), y: Math.round(y), width, height, minWidth, minHeight };
}
class WindowState {
  constructor(directory) { this.file = path.join(directory, 'window-state.json'); this.queue = Promise.resolve(); }
  async read() {
    try { return normalize(JSON.parse(await fs.readFile(this.file, 'utf8'))); }
    catch { return normalize(); /* Optional window preferences must never prevent startup. */ }
  }
  save(state) {
    const value = normalize(state);
    const next = this.queue.then(async () => { await fs.writeFile(this.file + '.tmp', JSON.stringify(value)); await fs.rename(this.file + '.tmp', this.file); });
    this.queue = next.catch(() => {}); return next;
  }
}
function shortcut(input) {
  if (input.type !== 'keyDown' || input.isComposing || input.alt || input.meta || input.isAutoRepeat) return null;
  const key = input.key.toLowerCase();
  if (!input.control && key === 'f6') return 'focus-cycle';
  if (!input.control && !input.shift && key === 'f1') return 'shortcuts';
  if (!input.control) return null;
  if (!input.shift && ['1', '2', '3', '4'].includes(key)) return ['workspace', 'usage', 'home', 'appearance'][Number(key) - 1];
  if (!input.shift && key === ',') return 'appearance';
  if (key === '+' || key === '=') return 'zoom-in';
  if (key === '-' || key === '_') return 'zoom-out';
  if (key === '0' && !input.shift) return 'zoom-reset';
  return null;
}
module.exports = { WindowState, fitWindow, normalize, zoomSteps, shortcut };

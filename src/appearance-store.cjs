const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const DEFAULTS = Object.freeze({ preset: 'classic', mode: 'system', background: 'default', color: '#a6b8db', fit: 'cover', blur: 18, lightOverlay: 35, darkOverlay: 55, motion: 'system', lowEffects: false });
function normalize(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
  const out = { ...DEFAULTS };
  for (const [key, values] of Object.entries({ preset: ['classic', 'glass'], mode: ['system', 'light', 'dark'], background: ['default', 'gradient', 'solid', 'image'], fit: ['cover', 'contain'], motion: ['system', 'full', 'reduced'] })) if (values.includes(input[key])) out[key] = input[key];
  if (typeof input.color === 'string' && /^#[\da-f]{6}$/i.test(input.color)) out.color = input.color;
  for (const [key, max] of Object.entries({ blur: 40, lightOverlay: 90, darkOverlay: 90 })) if (Number.isFinite(input[key])) out[key] = Math.max(0, Math.min(max, input[key]));
  out.lowEffects = input.lowEffects === true;
  if (typeof input.wallpaper === 'string' && /^[\da-f-]{36}\.jpg$/.test(input.wallpaper)) out.wallpaper = input.wallpaper;
  return out;
}
class AppearanceStore {
  constructor(directory) { this.dir = path.join(directory, 'appearance'); this.file = path.join(this.dir, 'settings.json'); this.queue = Promise.resolve(); }
  async read() {
    let settings;
    try { settings = normalize(JSON.parse(await fs.readFile(this.file, 'utf8'))); }
    catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; settings = { ...DEFAULTS }; }
    let wallpaperUrl = '';
    if (settings.wallpaper) {
      try { wallpaperUrl = 'data:image/jpeg;base64,' + (await fs.readFile(path.join(this.dir, settings.wallpaper))).toString('base64'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    if (settings.background === 'image' && !wallpaperUrl) settings.background = 'default';
    return { settings, wallpaperUrl };
  }
  mutate(operation) { const next = this.queue.then(operation); this.queue = next.catch(() => {}); return next; }
  async write(settings) {
    await fs.mkdir(this.dir, { recursive: true });
    const temporary = this.file + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(settings, null, 2));
    await fs.rename(temporary, this.file);
  }
  save(input) { return this.mutate(async () => {
    const previous = await this.read();
    const settings = normalize({ ...previous.settings, ...input, wallpaper: previous.settings.wallpaper });
    await this.write(settings); return this.read();
  }); }
  importImage(file, nativeImage) { return this.mutate(async () => {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('请选择不超过 20 MB 的静态图片。');
    if (!/\.(png|jpe?g|webp)$/i.test(file)) throw new Error('支持 PNG、JPEG 和 WebP 图片。');
    let img = nativeImage.createFromBuffer(await fs.readFile(file));
    if (img.isEmpty()) throw new Error('无法读取这张图片，请换一张重试。');
    const size = img.getSize();
    if (Math.max(size.width, size.height) > 2560) img = img.resize(size.width >= size.height ? { width: 2560 } : { height: 2560 });
    const previous = await this.read();
    const wallpaper = randomUUID() + '.jpg';
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, wallpaper), img.toJPEG(88));
    await this.write({ ...previous.settings, background: 'image', wallpaper });
    if (previous.settings.wallpaper) await fs.rm(path.join(this.dir, previous.settings.wallpaper), { force: true }).catch(() => {});
    return this.read();
  }); }
  reset() { return this.mutate(async () => {
    const previous = await this.read(); await this.write(DEFAULTS);
    if (previous.settings.wallpaper) await fs.rm(path.join(this.dir, previous.settings.wallpaper), { force: true }).catch(() => {});
    return this.read();
  }); }
}
module.exports = { AppearanceStore, normalize, DEFAULTS };

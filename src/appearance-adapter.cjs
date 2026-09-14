// Presentation adapter for @deepseek-ai/dsh-client-ui-* 0.1.5-rc.2.
// All upstream selectors stay here / in appearance-workspace.css; no bundle patches.
const fs = require('node:fs/promises');
const path = require('node:path');
class AppearanceAdapter {
  constructor() { this.keys = new WeakMap(); this.queue = Promise.resolve(); }
  apply(contents, payload) {
    const next = this.queue.then(async () => {
      if (!contents || contents.isDestroyed()) return;
      const [script, css, motion, glass, design, workspace, accessibility] = await Promise.all([
        fs.readFile(path.join(__dirname, 'appearance-theme.js'), 'utf8'),
        fs.readFile(path.join(__dirname, 'appearance-workspace.css'), 'utf8'),
        fs.readFile(path.join(__dirname, 'fluid-motion.js'), 'utf8'),
        fs.readFile(path.join(__dirname, 'liquid-glass.js'), 'utf8'),
        fs.readFile(path.join(__dirname, 'fluid-design.css'), 'utf8'),
        fs.readFile(path.join(__dirname, 'appearance-workspace.js'), 'utf8'),
        fs.readFile(path.join(__dirname, 'accessibility.css'), 'utf8'),
      ]);
      const key = await contents.insertCSS(css + '\n' + design + '\n' + accessibility);
      const previous = this.keys.get(contents); this.keys.set(contents, key);
      if (previous) await contents.removeInsertedCSS(previous);
      await contents.executeJavaScript(`${motion}\n${glass}\n${script}\ndocument.documentElement.dataset.appearanceHost = 'workspace';\nwindow.__desktopAppearance = ${JSON.stringify(payload)};
        DesktopAppearance.apply(window.__desktopAppearance);
        window.dispatchEvent(new CustomEvent('desktop:appearance', { detail: { mode: window.__desktopAppearance.settings.mode } }));
        if (!window.__desktopAppearanceMedia) {
          window.__desktopAppearanceMedia = true;
          for (const query of ['(prefers-color-scheme: dark)', '(prefers-reduced-motion: reduce)']) matchMedia(query).addEventListener('change', () => DesktopAppearance.apply(window.__desktopAppearance));
        }\n${workspace}`);
    });
    this.queue = next.catch(() => {}); return next;
  }
}
function acceptsThemeEvent(event, contents, origin, mode) {
  if (!['light', 'dark', 'system'].includes(mode) || !contents || contents.isDestroyed() || event.sender !== contents || event.senderFrame !== contents.mainFrame) return false;
  try { return new URL(event.senderFrame.url).origin === origin && new URL(contents.getURL()).origin === origin; } catch { return false; }
}
module.exports = { AppearanceAdapter, acceptsThemeEvent };

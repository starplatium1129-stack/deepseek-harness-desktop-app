/* MIT. Framework-independent motion primitives. See docs/apple-design-reference.md. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (!root.FluidMotion) root.FluidMotion = api;
})(globalThis, function () {
  const profiles = Object.freeze({ navigation: { frequency: 3.8, damping: 1 }, control: { frequency: 5.5, damping: .86 }, presentation: { frequency: 3.4, damping: .94 }, sidebar: { frequency: 4.2, damping: 1 } });
  class Spring {
    constructor(value, options = profiles.navigation) { this.value = value; this.velocity = 0; this.target = value; this.frequency = options.frequency; this.damping = options.damping; }
    to(target) { this.target = target; return this; }
    snap(target = this.target) { this.value = this.target = target; this.velocity = 0; return this; }
    step(dt) {
      // Exact closed-form solution, so 60/120 Hz and dropped frames follow the same trajectory.
      const w = 2 * Math.PI * this.frequency, z = this.damping, x = this.value - this.target, v = this.velocity;
      if (z < 1) {
        const a = z * w, b = w * Math.sqrt(1 - z * z), c = (v + a * x) / b;
        const e = Math.exp(-a * dt), cos = Math.cos(b * dt), sin = Math.sin(b * dt);
        this.value = this.target + e * (x * cos + c * sin);
        this.velocity = e * ((-a * x + b * c) * cos + (-a * c - b * x) * sin);
      } else {
        const c = v + w * x, e = Math.exp(-w * dt);
        this.value = this.target + (x + c * dt) * e;
        this.velocity = (v - w * c * dt) * e;
      }
      if (Math.abs(this.value - this.target) < .0005 && Math.abs(this.velocity) < .005) this.snap();
      return this.value;
    }
    get settled() { return this.value === this.target && this.velocity === 0; }
  }
  const active = new Set(), channels = new WeakMap();
  let frame = 0, last = 0, installed = false, currentRoute, snapshotVersion = 0;
  const reduced = () => typeof document === 'undefined' || document.documentElement.dataset.motion !== 'full';
  function tick(now) {
    const dt = last ? Math.max(0, (now - last) / 1000) : 1 / 60; last = now;
    for (const track of [...active]) {
      if (reduced()) track.spring.snap(); else track.spring.step(dt);
      track.write(track.spring.value);
      if (track.spring.settled) { active.delete(track); const done = track.done; track.done = null; done?.(); }
    }
    frame = active.size ? requestAnimationFrame(tick) : 0;
    if (!frame) last = 0;
  }
  function animate(owner, key, target, write, options = {}) {
    let map = channels.get(owner); if (!map) channels.set(owner, map = new Map());
    let track = map.get(key);
    if (!track) {
      track = { spring: new Spring(options.from ?? target, profiles[options.profile] || profiles.navigation), write };
      map.set(key, track);
    }
    track.write = write; track.done = options.done;
    track.spring.to(target); // Never zero velocity on a retarget.
    if (Number.isFinite(options.velocity)) track.spring.velocity = options.velocity;
    if (options.snap || reduced()) {
      track.spring.snap(); active.delete(track); write(target); const done = track.done; track.done = null; done?.();
    } else { active.add(track); if (!frame) frame = requestAnimationFrame(tick); }
    return track.spring;
  }
  function cancel(owner) { const map = channels.get(owner); if (map) for (const track of map.values()) active.delete(track); channels.delete(owner); }
  function adopt(from, to) { const map = channels.get(from); if (map) { cancel(to); channels.set(to, map); channels.delete(from); } }
  function finish() {
    for (const track of [...active]) { track.spring.snap(); track.write(track.spring.value); active.delete(track); const done = track.done; track.done = null; done?.(); }
    if (frame) cancelAnimationFrame(frame); frame = 0; last = 0;
  }
  function visual(el, target, options = {}) {
    for (const [key, value] of Object.entries(target)) {
      const write = key === 'opacity' ? v => el.style.opacity = Math.max(0, Math.min(1, v)) : key === 'scale' ? v => el.style.scale = String(v) : v => el.style.translate = `0 ${v}px`;
      animate(el, key, value, write, { ...options, from: options.from?.[key], done: key === 'opacity' ? options.done : undefined });
    }
  }
  function indicator(nav, button) {
    if (!nav || !button) return;
    let pill = nav.querySelector('.fluid-selection');
    if (!pill) { pill = document.createElement('span'); pill.className = 'fluid-selection'; pill.setAttribute('aria-hidden', 'true'); nav.prepend(pill); }
    animate(pill, 'x', button.offsetLeft, v => pill.style.left = `${v}px`, { profile: 'control' });
    animate(pill, 'width', button.offsetWidth, v => pill.style.width = `${v}px`, { profile: 'control' });
    pill.style.top = `${button.offsetTop}px`; pill.style.height = `${button.offsetHeight}px`;
  }
  function toggle(el, checked) { animate(el, 'switch', checked ? 17 : 2, v => el.style.setProperty('--switch-x', `${v}px`), { profile: 'control' }); }
  function route(name) {
    const mapping = { home: 'management-page', usage: 'usage-page', appearance: 'appearance-page' };
    indicator(document.querySelector('header nav'), document.getElementById(name));
    if (currentRoute === name) return;
    const oldName = currentRoute; currentRoute = name;
    const oldScroll = window.scrollY; window.scrollTo({ top: 0, behavior: 'instant' });
    for (const [key, id] of Object.entries(mapping)) {
      const el = document.getElementById(id); if (!el) continue;
      const incoming = key === name;
      el.inert = !incoming; el.setAttribute('aria-hidden', String(!incoming));
      if (incoming) {
        const wasHidden = el.hidden; el.hidden = false; el.classList.remove('fluid-departing'); el.style.top = '';
        if (wasHidden) cancel(el);
        visual(el, { y: 0, scale: 1, opacity: 1 }, { from: { y: 12, scale: .994, opacity: 0 } });
      } else if (!el.hidden) {
        el.classList.add('fluid-departing'); if (key === oldName) el.style.top = `${-oldScroll}px`;
        visual(el, { y: -8, scale: .994, opacity: 0 }, { done: () => { if (currentRoute !== key) { el.hidden = true; el.classList.remove('fluid-departing'); cancel(el); } } });
      }
    }
  }
  const dialogs = new WeakMap();
  function openDialog(dialog, source) {
    let state = dialogs.get(dialog);
    if (!dialog.open) {
      cancel(dialog);
      dialog.style.transform = ''; dialog.style.opacity = ''; dialog.style.removeProperty('--presentation');
      dialog.showModal();
      const to = dialog.getBoundingClientRect(), from = source?.getBoundingClientRect();
      state = { source, x: from ? from.left + from.width / 2 - (to.left + to.width / 2) : 0, y: from ? from.top + from.height / 2 - (to.top + to.height / 2) : 24, progress: 0 };
      dialogs.set(dialog, state);
      dialog.style.transform = `translate(${state.x}px,${state.y}px) scale(.18)`;
      dialog.style.opacity = '0';
    }
    state.closing = false;
    animate(dialog, 'presentation', 1, p => {
      state.progress = p;
      dialog.style.transform = `translate(${state.x * (1 - p)}px,${state.y * (1 - p)}px) scale(${.18 + .82 * p})`;
      dialog.style.opacity = Math.min(1, Math.max(0, p * 2));
      dialog.style.setProperty('--presentation', Math.max(0, Math.min(1, p)));
    }, { from: 0, profile: 'presentation' });
  }
  function closeDialog(dialog, instant = false) {
    const state = dialogs.get(dialog); if (!dialog.open) return;
    if (!state || instant) { cancel(dialog); dialog.close(); dialog.style.transform = ''; dialog.style.opacity = ''; return; }
    state.closing = true;
    animate(dialog, 'presentation', 0, p => {
      state.progress = p;
      dialog.style.transform = `translate(${state.x * (1 - p)}px,${state.y * (1 - p)}px) scale(${.18 + .82 * p})`;
      dialog.style.opacity = Math.min(1, Math.max(0, p * 2)); dialog.style.setProperty('--presentation', Math.max(0, Math.min(1, p)));
    }, { profile: 'presentation', done: () => { if (state.closing) { dialog.close(); dialog.style.transform = ''; dialog.style.opacity = ''; state.source?.focus({ preventScroll: true }); cancel(dialog); } } });
  }
  async function snapshot(url, offset = 0) {
    const version = ++snapshotVersion;
    document.querySelectorAll('.fluid-snapshot').forEach(el => { cancel(el); el.remove(); });
    if (reduced() || !url?.startsWith('data:image/png;base64,')) return;
    const img = document.createElement('img'); img.className = 'fluid-snapshot'; img.alt = ''; img.setAttribute('aria-hidden', 'true'); img.src = url; img.style.top = `${offset}px`;
    await img.decode().catch(() => {}); if (version !== snapshotVersion || reduced() || document.hidden) return; document.body.append(img);
    visual(img, { opacity: 0, scale: .992 }, { from: { opacity: 1, scale: 1 }, done: () => { img.remove(); cancel(img); } });
  }
  function install() {
    if (installed) return; installed = true;
    const pressed = new Map();
    const release = id => { const el = pressed.get(id); if (el) { pressed.delete(id); animate(el, 'press', 1, v => el.style.scale = String(v), { profile: 'control' }); } };
    document.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const el = event.target.closest('button:not(:disabled)'); if (!el) return;
      el.dataset.fluidPress = ''; pressed.set(event.pointerId, el);
      animate(el, 'press', .965, v => el.style.scale = String(v), { from: 1, profile: 'control' });
    }, true);
    document.addEventListener('pointerup', event => release(event.pointerId), true);
    document.addEventListener('pointercancel', event => release(event.pointerId), true);
    window.addEventListener('blur', () => [...pressed.keys()].forEach(release));
    document.addEventListener('cancel', event => { if (event.target instanceof HTMLDialogElement) { event.preventDefault(); closeDialog(event.target); } }, true);
    document.addEventListener('visibilitychange', () => { if (document.hidden) finish(); });
    new MutationObserver(() => { if (reduced()) finish(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
    window.addEventListener('resize', () => indicator(document.querySelector('header nav'), document.getElementById(currentRoute)));
  }
  return { Spring, profiles, animate, visual, cancel, adopt, finish, reduced, route, indicator, toggle, openDialog, closeDialog, snapshot, install, get activeCount() { return active.size; } };
});

(() => {
  FluidMotion.install(); LiquidGlass.install();
  const $ = id => document.getElementById(id);
  let current, pending = Promise.resolve(), revision = 0, serverRevision = -1, outstanding = 0, latestRemote;
  const fields = ['mode', 'background', 'color', 'fit', 'blur', 'lightOverlay', 'darkOverlay', 'motion', 'lowEffects'];
  function draw(payload) {
    if (Number.isFinite(payload.revision)) {
      if (payload.revision < serverRevision) return;
      serverRevision = payload.revision;
    }
    current = payload; DesktopAppearance.apply(payload);
    for (const key of fields) { const el = $('appearance-' + key); if (el.type === 'checkbox') { el.checked = payload.settings[key]; FluidMotion.toggle(el, el.checked); } else el.value = payload.settings[key]; }
    document.querySelectorAll('[data-preset]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.preset === payload.settings.preset)));
    for (const key of ['blur', 'lightOverlay', 'darkOverlay']) $(key + '-value').textContent = payload.settings[key] + (key === 'blur' ? ' px' : '%');
    $('wallpaper-color-row').hidden = payload.settings.background !== 'solid';
    $('wallpaper-fit-row').hidden = payload.settings.background !== 'image';
    $('wallpaper-state').textContent = payload.wallpaperUrl ? '图片已保存在本机' : 'PNG / JPEG / WebP · 最大 20 MB';
    $('appearance-blur').disabled = payload.settings.lowEffects;
  }
  async function invoke(name, value) { const result = await window.desktop.action(name, value); if (result?.error) throw new Error(result.error); return result; }
  function persist(name, value) {
    const ticket = ++revision;
    outstanding++;
    $('appearance-feedback').textContent = '正在保存…';
    pending = pending.then(async () => {
      try {
        const result = await invoke(name, value);
        if (ticket === revision) { draw(latestRemote?.revision > result.revision ? latestRemote : result); $('appearance-feedback').textContent = '已保存 · 外观已生效'; }
      } catch (error) {
        if (ticket === revision) { $('appearance-feedback').textContent = error.message; try { draw(await invoke('appearance-read')); } catch {} }
      } finally {
        outstanding--;
        if (!outstanding && latestRemote) { draw(latestRemote); latestRemote = undefined; }
      }
    });
  }
  function change(patch) {
    if (!current) return;
    draw({ ...current, settings: { ...current.settings, ...patch } });
    persist('appearance-save', patch);
  }
  for (const key of fields) {
    const el = $('appearance-' + key);
    const onInput = () => {
      if (!current) return;
      const value = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
      if (key === 'background' && value === 'image' && !current.wallpaperUrl) { el.value = current.settings.background; persist('appearance-import'); return; }
      if (el.type === 'range' || el.type === 'color') draw({ ...current, settings: { ...current.settings, [key]: value } });
      else change({ [key]: value });
    };
    el.addEventListener('input', onInput);
    if (el.type === 'range' || el.type === 'color') el.addEventListener('change', () => change({ [key]: el.type === 'range' ? Number(el.value) : el.value }));
    else if (el.tagName === 'SELECT') el.addEventListener('change', onInput);
  }
  document.querySelectorAll('[data-preset]').forEach(el => el.addEventListener('click', () => change({ preset: el.dataset.preset })));
  $('wallpaper-import').addEventListener('click', () => persist('appearance-import'));
  $('appearance-reset').addEventListener('click', () => persist('appearance-reset'));
  for (const query of ['(prefers-color-scheme: dark)', '(prefers-reduced-motion: reduce)']) matchMedia(query).addEventListener('change', () => { if (current) DesktopAppearance.apply(current); });
  window.desktop.onAppearance(payload => {
    if (Number.isFinite(payload.revision) && payload.revision < serverRevision) return;
    if (outstanding) { if (!latestRemote || payload.revision > latestRemote.revision) latestRemote = payload; }
    else { draw(payload); if (payload.source === 'workspace') $('appearance-feedback').textContent = '已同步工作空间的主题设置'; }
  });
  invoke('appearance-read').then(payload => { draw(payload); $('appearance-feedback').textContent = '调整后自动保存'; }).catch(error => { $('appearance-feedback').textContent = error.message; });
})();

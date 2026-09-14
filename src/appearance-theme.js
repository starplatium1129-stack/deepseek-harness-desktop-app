(function (root) {
  function apply(payload) {
    const s = payload.settings, el = document.documentElement;
    const dark = s.mode === 'dark' || (s.mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    el.dataset.appearance = s.preset; el.dataset.scheme = dark ? 'dark' : 'light';
    el.dataset.motion = s.motion === 'reduced' || (s.motion === 'system' && matchMedia('(prefers-reduced-motion: reduce)').matches) ? 'reduced' : 'full';
    el.dataset.lowEffects = String(s.lowEffects);
    const gradient = 'radial-gradient(ellipse at 15% 20%, #accfff 0%, transparent 55%), radial-gradient(ellipse at 85% 25%, #d5b7f2 0%, transparent 55%), radial-gradient(ellipse at 60% 95%, #95ded9 0%, transparent 65%)';
    const background = s.background === 'image' && payload.wallpaperUrl ? `url("${payload.wallpaperUrl}")` : s.background === 'gradient' ? gradient : 'none';
    const original = el.dataset.appearanceHost === 'workspace' ? (dark ? '#151517' : '#ffffff') : (dark ? '#151b29' : '#f5f7fc');
    const isDefault = s.background === 'default';
    el.style.setProperty('--wallpaper', background);
    el.style.setProperty('--wallpaper-color', s.background === 'solid' ? s.color : isDefault ? original : dark ? '#151b29' : '#f5f7fc');
    el.style.setProperty('--wallpaper-fit', s.fit);
    el.style.setProperty('--wallpaper-blur', `${isDefault || s.lowEffects ? 0 : s.blur}px`);
    el.style.setProperty('--wallpaper-overlay', String(isDefault ? 0 : (dark ? s.darkOverlay : s.lightOverlay) / 100));
    // Keep a minimum combined scrim + material density even over extreme wallpapers.
    const overlay = isDefault ? 0 : (dark ? s.darkOverlay : s.lightOverlay) / 100;
    const minDensity = dark ? .32 : .35;
    const targetDensity = dark ? .40 : .78;
    const density = dark ? Math.max(minDensity, Math.min(.52, targetDensity + overlay * .15)) : Math.max(minDensity, (targetDensity - overlay) / (1 - overlay));
    el.style.setProperty('--liquid-fill', dark ? `rgba(15,20,30,${density.toFixed(3)})` : `rgba(255,255,255,${density.toFixed(3)})`);
    el.style.colorScheme = dark ? 'dark' : 'light';
  }
  root.DesktopAppearance = { apply };
})(globalThis);

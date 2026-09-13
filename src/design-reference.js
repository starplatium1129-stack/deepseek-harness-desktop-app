(() => {
  const $ = id => document.getElementById(id), html = document.documentElement;
  const systemMotion = matchMedia('(prefers-reduced-motion: reduce)'), systemColor = matchMedia('(prefers-color-scheme: dark)');
  let manualMotion = false, manualColor = false;
  const syncSystem = () => {
    if (!manualMotion) { html.dataset.motion = systemMotion.matches ? 'reduced' : 'full'; $('reference-motion').setAttribute('aria-pressed', String(systemMotion.matches)); }
    if (!manualColor) { html.dataset.scheme = systemColor.matches ? 'dark' : 'light'; $('reference-scheme').setAttribute('aria-pressed', String(systemColor.matches)); $('reference-scheme').textContent = systemColor.matches ? '浅色' : '深色'; }
  };
  systemMotion.addEventListener('change', syncSystem); systemColor.addEventListener('change', syncSystem); syncSystem();
  FluidMotion.install(); LiquidGlass.install();
  const tabs = document.querySelector('.reference-tabs');
  let selected = 'material';
  tabs.querySelectorAll('button').forEach(button => button.addEventListener('click', () => {
    tabs.querySelectorAll('button').forEach(el => { el.classList.toggle('selected', el === button); el.setAttribute('aria-pressed', String(el === button)); });
    FluidMotion.indicator(tabs, button);
    if (selected === button.dataset.tab) return;
    selected = button.dataset.tab;
    for (const panel of document.querySelectorAll('.reference-panel')) {
      const incoming = panel.id === 'panel-' + selected;
      panel.inert = !incoming; panel.setAttribute('aria-hidden', String(!incoming));
      if (incoming) {
        if (panel.hidden) FluidMotion.cancel(panel);
        panel.hidden = false; panel.classList.remove('reference-departing');
        FluidMotion.visual(panel, { opacity: 1, y: 0 }, { from: { opacity: 0, y: 10 } });
      } else if (!panel.hidden) {
        panel.classList.add('reference-departing');
        FluidMotion.visual(panel, { opacity: 0, y: -8 }, { done: () => { if (panel.id !== 'panel-' + selected) { panel.hidden = true; panel.classList.remove('reference-departing'); FluidMotion.cancel(panel); } } });
      }
    }
  }));
  FluidMotion.indicator(tabs, tabs.querySelector('button'));
  $('reference-scheme').onclick = event => { manualColor = true; const dark = html.dataset.scheme !== 'dark'; html.dataset.scheme = dark ? 'dark' : 'light'; event.currentTarget.setAttribute('aria-pressed', String(dark)); event.currentTarget.textContent = dark ? '浅色' : '深色'; };
  $('reference-motion').onclick = event => { manualMotion = true; const reduced = html.dataset.motion !== 'reduced'; html.dataset.motion = reduced ? 'reduced' : 'full'; event.currentTarget.setAttribute('aria-pressed', String(reduced)); if (reduced) FluidMotion.finish(); };
  let expanded = true;
  $('demo-toggle').onclick = event => {
    expanded = !expanded; event.currentTarget.setAttribute('aria-expanded', String(expanded));
    let spring;
    spring = FluidMotion.animate($('demo-sidebar'), 'width', expanded ? 238 : 68, v => {
      $('demo-sidebar').style.width = `${v}px`;
      $('velocity-value').textContent = `${Math.round(spring?.velocity || 0)} px/s`;
      $('velocity-bar').style.width = `${Math.min(100, Math.abs(spring?.velocity || 0) / 12)}%`;
    }, { from: 238, profile: 'sidebar' });
  };
  $('demo-open').onclick = () => FluidMotion.openDialog($('demo-dialog'), $('demo-open'));
  $('demo-close').onclick = $('demo-done').onclick = () => FluidMotion.closeDialog($('demo-dialog'));
  const lens = $('reference-lens'), stage = $('lens-stage');
  let drag;
  function home() { return { x: stage.clientWidth * .42, y: stage.clientHeight * .28 }; }
  function release(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const saved = drag; drag = null; lens.releasePointerCapture(event.pointerId);
    for (const axis of ['x', 'y']) FluidMotion.animate(lens, `drag-${axis}`, home()[axis], v => lens.style[axis === 'x' ? 'left' : 'top'] = `${v}px`, { from: saved[axis], velocity: event.type === 'pointercancel' ? 0 : saved['v' + axis], profile: 'presentation' });
  }
  lens.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const rect = lens.getBoundingClientRect(); FluidMotion.cancel(lens);
    drag = { id: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top, x: lens.offsetLeft, y: lens.offsetTop, vx: 0, vy: 0, time: event.timeStamp };
    lens.setPointerCapture(event.pointerId);
  });
  lens.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const rect = stage.getBoundingClientRect(), dt = Math.max(.008, (event.timeStamp - drag.time) / 1000);
    const x = Math.max(8, Math.min(stage.clientWidth - lens.offsetWidth - 8, event.clientX - rect.left - drag.dx));
    const y = Math.max(8, Math.min(stage.clientHeight - lens.offsetHeight - 8, event.clientY - rect.top - drag.dy));
    drag.vx = Math.max(-1000, Math.min(1000, (x - drag.x) / dt)); drag.vy = Math.max(-1000, Math.min(1000, (y - drag.y) / dt));
    drag.x = x; drag.y = y; drag.time = event.timeStamp;
    lens.style.left = `${x}px`; lens.style.top = `${y}px`;
  });
  lens.addEventListener('pointerup', release); lens.addEventListener('pointercancel', release);
  lens.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Home'].includes(event.key)) return;
    event.preventDefault(); const pos = event.key === 'Enter' || event.key === 'Home' ? home() : { x: Math.max(8, Math.min(stage.clientWidth - lens.offsetWidth - 8, lens.offsetLeft + (event.key === 'ArrowRight' ? 32 : event.key === 'ArrowLeft' ? -32 : 0))), y: Math.max(8, Math.min(stage.clientHeight - lens.offsetHeight - 8, lens.offsetTop + (event.key === 'ArrowDown' ? 32 : event.key === 'ArrowUp' ? -32 : 0))) };
    for (const axis of ['x', 'y']) FluidMotion.animate(lens, `drag-${axis}`, pos[axis], v => lens.style[axis === 'x' ? 'left' : 'top'] = `${v}px`, { from: axis === 'x' ? lens.offsetLeft : lens.offsetTop, profile: 'presentation' });
  });
})();

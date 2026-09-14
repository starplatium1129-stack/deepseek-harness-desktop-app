/* Version-bound DOM adaptation lives here; the spring/material engines are generic. */
(() => {
  if (window.__fluidWorkspace) return; window.__fluidWorkspace = true;
  FluidMotion.install();
  LiquidGlass.install({ selector: '.desktop-sidebar-material,.uV2eYG_card,[role="dialog"],[role="menu"]' });
  let frame, observer, lastGrid, lastSource;
  const popups = new Map(), exits = new Map();
  const measurePopups = () => { for (const [el, state] of popups) if (el.isConnected) {
    const scale = el.style.scale, translate = el.style.translate;
    el.style.scale = '1'; el.style.translate = 'none'; state.rect = el.getBoundingClientRect();
    el.style.scale = scale; el.style.translate = translate;
  } };
  document.addEventListener('click', measurePopups, true);
  document.addEventListener('keydown', measurePopups, true);
  document.addEventListener('pointerdown', event => { lastSource = event.target.closest('button,[role=button]')?.getBoundingClientRect(); }, true);
  function syncGrid() {
    if (!frame?.isConnected) return;
    const raw = frame.style.gridTemplateColumns;
    const match = raw.match(/^([\d.]+)px\s+minmax\(0(?:px)?,\s*1fr\)\s+([\d.]+)px$/);
    if (!match || raw === lastGrid) return;
    const initial = !lastGrid; lastGrid = raw;
    frame.dataset.fluidLayout = '';
    const snap = initial || frame.hasAttribute('data-dragging') || frame.hasAttribute('data-rightbar-instant') || frame.hasAttribute('data-rightbar-fullscreen');
    FluidMotion.animate(frame, 'sidebar-width', Number(match[1]), v => {
      frame.style.setProperty('--fluid-sidebar', `${v}px`);
      for (const handle of frame.querySelectorAll('.pI_x6G_handle')) {
        if (Math.abs(parseFloat(handle.style.left) - Number(match[1])) < 1) handle.style.translate = `${v - Number(match[1])}px 0`;
      }
    }, { profile: 'sidebar', snap });
    frame.style.setProperty('--fluid-rightbar', `${match[2]}px`);
  }
  function scan() {
    const sidebar = document.querySelector('.pI_x6G_sidebarCol');
    if (sidebar && !sidebar.querySelector(':scope > .desktop-sidebar-material')) {
      const material = document.createElement('div'); material.className = 'desktop-sidebar-material'; material.setAttribute('aria-hidden', 'true');
      sidebar.dataset.liquidHost = ''; sidebar.prepend(material);
    }
    for (const [el, state] of popups) if (!el.isConnected) {
      popups.delete(el);
      if (FluidMotion.reduced() || !state.rect.width) { FluidMotion.cancel(el); continue; }
      const ghost = el.cloneNode(true), rect = state.rect;
      ghost.removeAttribute('role'); ghost.removeAttribute('id'); ghost.querySelectorAll('[id]').forEach(child => child.removeAttribute('id'));
      ghost.dataset.fluidGhost = ''; ghost.inert = true; ghost.setAttribute('aria-hidden', 'true');
      Object.assign(ghost.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, right: 'auto', bottom: 'auto', width: `${rect.width}px`, height: `${rect.height}px`, margin: '0', zIndex: '2000', pointerEvents: 'none', backdropFilter: 'blur(8px)', transform: 'none' });
      const old = exits.get(state.role); if (old) { FluidMotion.cancel(old); old.remove(); }
      exits.set(state.role, ghost); document.body.append(ghost); FluidMotion.adopt(el, ghost);
      FluidMotion.visual(ghost, { opacity: 0, scale: .84, y: -6 }, { profile: 'presentation', done: () => { if (exits.get(state.role) === ghost) exits.delete(state.role); ghost.remove(); FluidMotion.cancel(ghost); } });
    }
    const next = document.querySelector('.pI_x6G_frame');
    if (next && next !== frame) {
      observer?.disconnect(); if (frame) FluidMotion.cancel(frame);
      frame = next; lastGrid = null; syncGrid();
      observer = new MutationObserver(syncGrid); observer.observe(frame, { attributes: true, attributeFilter: ['style', 'data-dragging', 'data-rightbar-instant', 'data-rightbar-fullscreen'] });
    }
    for (const el of document.querySelectorAll('[role=dialog]:not([data-fluid-entered]),[role=menu]:not([data-fluid-entered])')) {
      if (el.closest('[data-fluid-ghost]')) continue;
      el.dataset.fluidEntered = '';
      const rect = el.getBoundingClientRect();
      const role = el.getAttribute('role'), ghost = exits.get(role);
      if (ghost) { FluidMotion.adopt(ghost, el); ghost.remove(); exits.delete(role); }
      popups.set(el, { rect, role });
      if (lastSource) el.style.transformOrigin = `${Math.max(0, Math.min(rect.width, lastSource.left + lastSource.width / 2 - rect.left))}px ${Math.max(0, Math.min(rect.height, lastSource.top + lastSource.height / 2 - rect.top))}px`;
      FluidMotion.visual(el, { opacity: 1, scale: 1, y: 0 }, { from: { opacity: 0, scale: .84, y: -6 }, profile: 'presentation' });
    }
  }
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true }); scan();
})();

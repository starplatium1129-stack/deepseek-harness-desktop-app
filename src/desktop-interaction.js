(() => {
  const pages = { home: document.getElementById('management-page'), usage: document.getElementById('usage-page'), appearance: document.getElementById('appearance-page') };
  const nav = document.querySelector('header nav'), remembered = new Map();
  let current = 'home', request = 0;
  const available = el => el?.isConnected && !el.disabled && !el.closest('[hidden],[inert]') && el.getClientRects().length;
  for (const [name, page] of Object.entries(pages)) {
    const heading = page.querySelector('h1'); heading.id ||= `${name}-heading`; heading.tabIndex = -1;
    page.setAttribute('aria-labelledby', heading.id);
  }
  function focusContent() {
    const page = pages[current]; if (!page) return;
    const old = remembered.get(current); (available(old) ? old : page.querySelector('h1')).focus({ preventScroll: true });
  }
  function focusNav() { (nav.querySelector('[aria-current=page]:not(:disabled)') || nav.querySelector('button:not(:disabled)')).focus({ preventScroll: true }); }
  function cycleFocus() { if (document.activeElement.closest('header')) focusContent(); else focusNav(); }
  function render(page, focusRequest = 0) {
    const previous = pages[current], active = document.activeElement;
    const hadContentFocus = previous?.contains(active);
    if (page !== current && hadContentFocus) remembered.set(current, active);
    const changed = page !== current; current = page;
    FluidMotion.route(page);
    for (const el of nav.querySelectorAll('button')) {
      if (el.id === page) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
      el.tabIndex = el.id === page ? 0 : -1;
    }
    if ((focusRequest && focusRequest !== request) || (changed && hadContentFocus)) focusContent();
    request = focusRequest;
  }
  nav.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const buttons = [...nav.querySelectorAll('button:not(:disabled)')], i = buttons.indexOf(document.activeElement);
    if (i < 0) return; event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons.forEach((el, index) => el.tabIndex = index === next ? 0 : -1); buttons[next].focus();
  });
  document.getElementById('skip-content').addEventListener('click', () => window.desktop.action('focus-content'));
  const keys = { workspace: 'Control+1', usage: 'Control+2', home: 'Control+3', appearance: 'Control+4' };
  for (const [id, key] of Object.entries(keys)) { const el = document.getElementById(id); el.setAttribute('aria-keyshortcuts', key); el.title = `${el.textContent} (${key.replace('Control', 'Ctrl')})`; }
  document.getElementById('api-key').setAttribute('aria-describedby', 'key-message');
  document.getElementById('api-key').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); document.getElementById('save-key').click(); } });
  window.DesktopInteraction = { render, focusContent, focusNav, cycleFocus };
})();

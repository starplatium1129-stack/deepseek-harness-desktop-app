// Browser half of the desktop plugin; only uses the public workspace navigation service.
window.__ModuleLoader__.load({
  id: 'deepseek-harness-desktop-integrations',
  factory: () => ({
    inject: ['uiWorkspace', 'theme'],
    apply(ctx) {
      const open = event => {
        if (typeof event.detail?.id !== 'string' || event.detail.id.length > 256) return;
        ctx.uiWorkspace.openSession(event.detail.id);
        event.preventDefault();
      };
      window.addEventListener('desktop:open-session', open);
      const appearance = event => {
        const mode = event.detail?.mode;
        if (['light', 'dark', 'system'].includes(mode) && ctx.theme.getTheme().preference !== mode) ctx.theme.setTheme(mode);
      };
      window.addEventListener('desktop:appearance', appearance);
      if (window.__desktopAppearance) appearance({ detail: { mode: window.__desktopAppearance.settings.mode } });
      ctx.on('dispose', () => {
        window.removeEventListener('desktop:open-session', open);
        window.removeEventListener('desktop:appearance', appearance);
      });
    },
  }),
});

// Browser half of the desktop plugin; only uses the public workspace navigation service.
window.__ModuleLoader__.load({
  id: 'deepseek-harness-desktop-integrations',
  factory: () => ({
    inject: ['uiWorkspace'],
    apply(ctx) {
      const open = event => {
        if (typeof event.detail?.id !== 'string' || event.detail.id.length > 256) return;
        ctx.uiWorkspace.openSession(event.detail.id);
        event.preventDefault();
      };
      window.addEventListener('desktop:open-session', open);
      ctx.on('dispose', () => window.removeEventListener('desktop:open-session', open));
    },
  }),
});

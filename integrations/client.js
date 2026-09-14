// Browser half of the desktop plugin; uses public workspace and theme services.
window.__ModuleLoader__.load({
  id: 'deepseek-harness-desktop-integrations',
  factory: () => ({
    inject: ['uiWorkspace', 'theme', 'settingsScope'],
    apply(ctx) {
      const open = event => {
        if (typeof event.detail?.id !== 'string' || event.detail.id.length > 256) return;
        ctx.uiWorkspace.openSession(event.detail.id);
        event.preventDefault();
      };
      window.addEventListener('desktop:open-session', open);
      const scope = ctx.settingsScope.bind({ namespace: 'ui-theme' });
      let applyingDesktop = false, lastPreference, initialized = false, pendingDesktop, expected;
      const themeChanged = snapshot => {
        const mode = snapshot.preference;
        if (!['light', 'dark', 'system'].includes(mode) || !window.__desktopAppearance || !initialized) return;
        window.__desktopAppearance = { ...window.__desktopAppearance, settings: { ...window.__desktopAppearance.settings, mode } };
        window.DesktopAppearance?.apply(window.__desktopAppearance);
        const saved = scope.getSnapshot();
        // The mirror can repeat the pre-write value while the theme service is optimistic.
        // A genuinely accepted change advances the namespace revision and is handled below.
        const staleAdoption = expected && mode !== expected.mode && mode === saved.value?.preference && saved.revision === expected.revision;
        if (!applyingDesktop && !staleAdoption && mode !== lastPreference) {
          lastPreference = mode;
          expected = saved.value?.preference !== mode ? { mode, revision: saved.revision } : undefined;
          window.desktopTheme?.report(mode);
        }
      };
      const applyPending = () => {
        const saved = scope.getSnapshot();
        if (saved.status !== 'ready' || pendingDesktop === undefined) return;
        const mode = pendingDesktop; pendingDesktop = undefined; initialized = true;
        expected = saved.value?.preference !== mode ? { mode, revision: saved.revision } : undefined;
        applyingDesktop = true; lastPreference = mode;
        try {
          if (ctx.theme.getTheme().preference !== mode) ctx.theme.setTheme(mode);
          themeChanged(ctx.theme.getTheme());
        } finally { applyingDesktop = false; }
      };
      const appearance = event => {
        const mode = event.detail?.mode;
        if (!['light', 'dark', 'system'].includes(mode)) return;
        pendingDesktop = mode; applyPending();
      };
      const unsubscribeScope = scope.subscribe(() => {
        applyPending();
        if (initialized && expected && scope.getSnapshot().revision !== expected.revision) {
          expected = undefined; themeChanged(ctx.theme.getTheme());
        }
      });
      ctx.on('theme/change', themeChanged);
      window.addEventListener('desktop:appearance', appearance);
      if (window.__desktopAppearance) appearance({ detail: { mode: window.__desktopAppearance.settings.mode } });
      ctx.on('dispose', () => {
        unsubscribeScope();
        window.removeEventListener('desktop:open-session', open);
        window.removeEventListener('desktop:appearance', appearance);
      });
    },
  }),
});

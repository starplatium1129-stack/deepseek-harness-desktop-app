// Commit native visibility/state synchronously. Renderer decoration is best-effort only.
function commitNavigation({ page, previous, keyboard, generation, view, win, publish }) {
  const usable = view && !view.webContents.isDestroyed();
  if (usable) view.setVisible(page === 'workspace');
  publish({ page, showHome: page !== 'workspace', focusRequest: keyboard ? generation : 0 });
  if (page === 'workspace' && usable) view.webContents.focus();
  else if (keyboard) win.webContents.focus();
  if (previous !== page && page === 'workspace' && usable) {
    try {
      void view.webContents.executeJavaScript(`
        if (!document.hidden && window.FluidMotion) {
          // Keep compositor state intact without resetting #root opacity to avoid layout reflow and stutter
        }
      `).catch(() => {});
    } catch { /* A disposed renderer cannot undo an already committed navigation. */ }
  }
}
module.exports = { commitNavigation };

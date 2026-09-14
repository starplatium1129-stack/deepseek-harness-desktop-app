// Ordinary Electron launch: deliberately does not import Playwright's Electron loader.
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  (async () => {
    const data = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-native-nav-'));
    await fs.mkdir(path.join(data, 'appearance'));
    await fs.writeFile(path.join(data, 'appearance/settings.json'), JSON.stringify({ preset: 'classic', mode: 'system', background: 'default', motion: 'full' }));
    const env = { ...process.env, DSH_DESKTOP_TEST_DATA: data }; delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('electron'), [__filename], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    const result = JSON.parse(await fs.readFile(path.join(data, 'native-navigation-result.json'), 'utf8'));
    if (exit !== 0 || !result.passed) throw Error(result.error || `Electron exit ${exit}`);
    console.log('Native navigation passed with default background throttling:', result.routes.join(' → '));
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  require('../src/main.cjs');
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const waitFor = async (read, label, timeout = 8000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) { const value = await read(); if (value) return value; await sleep(100); }
    throw Error(`Timed out: ${label}`);
  };
  void (async () => {
    let result;
    try {
      await app.whenReady();
      for (const flag of ['disable-background-timer-throttling', 'disable-backgrounding-occluded-windows', 'disable-renderer-backgrounding']) if (app.commandLine.hasSwitch(flag)) throw Error(`Unexpected test-only flag: ${flag}`);
      const win = await waitFor(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')), 'desktop window', 30000);
      await waitFor(async () => (await win.webContents.executeJavaScript('window.desktop.state()')).phase === 'ready', 'core ready', 120000);
      const view = win.contentView.children.find(v => v.webContents && v.webContents !== win.webContents);
      if (!view || view.webContents.getLastWebPreferences().backgroundThrottling === false) throw Error('Production view/throttling configuration missing');
      const routes = ['home', 'workspace', 'appearance', 'workspace', 'usage', 'workspace', 'home'];
      for (const route of routes) {
        // Drive only the visible desktop chrome; never query/screenshot a hidden renderer.
        await win.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(route)}).click()`);
        await waitFor(async () => {
          const state = await win.webContents.executeJavaScript('window.desktop.state()');
          return state.page === route && view.getVisible() === (route === 'workspace');
        }, `native view switch to ${route}`);
      }
      result = { passed: true, routes };
    } catch (error) { result = { passed: false, error: error.message }; }
    await fs.writeFile(path.join(app.getPath('userData'), 'native-navigation-result.json'), JSON.stringify(result));
    app.quit();
  })();
}

const { app, BrowserWindow, WebContentsView, ipcMain, shell, dialog, safeStorage, Menu, Notification, nativeImage, nativeTheme, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { appendFileSync, mkdirSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { RuntimeManager, redact } = require('./runtime.cjs');
const { PricingStore } = require('./pricing-store.cjs');
const { AppearanceStore } = require('./appearance-store.cjs');
const { AppearanceAdapter, acceptsThemeEvent } = require('./appearance-adapter.cjs');
const { WindowState, fitWindow, zoomSteps, shortcut } = require('./window-state.cjs');
const { commitNavigation } = require('./navigation.cjs');
const appearanceAdapter = new AppearanceAdapter();
let appearanceStore;
let appearanceQueue = Promise.resolve(), appearanceRevision = 0, workspaceOrigin;
function queueAppearance(operation) {
  const next = appearanceQueue.then(operation); appearanceQueue = next.catch(() => {}); return next;
}
async function readAppearance() { return { ...await appearanceStore.read(), revision: appearanceRevision }; }
function changeAppearance(operation, source = 'desktop') {
  return queueAppearance(async () => {
    const payload = { ...await operation(), revision: ++appearanceRevision, source };
    nativeTheme.themeSource = payload.settings.mode;
    if (win && !win.isDestroyed()) {
      win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#151b29' : '#f5f7fc');
      win.webContents.send('desktop:appearance', payload);
    }
    // The workspace has already applied its own choice. Echoing it back calls
    // setTheme again and can supersede a newer in-flight choice in the upstream scope.
    if (source !== 'workspace' && view && !view.webContents.isDestroyed()) await appearanceAdapter.apply(view.webContents, payload);
    return payload;
  });
}
let windowStore, saveWindow, zoom = 1;
const testData = process.env.DSH_DESKTOP_TEST_DATA;
if (testData && path.isAbsolute(testData)) app.setPath('userData', testData);
function lifecycle(event, details = {}) {
  try {
    const data = app.getPath('userData'); mkdirSync(data, { recursive: true });
    appendFileSync(path.join(data, 'desktop-lifecycle.log'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...details }) + '\n');
  } catch { /* Diagnostics must not alter application shutdown. */ }
}
process.on('uncaughtExceptionMonitor', (error, origin) => lifecycle('uncaught-exception', { origin, error: redact(String(error?.stack || error)).slice(0, 5000) }));
process.on('exit', code => lifecycle('process-exit', { code }));
app.on('render-process-gone', (_event, _contents, details) => lifecycle('renderer-exit', { reason: details.reason, exitCode: details.exitCode }));
app.on('child-process-gone', (_event, details) => lifecycle('child-exit', { type: details.type, reason: details.reason, exitCode: details.exitCode }));
app.on('will-quit', () => lifecycle('will-quit'));
app.setAppUserModelId('io.deepseekharness.desktop.community');
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
let win, view, manager, referenceWindow, navigationGeneration = 0, quitting = false, booting = false;
let usageSessionIds = new Set();
let status = { phase: 'starting', message: '正在准备你的工作空间…', desktopVersion: app.getVersion(), active: '', pending: '', canRollback: false, hasKey: false, showHome: true, page: 'home' };
const localPage = pathToFileURL(path.join(__dirname, 'index.html')).href;
const publish = patch => { Object.assign(status, patch); if (win && !win.isDestroyed()) win.webContents.send('desktop:state', status); };
const chromeHeight = () => Math.round(58 * zoom);
const resize = () => { if (view && win && !win.isDestroyed()) { const [width, height] = win.getContentSize(); view.setBounds({ x: 0, y: chromeHeight(), width, height: Math.max(0, height - chromeHeight()) }); } };
const sync = () => publish({ active: manager?.state?.active || '', pending: manager?.state?.pending || '', canRollback: !!manager?.state?.previous });
async function showPage(page, keyboard = false) {
  const generation = ++navigationGeneration, previous = status.page;
  if (quitting) return;
  // A hidden WebContentsView is throttled in normal Electron launches. Never
  // wait for its image decode, capture, JavaScript or animation before showing it.
  commitNavigation({ page, previous, keyboard, generation, view, win, publish });
}
function showHome(show) { return showPage(show ? 'home' : 'workspace'); }
async function command(name, source = win.webContents) {
  const modal = await source.executeJavaScript(`!!document.querySelector('dialog[open],[role="dialog"][aria-modal="true"]')`);
  if (modal) return;
  if (['workspace', 'usage', 'home', 'appearance'].includes(name)) {
    if (name !== 'workspace' || status.phase === 'ready') await showPage(name, true); return;
  }
  if (name === 'shortcuts') {
    await dialog.showMessageBox(win, { type: 'info', title: '键盘快捷键', message: '键盘也能完成主要操作', detail: 'Ctrl+1　工作空间\nCtrl+2　用量统计\nCtrl+3　桌面管理\nCtrl+4 / Ctrl+,　外观\nF6 / Shift+F6　导航与内容之间切换\n方向键 / Home / End　移动导航焦点；Enter 确认\nTab / Shift+Tab　下一个 / 上一个控件\nEsc　关闭弹窗\nCtrl++ / Ctrl+- / Ctrl+0　放大 / 缩小 / 恢复 100%\nF1　查看快捷键\nAlt+F4　关闭窗口', buttons: ['知道了'] }); return;
  }
  if (name === 'focus-cycle' || name === 'focus-content') {
    if (status.page === 'workspace' && view) {
      if (name === 'focus-content' || source === win.webContents) view.webContents.focus();
      else { win.webContents.focus(); await win.webContents.executeJavaScript('window.DesktopInteraction?.focusNav()'); }
    } else await win.webContents.executeJavaScript(`window.DesktopInteraction?.${name === 'focus-content' ? 'focusContent' : 'cycleFocus'}()`);
    return;
  }
  if (name.startsWith('zoom-')) {
    const index = zoomSteps.indexOf(zoom);
    zoom = name === 'zoom-reset' ? 1 : zoomSteps[Math.max(0, Math.min(zoomSteps.length - 1, index + (name === 'zoom-in' ? 1 : -1)))];
    win.webContents.setZoomFactor(zoom); if (view && !view.webContents.isDestroyed()) view.webContents.setZoomFactor(zoom); resize(); saveWindow?.();
    publish({ zoom });
  }
}
function installDesktopInput(contents) {
  contents.on('before-input-event', (event, input) => {
    const name = shortcut(input); if (!name) return;
    event.preventDefault(); void command(name, contents).catch(error => lifecycle('desktop-command-error', { error: redact(error.message) }));
  });
  contents.on('context-menu', (_event, params) => {
    const items = params.isEditable ? [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { type: 'separator' }, { role: 'selectAll', label: '全选' }] : params.selectionText ? [{ role: 'copy', label: '复制' }, { role: 'selectAll', label: '全选' }] : [];
    const flags = { undo: 'canUndo', redo: 'canRedo', cut: 'canCut', copy: 'canCopy', paste: 'canPaste', selectAll: 'canSelectAll' };
    for (const item of items) if (item.role) item.enabled = params.editFlags?.[flags[item.role]] !== false;
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
}
async function readKey() {
  try { const value = await fs.readFile(path.join(app.getPath('userData'), 'credential.bin')); return safeStorage.decryptString(value); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw new Error('无法解密已保存的密钥，请在桌面设置中重新保存。'); }
}
async function boot() {
  if (booting) return; booting = true;
  try {
    publish({ phase: 'starting', message: '正在启动内置 Harness…' });
    await manager.process?.stop();
    const key = await readKey(); publish({ hasKey: !!key });
    const url = await manager.start(key ? { DEEPSEEK_API_KEY: key } : {});
    if (quitting) return;
    const origin = new URL(url).origin;
    workspaceOrigin = origin;
    if (view) { win.contentView.removeChildView(view); view.webContents.close(); }
    view = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'workspace-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'persist:harness' } });
    view.webContents.setZoomFactor(zoom); installDesktopInput(view.webContents);
    const external = value => { try { const u = new URL(value); if (u.protocol === 'https:' || u.protocol === 'http:') void shell.openExternal(u.href); } catch {} };
    view.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
    view.webContents.on('will-navigate', (event, destination) => { if (new URL(destination).origin !== origin) { event.preventDefault(); external(destination); } });
    view.webContents.session.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
    win.contentView.addChildView(view); view.setVisible(status.page === 'workspace'); resize();
    const contents = view.webContents;
    let finishAppearance;
    const appearanceReady = new Promise(resolve => { finishAppearance = resolve; });
    contents.once('did-finish-load', () => {
      contents.setZoomFactor(zoom); resize();
      void queueAppearance(async () => appearanceAdapter.apply(contents, await readAppearance()))
        .catch(error => publish({ appearanceError: redact(error.message) }))
        .finally(finishAppearance);
    });
    await view.webContents.loadURL(url);
    await appearanceReady;
    sync(); publish({ phase: 'ready', message: 'Harness 已就绪' });
    if (!['usage', 'appearance'].includes(status.page)) showHome(false);
  } catch (error) { showHome(true); publish({ phase: 'error', message: redact(error.message) }); }
  finally { booting = false; }
}
async function main() {
  lifecycle('started', { parentPid: process.ppid, version: app.getVersion() });
  Menu.setApplicationMenu(null);
  const data = app.getPath('userData'); await fs.mkdir(data, { recursive: true });
  const pricing = new PricingStore(data);
  appearanceStore = new AppearanceStore(data);
  windowStore = new WindowState(data);
  const displays = () => [screen.getPrimaryDisplay(), ...screen.getAllDisplays().filter(d => d.id !== screen.getPrimaryDisplay().id)];
  const restored = fitWindow(await windowStore.read(), displays()); zoom = restored.zoom; status.zoom = zoom;
  nativeTheme.themeSource = (await appearanceStore.read()).settings.mode;
  const resources = app.isPackaged ? path.join(process.resourcesPath, 'runtime') : path.resolve(__dirname, '../runtime');
  manager = new RuntimeManager(resources, data);
  win = new BrowserWindow({ x: restored.x, y: restored.y, width: restored.width, height: restored.height, minWidth: restored.minWidth, minHeight: restored.minHeight, title: 'DeepSeek Harness Desktop', backgroundColor: '#f5f7fc', icon: path.join(__dirname, '../assets/icon.ico'), show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.setZoomFactor(zoom); installDesktopInput(win.webContents);
  win.webContents.on('did-finish-load', () => { win.webContents.setZoomFactor(zoom); resize(); });
  let windowTimer;
  saveWindow = () => {
    clearTimeout(windowTimer); if (!win || win.isDestroyed()) return;
    void windowStore.save({ ...win.getNormalBounds(), maximized: win.isMaximized(), zoom }).catch(error => lifecycle('window-state-save-error', { error: redact(error.message) }));
  };
  const laterSave = () => { clearTimeout(windowTimer); windowTimer = setTimeout(saveWindow, 200); };
  for (const event of ['move', 'resize', 'maximize', 'unmaximize']) win.on(event, laterSave);
  win.on('close', saveWindow);
  const fitDisplay = () => { if (!win.isDestroyed() && !win.isMaximized()) { const fitted = fitWindow({ ...win.getBounds(), zoom }, displays()); win.setMinimumSize(fitted.minWidth, fitted.minHeight); win.setBounds({ x: fitted.x, y: fitted.y, width: fitted.width, height: fitted.height }); } };
  screen.on('display-removed', fitDisplay);
  win.on('closed', () => { clearTimeout(windowTimer); screen.removeListener('display-removed', fitDisplay); });
  win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#151b29' : '#f5f7fc');
  win.once('ready-to-show', () => { if (restored.maximized) win.maximize(); win.show(); }); win.on('resize', resize);
  win.on('closed', () => { if (referenceWindow && !referenceWindow.isDestroyed()) referenceWindow.close(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (url !== localPage) e.preventDefault(); });
  ipcMain.handle('desktop:state', event => { if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Invalid caller'); return status; });
  ipcMain.on('desktop:workspace-theme', (event, mode) => {
    if (!acceptsThemeEvent(event, view?.webContents, workspaceOrigin, mode)) return;
    void changeAppearance(() => appearanceStore.save({ mode }), 'workspace').catch(error => publish({ appearanceError: redact(error.message) }));
  });
  ipcMain.handle('desktop:action', async (event, name, value) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Invalid caller');
    try {
      if (name === 'home') { showHome(true); return; }
      if (name === 'usage') { showPage('usage'); return; }
      if (name === 'appearance') { showPage('appearance'); return; }
      if (['shortcuts', 'focus-content', 'zoom-in', 'zoom-out', 'zoom-reset'].includes(name)) return await command(name);
      if (name === 'design-reference') {
        if (referenceWindow && !referenceWindow.isDestroyed()) { referenceWindow.focus(); return; }
        const referenceBounds = fitWindow({ ...win.getNormalBounds(), width: 1240, height: 900 }, displays());
        referenceWindow = new BrowserWindow({ x: referenceBounds.x, y: referenceBounds.y, width: referenceBounds.width, height: referenceBounds.height, minWidth: referenceBounds.minWidth, minHeight: referenceBounds.minHeight, title: 'Fluid · 苹果设计参考', backgroundColor: '#edf3fa', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
        referenceWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        referenceWindow.webContents.on('will-navigate', event => event.preventDefault());
        await referenceWindow.loadFile(path.join(__dirname, 'design-reference.html')); return;
      }
      if (name === 'appearance-read') return await queueAppearance(readAppearance);
      if (['appearance-save', 'appearance-import', 'appearance-reset'].includes(name)) {
        if (name === 'appearance-import') {
          const result = await dialog.showOpenDialog(win, { title: '选择背景壁纸', properties: ['openFile'], filters: [{ name: '静态图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
          return result.canceled ? await queueAppearance(readAppearance) : await changeAppearance(() => appearanceStore.importImage(result.filePaths[0], nativeImage));
        }
        return await changeAppearance(() => name === 'appearance-reset' ? appearanceStore.reset() : appearanceStore.save(value));
      }
      if (name === 'usage-prices') return await pricing.read();
      if (name === 'usage-prices-save') return await pricing.save(value);
      if (name === 'usage-prices-sync') { await pricing.catalog.sync(true); return await pricing.read(); }
      if (name === 'usage-prices-config') { await pricing.catalog.configure(value); return await pricing.read(); }
      if (name === 'usage-read') {
        if (status.phase !== 'ready' || !manager.process) throw new Error('Harness 尚未就绪，请启动后刷新统计。');
        const snapshot = await manager.process.readUsage();
        if (!snapshot || !Array.isArray(snapshot.sessions)) throw new Error('用量统计返回了不兼容的数据。');
        usageSessionIds = new Set(snapshot.sessions.map(session => session.id));
        return snapshot;
      }
      if (name === 'usage-open-session') {
        if (typeof value !== 'string' || value.length > 256 || !usageSessionIds.has(value) || status.phase !== 'ready' || !view || view.webContents.isDestroyed()) throw new Error('会话暂时无法打开，请刷新统计后重试。');
        const opened = await view.webContents.executeJavaScript(`!window.dispatchEvent(new CustomEvent('desktop:open-session', { detail: { id: ${JSON.stringify(value)} }, cancelable: true }))`);
        if (!opened) throw new Error('工作空间尚未就绪，或当前核心不支持打开会话。');
        showHome(false); return;
      }
      if (name === 'workspace') { if (status.phase === 'ready') showHome(false); return; }
      if (name === 'retry') { if (!booting && status.phase !== 'ready') await boot(); return; }
      if (name === 'check') { const result = await manager.check(); publish({ update: result, updateMessage: result.newer ? `发现上游新版本 ${result.version}` : '当前已是上游最新版本。' }); return; }
      if (name === 'download') { publish({ updating: true }); try { const result = await manager.stage(); sync(); publish({ updateMessage: result.message }); } finally { publish({ updating: false }); } return; }
      if (name === 'logs') { await shell.openPath(path.join(data, 'desktop.log')); return; }
      if (name === 'data') { await shell.openPath(data); return; }
      if (name === 'upstream') { await shell.openExternal('https://github.com/deepseek-ai/deepseek-harness'); return; }
      if (name === 'rollback') {
        if (!manager.state.previous || booting || manager.busy) throw new Error('当前无法回退。');
        const result = await dialog.showMessageBox(win, { type: 'warning', buttons: ['取消', '回退并重启'], defaultId: 0, cancelId: 0, message: '回退到上一个 Harness 版本？', detail: '请先结束所有任务。将恢复升级前的数据快照；当前数据另存保留在 recovered-data 文件夹。' });
        if (result.response === 1) { showHome(true); await manager.restore(); await boot(); } return;
      }
      if (name === 'save-key') {
        if (typeof value !== 'string' || value.length > 4096) throw new Error('密钥格式无效。');
        if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密当前不可用。');
        const key = value.trim(), file = path.join(data, 'credential.bin');
        if (key) await fs.writeFile(file, safeStorage.encryptString(key)); else await fs.rm(file, { force: true });
        publish({ hasKey: !!key, keyMessage: '已使用 Windows 加密保存，下次启动生效。' }); return;
      }
      if (name === 'restart') {
        if (manager.busy || booting) throw new Error('请等待当前操作完成。');
        const result = await dialog.showMessageBox(win, { type: 'question', buttons: ['取消', '重启应用'], defaultId: 0, cancelId: 0, message: '确认所有任务已结束后重启？', detail: '重启会停止当前 Harness 服务，并应用已准备的更新和配置。' });
        if (result.response === 1) { app.relaunch(); app.quit(); } return;
      }
      throw new Error('未知操作。');
    } catch (error) { return { error: redact(error.message) }; }
  });
  await win.loadFile(path.join(__dirname, 'index.html'));
  let priceStatus;
  const syncPrices = async () => {
    try {
      const result = await pricing.catalog.sync();
      const revision = JSON.stringify([result.status.lastSyncAt, result.status.lastError]);
      if (!quitting && revision !== priceStatus) { priceStatus = revision; publish({ priceRevision: revision }); }
    } catch { /* Price service must not affect Harness startup. */ }
  };
  void syncPrices();
  const priceTimer = setInterval(syncPrices, 30000); priceTimer.unref();
  app.once('before-quit', () => clearInterval(priceTimer));
  manager.on('progress', message => publish(manager.busy ? { updateMessage: message } : { message }));
  const notifications = new Set();
  manager.on('task-completed', () => {
    if (quitting || !win || win.isDestroyed()) return;
    publish({ completedAt: Date.now() });
    try {
      if (!Notification.isSupported()) return;
      const notification = new Notification({ title: '任务已完成', body: 'Harness 已完成一轮任务，点击返回应用查看结果。', icon: path.join(__dirname, '../assets/icon.png') });
      notifications.add(notification);
      notification.on('close', () => notifications.delete(notification));
      notification.on('failed', () => notifications.delete(notification));
      notification.on('click', () => {
        if (quitting || !win || win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show(); win.focus(); showHome(false);
      });
      notification.show();
    } catch { /* The in-app completion message remains available. */ }
  });
  let logQueue = Promise.resolve();
  manager.on('log', text => { logQueue = logQueue.then(() => fs.appendFile(path.join(data, 'desktop.log'), redact(text))).catch(() => {}); });
  manager.on('crash', code => { lifecycle('harness-exit', { code, quitting }); if (!booting && !quitting) { showHome(true); publish({ phase: 'error', message: 'Harness 意外退出。你的数据已保留，可以重试启动。' }); } });
  try { await manager.init(); sync(); await boot(); }
  catch (error) { publish({ phase: 'error', message: redact(error.message) }); }
}
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  lifecycle('before-quit', { quitting });
  if (quitting) return; event.preventDefault(); quitting = true;
  saveWindow?.();
  void (async () => { await windowStore?.queue; await appearanceQueue; await manager?.stop(); app.quit(); })();
});
if (locked) app.whenReady().then(main).catch(error => { dialog.showErrorBox('启动失败', redact(error.message)); app.quit(); });

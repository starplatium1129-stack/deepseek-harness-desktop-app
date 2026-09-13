const { app, BrowserWindow, WebContentsView, ipcMain, shell, dialog, safeStorage, Menu, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { appendFileSync, mkdirSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { RuntimeManager, redact } = require('./runtime.cjs');
const { PricingStore } = require('./pricing-store.cjs');
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
let win, view, manager, quitting = false, booting = false;
let usageSessionIds = new Set();
let status = { phase: 'starting', message: '正在准备你的工作空间…', desktopVersion: app.getVersion(), active: '', pending: '', canRollback: false, hasKey: false, showHome: true, page: 'home' };
const localPage = pathToFileURL(path.join(__dirname, 'index.html')).href;
const publish = patch => { Object.assign(status, patch); if (win && !win.isDestroyed()) win.webContents.send('desktop:state', status); };
const resize = () => { if (view && win) { const [width, height] = win.getContentSize(); view.setBounds({ x: 0, y: 58, width, height: Math.max(0, height - 58) }); } };
const sync = () => publish({ active: manager?.state?.active || '', pending: manager?.state?.pending || '', canRollback: !!manager?.state?.previous });
function showPage(page) { if (view) view.setVisible(page === 'workspace'); publish({ page, showHome: page !== 'workspace' }); }
function showHome(show) { showPage(show ? 'home' : 'workspace'); }
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
    if (view) { win.contentView.removeChildView(view); view.webContents.close(); }
    view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'persist:harness' } });
    const external = value => { try { const u = new URL(value); if (u.protocol === 'https:' || u.protocol === 'http:') void shell.openExternal(u.href); } catch {} };
    view.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
    view.webContents.on('will-navigate', (event, destination) => { if (new URL(destination).origin !== origin) { event.preventDefault(); external(destination); } });
    view.webContents.session.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
    win.contentView.addChildView(view); resize();
    await view.webContents.loadURL(url);
    sync(); publish({ phase: 'ready', message: 'Harness 已就绪' });
    if (status.page !== 'usage') showHome(false);
  } catch (error) { showHome(true); publish({ phase: 'error', message: redact(error.message) }); }
  finally { booting = false; }
}
async function main() {
  lifecycle('started', { parentPid: process.ppid, version: app.getVersion() });
  Menu.setApplicationMenu(null);
  const data = app.getPath('userData'); await fs.mkdir(data, { recursive: true });
  const pricing = new PricingStore(data);
  const resources = app.isPackaged ? path.join(process.resourcesPath, 'runtime') : path.resolve(__dirname, '../runtime');
  manager = new RuntimeManager(resources, data);
  win = new BrowserWindow({ width: 1320, height: 880, minWidth: 880, minHeight: 650, title: 'DeepSeek Harness Desktop', backgroundColor: '#f5f7fc', icon: path.join(__dirname, '../assets/icon.ico'), show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.once('ready-to-show', () => win.show()); win.on('resize', resize);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (url !== localPage) e.preventDefault(); });
  ipcMain.handle('desktop:state', event => { if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Invalid caller'); return status; });
  ipcMain.handle('desktop:action', async (event, name, value) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Invalid caller');
    try {
      if (name === 'home') { showHome(true); return; }
      if (name === 'usage') { showPage('usage'); return; }
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
  void (async () => { await manager?.stop(); app.quit(); })();
});
if (locked) app.whenReady().then(main).catch(error => { dialog.showErrorBox('启动失败', redact(error.message)); app.quit(); });

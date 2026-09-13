const path = require('node:path');
const { app } = require('electron');
const hostAt = process.argv.indexOf('--collaboration-zcode-host');

if (hostAt === -1) {
  require('./main.cjs');
} else {
  // A dedicated, windowless process for the installed ZCode native host.
  // This does not acquire the desktop application's user-data/single-instance lock.
  try {
    const raw = process.argv[hostAt + 1];
    if (!raw || raw.length > 32768) throw new Error('Missing native host parameters.');
    const options = JSON.parse(raw);
    if (!options || Object.keys(options).some(key => !['cliPath', 'nodePath', 'workspace', 'transportPipe'].includes(key)) ||
      ['cliPath', 'nodePath', 'workspace'].some(key => typeof options[key] !== 'string' || !path.isAbsolute(options[key]))) throw new Error('Native host paths must be explicit absolute paths.');
    if (options.transportPipe !== undefined && (typeof options.transportPipe !== 'string' || !/^\\\\\.\\pipe\\deepseek-zcode-[a-zA-Z0-9-]+$/.test(options.transportPipe))) throw new Error('Invalid native host pipe.');
    const entry = app.isPackaged
      ? path.join(process.resourcesPath, 'runtime', 'collaboration', 'adapters', 'zcode-desktop-bridge.cjs')
      : path.resolve(__dirname, '../collaboration/adapters/zcode-desktop-bridge.cjs');
    const { runDesktopBridge } = require(entry);
    Promise.resolve(runDesktopBridge(options)).catch(() => { process.stderr.write('ZCode native host bridge failed.\n'); app.exit(1); });
  } catch {
    process.stderr.write('Invalid ZCode native host launch.\n'); app.exit(1);
  }
}

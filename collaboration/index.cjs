const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { CollaborationService } = require('./core.cjs');
const { createHarnessAdapter } = require('./adapters/harness.cjs');
const { createZCodeAdapter } = require('./adapters/zcode.cjs');

async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function executorSettings(dataDir) {
  let settings;
  try { settings = JSON.parse(await fs.readFile(path.join(dataDir, 'executors.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('执行器配置 executors.json 无法读取。'); }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).some(key => key !== 'zcode') ||
    (settings.zcode && (typeof settings.zcode !== 'object' || Array.isArray(settings.zcode) || Object.keys(settings.zcode).some(key => key !== 'profileMode') || !['dedicated', 'existing'].includes(settings.zcode.profileMode)))) throw new Error('executors.json 只支持 zcode.profileMode: dedicated 或 existing。');
  return settings;
}
async function createDefaultService(options = {}) {
  const desktopData = options.desktopData || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'deepseek-harness-desktop');
  // Source checkout and installed runtime/collaboration use the same portable layout.
  const resources = options.runtimeResources || (await exists(path.join(__dirname, '..', 'manifest.json')) ? path.resolve(__dirname, '..') : path.resolve(__dirname, '..', 'runtime'));
  let runtimeRoot = path.join(resources, 'harness');
  try {
    const state = JSON.parse(await fs.readFile(path.join(desktopData, 'runtime-state.json'), 'utf8'));
    if (typeof state.active === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[\w.-]+)?$/.test(state.active)) {
      const candidate = path.join(desktopData, 'versions', state.active);
      if (await exists(path.join(candidate, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))) runtimeRoot = candidate;
    }
  } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
  const nodePath = await exists(path.join(resources, 'node', 'node.exe')) ? path.join(resources, 'node', 'node.exe') : process.execPath;
  const dataDir = options.dataDir || path.join(process.env.APPDATA || process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'DeepSeek-Harness-Collaboration');
  const settings = await executorSettings(dataDir);
  const service = new CollaborationService({
    dataDir, allowedRoots: options.allowedRoots,
    concurrency: options.concurrency || 2,
    adapters: options.adapters || [
      createHarnessAdapter({ runtimeRoot, nodePath, harnessHome: process.env.DSH_HOME || path.join(desktopData, 'harness-home'), ...options.harness }),
      createZCodeAdapter({ nodePath, profileDir: path.join(dataDir, 'zcode-browser'), ...settings.zcode, ...options.zcode, managedLifetime: options.managedLifetime === true }),
    ],
  });
  if (options.inspectOnly) {
    service.allowedRoots = await Promise.all(service.allowedRoots.map(root => fs.realpath(root)));
    return service;
  }
  await service.init();
  try {
    const { LongRunManager } = require('./long-run.cjs');
    service.longRuns = await new LongRunManager({ service, resources, managedLifetime: options.managedLifetime === true, ...options.longRuns }).init();
    return service;
  } catch (error) { await service.close(); throw error; }
}
module.exports = { createDefaultService, executorSettings };

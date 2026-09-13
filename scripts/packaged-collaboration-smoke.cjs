// Launch only the built test application with a fresh, ACL-capable user temp
// directory. No user profile, model request or existing desktop is controlled.
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
async function main() {
  const resources = path.join(root, 'release/win-unpacked/resources/runtime');
  const { desktopBridgeStatus, descriptorPath } = require(path.join(resources, 'collaboration/harness-desktop-client.cjs'));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'packaged-collaboration-'));
  const home = path.join(data, 'harness-home');
  const env = { ...process.env, DSH_DESKTOP_TEST_DATA: data, PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}` };
  delete env.ELECTRON_RUN_AS_NODE; delete env.DSH_HOME; delete env.DEEPSEEK_API_KEY;
  const expectedVersion = require('../package.json').version;
  const report = { desktopVersion: expectedVersion, isolatedData: data, developmentToolsOnChildPath: false, modelCalls: 0, launches: [] };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const app = await electron.launch({ executablePath: path.join(root, 'release/win-unpacked/DeepSeek Harness Desktop.exe'), args: [], env, timeout: 60000 });
    try {
      const page = await app.firstWindow();
      await page.locator('#status-short').filter({ hasText: /本地服务已就绪|需要处理/ }).waitFor({ timeout: 120000 });
      const state = await page.evaluate(() => window.desktop.state());
      assert.equal(state.phase, 'ready', state.message);
      assert.equal(state.desktopVersion, expectedVersion);
      assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
      const bridge = await desktopBridgeStatus(home);
      assert.equal(bridge.available, true, bridge.reason);
      const owner = JSON.parse(await fs.readFile(path.join(home, '.desktop-owner.json'), 'utf8'));
      assert.equal(bridge.pid, owner.pid);
      if (attempt === 1) await fs.writeFile(path.join(home, 'collaboration-smoke-marker'), 'preserved');
      else assert.equal(await fs.readFile(path.join(home, 'collaboration-smoke-marker'), 'utf8'), 'preserved');
      report.launches.push({ attempt, ready: true, harnessVersion: state.active, bridgeAuthenticated: true, bridgeIsDesktopChild: true });
    } finally { await app.close(); }
    assert.equal((await desktopBridgeStatus(home, { connectTimeoutMs: 1000 })).available, false);
    await assert.rejects(fs.access(descriptorPath(home)), { code: 'ENOENT' });
  }
  report.passed = true;
  await fs.mkdir(path.join(root, '.test-data'), { recursive: true });
  await fs.writeFile(path.join(root, '.test-data/packaged-collaboration-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

// Update only this project's installed runtime extensions, with recoverable
// snapshots. This never restarts a user application or touches its data home.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { within } = require('../collaboration/core.cjs');
async function install({ target, dryRun = false }) {
  if (!path.isAbsolute(target || '')) throw new Error('An explicit absolute installed application directory is required.');
  const application = await fs.realpath(target);
  await fs.access(path.join(application, 'DeepSeek Harness Desktop.exe'));
  const runtime = await fs.realpath(path.join(application, 'resources', 'runtime'));
  if (!within(application, runtime)) throw new Error('Installed runtime resolves outside the selected application.');
  const manifest = JSON.parse(await fs.readFile(path.join(runtime, 'manifest.json'), 'utf8'));
  if (manifest.harnessVersion !== '0.1.5-rc.1') throw new Error('This bridge is verified only with Harness 0.1.5-rc.1.');
  const sourceRoot = path.resolve(__dirname, '..');
  const groups = ['collaboration', 'desktop-integrations'].map(name => ({ name,
    source: path.join(sourceRoot, name === 'desktop-integrations' ? 'integrations' : name),
    destination: path.join(runtime, name) }));
  await fs.access(path.join(sourceRoot, 'collaboration', 'harness-desktop-server.cjs'));
  await fs.access(path.join(sourceRoot, 'collaboration', 'harness-desktop-worker.cjs'));
  const report = { application, runtime, harnessVersion: manifest.harnessVersion, dryRun, restartedApplication: false, groups: groups.map(g => g.name) };
  if (dryRun) return report;
  const tag = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  report.backups = [];
  for (const group of groups) {
    const stage = path.join(runtime, `${group.name}.staging-${tag}`);
    const backup = path.join(runtime, `${group.name}.before-${tag}`);
    for (const candidate of [stage, backup, group.destination]) if (!within(runtime, path.resolve(candidate))) throw new Error('Extension target escaped the selected runtime.');
    await fs.cp(group.source, stage, { recursive: true });
    let existed = false;
    try {
      const current = await fs.realpath(group.destination);
      if (!within(runtime, current)) throw new Error('Existing extension resolves outside the runtime.');
      await fs.rename(group.destination, backup); existed = true; report.backups.push(backup);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await fs.rename(stage, group.destination); }
    catch (error) { if (existed) await fs.rename(backup, group.destination); throw error; }
  }
  const records = {};
  for (const file of ['collaboration/harness-desktop-server.cjs', 'collaboration/harness-desktop-client.cjs', 'collaboration/harness-desktop-worker.cjs', 'desktop-integrations/index.cjs']) {
    records[file] = createHash('sha256').update(await fs.readFile(path.join(runtime, file))).digest('hex');
  }
  report.installedAt = new Date().toISOString(); report.sha256 = records;
  await fs.writeFile(path.join(runtime, 'desktop-collaboration-install.json'), JSON.stringify(report, null, 2));
  return report;
}
if (require.main === module) {
  const at = process.argv.indexOf('--target');
  install({ target: process.argv[at + 1], dryRun: process.argv.includes('--dry-run') }).then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { install };

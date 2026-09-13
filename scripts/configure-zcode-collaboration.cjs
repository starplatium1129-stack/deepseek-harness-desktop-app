// Explicit local setup only. Does not launch ZCode, copy its data, or solve
// authentication challenges. The original native application owns its profile.
const fs = require('node:fs/promises');
const path = require('node:path');
const { defaultDataDir } = require('../collaboration/cli.cjs');
async function configure({ profileMode, dataDir = defaultDataDir() }) {
  if (!['dedicated', 'existing'].includes(profileMode)) throw new Error('Choose dedicated or existing.');
  if (!path.isAbsolute(dataDir)) throw new Error('dataDir must be absolute.');
  await fs.mkdir(dataDir, { recursive: true });
  const file = path.join(await fs.realpath(dataDir), 'executors.json');
  const value = { zcode: { profileMode } };
  let previous;
  try { previous = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous) await fs.copyFile(file, `${file}.before-${Date.now()}`, require('node:fs').constants.COPYFILE_EXCL);
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
  if ((await fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; })) !== previous) { await fs.unlink(temp); throw new Error('Executor settings changed concurrently.'); }
  await fs.rename(temp, file);
  return { file, ...value, launchedZCode: false, restartServiceRequired: true };
}
if (require.main === module) {
  const mode = process.argv[2];
  const at = process.argv.indexOf('--data-dir');
  if (!mode || mode === '--help') console.log('node scripts/configure-zcode-collaboration.cjs <dedicated|existing> [--data-dir <absolute-directory>]');
  else configure({ profileMode: mode, ...(at >= 0 ? { dataDir: process.argv[at + 1] } : {}) }).then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { configure };

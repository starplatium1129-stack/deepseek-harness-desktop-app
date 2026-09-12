const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function prepareIntegrationPatch(runtimeResources, runtimeRoot, home) {
  const plugin = path.join(runtimeResources, 'desktop-integrations', 'index.cjs');
  try { await fs.access(plugin); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  const patch = [
    { insert: [{ id: 'desktop-integrations', name: pathToFileURL(plugin).href, config: { runtimeRoot } }] },
    { id: 'web', config: { searchProvider: 'desktop-exa', fetchProvider: 'http' } },
  ];
  const file = path.join(home, '.desktop-integrations.json');
  const text = JSON.stringify(patch, null, 2);
  let existing;
  try { existing = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing !== text) { await fs.writeFile(`${file}.tmp`, text); await fs.rename(`${file}.tmp`, file); }
  return file;
}
module.exports = { prepareIntegrationPatch };

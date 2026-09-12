const { HarnessProcess, healthCheck } = require('../src/runtime.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
async function main() {
  const home = path.join(root, '.test-data', `smoke-${Date.now()}`);
  const host = new HarnessProcess(path.join(root, 'runtime/node/node.exe'), path.join(root, 'runtime/harness'), home);
  host.on('log', text => process.stdout.write(text));
  try {
    const url = await host.start();
    const result = await healthCheck(url);
    await fs.writeFile(path.join(home, 'desktop-smoke-marker'), 'preserved');
    console.log(`Web UI healthy: HTTP ${result.status}; ${result.bytes} bytes`);
  } finally { await host.stop(); }
  const again = new HarnessProcess(path.join(root, 'runtime/node/node.exe'), path.join(root, 'runtime/harness'), home);
  try {
    await again.start();
    if (await fs.readFile(path.join(home, 'desktop-smoke-marker'), 'utf8') !== 'preserved') throw new Error('Data not preserved');
    console.log('Second launch healthy; user data preserved.');
  } finally { await again.stop(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

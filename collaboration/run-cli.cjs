#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const { SharedClient } = require('./client.cjs');
const { defaultDataDir } = require('./cli.cjs');
const { safe } = require('./core.cjs');
async function main(argv) {
  const names = { start: 'start_run', get: 'get_run', list: 'list_runs', wait: 'wait_run', pause: 'pause_run', resume: 'resume_run' };
  const action = argv[0];
  if (!names[action] || argv.includes('--help')) { console.log('run-cli.cjs <start|get|list|wait|pause|resume> --allow-root <absolute-root> [--data-dir <absolute-dir>] [--input <JSON-file>] [--run-id <id>]'); return; }
  const options = { allowedRoots: [], dataDir: defaultDataDir() }; let inputFile, runId;
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index], value = argv[++index]; if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === '--allow-root') options.allowedRoots.push(value);
    else if (flag === '--data-dir') options.dataDir = value;
    else if (flag === '--input') inputFile = value;
    else if (flag === '--run-id') runId = value;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  const input = inputFile ? JSON.parse(await fs.readFile(inputFile, 'utf8')) : {};
  if (runId) input.runId = runId;
  const client = await SharedClient.connect(options);
  try { console.log(JSON.stringify(await client.call(names[action], input), null, 2)); }
  finally { client.close(); }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(safe(error.message)); process.exitCode = 1; });
module.exports = { main };

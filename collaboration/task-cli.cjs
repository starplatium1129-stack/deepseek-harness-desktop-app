#!/usr/bin/env node
'use strict';
// Source-version fallback when a desktop MCP tool catalog has not refreshed.
const fs = require('node:fs/promises');
const { SharedClient } = require('./client.cjs');
const { tools, safeError } = require('./mcp.cjs');
async function main(argv) {
  const [name, optionsFile, inputFile] = argv;
  if (!tools.some(t => t.name === name) || !optionsFile || argv.length > 3) throw new Error('Usage: task-cli.cjs <MCP tool name> <connection-options.json> [arguments.json]');
  const options = JSON.parse(await fs.readFile(optionsFile, 'utf8'));
  const input = inputFile ? JSON.parse(await fs.readFile(inputFile, 'utf8')) : {};
  const client = await SharedClient.connect(options);
  try { console.log(JSON.stringify(await client.call(name, input), null, 2)); } finally { client.close(); }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(safeError(error)); process.exitCode = 1; });
module.exports = { main };

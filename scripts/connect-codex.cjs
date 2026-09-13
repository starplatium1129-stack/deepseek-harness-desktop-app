// Register the local collaboration entry through Codex's supported CLI.
// Keeps backups beside the user's config, never in the project or task audit log.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const SERVER_NAME = 'agent-collaboration';

function configureTimeouts(source) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex(line => /^\[mcp_servers\.(?:agent-collaboration|"agent-collaboration")\]\s*$/.test(line.trim()));
  if (start < 0) throw new Error('Codex did not write the expected MCP server section.');
  let end = start + 1; while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  const values = { startup_timeout_sec: '30', tool_timeout_sec: '75' };
  const body = lines.slice(start + 1, end);
  for (const [key, value] of Object.entries(values)) {
    const at = body.findIndex(line => new RegExp(`^\\s*${key}\\s*=`).test(line));
    if (at < 0) body.unshift(`${key} = ${value}`); else body[at] = `${key} = ${value}`;
  }
  lines.splice(start + 1, end - start - 1, ...body);
  return lines.join('\n');
}

async function install({ root = path.resolve(__dirname, '..'), codex = 'codex', dryRun = false } = {}) {
  const repository = await fs.realpath(root);
  const node = path.join(repository, 'runtime', 'node', 'node.exe');
  const cli = path.join(repository, 'collaboration', 'cli.cjs');
  await Promise.all([fs.access(node), fs.access(cli), fs.access(path.join(repository, 'collaboration', 'bridge.cjs'))]);
  const args = [cli, '--shared', '--allow-root', repository];
  const cfgHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const config = path.join(cfgHome, 'config.toml');
  if (dryRun) return { name: SERVER_NAME, command: node, args, config, installed: false };
  await fs.mkdir(cfgHome, { recursive: true });
  const backup = `${config}.before-agent-collaboration-${Date.now()}`;
  let hadConfig = true;
  try { await fs.copyFile(config, backup, require('node:fs').constants.COPYFILE_EXCL); }
  catch (error) { if (error.code === 'ENOENT') hadConfig = false; else throw error; }
  await exec(codex, ['mcp', 'add', SERVER_NAME, '--', node, ...args], { windowsHide: true, timeout: 30000, maxBuffer: 32000 });
  const after = await fs.readFile(config, 'utf8');
  const amended = configureTimeouts(after);
  const temp = `${config}.agent-collaboration-${process.pid}.tmp`;
  await fs.writeFile(temp, amended, { flag: 'wx', mode: 0o600 });
  // Keep an intervening user edit intact rather than replacing it with our copy.
  if (await fs.readFile(config, 'utf8') !== after) { await fs.unlink(temp); throw new Error('Codex configuration changed concurrently; connection exists, timeout update was not applied.'); }
  await fs.rename(temp, config);
  const result = JSON.parse((await exec(codex, ['mcp', 'get', SERVER_NAME, '--json'], { windowsHide: true, timeout: 30000, maxBuffer: 32000 })).stdout);
  return { name: SERVER_NAME, installed: result.enabled === true, config, backup: hadConfig ? backup : null,
    transport: { command: node, args }, startupTimeoutSeconds: 30, toolTimeoutSeconds: 75 };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  if (!dryRun && !process.argv.includes('--install')) { console.log('Use --dry-run to inspect, or --install to register agent-collaboration in this user\'s Codex MCP configuration.'); }
  else install({ dryRun }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { install, configureTimeouts };

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
async function main() {
  const runtime = path.join(root, 'runtime');
  await fs.mkdir(path.join(runtime, 'node'), { recursive: true });
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build this target on Windows x64.');
  if (process.versions.node !== '24.18.0') throw new Error('Use Node 24.18.0 for the locked Windows runtime.');
  // A registered MCP service can already be using the bundled executable.
  // Preserve identical bytes; a genuinely different locked binary still fails.
  const sourceNode = await fs.readFile(process.execPath);
  const nodeFile = path.join(runtime, 'node', 'node.exe');
  const existingNode = await fs.readFile(nodeFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!existingNode?.equals(sourceNode)) await fs.copyFile(process.execPath, nodeFile);
  await fs.copyFile(path.join(__dirname, 'harness-launcher.cjs'), path.join(runtime, 'harness-launcher.cjs'));
  await fs.cp(path.join(root, 'integrations'), path.join(runtime, 'desktop-integrations'), { recursive: true });
  await fs.cp(path.join(root, 'collaboration'), path.join(runtime, 'collaboration'), { recursive: true });
  await fs.copyFile(path.join(root, 'LICENSE'), path.join(runtime, 'collaboration', 'LICENSE'));
  await fs.mkdir(path.join(runtime, 'collaboration', 'docs'), { recursive: true });
  for (const file of ['agent-collaboration-design.md', 'collaboration-mcp.md', 'collaboration-validation.md', 'codex-collaboration-connection.md', 'harness-collaboration.md', 'harness-desktop-bridge.md', 'zcode-protocol.md', 'zcode-renderer-protocol.md', 'zcode-verification-feedback.md', 'windows-legacy-upgrade.md', 'long-running-collaboration.md', 'codex-dispatcher-return.md']) {
    await fs.copyFile(path.join(root, 'docs', file), path.join(runtime, 'collaboration', 'docs', file));
  }
  const npmPath = path.join(path.dirname(process.execPath), 'node_modules', 'npm');
  await fs.cp(npmPath, path.join(runtime, 'npm'), { recursive: true });
  const harness = path.join(runtime, 'harness');
  const pinnedLock = await fs.readFile(path.join(root, 'harness-lock.json'));
  const pinnedVersion = JSON.parse(pinnedLock).packages?.['']?.dependencies?.['@deepseek-ai/dsh'];
  if (!require('semver').valid(pinnedVersion)) throw new Error('Harness lock must pin an exact version.');
  let prepared = false;
  try {
    const installed = JSON.parse(await fs.readFile(path.join(harness, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')));
    prepared = installed.version === pinnedVersion && (await fs.readFile(path.join(harness, 'package-lock.json'))).equals(pinnedLock);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!prepared) {
    await fs.mkdir(harness, { recursive: true });
    await fs.writeFile(path.join(harness, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': pinnedVersion } }));
    await fs.copyFile(path.join(root, 'harness-lock.json'), path.join(harness, 'package-lock.json'));
    execFileSync(process.execPath, [path.join(npmPath, 'bin/npm-cli.js'), 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: harness, stdio: 'inherit', windowsHide: true });
  }
  const pkg = JSON.parse(await fs.readFile(path.join(runtime, 'harness', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')));
  if (pkg.version !== pinnedVersion) throw new Error('Prepared Harness version does not match the lock.');
  const nodeLicense = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`);
  if (!nodeLicense.ok) throw new Error('Cannot retrieve Node license');
  await fs.writeFile(path.join(runtime, 'node', 'LICENSE'), await nodeLicense.text());
  await fs.writeFile(path.join(runtime, 'manifest.json'), JSON.stringify({ harnessVersion: pkg.version, nodeVersion: process.versions.node, nodeSha256: crypto.createHash('sha256').update(sourceNode).digest('hex'), platform: 'win32-x64' }, null, 2));
  const sharp = require('sharp');
  // Preserve the supplied artwork; only produce square icon format variants.
  await sharp(path.join(root, 'assets', 'icon-source.png')).resize(512, 512, { fit: 'contain', background: '#00000000' }).png().toFile(path.join(root, 'assets', 'icon.png'));
  const pngToIco = (await import('png-to-ico')).default;
  await fs.writeFile(path.join(root, 'assets', 'icon.ico'), await pngToIco(path.join(root, 'assets', 'icon.png')));
  console.log(`Prepared Harness ${pkg.version} + Node ${process.versions.node}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });

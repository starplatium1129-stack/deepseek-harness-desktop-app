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
  await fs.copyFile(process.execPath, path.join(runtime, 'node', 'node.exe'));
  await fs.copyFile(path.join(__dirname, 'harness-launcher.cjs'), path.join(runtime, 'harness-launcher.cjs'));
  await fs.cp(path.join(root, 'integrations'), path.join(runtime, 'desktop-integrations'), { recursive: true });
  const npmPath = path.join(path.dirname(process.execPath), 'node_modules', 'npm');
  await fs.cp(npmPath, path.join(runtime, 'npm'), { recursive: true });
  const harness = path.join(runtime, 'harness');
  try { await fs.access(path.join(harness, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')); }
  catch {
    await fs.mkdir(harness, { recursive: true });
    await fs.writeFile(path.join(harness, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '0.1.5-rc.1' } }));
    await fs.copyFile(path.join(root, 'harness-lock.json'), path.join(harness, 'package-lock.json'));
    execFileSync(process.execPath, [path.join(npmPath, 'bin/npm-cli.js'), 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: harness, stdio: 'inherit', windowsHide: true });
  }
  const pkg = JSON.parse(await fs.readFile(path.join(runtime, 'harness', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')));
  await fs.copyFile(path.join(runtime, 'harness', 'package-lock.json'), path.join(root, 'harness-lock.json'));
  const nodeLicense = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`);
  if (!nodeLicense.ok) throw new Error('Cannot retrieve Node license');
  await fs.writeFile(path.join(runtime, 'node', 'LICENSE'), await nodeLicense.text());
  await fs.writeFile(path.join(runtime, 'manifest.json'), JSON.stringify({ harnessVersion: pkg.version, nodeVersion: process.versions.node, nodeSha256: crypto.createHash('sha256').update(await fs.readFile(process.execPath)).digest('hex'), platform: 'win32-x64' }, null, 2));
  const sharp = require('sharp');
  // Preserve the supplied artwork; only produce square icon format variants.
  await sharp(path.join(root, 'assets', 'icon-source.png')).resize(512, 512, { fit: 'contain', background: '#00000000' }).png().toFile(path.join(root, 'assets', 'icon.png'));
  const pngToIco = (await import('png-to-ico')).default;
  await fs.writeFile(path.join(root, 'assets', 'icon.ico'), await pngToIco(path.join(root, 'assets', 'icon.png')));
  console.log(`Prepared Harness ${pkg.version} + Node ${process.versions.node}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });

const fs = require('node:fs/promises');
const { writeFileSync } = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const semver = require('semver');
const { prepareIntegrationPatch } = require('./integrations.cjs');

const REGISTRY = 'https://registry.npmjs.org';
const PACKAGE = '@deepseek-ai/dsh';
function validVersion(value) { return typeof value === 'string' && semver.valid(value) === value; }
function redact(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '').replace(/(https?:\/\/127\.0\.0\.1:\d+)[^\s]*/g, '$1/[private]')
    .replace(/sk-[a-zA-Z0-9_-]+/g, '[redacted]').replace(/(Bearer\s+)\S+/gi, '$1[redacted]');
}
async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(data, null, 2));
  await fs.rename(`${file}.tmp`, file);
}
function cleanEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NODE_OPTIONS|ELECTRON_RUN_AS_NODE|DSH_.*|npm_.*|pnpm_.*)$/i.test(k)));
  return { ...env, ...extra };
}
async function copyTree(source, destination) {
  // Preserve upstream's Windows directory junctions without requiring developer mode.
  await fs.cp(source, destination, { recursive: true, filter: async (from, to) => {
    const entry = await fs.lstat(from);
    if (!entry.isSymbolicLink()) return true;
    await fs.mkdir(path.dirname(to), { recursive: true });
    const target = path.resolve(path.dirname(from), await fs.readlink(from));
    const targetStat = await fs.stat(from);
    if (targetStat.isDirectory()) await fs.symlink(target, to, process.platform === 'win32' ? 'junction' : 'dir');
    else await fs.copyFile(from, to);
    return false;
  } });
}
async function healthCheck(url) {
  let response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  if (response.status === 303) {
    const target = new URL(response.headers.get('location'), url);
    if (target.origin !== new URL(url).origin) throw new Error('启动认证发生了跨域跳转。');
    const cookies = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    response = await fetch(target, { headers: { Cookie: cookies }, signal: AbortSignal.timeout(15000) });
  }
  const html = await response.text();
  if (!response.ok || !/<html[\s>]/i.test(html)) throw new Error(`界面健康检查失败（HTTP ${response.status}）。`);
  return { status: response.status, bytes: html.length };
}
async function recoverOwnedLocks(home) {
  const owner = await readJson(path.join(home, '.desktop-owner.json'), null);
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return;
  try { process.kill(owner.pid, 0); return; } catch (error) { if (error.code !== 'ESRCH') return; }
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && entry.name !== 'node_modules') await visit(file);
      else if (entry.isFile() && entry.name.endsWith('.lock')) {
        const stat = await fs.stat(file);
        if (stat.size <= 20 && (await fs.readFile(file, 'utf8')).trim() === String(owner.pid)) await fs.unlink(file);
      }
    }
  }
  await visit(home);
}
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (child.connected) {
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 8000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.send({ type: 'shutdown' }, () => {});
    });
    if (child.exitCode !== null || child.signalCode !== null) return;
  }
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', resolve); killer.once('close', resolve);
    });
  } else { child.kill('SIGTERM'); }
}

class HarnessProcess extends EventEmitter {
  constructor(node, root, home, extraEnv = {}) { super(); Object.assign(this, { node, root, home, extraEnv }); this.child = null; this.stopping = false; }
  async start(timeout = 90000) {
    await fs.mkdir(this.home, { recursive: true });
    await recoverOwnedLocks(this.home);
    const entry = path.join(this.root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    await fs.access(entry);
    const launcher = path.resolve(path.dirname(this.node), '..', 'harness-launcher.cjs');
    let args = [entry, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'];
    const patch = await prepareIntegrationPatch(path.dirname(launcher), this.root, this.home);
    if (patch) args.splice(1, 1, '--profile', 'web', '--patch', patch);
    try { await fs.access(launcher); args.unshift(launcher); } catch {}
    const child = this.child = spawn(this.node, args, {
      cwd: this.home, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: cleanEnv({ ...this.extraEnv, DSH_HOME: this.home, PATH: `${path.dirname(this.node)}${path.delimiter}${process.env.PATH || ''}` }),
    });
    if (child.pid) writeFileSync(path.join(this.home, '.desktop-owner.json'), JSON.stringify({ pid: child.pid }));
    try {
      return await new Promise((resolve, reject) => {
        let buffer = '', tail = '', settled = false;
        const timer = setTimeout(() => finish(new Error('Harness 启动超时，请查看诊断日志。')), timeout);
        const finish = (error, url) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(url); };
        child.once('error', error => finish(error));
        child.once('exit', code => {
          finish(new Error(`Harness 已退出（${code}）。${tail.slice(-1800)}`));
          if (!this.stopping) this.emit('crash', code);
        });
        const output = (chunk, stdout) => {
          const text = String(chunk);
          const safe = redact(this.extraEnv.DEEPSEEK_API_KEY ? text.replaceAll(this.extraEnv.DEEPSEEK_API_KEY, '[redacted]') : text);
          tail = (tail + safe).slice(-4000); this.emit('log', safe);
          if (!stdout) return;
          buffer = (buffer + text).slice(-16000);
          const match = buffer.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+[^\s]*)[\r\n]/);
          if (match) {
            const url = new URL(match[1]);
            if (url.hostname === '127.0.0.1' && Number(url.port) > 0) finish(null, url.href);
          }
        };
        child.stdout.on('data', c => output(c, true)); child.stderr.on('data', c => output(c, false));
      });
    } catch (error) { await this.stop(); throw error; }
  }
  async stop() { this.stopping = true; await stopChild(this.child); this.child = null; }
}

class RuntimeManager extends EventEmitter {
  constructor(resources, data) {
    super(); Object.assign(this, { resources, data });
    this.node = path.join(resources, 'node', 'node.exe'); this.home = path.join(data, 'harness-home');
    this.stateFile = path.join(data, 'runtime-state.json'); this.busy = false;
  }
  async init() {
    this.seed = await readJson(path.join(this.resources, 'manifest.json'));
    if (!validVersion(this.seed.harnessVersion)) throw new Error('内置运行时版本无效。');
    this.state = await readJson(this.stateFile, { active: this.seed.harnessVersion });
    for (const key of ['active', 'previous', 'pending']) if (this.state[key] && !validVersion(this.state[key])) throw new Error('运行时版本记录损坏。');
    // Preserve a seed copy before a future desktop installer replaces resources.
    const savedSeed = path.join(this.data, 'versions', this.seed.harnessVersion);
    try { await fs.access(path.join(savedSeed, '.desktop-seed-ready')); }
    catch {
      this.emit('progress', '首次准备运行环境，正在保存可回退的内置版本…');
      const staging = path.join(this.data, 'staging', `seed-${Date.now()}`);
      await copyTree(path.join(this.resources, 'harness'), staging);
      await fs.writeFile(path.join(staging, '.desktop-seed-ready'), this.seed.harnessVersion);
      await fs.mkdir(path.dirname(savedSeed), { recursive: true });
      try { await fs.rename(savedSeed, `${savedSeed}-saved-${Date.now()}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.rename(staging, savedSeed);
    }
  }
  root(version) { return path.join(this.data, 'versions', version); }
  async check() {
    const response = await fetch(`${REGISTRY}/@deepseek-ai%2fdsh`, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`版本服务返回 ${response.status}`);
    const metadata = await response.json();
    const version = metadata['dist-tags']?.latest;
    if (!validVersion(version)) throw new Error('上游版本格式无效。');
    const release = metadata.versions?.[version];
    if (!release?.dist?.integrity?.startsWith('sha512-')) throw new Error('上游包缺少 SHA-512 校验信息。');
    if (release.engines?.node && !semver.satisfies(this.seed.nodeVersion, release.engines.node)) throw new Error('新版需要更新桌面内置 Node，请等待新版桌面安装包。');
    this.available = { version, integrity: release.dist.integrity, newer: semver.gt(version, this.state.active), published: metadata.time?.[version] };
    return this.available;
  }
  async stage() {
    if (this.busy) throw new Error('已有更新正在准备。');
    this.busy = true;
    try {
      const candidate = await this.check();
      if (!candidate.newer) return { message: '当前已经是最新版本。' };
      const stage = path.join(this.data, 'staging', `${candidate.version}-${Date.now()}`);
      await fs.mkdir(stage, { recursive: true });
      await writeJson(path.join(stage, 'package.json'), { private: true, dependencies: { [PACKAGE]: candidate.version } });
      this.emit('progress', '正在下载并校验上游依赖…');
      await new Promise((resolve, reject) => {
        const child = spawn(this.node, [path.join(this.resources, 'npm', 'bin', 'npm-cli.js'), 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--registry', REGISTRY], {
          cwd: stage, windowsHide: true, env: cleanEnv({ PATH: `${path.dirname(this.node)}${path.delimiter}${process.env.PATH || ''}`, npm_config_userconfig: path.join(stage, '.npmrc') }), stdio: ['ignore', 'pipe', 'pipe'],
        });
        this.installer = child;
        let tail = '';
        const timer = setTimeout(() => { void stopChild(child); reject(new Error('更新下载超时，可稍后重试。')); }, 600000);
        const output = c => { tail = (tail + redact(c)).slice(-2000); };
        child.stdout.on('data', output); child.stderr.on('data', output);
        child.once('error', e => { clearTimeout(timer); reject(e); });
        child.once('close', code => { clearTimeout(timer); this.installer = null; code === 0 ? resolve() : reject(new Error(`依赖安装失败：${tail}`)); });
      });
      const lock = await readJson(path.join(stage, 'package-lock.json'));
      if (lock.packages?.['node_modules/@deepseek-ai/dsh']?.integrity !== candidate.integrity) throw new Error('上游包校验信息发生变化，已停止更新。');
      this.emit('progress', '正在隔离环境中验证新版启动…');
      const probe = this.probe = new HarnessProcess(this.node, stage, path.join(stage, '.probe-home'));
      try {
        const url = await probe.start();
        await healthCheck(url);
      } finally { await probe.stop(); this.probe = null; }
      await fs.rm(path.join(stage, '.probe-home'), { recursive: true, force: true });
      const destination = this.root(candidate.version);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      try { await fs.rename(destination, `${destination}-replaced-${Date.now()}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.rename(stage, destination);
      this.state.pending = candidate.version; await writeJson(this.stateFile, this.state);
      return { message: '新版已准备好。退出应用后，下次启动时生效；当前任务不会被打断。' };
    } finally { this.busy = false; }
  }
  async start(extraEnv = {}) {
    let switching = false;
    if (this.state.pending) {
      this.emit('progress', '正在备份数据并应用已验证的更新…');
      const snapshot = `before-${Date.now()}`;
      await fs.mkdir(this.home, { recursive: true });
      await copyTree(this.home, path.join(this.data, 'backups', snapshot));
      this.state = { active: this.state.pending, previous: this.state.active, snapshot, trial: true };
      await writeJson(this.stateFile, this.state); switching = true;
    } else if (this.state.trial) {
      // An interrupted first launch must restore the old runtime and matching data.
      await this.restore();
    }
    try {
      const url = await this.launch(extraEnv);
      this.state.trial = false; await writeJson(this.stateFile, this.state); return url;
    } catch (error) {
      if (!switching) throw error;
      this.emit('progress', '新版启动失败，正在恢复上一版本及数据…');
      await this.restore(); return this.launch(extraEnv);
    }
  }
  async launch(extraEnv) {
    this.process = new HarnessProcess(this.node, this.root(this.state.active), this.home, extraEnv);
    this.process.on('log', text => this.emit('log', text)); this.process.on('crash', code => this.emit('crash', code));
    const url = await this.process.start();
    try { await healthCheck(url); return url; } catch (error) { await this.process.stop(); throw error; }
  }
  async restore() {
    if (!this.state.previous || !/^before-\d+$/.test(this.state.snapshot || '')) throw new Error('没有可用的回退快照。');
    await fs.access(path.join(this.data, 'backups', this.state.snapshot));
    await this.process?.stop();
    await fs.rename(this.home, path.join(this.data, `recovered-data-${Date.now()}`));
    await copyTree(path.join(this.data, 'backups', this.state.snapshot), this.home);
    this.state = { active: this.state.previous }; await writeJson(this.stateFile, this.state);
  }
  async stop() { await Promise.all([this.process?.stop(), this.probe?.stop(), stopChild(this.installer)]); }
}
module.exports = { HarnessProcess, RuntimeManager, validVersion, redact, writeJson, readJson, healthCheck, recoverOwnedLocks, copyTree };

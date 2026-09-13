'use strict';

// A single core owns the existing service.lock. Each authenticated IPC connection
// owns only its MCP transport, never the core or the native tasks.
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { randomBytes, timingSafeEqual, createHmac } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createMcpServer, tools, safeError } = require('./mcp.cjs');
const exec = promisify(execFile);
const DEFAULT_IDLE_MS = 300000;
const IPC_VERSION = 1;

function identityPath(value) { return process.platform === 'win32' ? value.toLowerCase() : value; }
async function canonicalRoots(roots) {
  if (!Array.isArray(roots) || !roots.length || roots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) throw new Error('Explicit absolute allowed roots are required');
  return [...new Set(await Promise.all(roots.map(async root => identityPath(await fs.realpath(root)))))].sort();
}
function equalRoots(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function authenticationProof(owner, request, challenge, role) {
  return createHmac('sha256', Buffer.from(owner.token, 'hex')).update(JSON.stringify([
    IPC_VERSION, role, owner.endpointId, challenge, request.clientNonce, request.allowedRoots, request.operation,
  ])).digest('hex');
}
function equalProof(received, expected) {
  return typeof received === 'string' && /^[a-f0-9]{64}$/.test(received) && timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
}

async function privateDirectory(dataDir) {
  if (!path.isAbsolute(dataDir)) throw new Error('dataDir must be absolute');
  await fs.mkdir(dataDir, { recursive: true });
  const realDataDir = await fs.realpath(dataDir);
  const directory = path.join(realDataDir, 'ipc');
  await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('IPC directory must be a real private directory');
  if (process.platform === 'win32') {
    // Node chmod does not implement Windows ACLs. Remove inherited entries and
    // grant this user's SID alone full control before creating any credentials.
    const script = "$ErrorActionPreference='Stop'; $p=$env:DSH_COLLAB_PRIVATE_DIR; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); [System.IO.Directory]::SetAccessControl($p,$acl)";
    await exec(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000, env: { ...process.env, DSH_COLLAB_PRIVATE_DIR: directory } });
  } else {
    if (stat.uid !== process.getuid()) throw new Error('IPC directory belongs to another user');
    await fs.chmod(directory, 0o700);
  }
  return { dataDir: realDataDir, directory, ownerFile: path.join(directory, 'owner.json') };
}

async function readOwner(ownerFile, allowedRoots) {
  let owner;
  try { owner = JSON.parse(await fs.readFile(ownerFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Shared service owner configuration cannot be read'); }
  if (owner.version !== IPC_VERSION || !/^[a-f0-9]{64}$/.test(owner.token || '') || !/^[a-f0-9]{48}$/.test(owner.endpointId || '') || !Array.isArray(owner.allowedRoots)) throw new Error('Shared service owner configuration is invalid');
  if (!equalRoots(owner.allowedRoots, allowedRoots)) throw new Error('Shared service allowed roots differ from its persistent owner configuration; use the exact same roots or a separate --data-dir');
  return owner;
}

function endpointFor(owner) {
  // The unpredictable name is in the private owner file. Another local user
  // cannot pre-bind a predictable pipe name and receive the authentication key.
  return process.platform === 'win32' ? `\\\\.\\pipe\\dsh-collaboration-${owner.endpointId}` : path.join(os.tmpdir(), `dsh-collaboration-${owner.endpointId}.sock`);
}

async function createOwner(location, allowedRoots) {
  const existing = await readOwner(location.ownerFile, allowedRoots);
  if (existing) return existing;
  const owner = { version: IPC_VERSION, allowedRoots, token: randomBytes(32).toString('hex'), endpointId: randomBytes(24).toString('hex') };
  // Publish a complete file atomically, with no partially readable auth secret.
  const temp = path.join(location.directory, `owner-${randomBytes(12).toString('hex')}.tmp`);
  await fs.writeFile(temp, JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
  try { await fs.link(temp, location.ownerFile); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  finally { await fs.unlink(temp); }
  return readOwner(location.ownerFile, allowedRoots);
}

async function startDaemon({ dataDir, allowedRoots, idleMs = DEFAULT_IDLE_MS, createService, error = process.stderr, signals = process }) {
  const roots = await canonicalRoots(allowedRoots);
  const location = await privateDirectory(dataDir);
  const owner = await createOwner(location, roots);
  const service = await (createService || require('./index.cjs').createDefaultService)({ dataDir: location.dataDir, allowedRoots: roots, managedLifetime: true });
  const endpoint = endpointFor(owner), connections = new Set(), sessions = new Set();
  let inflight = 0, closing = false, closePromise, idleSince = Date.now(), finish;
  const done = new Promise(resolve => { finish = resolve; });
  const hasPersistentResources = () => { try { return Boolean(service.hasPersistentResources?.()); } catch { return true; } };
  const hasWork = () => hasPersistentResources() || inflight > 0 || service.longRuns?.active?.size > 0 || service.active?.size > 0 || [...(service.tasks?.values() || [])].some(task => task.state === 'queued' || task.state === 'running');
  const status = () => ({ pid: process.pid, clientCount: sessions.size, activeCount: service.active?.size || 0,
    queuedCount: [...(service.tasks?.values() || [])].filter(task => task.state === 'queued').length,
    inflightCount: inflight, coordinatorCount: service.longRuns?.active?.size || 0, persistentResources: hasPersistentResources(), busy: hasWork(), closing, managementVersion: 1 });
  const log = cause => { if (!error.destroyed) error.write(`[collaboration-daemon] ${safeError(cause)}\n`); };
  const server = net.createServer(socket => {
    if (closing || connections.size >= 64) { socket.destroy(); return; }
    connections.add(socket); idleSince = Date.now();
    socket.on('error', () => {});
    socket.once('close', () => { connections.delete(socket); idleSince = Date.now(); });
    let authBuffer = Buffer.alloc(0);
    const challenge = randomBytes(32).toString('hex');
    socket.write(JSON.stringify({ version: IPC_VERSION, challenge }) + '\n');
    const timeout = setTimeout(() => socket.destroy(), 5000);
    const reject = message => { socket.end(JSON.stringify({ ok: false, error: message }) + '\n', () => socket.destroy()); };
    function auth(chunk) {
      authBuffer = Buffer.concat([authBuffer, chunk]);
      const index = authBuffer.indexOf(10);
      if (index < 0 && authBuffer.length <= 16384) return;
      socket.pause(); socket.removeListener('data', auth); clearTimeout(timeout);
      if (index < 0 || index > 16384) { reject('Authentication frame exceeds limit'); return; }
      let request;
      try { request = JSON.parse(authBuffer.subarray(0, index).toString('utf8')); }
      catch { reject('Authentication required'); return; }
      if (request?.version !== IPC_VERSION || !/^[a-f0-9]{64}$/.test(request.clientNonce || '') || !equalProof(request.proof, authenticationProof(owner, request, challenge, 'client'))) { reject('Authentication failed'); return; }
      if (!equalRoots(request.allowedRoots, roots)) { reject('Allowed roots do not match service owner'); return; }
      if (request.operation === 'status') {
        socket.end(JSON.stringify({ ok: true, status: status(), proof: authenticationProof(owner, request, challenge, 'server') }) + '\n', () => socket.destroy());
        return;
      }
      if (closing) { reject('Shared service is stopping'); return; }
      if (request.operation === 'shutdown' || request.operation === 'restart') {
        if (hasPersistentResources()) { reject('A native window is still open; close it in the native app before stopping or restarting the shared service'); return; }
        if (hasWork()) { reject('Shared service is busy; active or queued tasks and in-flight requests must finish first'); return; }
        if (request.operation === 'shutdown' && sessions.size) { reject('Shared service is busy; other clients must finish first'); return; }
        // Reserve shutdown synchronously with the no-work check. Existing idle
        // clients cannot submit new work between acknowledgment and close().
        closing = true;
        socket.end(JSON.stringify({ ok: true, pid: process.pid, stopping: true, restarting: request.operation === 'restart', proof: authenticationProof(owner, request, challenge, 'server') }) + '\n', () => { void close().catch(log); });
        return;
      }
      if (request.operation !== 'connect') { reject('Unknown authenticated operation'); return; }
      const sessionService = { close: async () => {} };
      for (const tool of tools) sessionService[tool.method] = async args => {
        if (closing) throw new Error('Shared service is stopping');
        inflight++;
        try { return await service[tool.method](args); }
        finally { inflight--; idleSince = Date.now(); }
      };
      socket.write(JSON.stringify({ ok: true, version: IPC_VERSION, pid: process.pid, proof: authenticationProof(owner, request, challenge, 'server') }) + '\n');
      const mcp = createMcpServer({ service: sessionService, input: socket, output: socket, error });
      sessions.add(mcp);
      mcp.done.finally(() => { sessions.delete(mcp); idleSince = Date.now(); });
      // Normally the bridge waits for auth acknowledgment before sending MCP.
      const remaining = authBuffer.subarray(index + 1);
      authBuffer = Buffer.alloc(0);
      if (remaining.length) socket.unshift(remaining);
      socket.resume();
    }
    socket.on('data', auth);
    socket.once('close', () => clearTimeout(timeout));
  });
  let timer;
  function close({ force = false } = {}) {
    if (closePromise) return closePromise;
    if (hasPersistentResources()) return Promise.reject(Object.assign(new Error('A native window is still open; shared service must remain alive until the user closes it'), { code: 'PERSISTENT_NATIVE_RESOURCES' }));
    if (!force && hasWork()) return Promise.reject(new Error('Shared service still owns active tasks'));
    closing = true;
    closePromise = (async () => {
      // Core may discover a window during an in-progress native launch. Let it
      // refuse first, while the listener and client transports are still intact.
      await service.close();
      clearInterval(timer);
      signals.removeListener('SIGINT', stop); signals.removeListener('SIGTERM', stop);
      const stopped = new Promise(resolve => server.close(resolve));
      await Promise.all([...sessions].map(session => session.close()));
      for (const connection of connections) connection.destroy();
      await stopped;
      finish();
    })().catch(cause => { closing = false; closePromise = null; idleSince = Date.now(); throw cause; });
    return closePromise;
  }
  const stop = () => { void close({ force: true }).catch(log); };
  try {
    if (process.platform !== 'win32') {
      // Only the core lock owner may remove a stale Unix socket.
      await fs.unlink(endpoint).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, () => { server.removeListener('error', reject); resolve(); }); });
    if (process.platform !== 'win32') await fs.chmod(endpoint, 0o600);
    server.on('error', cause => { log(cause); void close({ force: true }).catch(log); });
    signals.on('SIGINT', stop); signals.on('SIGTERM', stop);
    timer = setInterval(() => {
      if (connections.size || hasWork()) { idleSince = Date.now(); return; }
      if (Date.now() - idleSince >= idleMs) void close().catch(log);
    }, Math.min(1000, Math.max(25, idleMs / 4)));
  } catch (cause) { server.close(); await service.close(); throw cause; }
  return { close, done, endpoint, service, get clientCount() { return sessions.size; }, hasWork };
}

module.exports = { startDaemon, canonicalRoots, privateDirectory, readOwner, endpointFor, authenticationProof, equalProof, DEFAULT_IDLE_MS, IPC_VERSION };

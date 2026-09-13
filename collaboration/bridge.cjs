'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomBytes } = require('node:crypto');
const { canonicalRoots, privateDirectory, readOwner, endpointFor, authenticationProof, equalProof, DEFAULT_IDLE_MS, IPC_VERSION } = require('./daemon.cjs');
const exec = promisify(execFile);

function quoteWindowsArgument(value) { return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'; }

async function spawnWindowsDaemon(executable, args) {
  // Launch through the existing same-user desktop shell, which owns this
  // background app's lifetime. Codex is free to clean up its MCP process tree.
  // This neither elevates nor registers an autorun, task or service. Never use a
  // different user/service context when a desktop shell is unavailable.
  const script = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CollaborationDesktopWindow {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}
'@
$shell=New-Object -ComObject Shell.Application
$window=0
$desktop=$shell.Windows().FindWindowSW(0,0,8,[ref]$window,1)
if($null -eq $desktop -or $window -eq 0) { throw 'Shared mode requires an already-running Explorer desktop for the current user.' }
[uint32]$shellPid=0
[void][CollaborationDesktopWindow]::GetWindowThreadProcessId([IntPtr]$window,[ref]$shellPid)
$query=New-Object System.Management.ManagementObjectSearcher('SELECT * FROM Win32_Process WHERE ProcessId = '+$shellPid)
$sameUser=$false
foreach($item in $query.Get()) {
  $owner=$item.InvokeMethod('GetOwnerSid',$null,$null)
  if($item.Name -eq 'explorer.exe' -and $owner.ReturnValue -eq 0 -and $owner.Sid -eq [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { $sameUser=$true }
}
$query.Dispose()
if(-not $sameUser) { throw 'Shared mode requires the existing desktop shell to belong to the current user.' }
$desktop.Document.Application.ShellExecute($env:DSH_COLLAB_SPAWN_EXE,$env:DSH_COLLAB_SPAWN_ARGUMENTS,$env:DSH_COLLAB_SPAWN_DIRECTORY,'open',0)`;
  try {
    await exec(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 15000,
      env: { ...process.env, DSH_COLLAB_SPAWN_EXE: executable, DSH_COLLAB_SPAWN_ARGUMENTS: args.map(quoteWindowsArgument).join(' '), DSH_COLLAB_SPAWN_DIRECTORY: path.dirname(executable) },
    });
  } catch (cause) {
    throw new Error(`Cannot launch the shared service through this user's existing Explorer desktop. ${cause.killed ? 'Desktop launch timed out.' : String(cause.stderr || 'No supported desktop launcher is available.').trim().slice(0, 1200)}`);
  }
}

function authenticate(owner, roots, operation = 'connect') {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpointFor(owner));
    let buffer = Buffer.alloc(0), settled = false, challenge;
    const request = { version: IPC_VERSION, clientNonce: randomBytes(32).toString('hex'), allowedRoots: roots, operation };
    const timer = setTimeout(() => fail(new Error('Shared service handshake timed out')), 5000);
    function fail(error) { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); reject(error); }
    socket.once('error', fail);
    socket.once('end', () => fail(new Error('Shared service closed during authentication')));
    function data(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const index = buffer.indexOf(10);
      if (buffer.length > 16384) { fail(new Error('Invalid shared service handshake')); return; }
      if (index < 0) return;
      let message;
      try { message = JSON.parse(buffer.subarray(0, index).toString('utf8')); }
      catch { fail(new Error('Invalid shared service handshake')); return; }
      if (!challenge) {
        if (message.version !== IPC_VERSION || !/^[a-f0-9]{64}$/.test(message.challenge || '') || buffer.length !== index + 1) { fail(new Error('Invalid shared service challenge')); return; }
        challenge = message.challenge; buffer = Buffer.alloc(0);
        // The credential never crosses IPC. Fresh, role-bound HMAC proofs also
        // authenticate the daemon before the bridge forwards any MCP content.
        socket.write(JSON.stringify({ ...request, proof: authenticationProof(owner, request, challenge, 'client') }) + '\n');
        return;
      }
      if (message.ok !== true) { fail(Object.assign(new Error(message.error || 'Shared service authentication rejected'), { code: 'AUTH_REJECTED' })); return; }
      if (!equalProof(message.proof, authenticationProof(owner, request, challenge, 'server'))) { fail(new Error('Shared service identity could not be authenticated')); return; }
      settled = true; clearTimeout(timer); socket.pause(); socket.removeListener('data', data); socket.removeListener('error', fail);
      if (buffer.length > index + 1) socket.unshift(buffer.subarray(index + 1));
      resolve({ socket, pid: message.pid, stopping: message.stopping, restarting: message.restarting, status: message.status });
    }
    socket.on('data', data);
  });
}

async function spawnOwnedDaemon({ dataDir, allowedRoots, idleMs, location, spawnProcess = spawn }) {
  const args = [path.join(__dirname, 'cli.cjs'), '--daemon', '--data-dir', dataDir, '--shared-idle-ms', String(idleMs)];
  for (const root of allowedRoots) args.push('--allow-root', root);
  if (process.platform === 'win32' && spawnProcess === spawn) {
    await spawnWindowsDaemon(process.execPath, args);
    return;
  }
  const log = await fs.open(path.join(location.directory, 'daemon.log'), 'a', 0o600);
  try {
    const child = spawnProcess(process.execPath, args, { detached: true, windowsHide: true, stdio: ['ignore', 'ignore', log.fd] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { await log.close(); }
}

async function connectShared({ dataDir, allowedRoots, idleMs = DEFAULT_IDLE_MS, startupMs = 25000, spawnDaemon = spawnOwnedDaemon, operation = 'connect' }) {
  const roots = await canonicalRoots(allowedRoots), location = await privateDirectory(dataDir);
  const deadline = Date.now() + startupMs;
  let spawned = false, lastError;
  while (Date.now() < deadline) {
    const owner = await readOwner(location.ownerFile, roots);
    if (owner) {
      try { return await authenticate(owner, roots, operation); }
      catch (cause) {
        if (['status', 'restart'].includes(operation) && cause.message === 'Unknown authenticated operation') throw Object.assign(new Error('The running daemon predates safe status/restart support. Close its existing MCP clients and use --shared-stop before starting the updated service; no process was killed.'), { code: 'MANAGEMENT_UNSUPPORTED' });
        if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET'].includes(cause.code)) throw cause;
        lastError = cause;
      }
    }
    if (operation !== 'connect') throw Object.assign(new Error('No running shared service was found'), { code: 'NO_SHARED_SERVICE' });
    if (!spawned) { spawned = true; await spawnDaemon({ dataDir: location.dataDir, allowedRoots: roots, idleMs, location }); }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Shared service did not start; inspect the private ipc/daemon.log in --data-dir (${lastError?.code || 'startup timeout'})`);
}

async function readSharedStatus(options) {
  const connection = await connectShared({ ...options, operation: 'status' });
  connection.socket.destroy();
  return connection.status;
}

async function restartShared(options) {
  let previousPid = null;
  try {
    const connection = await connectShared({ ...options, operation: 'restart' });
    previousPid = connection.pid;
    connection.socket.destroy();
  } catch (cause) { if (cause.code !== 'NO_SHARED_SERVICE') throw cause; }
  if (previousPid !== null) {
    const deadline = Date.now() + (options.startupMs || 25000);
    while (true) {
      let lock;
      try { lock = JSON.parse(await fs.readFile(path.join(options.dataDir, 'service.lock'), 'utf8')); }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      if (!lock || lock.pid !== previousPid) break;
      if (Date.now() >= deadline) throw new Error('Idle daemon acknowledged restart but did not release its own lock; it was not forcefully killed');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  const replacement = await connectShared({ ...options, operation: 'connect' });
  const pid = replacement.pid;
  replacement.socket.destroy();
  return { restarted: previousPid !== null, previousPid, pid };
}

async function runBridge(options, { input = process.stdin, output = process.stdout, signals = process } = {}) {
  // Keep stdin bytes buffered until the authenticated service is available.
  input.pause();
  const { socket } = await connectShared(options);
  if (options.operation === 'shutdown') { socket.destroy(); return; }
  await new Promise((resolve, reject) => {
    let finished = false;
    const finish = cause => {
      if (finished) return; finished = true;
      input.unpipe(socket); socket.unpipe(output); input.pause(); input.destroy(); socket.destroy();
      signals.removeListener('SIGINT', stop); signals.removeListener('SIGTERM', stop);
      input.removeListener('end', onEnd); input.removeListener('error', onError);
      output.removeListener('error', onError); socket.removeListener('error', onError);
      if (cause) reject(cause); else resolve();
    };
    const stop = () => finish();
    const onEnd = () => finish();
    const onError = cause => finish(cause);
    signals.once('SIGINT', stop); signals.once('SIGTERM', stop);
    input.once('end', onEnd); input.on('error', onError); output.on('error', onError);
    socket.on('error', onError); socket.once('close', () => finish());
    socket.pipe(output, { end: false }); input.pipe(socket); input.resume(); socket.resume();
  });
}

module.exports = { authenticate, connectShared, readSharedStatus, restartShared, runBridge, spawnOwnedDaemon };

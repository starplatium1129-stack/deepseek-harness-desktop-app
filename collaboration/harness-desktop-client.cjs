'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { randomBytes, createHmac, timingSafeEqual } = require('node:crypto');

const VERSION = 1;
const MAX_FRAME_BYTES = 256 * 1024;
const AUTH_FRAME_BYTES = 4096;
function failure(code, message, state) { return Object.assign(new Error(message), { code, ...(state ? { state } : {}) }); }
function descriptorPath(harnessHome) {
  if (typeof harnessHome !== 'string' || !path.isAbsolute(harnessHome)) throw failure('INVALID_HOME', 'Harness 数据目录必须是绝对路径。');
  return path.join(harnessHome, '.desktop-collaboration', 'ipc', 'desktop.json');
}
function endpointFor(owner) { return `\\\\.\\pipe\\dsh-desktop-collaboration-${owner.endpointId}`; }
function proof(owner, request, challenge, role) {
  return createHmac('sha256', Buffer.from(owner.token, 'hex')).update(JSON.stringify([
    'dsh-desktop-collaboration', VERSION, role, owner.endpointId, owner.pid, challenge, request.clientNonce, request.operation,
  ])).digest('hex');
}
function equalProof(received, expected) {
  return typeof received === 'string' && /^[a-f0-9]{64}$/.test(received) && timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
}
async function readDescriptor(harnessHome) {
  const file = descriptorPath(harnessHome);
  let owner;
  try {
    const [directory, stat] = await Promise.all([fs.lstat(path.dirname(file)), fs.lstat(file)]);
    if (!directory.isDirectory() || directory.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || stat.size > AUTH_FRAME_BYTES) throw new Error('Invalid descriptor');
    owner = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw failure('HARNESS_DESKTOP_DESCRIPTOR_INVALID', '桌面协作入口无效，请在任务结束后正常重启桌面应用。', 'needs_input');
  }
  if (owner.version !== VERSION || !/^[a-f0-9]{64}$/.test(owner.token || '') || !/^[a-f0-9]{48}$/.test(owner.endpointId || '') || !Number.isSafeInteger(owner.pid) || owner.pid < 1) {
    throw failure('HARNESS_DESKTOP_DESCRIPTOR_INVALID', '桌面协作入口版本或身份无效。', 'needs_input');
  }
  return owner;
}

// Every phase is framed and bounded; no task text is sent before server proof.
function createChannel(socket) {
  const channel = new EventEmitter();
  let buffer = Buffer.alloc(0), limit = AUTH_FRAME_BYTES, pendingBytes = 0;
  channel.setLimit = value => { limit = value; };
  channel.send = message => new Promise((resolve, reject) => {
    let bytes;
    try { bytes = Buffer.from(JSON.stringify(message) + '\n'); } catch { reject(failure('HARNESS_DESKTOP_FRAME_INVALID', '协作消息无法编码。')); return; }
    if (bytes.length - 1 > limit || pendingBytes + bytes.length > MAX_FRAME_BYTES * 8) { reject(failure('HARNESS_DESKTOP_FRAME_LIMIT', '协作消息超过大小限制。')); return; }
    if (socket.destroyed) { reject(failure('HARNESS_DESKTOP_DISCONNECTED', '桌面协作连接已断开。')); return; }
    pendingBytes += bytes.length;
    socket.write(bytes, error => { pendingBytes -= bytes.length; error ? reject(failure('HARNESS_DESKTOP_DISCONNECTED', '桌面协作连接已断开。')) : resolve(); });
  });
  channel.on('fault', () => {});
  socket.on('error', () => channel.emit('fault', failure('HARNESS_DESKTOP_DISCONNECTED', '桌面协作连接失败。')));
  socket.once('close', () => channel.emit('closed'));
  socket.on('data', chunk => {
    // Iterate the chunk so several valid frames may share one network read.
    let offset = 0;
    while (offset < chunk.length && !socket.destroyed) {
      const newline = chunk.indexOf(10, offset), end = newline < 0 ? chunk.length : newline;
      if (buffer.length + end - offset > limit) { channel.emit('fault', failure('HARNESS_DESKTOP_FRAME_LIMIT', '协作消息超过大小限制。')); socket.destroy(); return; }
      buffer = Buffer.concat([buffer, chunk.subarray(offset, end)]);
      if (newline < 0) return;
      let message;
      try { message = JSON.parse(buffer.toString('utf8')); if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error(); }
      catch { channel.emit('fault', failure('HARNESS_DESKTOP_FRAME_INVALID', '协作消息格式无效。')); socket.destroy(); return; }
      buffer = Buffer.alloc(0); offset = newline + 1;
      channel.emit('frame', message);
    }
  });
  return channel;
}

async function connectDesktop(harnessHome, operation, options = {}) {
  if (process.platform !== 'win32') throw failure('HARNESS_DESKTOP_PLATFORM', '桌面协作桥目前仅支持 Windows。');
  const owner = await readDescriptor(harnessHome);
  if (!owner) throw failure('HARNESS_DESKTOP_UNAVAILABLE', '当前桌面尚未提供协作入口。', 'needs_input');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpointFor(owner)), channel = createChannel(socket);
    const request = { version: VERSION, clientNonce: randomBytes(32).toString('hex'), operation };
    let challenge, done = false;
    const timer = setTimeout(() => fail(failure('HARNESS_DESKTOP_AUTH_TIMEOUT', '桌面协作身份验证超时。', 'needs_input')), options.connectTimeoutMs || 5000);
    const fail = error => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); reject(error); };
    const closed = () => fail(failure('HARNESS_DESKTOP_DISCONNECTED', '桌面协作入口已断开。', 'needs_input'));
    channel.on('fault', fail); channel.once('closed', closed);
    const receive = message => {
      if (!challenge) {
        if (message.version !== VERSION || !/^[a-f0-9]{64}$/.test(message.challenge || '')) { fail(failure('HARNESS_DESKTOP_AUTH_FAILED', '桌面协作身份验证失败。', 'needs_input')); return; }
        challenge = message.challenge;
        void channel.send({ ...request, proof: proof(owner, request, challenge, 'client') }).catch(fail);
        return;
      }
      if (message.ok !== true || !equalProof(message.proof, proof(owner, request, challenge, 'server'))) { fail(failure('HARNESS_DESKTOP_AUTH_FAILED', '桌面协作身份验证失败。', 'needs_input')); return; }
      done = true; clearTimeout(timer); channel.removeListener('frame', receive); channel.removeListener('fault', fail); channel.removeListener('closed', closed);
      channel.setLimit(MAX_FRAME_BYTES);
      resolve({ socket, channel, status: { available: true, pid: owner.pid, nativeDesktop: true, nativeProtocol: 'Cordis Web AgentRegistry', activeCount: message.activeCount || 0 } });
    };
    channel.on('frame', receive);
  });
}

async function desktopBridgeStatus(harnessHome, options = {}) {
  try { const connection = await connectDesktop(harnessHome, 'status', options); connection.socket.destroy(); return connection.status; }
  catch (error) { return { available: false, nativeDesktop: true, code: error.code || 'HARNESS_DESKTOP_UNAVAILABLE', reason: error.message }; }
}

async function executeOnDesktop(task, ctx, options = {}) {
  ctx.signal?.throwIfAborted();
  const { socket, channel, status } = await connectDesktop(options.harnessHome, 'connect', options);
  const requestId = randomBytes(24).toString('hex');
  return new Promise((resolve, reject) => {
    let finished = false, chain = Promise.resolve(), dispatched = false, blocked, deadline, stopTimer, stopping, runSent = false;
    const finish = (error, result, uncertain = false) => {
      if (finished) return; finished = true; clearTimeout(deadline); clearTimeout(stopTimer); ctx.signal?.removeEventListener('abort', abort); socket.destroy();
      if (error && uncertain && dispatched && !blocked && !ctx.signal?.aborted && !error.state) error.dispatchUncertain = true;
      error ? reject(error) : resolve(result);
    };
    const stopUnconfirmed = () => {
      const error = failure('HARNESS_DESKTOP_STOP_UNCONFIRMED', '桌面尚未确认此协作任务已停止并恢复会话权限，请核查原生会话后再续接。', 'needs_input');
      error.dispatchUncertain = true;
      return error;
    };
    const requestStop = error => {
      if (finished || stopping) return;
      if (!runSent) { finish(error); return; }
      stopping = error; clearTimeout(deadline);
      // A sent cancel is not a native idle acknowledgment. The server sends a
      // terminal response only after runner cleanup restores the session.
      stopTimer = setTimeout(() => finish(stopUnconfirmed()), options.cancelTimeoutMs || 15000);
      void channel.send({ type: 'cancel', requestId }).catch(() => finish(stopUnconfirmed()));
    };
    const abort = () => requestStop(failure('CANCELLED', 'Harness 桌面协作任务已取消。', 'cancelled'));
    const disconnected = error => {
      // Terminal frames are parsed synchronously below when stopping, even if
      // an earlier persistence callback is pending. A close is never an ACK.
      if (stopping) { finish(stopUnconfirmed()); return; }
      void chain.then(() => finish(error || failure('HARNESS_DESKTOP_DISCONNECTED', '桌面协作连接中断；已接收任务需核查原生会话。'), undefined, true));
    };
    channel.on('fault', disconnected); channel.once('closed', () => disconnected());
    channel.on('frame', message => {
      if (finished) return;
      if (stopping && ['result', 'error'].includes(message.type)) {
        if (message.requestId !== requestId || message.dispatchUncertain) finish(stopUnconfirmed());
        else finish(stopping);
        return;
      }
      chain = chain.then(async () => {
        if (finished) return;
        if (message.requestId !== requestId) throw failure('HARNESS_DESKTOP_PROTOCOL', '桌面协作响应标识不匹配。');
        if (message.type === 'checkpoint') {
          if (dispatched || typeof message.checkpointId !== 'string' || !/^[a-f0-9]{48}$/.test(message.checkpointId)) throw failure('HARNESS_DESKTOP_PROTOCOL', '桌面协作检查点无效。');
          // Durable core checkpoint must succeed before model side effects.
          await ctx.checkpoint(message.data);
          if (finished || stopping || ctx.signal?.aborted) return;
          dispatched = true;
          await channel.send({ type: 'checkpoint-ack', requestId, checkpointId: message.checkpointId });
        } else if (message.type === 'event') await ctx.emit(message.event, message.event === 'executor_ready' ? { ...status, ...message.data } : message.data);
        else if (message.type === 'state') {
          if (!['needs_input', 'needs_approval'].includes(message.state)) throw failure('HARNESS_DESKTOP_PROTOCOL', '桌面协作状态无效。');
          blocked = message.state; await ctx.state(message.state, message.data);
        }
        else if (message.type === 'result') finish(null, message.data);
        else if (message.type === 'error') {
          const error = failure(message.code || 'HARNESS_DESKTOP_FAILED', message.message || 'Harness 桌面协作失败。', message.state || blocked);
          if (message.dispatchUncertain) error.dispatchUncertain = true;
          finish(error);
        } else throw failure('HARNESS_DESKTOP_PROTOCOL', '桌面协作响应类型无效。');
      }).catch(error => { if (!stopping) finish(error, undefined, true); });
    });
    ctx.signal?.addEventListener('abort', abort, { once: true });
    if (ctx.signal?.aborted) { abort(); return; }
    deadline = setTimeout(() => requestStop(failure('DEADLINE_EXCEEDED', 'Harness 桌面协作已达到截止时间。')), Math.min(2147483647, Math.max(1, Date.parse(task.deadlineAt) - Date.now())));
    runSent = true;
    void channel.send({ type: 'run', requestId, task }).catch(error => finish(stopping ? stopUnconfirmed() : error));
  });
}

module.exports = { desktopBridgeStatus, executeOnDesktop, descriptorPath, readDescriptor, endpointFor, proof, equalProof, createChannel, VERSION, MAX_FRAME_BYTES };

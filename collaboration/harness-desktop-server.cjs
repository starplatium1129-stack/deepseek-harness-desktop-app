'use strict';

// Loaded as a Cordis plugin in the existing desktop Web Core. This owns only
// its private pipe and delegated runs, never the Web Core or native Agent.
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const { privateDirectory } = require('./daemon.cjs');
const { descriptorPath, readDescriptor, endpointFor, proof, equalProof, createChannel, VERSION, MAX_FRAME_BYTES } = require('./harness-desktop-client.cjs');

function failure(code, message, state) { return Object.assign(new Error(message), { code, ...(state ? { state } : {}) }); }
function safeMessage(error) {
  return String(error?.message || 'Harness desktop bridge failed').slice(0, 3000).replace(/\bsk-[\w-]+/g, '[redacted]').replace(/(Bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;}]+/gi, '$1[redacted]');
}
function livePid(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } }

async function startDesktopServer(ctx, config, options = {}) {
  if (process.platform !== 'win32') throw failure('HARNESS_DESKTOP_PLATFORM', '桌面协作桥目前仅支持 Windows。');
  const file = descriptorPath(config.harnessHome);
  const location = await privateDirectory(path.dirname(path.dirname(file)));
  const previous = await readDescriptor(config.harnessHome);
  if (previous && livePid(previous.pid)) throw failure('HARNESS_DESKTOP_ALREADY_RUNNING', '此 Harness 数据目录已有桌面协作入口。');
  if (previous) await fs.unlink(file);
  const owner = { version: VERSION, pid: process.pid, endpointId: randomBytes(24).toString('hex'), token: randomBytes(32).toString('hex') };
  const runner = options.runner || require('./harness-desktop-worker.cjs').createDesktopRunner(ctx, config);
  const connections = new Set(), runs = new Map(), seen = new Set();
  let closing = false, closePromise;
  const server = net.createServer(socket => {
    if (closing || connections.size >= 32) { socket.destroy(); return; }
    connections.add(socket);
    const channel = createChannel(socket), challenge = randomBytes(32).toString('hex');
    let authenticated = false, record, receivedRun = false;
    const timeout = setTimeout(() => socket.destroy(), options.authTimeoutMs || 5000);
    const abort = () => {
      record?.controller.abort();
      if (record?.checkpoint) { clearTimeout(record.checkpoint.timeout); record.checkpoint.reject(failure('CANCELLED', '桌面协作连接已取消。')); record.checkpoint = undefined; }
    };
    channel.on('fault', () => { abort(); socket.destroy(); });
    channel.once('closed', () => { clearTimeout(timeout); abort(); connections.delete(socket); });
    const send = message => channel.send({ ...message, requestId: record?.requestId });
    const reject = error => { void send({ type: 'error', code: error.code || 'HARNESS_DESKTOP_PROTOCOL', message: safeMessage(error), ...(error.state ? { state: error.state } : {}) }).finally(() => socket.destroy()).catch(() => {}); };
    channel.on('frame', message => {
      if (!authenticated) {
        clearTimeout(timeout);
        if (message.version !== VERSION || !['status', 'connect'].includes(message.operation) || !/^[a-f0-9]{64}$/.test(message.clientNonce || '') || !equalProof(message.proof, proof(owner, message, challenge, 'client'))) { socket.destroy(); return; }
        authenticated = true;
        channel.setLimit(MAX_FRAME_BYTES);
        void channel.send({ ok: true, version: VERSION, activeCount: runs.size, proof: proof(owner, message, challenge, 'server') }).then(() => { if (message.operation === 'status') socket.end(); }).catch(() => socket.destroy());
        if (message.operation === 'status') channel.removeAllListeners('frame');
        return;
      }
      if (message.type === 'run') {
        if (receivedRun || closing || !/^[a-f0-9]{48}$/.test(message.requestId || '')) { reject(failure('HARNESS_DESKTOP_PROTOCOL', '桌面协作请求无效。')); return; }
        receivedRun = true;
        record = { requestId: message.requestId, controller: new AbortController(), checkpoint: undefined, acknowledged: false };
        if (seen.has(record.requestId)) { reject(failure('HARNESS_DUPLICATE_REQUEST', '此协作请求已接收，不能重复派发。')); return; }
        if (seen.size >= 100000) { reject(failure('HARNESS_DESKTOP_CAPACITY', '桌面协作请求记录已满，请先完成现有任务再重启桌面。', 'needs_input')); return; }
        seen.add(record.requestId); runs.set(record.requestId, record);
        record.done = (async () => {
          try {
            const result = await runner.execute(message.task, {
              signal: record.controller.signal,
              emit: (event, data) => send({ type: 'event', event, data }),
              state: (state, data) => send({ type: 'state', state, data }),
              checkpoint: data => new Promise((resolve, rejectCheckpoint) => {
                if (record.controller.signal.aborted) { rejectCheckpoint(failure('CANCELLED', '桌面协作请求已取消。')); return; }
                if (record.checkpoint) { rejectCheckpoint(failure('HARNESS_DESKTOP_PROTOCOL', '桌面协作检查点尚未确认。')); return; }
                const checkpointId = randomBytes(24).toString('hex');
                const checkpointTimeout = setTimeout(() => {
                  record.checkpoint = undefined; rejectCheckpoint(failure('HARNESS_DESKTOP_CHECKPOINT_TIMEOUT', '协作记录尚未持久化，任务未开始。')); record.controller.abort();
                }, options.checkpointTimeoutMs || 30000);
                record.checkpoint = { checkpointId, resolve, reject: rejectCheckpoint, timeout: checkpointTimeout };
                void send({ type: 'checkpoint', checkpointId, data }).catch(error => { abort(); rejectCheckpoint(error); });
              }),
            });
            await send({ type: 'result', data: result });
          } catch (error) {
            if (record.acknowledged && ['HARNESS_DESKTOP_FRAME_LIMIT', 'HARNESS_DESKTOP_FRAME_INVALID', 'HARNESS_DESKTOP_DISCONNECTED'].includes(error.code)) error.dispatchUncertain = true;
            await send({ type: 'error', code: error.code || 'HARNESS_DESKTOP_FAILED', message: safeMessage(error), ...(error.state ? { state: error.state } : {}), ...(error.dispatchUncertain ? { dispatchUncertain: true } : {}) }).catch(() => {});
          } finally { abort(); runs.delete(record.requestId); }
        })();
      } else if (message.type === 'checkpoint-ack' && record && message.requestId === record.requestId && record.checkpoint && message.checkpointId === record.checkpoint.checkpointId) {
        record.acknowledged = true; clearTimeout(record.checkpoint.timeout); record.checkpoint.resolve(); record.checkpoint = undefined;
      } else if (message.type === 'cancel' && record && message.requestId === record.requestId) abort();
      else { abort(); reject(failure('HARNESS_DESKTOP_PROTOCOL', '桌面协作消息不属于此连接或状态无效。')); }
    });
    void channel.send({ version: VERSION, challenge }).catch(() => socket.destroy());
  });
  async function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      const stopped = new Promise(resolve => server.close(resolve));
      for (const socket of connections) socket.destroy();
      for (const record of runs.values()) record.controller.abort();
      await runner.dispose();
      await Promise.allSettled([...runs.values()].map(record => record.done));
      await stopped;
      const current = await readDescriptor(config.harnessHome).catch(() => null);
      if (current?.endpointId === owner.endpointId) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    })();
    return closePromise;
  }
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpointFor(owner), () => { server.removeListener('error', reject); resolve(); }); });
    const temp = path.join(location.directory, `desktop-${randomBytes(12).toString('hex')}.tmp`);
    await fs.writeFile(temp, JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
    try { await fs.link(temp, file); } finally { await fs.unlink(temp); }
  } catch (error) { await close(); throw error; }
  server.on('error', () => { void close().catch(() => {}); });
  return { close, get activeCount() { return runs.size; }, get clientCount() { return connections.size; } };
}

exports.name = 'desktop-collaboration-bridge';
exports.inject = ['agents', 'agentDefaultModel', 'sessions', 'sessionController', 'llm', 'approval', 'sandboxPolicy', 'tools'];
exports.apply = (ctx, config) => {
  // Cordis lifecycle owns teardown. No process signals and no Web shutdown.
  let instance;
  const started = startDesktopServer(ctx, config).then(value => { instance = value; return value; });
  ctx.effect(() => async () => { await started.catch(() => {}); await instance?.close(); });
  return started.then(() => {});
};
exports.startDesktopServer = startDesktopServer;

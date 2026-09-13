'use strict';

// Uses the installed, unmodified ZCode desktop host. Authentication and provider
// configuration stay inside that host; this bridge never calls credential APIs.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const readline = require('node:readline');

const METHODS = new Set(['session/create', 'session/resume', 'session/read', 'session/list',
  'session/subscribe', 'session/send', 'session/setMode', 'session/setModel', 'session/stop']);
const PREFERENCES = Object.freeze({ nativeSearchEnhancementsEnabled: false, memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: false, modelContextBudgetStrategy: 'preflight-v1', modelIoFullRetentionEnabled: false });

function fail(code, message) { return Object.assign(new Error(message), { code }); }
function safeSnapshot(value) {
  const session = value?.session || {};
  return { session: { sessionId: session.sessionId, status: session.status, workspace: session.workspace },
    settings: { mode: value?.settings?.mode, model: {
      current: value?.settings?.model?.current,
      available: (value?.settings?.model?.available || []).map(item => ({ ref: item.ref, label: item.label, providerLabel: item.providerLabel })),
    } }, runtime: { eventSeq: value?.runtime?.eventSeq, stateRevision: value?.runtime?.stateRevision } };
}

function nativeEvent(envelope) {
  if (envelope?.type !== 'session.event') return undefined;
  const event = envelope.event;
  if (!event || !['turn.started', 'turn.completed', 'turn.failed', 'model.streaming',
    'tool.started', 'tool.completed', 'tool.failed', 'tool.executed'].includes(event.type)) return undefined;
  // Never forward provider configuration or runtime authentication envelopes.
  const cleanse = value => {
    if (Array.isArray(value)) return value.map(cleanse);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) =>
      !/authorization|api[-_]?key|credential|secret|runtimeProviderHeaders|runtimeModel/i.test(key))
      .map(([key, child]) => [key, cleanse(child)]));
  };
  return cleanse(event);
}

async function runDesktopBridge(options) {
  const { app, utilityProcess, MessageChannelMain } = require('electron');
  if (!options || !path.isAbsolute(options.cliPath || '') || !path.isAbsolute(options.nodePath || '') || !path.isAbsolute(options.workspace || '')) {
    throw fail('invalid_bridge_options', 'ZCode 桌面桥需要绝对 CLI、Node 和工作目录路径。');
  }
  if (!/^\\\\\.\\pipe\\deepseek-zcode-[a-zA-Z0-9-]+$/.test(options.transportPipe || '')) throw fail('invalid_bridge_pipe', 'ZCode 桌面桥需要父进程创建的专用本地管道。');
  const pipeToken = process.env.COLLABORATION_ZCODE_PIPE_TOKEN;
  delete process.env.COLLABORATION_ZCODE_PIPE_TOKEN;
  if (!/^[a-f0-9]{64}$/.test(pipeToken || '')) throw fail('invalid_bridge_token', 'ZCode 桌面桥缺少本次启动的管道握手凭据。');
  const stream = require('node:net').createConnection(options.transportPipe);
  stream.once('connect', () => stream.write(`${JSON.stringify({ method: 'bridge/hello', params: { token: pipeToken } })}\n`));
  stream.on('error', () => app.exit(1));
  // Capture requests before the Electron and native host asynchronous startup.
  const input = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const lines = [];
  let handleLine;
  input.on('line', line => { if (handleLine) handleLine(line); else lines.push(line); });
  const workspace = path.resolve(options.workspace);
  const resources = path.dirname(path.dirname(options.cliPath));
  const hostRoot = path.join(resources, 'app.asar', 'out', 'host');
  await app.whenReady();
  const metadata = JSON.parse(require('node:fs').readFileSync(path.join(resources, 'app.asar', 'package.json'), 'utf8'));
  if (metadata.version !== '3.11.2') throw fail('zcode_desktop_version_unsupported', `ZCode 桌面版 ${metadata.version} 尚未验证；当前桌面桥仅支持 3.11.2。`);
  const native = await import(pathToFileURL(path.join(hostRoot, 'chunk-KGXW6KHC.js')).href);
  const { port1, port2 } = new MessageChannelMain();
  const protocol = new native.g({
    addEventListener: (name, fn) => port1.on(name, fn), removeEventListener: (name, fn) => port1.off(name, fn),
    postMessage: value => port1.postMessage(value), start: () => port1.start(), close: () => port1.close(),
  });
  const client = new native.i(protocol);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, { ZCODE_AGENT_SERVER_COMMAND: options.nodePath,
    ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([options.cliPath, 'app-server', '--stdio']),
    ZCODE_PROCESS_LABEL: 'ZCode collaboration native host' });
  const host = utilityProcess.fork(path.join(hostRoot, 'index.js'), [], { stdio: 'pipe', cwd: workspace, env });
  // Native diagnostics and parentPort messages are deliberately discarded. Some
  // contain native account details, signing metadata, or configured settings.
  host.stdout.on('data', () => {});
  host.stderr.on('data', () => {});
  host.on('message', message => {
    if (message?.type === 'browser-execute-request') {
      host.postMessage({ type: 'browser-execute-result', requestId: message.requestId, result: {
        ok: false, error: { code: 'backend_unavailable', message: 'Browser access is not part of this collaboration permission.' }, elapsedMs: 0,
      } });
    }
  });
  let closing = false;
  let nextInteraction = 1;
  const ownedSessions = new Set();
  const subscriptions = new Map();
  const output = value => { if (!closing) stream.write(`${JSON.stringify(value)}\n`); };
  const session = native.j.toService(client.getChannel('zcode-session'));
  const agent = native.j.toService(client.getChannel('zcode-agent'));
  const tasks = native.j.toService(client.getChannel('zcode-task'));
  const close = () => {
    if (closing) return;
    closing = true;
    for (const subscription of subscriptions.values()) subscription.dispose();
    client.dispose();
    host.postMessage({ type: 'dispose' });
    const timer = setTimeout(() => { host.kill(); app.exit(0); }, 3500);
    host.once('exit', () => { clearTimeout(timer); app.exit(0); });
  };
  host.on('exit', code => {
    if (!closing) {
      output({ method: 'bridge/failure', params: { code: 'zcode_desktop_host_exit', message: `ZCode 原生桌面 host 已退出（${code}）。` } });
      app.exit(1);
    }
  });
  stream.on('end', close);
  process.once('SIGTERM', close);
  host.postMessage({ type: 'init-local', agentSpawnFallbackCwd: workspace }, [port2]);
  const ready = client.whenInitialized().then(async () => {
    await agent.syncAppRuntimePreferences(PREFERENCES);
    const info = await session.initializeWorkspace({ workspacePath: workspace });
    if (!info.available) throw fail('zcode_runtime_unavailable', 'ZCode 原生桌面运行时尚未就绪。');
  });
  ready.catch(() => {});
  const target = params => {
    if (!ownedSessions.has(params.sessionId)) throw fail('invalid_session', '只能操作本次桥接创建或显式恢复的 ZCode 会话。');
    return { workspacePath: workspace, sessionId: params.sessionId };
  };
  const subscribe = params => {
    const scope = target(params);
    subscriptions.get(params.sessionId)?.dispose();
    subscriptions.set(params.sessionId, agent.onDynamicSessionEvent({ ...scope,
      deliveryKind: 'desktop-continuous', afterSeq: params.afterSeq, includeSnapshot: false })(envelope => {
      const event = nativeEvent(envelope);
      if (event) output({ method: 'session/event', params: event });
      if (envelope?.type === 'providerRuntimeHeaders.request') {
        // ZCode-plan providers require the official renderer's CAPTCHA flow.
        // Do not claim headers were applied or manufacture a verifier response.
        output({ id: `native-interaction-${nextInteraction++}`, method: 'interaction/requestProviderRuntimeHeaders', params: {
          sessionId: params.sessionId, code: 'zcode_native_renderer_required',
          providerId: envelope.request?.providerId,
          message: 'ZCode 要求官方桌面 renderer 提供本轮运行时验证结果；当前桌面 host 桥尚未接入该原生流程。这是适配器缺口，不代表账号未登录或用户需要输入验证码。',
        } });
      } else if (envelope?.type === 'permission.request' || envelope?.type === 'userInput.request') {
        output({ id: `native-interaction-${nextInteraction++}`,
          method: envelope.type === 'permission.request' ? 'interaction/requestPermission' : 'interaction/requestUserInput',
          params: { sessionId: params.sessionId, request: envelope.request } });
      }
    }));
  };
  const dispatch = async (method, params) => {
    if (!METHODS.has(method)) throw fail('method_not_allowed', 'ZCode 桌面桥不暴露该方法。');
    await ready;
    if (params.workspace && path.resolve(params.workspace.workspacePath || '') !== workspace) throw fail('invalid_workspace', '工作目录与桥接范围不一致。');
    if (method === 'session/create') {
      const value = await session.createSession({ workspacePath: workspace, mode: params.mode, model: params.model,
        toolAllowlist: params.toolAllowlist, toolDenylist: params.toolDenylist, mcpServers: [], titleGenerationEnabled: false });
      ownedSessions.add(value.session.sessionId);
      return safeSnapshot(value);
    }
    if (method === 'session/resume') {
      if (typeof params.sessionId !== 'string' || !params.sessionId) throw fail('invalid_session', '恢复会话 ID 缺失。');
      const value = await session.resumeSession({ workspacePath: workspace, sessionId: params.sessionId,
        toolAllowlist: params.toolAllowlist, toolDenylist: params.toolDenylist, mcpServers: [], broadcastSnapshot: false });
      ownedSessions.add(params.sessionId);
      return safeSnapshot(value);
    }
    if (method === 'session/list') {
      const value = await session.listSessions({ workspacePath: workspace });
      return { sessions: (value.sessions || []).map(item => ({ sessionId: item.sessionId, status: item.status })) };
    }
    const scope = target(params);
    if (method === 'session/read') return safeSnapshot(await session.readSession(scope));
    if (method === 'session/setMode') return safeSnapshot(await session.setMode({ ...scope, mode: params.mode }));
    if (method === 'session/setModel') return safeSnapshot(await session.setModel({ ...scope, model: params.model }));
    if (method === 'session/subscribe') {
      const snapshot = await session.readSession(scope);
      subscribe({ ...params, afterSeq: snapshot.runtime?.eventSeq });
      return { eventSeq: snapshot.runtime?.eventSeq ?? -1 };
    }
    if (method === 'session/send') return agent.sendPrompt({ ...scope, inputId: params.inputId, content: params.content, toolDenylist: params.toolDenylist });
    if (method === 'session/stop') { await tasks.stopGeneration({ workspacePath: workspace, taskId: params.sessionId }); return {}; }
  };
  handleLine = async line => {
    if (Buffer.byteLength(line) > 8 * 1024 * 1024) return close();
    let request;
    try { request = JSON.parse(line); } catch { return close(); }
    if (request.id === undefined || !request.method) return;
    try { output({ id: request.id, result: await dispatch(request.method, request.params || {}) }); }
    catch (cause) { output({ id: request.id, error: { code: -32000,
      message: cause.message || 'ZCode 原生桌面操作失败。', data: { code: cause.code || 'zcode_desktop_error' } } }); }
  };
  for (const line of lines.splice(0)) handleLine(line);
}

module.exports = { runDesktopBridge, safeSnapshot, nativeEvent };
if (require.main === module || (process.versions.electron && path.resolve(process.argv[1] || '') === __filename)) {
  let options;
  try { options = JSON.parse(process.argv[2] || '{}'); } catch { process.exit(1); }
  runDesktopBridge(options).catch(cause => {
    process.stdout.write(`${JSON.stringify({ method: 'bridge/failure', params: { code: cause.code || 'zcode_desktop_start_failed', message: cause.message } })}\n`, () => require('electron').app.exit(1));
  });
}

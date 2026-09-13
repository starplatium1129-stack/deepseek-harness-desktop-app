'use strict';

// Versioned interoperability with the installed, unmodified ZCode renderer.
// All browser traffic uses inherited CDP pipes; no debugging TCP listener.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const runFile = promisify(execFile);
const MAX_FRAME = 8 * 1024 * 1024;
const failure = (code, message) => Object.assign(new Error(message), { code });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (cause) { return cause.code !== 'ESRCH'; }
}
function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve(true);
  return new Promise(resolve => {
    const done = value => { clearTimeout(timer); child.off('exit', onExit); resolve(value); };
    const onExit = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode) done(true);
  });
}

class CdpPipe extends EventEmitter {
  constructor(reader, writer) {
    super(); this.reader = reader; this.writer = writer; this.nextId = 1;
    this.pending = new Map(); this.buffer = ''; this.closed = false;
    reader.setEncoding('utf8');
    reader.on('data', data => this.parse(data));
    reader.on('end', () => this.fail(failure('zcode_renderer_disconnected', 'ZCode 原版窗口连接已关闭。')));
    reader.on('error', () => this.fail(failure('zcode_renderer_disconnected', 'ZCode 原版窗口管道失败。')));
    writer.on('error', () => this.fail(failure('zcode_renderer_disconnected', 'ZCode 原版窗口管道不可写。')));
  }
  parse(data) {
    this.buffer += data;
    if (Buffer.byteLength(this.buffer) > MAX_FRAME) return this.fail(failure('zcode_renderer_frame_limit', 'ZCode renderer 消息超过限制。'));
    let at;
    while ((at = this.buffer.indexOf('\0')) >= 0) {
      const line = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 1);
      if (!line) continue;
      let value;
      try { value = JSON.parse(line); } catch { return this.fail(failure('zcode_renderer_protocol', 'ZCode renderer 返回无效协议帧。')); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) return this.fail(failure('zcode_renderer_protocol', 'ZCode renderer 返回无效协议对象。'));
      const pending = this.pending.get(value.id);
      if (pending) {
        this.pending.delete(value.id); clearTimeout(pending.timer);
        if (value.error) pending.reject(failure('zcode_renderer_rpc', value.error.message || 'ZCode renderer 请求失败。'));
        else pending.resolve(value.result);
      } else if (value.method) this.emit('notification', value);
    }
  }
  request(method, params = {}, sessionId, timeoutMs = 15000) {
    if (this.closed) return Promise.reject(failure('zcode_renderer_disconnected', 'ZCode renderer 连接已结束。'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(failure('zcode_renderer_timeout', `ZCode renderer 请求超时：${method}；不会自动重发。`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.writer.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }
  fail(cause) {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(cause); }
    this.pending.clear(); this.emit('failure', cause);
  }
  close() { this.fail(failure('zcode_renderer_disconnected', 'ZCode renderer 连接已结束。')); this.writer.destroy(); this.reader.destroy(); }
}

async function readDesktopMetadata(archive) {
  const handle = await fs.open(archive, 'r');
  try {
    const first = Buffer.alloc(8); await handle.read(first, 0, 8, 0);
    const length = first.readUInt32LE(4);
    if (length < 8 || length > 32 * 1024 * 1024) throw failure('zcode_archive_invalid', 'ZCode 安装包头无效。');
    const header = Buffer.alloc(length); await handle.read(header, 0, length, 8);
    const data = JSON.parse(header.subarray(8, 8 + header.readUInt32LE(4)).toString());
    const metadata = data.files?.['package.json'];
    if (!metadata || !Number.isInteger(metadata.size) || metadata.size > 1024 * 1024) throw failure('zcode_archive_invalid', 'ZCode 安装包缺少版本元数据。');
    const body = Buffer.alloc(metadata.size); await handle.read(body, 0, body.length, 8 + length + Number(metadata.offset));
    const json = JSON.parse(body.toString());
    return { name: json.name, version: json.version };
  } finally { await handle.close(); }
}

async function rendererInstallation(cliPath, options = {}) {
  const resources = path.dirname(path.dirname(cliPath));
  const metadata = await readDesktopMetadata(path.join(resources, 'app.asar'));
  if (metadata.version !== '3.11.2') throw failure('zcode_desktop_version_unsupported', `ZCode 桌面版 ${metadata.version} 尚未验证；当前 renderer 适配仅支持 3.11.2。`);
  const executable = options.zcodeExecutable || path.join(path.dirname(resources), 'ZCode.exe');
  if (!path.isAbsolute(executable) || !(await fs.stat(executable).catch(() => null))?.isFile()) throw failure('zcode_not_found', '未找到 ZCode 原版桌面可执行文件。');
  let profileDir = path.resolve(options.profileDir || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'DeepSeek-Harness-Collaboration', 'zcode-browser'));
  if (options.profileMode === 'existing') profileDir = path.join(profileDir, 'existing-controller');
  return { executable, profileDir, version: metadata.version };
}

async function listZCodeMainProcesses(executable) {
  const script = `$target = [IO.Path]::GetFullPath($env:COLLABORATION_ZCODE_EXE)
Get-CimInstance Win32_Process -Filter "Name = 'ZCode.exe'" | Where-Object {
  !$_.ExecutablePath -or [string]::Equals([IO.Path]::GetFullPath($_.ExecutablePath), $target, [StringComparison]::OrdinalIgnoreCase)
} | Select-Object @{n='pid';e={$_.ProcessId}},@{n='parentPid';e={$_.ParentProcessId}},@{n='chromiumSubprocess';e={$_.CommandLine -match '--type='}} | ConvertTo-Json -Compress`;
  const result = await runFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 10000, maxBuffer: 65536, env: { ...process.env, COLLABORATION_ZCODE_EXE: executable },
  });
  const value = result.stdout.trim() ? JSON.parse(result.stdout) : [];
  return selectZCodeMainProcesses(Array.isArray(value) ? value : [value]);
}

function selectZCodeMainProcesses(processes) {
  const valid = processes.filter(item => Number.isInteger(item.pid) && item.pid > 0);
  const pids = new Set(valid.map(item => item.pid));
  // Native app-server and windows-helper processes reuse ZCode.exe without
  // Chromium's --type flag. Retain the entire same-executable parent inventory
  // before selecting roots, otherwise these children look like user windows.
  // Missing parent metadata stays conservative: an unproven root is retained.
  return valid.filter(item => !item.chromiumSubprocess && !pids.has(item.parentPid)).map(item => ({ pid: item.pid }));
}

async function assertExistingWindowAvailable(executable, options = {}, ownedPid) {
  if (options.managedLifetime !== true) throw failure('zcode_existing_requires_managed_lifetime', '复用原版 ZCode 窗口需要共享协作服务；独占 stdio 模式不能持有用户窗口。');
  const processes = await (options.processInventory || listZCodeMainProcesses)(executable);
  if (processes.some(item => item.pid !== ownedPid)) throw failure('zcode_existing_app_running', '原版 ZCode 当前已打开。请先在应用中正常退出后再交接协作；不会关闭现有窗口。');
}

function nativeEnvironment(options, profileDir) {
  const env = { ...(options.env || process.env) };
  if (options.profileMode !== 'existing') Object.assign(env, {
    ZCODE_DESKTOP_USER_DATA_DIR: path.join(profileDir, 'user-data'), ZCODE_DESKTOP_SESSION_DATA_DIR: path.join(profileDir, 'session-data'),
    ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: '1',
  });
  delete env.ELECTRON_RUN_AS_NODE; delete env.COLLABORATION_ZCODE_PIPE_TOKEN;
  if (options.profileMode !== 'existing') delete env.ZCODE_DESKTOP_APPLICATION_NAME;
  return env;
}

async function acquireProfile(profileDir) {
  await fs.mkdir(profileDir, { recursive: true });
  const file = path.join(profileDir, 'collaboration-owner.json');
  const nonce = randomUUID();
  const create = async () => {
    const handle = await fs.open(file, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce, phase: 'reserved' })); } finally { await handle.close(); }
  };
  try { await create(); }
  catch (cause) {
    if (cause.code !== 'EEXIST') throw cause;
    const guardFile = `${file}.recovery`;
    let guard;
    try { guard = await fs.open(guardFile, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw failure('zcode_profile_busy', 'ZCode profile 锁正在恢复，需要等待或人工核对。'); throw error; }
    try {
      const owner = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
      if (!Number.isInteger(owner?.pid) || owner.pid <= 0) throw failure('zcode_profile_busy', 'ZCode 协作 profile 锁无效，需要人工核对。');
      if (owner.phase === 'needs-review') throw failure('zcode_native_state_uncertain', '上次原生停止或退出未获确认，保留的 profile 锁需要人工核对，不能自动接管。');
      if (processAlive(owner.pid) || processAlive(owner.childPid)) throw failure('zcode_profile_busy', '已有 ZCode 协作进程仍在使用原生窗口；不能接管该 profile。');
      if (owner.phase === 'launching' && !owner.childPid) throw failure('zcode_profile_busy', '上次启动中断，无法确认原生窗口是否仍存在；需要人工核对。');
      await fs.unlink(file); await create();
    } finally { await guard.close(); await fs.unlink(guardFile).catch(() => {}); }
  }
  const release = async () => {
    const owner = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
    if (owner?.nonce === nonce) await fs.unlink(file).catch(() => {});
  };
  release.update = async patch => {
    const owner = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
    if (owner?.nonce !== nonce) throw failure('zcode_profile_busy', 'ZCode profile 所有权已变化。');
    const temp = `${file}.${nonce}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ ...owner, ...patch }), { mode: 0o600 });
    await fs.rename(temp, file);
  };
  return release;
}

async function profileWorkspace(profileDir, workspace, patch) {
  const file = path.join(profileDir, 'owned-workspaces.json');
  let data;
  try { data = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (cause) {
    if (cause.code !== 'ENOENT') throw failure('zcode_profile_state_invalid', '协作 profile 工作区记录损坏，需要人工核对。');
    data = { version: 1, workspaces: {} };
  }
  if (data.version !== 1 || !data.workspaces || typeof data.workspaces !== 'object') throw failure('zcode_profile_state_invalid', '协作 profile 工作区记录版本未知。');
  const key = path.resolve(workspace).toLowerCase();
  if (!patch) return data.workspaces[key];
  data.workspaces[key] = { ...data.workspaces[key], path: path.resolve(workspace), ...patch, updatedAt: new Date().toISOString() };
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 });
  await fs.rename(temp, file);
  return data.workspaces[key];
}

// Runs only in the owned original renderer. The search observes component
// identities and the exact workspace, never conversation history or credentials.
function rendererBootstrap(workspace) {
  const root = document.querySelector('#root');
  if (!root) return { ready: false, reason: 'root-not-mounted' };
  const key = Object.keys(root).find(name => name.startsWith('__reactContainer$'));
  if (!key) return { ready: false, reason: 'react-not-mounted' };
  let first = root[key]; first = first.current || first.stateNode?.current || first;
  const pending = [first], seen = new Set();
  let matched = 0;
  for (let count = 0; pending.length && count < 10000; count++) {
    const fiber = pending.shift(); if (!fiber || seen.has(fiber)) continue; seen.add(fiber);
    if (fiber.type?.name === 'PJt' && fiber.memoizedProps?.workspacePath === workspace) {
      matched++;
      for (let owner = fiber.return; owner; owner = owner.return) {
        const props = owner.memoizedProps;
        const services = [props?.services, props?.value].find(value => value?.zcodeAgentService && value?.zcodeSessionService);
        if (!services) continue;
        const clientId = localStorage.getItem('zcode-v4-client-id:v1');
        if (!clientId) return { ready: false, reason: 'native-client-id-not-ready', matched };
        const current = window.__deepseekZCodeRenderer;
        if (current && current.services.zcodeAgentService !== services.zcodeAgentService) return { ready: false, reason: 'workspace-connection-changed', matched };
        if (!current) window.__deepseekZCodeRenderer = { services, workspace, clientId,
          ...(fiber.memoizedProps.workspaceIdentity ? { workspaceIdentity: fiber.memoizedProps.workspaceIdentity } : {}),
          sessions: new Set(), events: [], subscriptions: new Map(), inputMap: new Map(), sending: false, heldEvents: [], verificationPending: false };
        return { ready: true, matched, sameListenerConnection: window.__deepseekZCodeRenderer.services.zcodeAgentService === services.zcodeAgentService };
      }
    }
    if (fiber.child) pending.push(fiber.child); if (fiber.sibling) pending.push(fiber.sibling);
  }
  return { ready: false, reason: 'native-workspace-verification-listener-not-mounted', matched };
}

async function rendererOperation({ method, params = {} }) {
  const bridge = window.__deepseekZCodeRenderer;
  if (!bridge) throw new Error('Original renderer connection is not initialized.');
  const { services, workspace, workspaceIdentity, clientId } = bridge;
  const agent = services.zcodeAgentService;
  const sessions = services.zcodeSessionService;
  const scope = { workspacePath: workspace, ...(workspaceIdentity ? { workspaceIdentity } : {}) };
  const snapshot = value => ({ session: { sessionId: value.session?.sessionId, status: value.session?.status },
    settings: { mode: value.settings?.mode, model: { current: value.settings?.model?.current } }, runtime: { eventSeq: value.runtime?.eventSeq } });
  const target = () => {
    if (!bridge.sessions.has(params.sessionId)) throw new Error('Session is outside this collaboration connection.');
    return { ...scope, sessionId: params.sessionId };
  };
  const clean = value => {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([name]) => !/authorization|api[-_]?key|credential|secret|runtimeProviderHeaders|runtimeModel/i.test(name)).map(([name, child]) => [name, clean(child)]));
  };
  const safeNativeText = value => typeof value !== 'string' ? undefined : value
    .replace(/\b(?:Bearer|Basic)\s+[^\s"',;}]+/gi, '[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/([?&](?:token|key|api_key|access_token)=)[^&#\s]*/gi, '$1[redacted]')
    .replace(/(["']?(?:api[-_]?key|authorization|password|secret|accessToken|refreshToken)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[redacted]')
    .slice(0, 4000);
  const ackDiagnostic = ack => ({
    commandId: safeNativeText(ack?.commandId), status: safeNativeText(ack?.status), reasonCode: safeNativeText(ack?.reasonCode),
    message: safeNativeText(ack?.message), revisionAtDecision: Number.isFinite(ack?.revisionAtDecision) ? ack.revisionAtDecision : undefined,
    resultType: safeNativeText(ack?.result?.type),
  });
  const heldDiagnostic = () => bridge.heldEvents.slice(0, 30).map(event => ({
    type: event.type, seq: event.seq, sessionId: event.sessionId, turnId: event.turnId,
    inputId: safeNativeText(event.payload?.inputId), resultType: safeNativeText(event.payload?.resultType),
    errorCode: safeNativeText(event.payload?.error?.code), errorMessage: safeNativeText(event.payload?.error?.message),
  }));
  const nativeModelParameters = async () => {
    let model = params.model, thoughtLevel = params.thoughtLevel;
    if (!model) {
      // Use the same versioned UI preference functions as GEe/Lt. Importing an
      // already loaded module reuses its store; no conversation is inspected.
      const preferences = bridge.modelPreferences ||= await import(new URL('./assets/skillStore-BMGt7ZCs.js', window.location.href).href);
      const draft = preferences.h.getState().getWorkspaceState(workspace, workspaceIdentity);
      const preferred = draft.draftPreferredModel?.trim()
        ? { model: draft.draftPreferredModel.trim(), thoughtLevel: draft.draftPreferredThoughtLevel?.trim() }
        : preferences.E('glm', workspace, workspaceIdentity);
      if (!preferred?.model?.trim()) throw new Error('ZCode UI has no explicit native model preference; select a model in ZCode or specify providerId/modelId. Task was not dispatched.');
      const decoded = preferences.O(preferred.model);
      if (decoded?.providerId && decoded?.modelName) model = { providerId: decoded.providerId, modelId: decoded.modelName };
      else {
        // Original vp() also accepts unencoded provider/model$variant values.
        const text = preferred.model.trim(), at = text.indexOf('/');
        const providerId = at > 0 ? text.slice(0, at) : 'glm', name = at > 0 ? text.slice(at + 1) : text, variantAt = name.indexOf('$');
        model = variantAt > 0 && variantAt < name.length - 1
          ? { providerId, modelId: name.slice(0, variantAt), variant: name.slice(variantAt + 1) }
          : { providerId, modelId: name };
      }
      thoughtLevel = preferred.thoughtLevel || undefined;
    }
    if (typeof model.providerId !== 'string' || !model.providerId.trim() || typeof model.modelId !== 'string' || !model.modelId.trim()) {
      throw new Error('ZCode native model selection requires an explicit provider and model. Task was not dispatched.');
    }
    // Runtime model data may contain native credentials. It stays opaque in
    // this renderer, passed straight from the official resolver to the official
    // session service, and never becomes a bridge result or diagnostic.
    const modelProviderFamilySelectedKeys = (await services.settingService.get()).modelProviderFamilySelectedKeys;
    const runtimeModel = await sessions.resolveRuntimeModelForV4({ ...scope, model, thoughtLevel, modelProviderFamilySelectedKeys,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}) });
    return { model, runtimeModel, thoughtLevel, modelProviderFamilySelectedKeys };
  };
  const selectedModelMatches = (value, selected) => {
    const current = value.settings?.model?.current;
    return current?.providerId === selected.providerId && current?.modelId === selected.modelId && current?.variant === selected.variant;
  };
  const observeVerification = (request, source) => {
    if (!bridge.sessions.has(request?.sessionId)) return;
    bridge.verificationPending = true;
    const key = `${source}:${request.sessionId}:${request.requestId || ''}`;
    const seen = (bridge.verificationSignals ||= new Set());
    if (seen.has(key)) return;
    seen.add(key); if (seen.size > 512) seen.delete(seen.values().next().value);
    bridge.events.push({ method: 'bridge/diagnostic', params: { phase: 'native-verification-pending', source,
      nativeSessionId: request.sessionId, requestAlive: true } });
  };
  const enqueue = event => {
    const nativeId = event.payload?.inputId;
    if (nativeId && bridge.inputMap.has(nativeId)) event = { ...event, payload: { ...event.payload, nativeInputId: nativeId, inputId: bridge.inputMap.get(nativeId) } };
    bridge.events.push({ method: 'session/event', params: clean(event) });
    if (bridge.events.length > 1000) { bridge.protocolFailure = 'Native event queue exceeded its bound.'; bridge.events.length = 1000; }
  };
  if (method === 'bridge/beginTask') {
    for (const subscription of bridge.subscriptions.values()) subscription.dispose();
    bridge.subscriptions.clear(); bridge.sessions.clear(); bridge.events.length = 0; bridge.heldEvents.length = 0;
    bridge.inputMap.clear(); bridge.verificationPending = false; bridge.sending = false; bridge.protocolFailure = undefined;
    if (params.nativeSessionId) bridge.sessions.add(params.nativeSessionId);
    return {};
  }
  if (method === 'bridge/releaseTask') {
    for (const subscription of bridge.subscriptions.values()) subscription.dispose();
    bridge.subscriptions.clear(); bridge.sessions.clear(); bridge.events.length = 0; bridge.heldEvents.length = 0;
    bridge.inputMap.clear(); bridge.verificationPending = false; bridge.sending = false;
    return {};
  }
  if (method === 'bridge/initialize') {
    const hello = await agent.helloConversationV4();
    if (hello.protocolVersion !== 3 || hello.clientMode !== 'desktop-continuous' || hello.capabilities?.binaryFrames !== false) throw new Error('Unsupported native renderer protocol.');
    await agent.initializeConversationV4({ kind: 'clientHello', protocolVersion: 3, clientId, clientKind: 'desktop', appVersion: 'unknown', capabilities: { workspaceHookReviewUi: true } });
    // Observe the same workspace signal used by the original PJt listener.
    // This listener neither calls the SDK nor responds to runtime-header requests.
    if (!bridge.verificationSubscription) bridge.verificationSubscription = agent.onDynamicWorkspaceProviderRuntimeHeadersRequest(scope)(request => observeVerification(request, 'workspace'));
    return { protocolVersion: hello.protocolVersion, connectionId: hello.connectionId, clientMode: hello.clientMode };
  }
  if (method === 'session/create') {
    const selected = await nativeModelParameters();
    const value = await sessions.createSession({ ...scope, mode: params.mode, ...selected,
      persistence: 'deferred', titleGenerationEnabled: false, toolAllowlist: params.toolAllowlist, toolDenylist: params.toolDenylist, mcpServers: [] });
    if (!selectedModelMatches(value, selected.model)) {
      await sessions.closeDeferredDraftSession?.({ ...scope, sessionId: value.session?.sessionId }).catch(() => {});
      throw new Error('ZCode returned a different provider or model than the UI/task selection. Task was not dispatched.');
    }
    bridge.sessions.add(value.session.sessionId);
    (bridge.deferredSessions ||= new Set()).add(value.session.sessionId);
    return snapshot(value);
  }
  if (method === 'session/resume') {
    if (params.requireIdle) {
      const prior = await sessions.readSession({ ...scope, sessionId: params.sessionId });
      if (prior.runtime?.activeTurnId || prior.runtime?.pendingRequestIds?.length || prior.session?.status === 'running') return { nativeSessionBusy: true };
    }
    const value = await sessions.resumeSession({ ...scope, sessionId: params.sessionId, toolAllowlist: params.toolAllowlist, toolDenylist: params.toolDenylist, mcpServers: [], broadcastSnapshot: false });
    if (value.runtime?.activeTurnId || value.runtime?.pendingRequestIds?.length || value.session?.status === 'running') throw new Error('Native session has unresolved execution; refusing to dispatch another input.');
    bridge.sessions.add(value.session.sessionId); return snapshot(value);
  }
  if (method === 'session/list') {
    const value = await sessions.listSessions(scope);
    return { sessions: (value.sessions || []).map(item => ({ sessionId: item.sessionId, status: item.status })) };
  }
  if (method === 'session/read') return snapshot(await sessions.readSession(target()));
  if (method === 'session/setMode') return snapshot(await sessions.setMode({ ...target(), mode: params.mode }));
  if (method === 'session/setModel') {
    const own = target(), selected = await nativeModelParameters();
    const value = await sessions.setModel({ ...own, ...selected });
    if (!selectedModelMatches(value, selected.model)) throw new Error('ZCode did not preserve the requested provider and model. Task was not dispatched.');
    return snapshot(value);
  }
  if (method === 'session/subscribe') {
    const own = target();
    bridge.subscriptions.get(params.sessionId)?.dispose();
    const current = await sessions.readSession(own);
    bridge.subscriptions.set(params.sessionId, agent.onDynamicSessionEvent({ ...own, deliveryKind: 'desktop-continuous', includeSnapshot: false, afterSeq: current.runtime?.eventSeq })(envelope => {
      if (envelope.type === 'session.event') {
        const event = envelope.event;
        if (!['turn.started', 'turn.completed', 'turn.failed', 'model.streaming', 'tool.started', 'tool.completed', 'tool.failed', 'tool.executed'].includes(event.type)) return;
        if (event.type.startsWith('model.') || event.type.startsWith('tool.') || event.type.startsWith('turn.completed') || event.type.startsWith('turn.failed')) bridge.verificationPending = false;
        if (bridge.sending) {
          if (bridge.heldEvents.length >= 1000) bridge.protocolFailure = 'Native pre-ack event queue exceeded its bound.';
          else bridge.heldEvents.push(event);
        } else enqueue(event);
      } else if (envelope.type === 'providerRuntimeHeaders.request') {
        // The original PJt component remains responsible for the SDK response.
        observeVerification(envelope.request || { sessionId: params.sessionId }, 'session');
      } else if (envelope.type === 'permission.request' || envelope.type === 'userInput.request') {
        bridge.events.push({ id: 'native-interaction-' + Date.now(), method: envelope.type === 'permission.request' ? 'interaction/requestPermission' : 'interaction/requestUserInput', params: clean(envelope.request) });
      }
    }));
    return { eventSeq: current.runtime?.eventSeq ?? -1 };
  }
  if (method === 'session/send') {
    const own = target(); bridge.sending = true;
    try {
      const ack = await agent.sendConversationCommandV4({ ...own, envelope: { commandId: params.inputId, clientId, sessionId: params.sessionId, type: 'sendText',
        payload: { text: params.content, requestedDelivery: 'startNow', toolDisallowlist: params.toolDenylist }, issuedAt: Date.now() } });
      if (ack.status !== 'accepted' && ack.status !== 'duplicate') return { accepted: false, nativeAck: ackDiagnostic(ack),
        heldNativeEvents: heldDiagnostic(), verificationPending: bridge.verificationPending };
      const actualInput = ack.result?.inputId;
      if (typeof actualInput !== 'string' || !actualInput) return { accepted: false, nativeAck: { ...ackDiagnostic(ack),
        message: 'Native V4 accepted delivery without an input ID; dispatch is uncertain and will not be retried.' },
        heldNativeEvents: heldDiagnostic(), verificationPending: bridge.verificationPending };
      bridge.inputMap.set(actualInput, params.inputId);
      if (ack.status === 'accepted' && bridge.deferredSessions?.has(params.sessionId)) {
        bridge.deferredSessions.delete(params.sessionId);
        try { await sessions.promoteDeferredDraftSession(own); }
        catch (cause) { bridge.events.push({ method: 'bridge/diagnostic', params: { phase: 'native-task-index-promotion', nativeSessionId: params.sessionId,
          code: safeNativeText(cause.code), message: safeNativeText(cause.message), inputAlreadyAccepted: true } }); }
      }
      return { accepted: true, nativeInputId: actualInput };
    } catch (cause) {
      return { accepted: false, nativeAck: { status: 'rpc-error', reasonCode: safeNativeText(cause.code), message: safeNativeText(cause.message) },
        heldNativeEvents: heldDiagnostic(), verificationPending: bridge.verificationPending };
    } finally { bridge.sending = false; for (const event of bridge.heldEvents.splice(0)) enqueue(event); }
  }
  if (method === 'session/stop') {
    const own = target();
    const ack = await agent.sendConversationCommandV4({ ...own, envelope: { commandId: params.commandId, clientId, sessionId: params.sessionId, type: 'stop', payload: {}, issuedAt: Date.now() } });
    return { accepted: ack.status === 'accepted' || ack.status === 'duplicate' };
  }
  if (method === 'bridge/stopState') {
    const value = await sessions.readSession(target());
    return { stopped: value.session?.status === 'idle' && !value.runtime?.activeTurnId && (value.runtime?.pendingRequestIds?.length || 0) === 0 };
  }
  if (method === 'bridge/poll') {
    if (bridge.protocolFailure) throw new Error(bridge.protocolFailure);
    let interactive = false, publicErrorCode;
    if (bridge.verificationPending) {
      const visible = (element, minSize = 40) => {
        const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
        if (rect.width <= minSize || rect.height <= minSize || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const inherited = getComputedStyle(parent);
          if (inherited.display === 'none' || inherited.visibility === 'hidden' || Number(inherited.opacity) === 0) return false;
        }
        return true;
      };
      // The official mount point itself is intentionally 0x0 and always exists.
      // Popup SDK elements can live outside it. The public aliyunCaptcha-* ID
      // namespace is documented by Alibaba; observe visibility, never puzzle data.
      interactive = [...document.querySelectorAll('#zcode-aliyun-captcha-element *, [id^="aliyunCaptcha-"]')].slice(0, 1000).some(element => visible(element));
      const errorElement = document.getElementById?.('aliyunCaptcha-sliding-errorCode');
      if (interactive && errorElement && visible(errorElement, 0)) {
        const match = (errorElement.textContent || '').trim().match(/^(?:error:\s*)?([A-Za-z0-9_.-]{1,64})$/i);
        if (match) publicErrorCode = match[1];
      }
    }
    return { events: bridge.events.splice(0, 200), verificationPending: bridge.verificationPending, interactive, publicErrorCode };
  }
  if (method === 'bridge/dispose') {
    for (const subscription of bridge.subscriptions.values()) subscription.dispose();
    bridge.subscriptions.clear(); bridge.verificationSubscription?.dispose(); bridge.verificationSubscription = undefined;
    return {};
  }
  if (method === 'bridge/resetWorkspace') {
    for (const subscription of bridge.subscriptions.values()) subscription.dispose();
    bridge.verificationSubscription?.dispose();
    delete window.__deepseekZCodeRenderer;
    return {};
  }
  throw new Error('Method is not exposed by the ZCode renderer bridge.');
}

class RendererTransport extends EventEmitter {
  constructor(options) { super(); this.options = options; this.closed = false; this.polling = false; this.pollGeneration = 0; this.targetSessions = new Map(); }
  static async connect(cliPath, options, workspace, guard = {}) {
    const transport = new RendererTransport({ ...options, workspace, ...guard });
    try { await transport.start(cliPath); return transport; }
    catch (cause) { await transport.close(); throw cause; }
  }
  remaining() { return Math.max(1, (this.options.deadline || Date.now() + 300000) - Date.now()); }
  async start(cliPath) {
    if (process.platform !== 'win32') throw failure('zcode_renderer_platform_unsupported', '原版 ZCode renderer 当前仅验证 Windows。');
    const installation = await rendererInstallation(cliPath, this.options);
    this.executable = installation.executable;
    if (this.options.profileMode === 'existing') await assertExistingWindowAvailable(installation.executable, this.options);
    this.release = await acquireProfile(installation.profileDir);
    this.profileDir = installation.profileDir;
    const prior = await profileWorkspace(this.profileDir, this.options.workspace);
    if (prior && ['running', 'uncertain'].includes(prior.state)) throw failure('zcode_native_state_uncertain', '该原生工作区上次执行未确认停止，任务不会自动恢复或重发。需要核对原生会话状态。');
    await profileWorkspace(this.profileDir, this.options.workspace, { state: prior?.state || 'idle' });
    const env = nativeEnvironment(this.options, installation.profileDir);
    this.nativeEnv = env;
    if (this.options.profileMode === 'existing') await assertExistingWindowAvailable(installation.executable, this.options);
    await this.release.update({ phase: 'launching' });
    this.child = spawn(installation.executable, ['--remote-debugging-pipe', '--open-workspace', this.options.workspace], {
      cwd: this.options.workspace, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    });
    if (this.options.profileMode === 'existing') this.child.once('exit', () => { this.cleanupExistingExit().catch(() => {}); });
    await this.release.update({ phase: 'running', childPid: this.child.pid });
    this.child.stdout.on('data', () => {}); this.child.stderr.on('data', () => {});
    this.cdp = new CdpPipe(this.child.stdio[4], this.child.stdio[3]);
    this.cdp.on('failure', cause => { if (!this.closed) this.emit('failure', cause); });
    this.child.on('error', () => this.emit('failure', failure('zcode_renderer_start_failed', '无法启动 ZCode 原版桌面进程。')));
    await this.bindWorkspaceTarget();
  }
  async bindWorkspaceTarget() {
    const until = Date.now() + Math.min(45000, this.remaining());
    let state;
    while (Date.now() < until) {
      this.checkGuard();
      const result = await this.cdp.request('Target.getTargets', {}, undefined, Math.min(10000, this.remaining()));
      for (const target of result.targetInfos.filter(item => item.type === 'page' && item.url.includes('/app.asar/out/renderer/index.html'))) {
        let session = this.targetSessions.get(target.targetId);
        if (!session) {
          session = (await this.cdp.request('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
          this.targetSessions.set(target.targetId, session);
        }
        this.sessionId = session;
        state = await this.evaluate(rendererBootstrap, this.options.workspace).catch(() => null);
        if (state?.ready) {
          this.targetId = target.targetId;
          this.handshake = await this.operation('bridge/initialize');
          return;
        }
      }
      await delay(250);
    }
    throw failure('zcode_renderer_listener_unavailable', `ZCode 原版工作区验证监听尚未就绪：${state?.reason || 'unknown'}。任务未派发。`);
  }
  hasPersistentResources() { return this.options.profileMode === 'existing' && !!this.child?.pid && this.child.exitCode === null && !this.child.signalCode; }
  async cleanupExistingExit() {
    if (this.exitCleanup) return this.exitCleanup;
    this.exitCleanup = (async () => {
      this.closed = true; this.pollGeneration++;
      // Child exit can arrive before pipe EOF. Once closed, the CDP failure
      // listener is suppressed, so notify the task lease directly without
      // waiting for its deadline or for any asynchronous profile cleanup.
      this.emit('failure', failure('zcode_renderer_disconnected', 'ZCode 原版窗口已退出；当前任务连接已结束，不会自动重放。'));
      this.cdp?.close();
      if (this.profileDir && this.sendAttempted && !this.terminalSeen && !this.stopConfirmed) await profileWorkspace(this.profileDir, this.options.workspace, { state: 'uncertain', sessionId: this.activeSessionId }).catch(() => {});
      await this.release?.();
      this.emit('persistentClosed');
    })();
    return this.exitCleanup;
  }
  async forwardWorkspace(workspace) {
    if (!this.hasPersistentResources()) throw failure('zcode_renderer_disconnected', '原版 ZCode 窗口已退出，工作区请求不会重放。');
    await assertExistingWindowAvailable(this.executable, this.options, this.child.pid);
    const forward = spawn(this.executable, ['--open-workspace', workspace], { env: this.nativeEnv, windowsHide: true, shell: false, stdio: 'ignore' });
    forward.on('error', () => {});
    const exited = await waitForChildExit(forward, Math.min(10000, this.remaining()));
    if (!exited || !this.hasPersistentResources()) throw failure('zcode_workspace_handoff_uncertain', '原版工作区切换未获确认；不会重发请求或派发模型任务。');
  }
  async prepareExistingTask(workspace, guard = {}) {
    if (!this.hasPersistentResources()) throw failure('zcode_renderer_disconnected', '原版 ZCode 窗口已退出；不会自动重放任务。');
    if (this.unresolvedTask) throw failure('zcode_native_state_uncertain', '上一个原生任务停止状态未确认；请先在原版窗口核对，不能开始其他任务。');
    const prior = await profileWorkspace(this.profileDir, workspace);
    if (prior && ['running', 'uncertain', 'stop-requested'].includes(prior.state)) throw failure('zcode_native_state_uncertain', '该工作区存在未确认结束的原生任务，不能自动恢复。');
    const changed = path.resolve(workspace) !== path.resolve(this.options.workspace);
    this.options = { ...this.options, ...guard, workspace };
    if (changed) {
      if (this.sessionId) await this.operation('bridge/resetWorkspace', {}, 5000).catch(() => {});
      await this.forwardWorkspace(workspace);
      await this.bindWorkspaceTarget();
    } else {
      const ready = this.sessionId && await this.evaluate(rendererBootstrap, workspace).catch(() => null);
      if (!ready?.ready) await this.bindWorkspaceTarget();
    }
    this.closed = false; this.sendAttempted = false; this.terminalSeen = false; this.stopAcknowledged = false; this.stopConfirmed = false;
    this.stopPromise = undefined; this.activeSessionId = undefined; this.activeExternalInputId = undefined; this.activeTurnId = undefined; this.trackedTurnStarted = false;
    this.reportedInteractive = false; this.lastVerificationErrorCode = undefined;
    await this.operation('bridge/beginTask', { nativeSessionId: guard.nativeSessionId });
    await profileWorkspace(this.profileDir, workspace, { state: prior?.state || 'idle' });
  }
  async confirmNativeStop() {
    if (!this.sendAttempted || this.terminalSeen || !this.activeSessionId) return;
    await this.request('session/stop', { sessionId: this.activeSessionId }).catch(() => {});
    if (this.stopAcknowledged) {
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        const state = await this.operation('bridge/stopState', { sessionId: this.activeSessionId }, 1000).catch(() => null);
        if (state?.stopped) { this.stopConfirmed = true; break; }
        await delay(150);
      }
    }
  }
  async finishExistingTask() {
    this.pollGeneration++;
    await this.pollPromise?.catch(() => {});
    if (this.hasPersistentResources()) {
      await this.confirmNativeStop();
      await this.operation('bridge/releaseTask', {}, 5000).catch(() => {});
    }
    const uncertain = this.sendAttempted && !this.terminalSeen && !this.stopConfirmed;
    if (this.profileDir && this.sendAttempted) await profileWorkspace(this.profileDir, this.options.workspace, {
      state: uncertain ? 'uncertain' : this.terminalSeen ? 'completed' : 'stopped', sessionId: this.activeSessionId,
    });
    this.options.signal = undefined; this.options.deadline = undefined;
    if (uncertain) { this.unresolvedTask = true; throw Object.assign(failure('zcode_shutdown_uncertain', '本任务的原生停止未确认；窗口保持打开，不会重放或开始其他任务。'), { dispatchUncertain: true, nativeSessionId: this.activeSessionId }); }
  }
  checkGuard() { if (this.options.signal?.aborted || this.remaining() <= 1) throw failure('cancelled', 'ZCode 任务已取消或截止。'); }
  async evaluate(fn, value, timeoutMs) {
    const result = await this.cdp.request('Runtime.evaluate', { expression: `(${fn.toString()})(${JSON.stringify(value)})`, awaitPromise: true, returnByValue: true }, this.sessionId, timeoutMs || Math.min(30000, this.remaining()));
    if (result.exceptionDetails) throw failure('zcode_renderer_operation', result.exceptionDetails.exception?.description?.split('\n')[0] || 'ZCode 原生 renderer 操作失败。');
    return result.result.value;
  }
  operation(method, params = {}, timeoutMs) { return this.evaluate(rendererOperation, { method, params }, timeoutMs); }
  async request(method, params = {}) {
    if (method === 'session/stop') {
      if (!this.stopPromise) this.stopPromise = this.operation(method, { ...params, commandId: randomUUID() }, 5000).then(async result => {
        this.stopAcknowledged = result.accepted === true;
        if (this.profileDir) await profileWorkspace(this.profileDir, this.options.workspace, { state: this.stopAcknowledged ? 'stop-requested' : 'uncertain', sessionId: params.sessionId });
        return result;
      });
      return this.stopPromise;
    }
    this.checkGuard();
    if (method === 'session/send') {
      const listener = await this.evaluate(rendererBootstrap, this.options.workspace);
      if (!listener.ready || listener.sameListenerConnection !== true) throw failure('zcode_renderer_listener_changed', 'ZCode 原生验证监听连接已变化，任务未派发。');
      this.sendAttempted = true; this.activeSessionId = params.sessionId; this.activeExternalInputId = params.inputId;
      await profileWorkspace(this.profileDir, this.options.workspace, { state: 'running', sessionId: params.sessionId, externalInputId: params.inputId });
    }
    const result = await this.operation(method, params, method === 'session/send' ? this.remaining() : undefined);
    if (method === 'session/send' && result?.accepted !== true) {
      const diagnostic = { phase: 'v4-send-ack', nativeSessionId: params.sessionId, externalInputId: params.inputId,
        ack: result?.nativeAck, heldNativeEvents: result?.heldNativeEvents || [], verificationPending: result?.verificationPending === true };
      this.emit('message', { method: 'bridge/diagnostic', params: diagnostic });
      throw Object.assign(failure('zcode_native_command_failed', result?.nativeAck?.message || `ZCode V4 请求未接收：${result?.nativeAck?.reasonCode || result?.nativeAck?.status || 'unknown'}。`),
        { dispatchUncertain: true, nativeSessionId: params.sessionId });
    }
    if (method === 'session/subscribe' && !this.polling) this.pollPromise = this.poll();
    return result;
  }
  write() { throw failure('zcode_renderer_method_denied', 'ZCode renderer 桥不接受人工合成的原生权限或验证响应。'); }
  async poll() {
    if (this.polling || this.closed) return;
    this.polling = true;
    const generation = this.pollGeneration;
    while (!this.closed && generation === this.pollGeneration) {
      try {
        const result = await this.operation('bridge/poll');
        for (const event of result.events) {
          const raw = event.method === 'session/event' ? event.params : undefined;
          const sameInput = !!raw && raw.sessionId === this.activeSessionId && raw.payload?.inputId === this.activeExternalInputId;
          if (sameInput && raw.type === 'turn.started' && !this.trackedTurnStarted) { this.activeTurnId = raw.turnId; this.trackedTurnStarted = true; }
          const sameTurn = this.trackedTurnStarted && raw?.sessionId === this.activeSessionId && this.activeTurnId && raw.turnId === this.activeTurnId && (!raw.payload?.inputId || sameInput);
          const compatibleTurn = !this.activeTurnId || !raw?.turnId || raw.turnId === this.activeTurnId;
          if (compatibleTurn && (sameInput || sameTurn) && (raw?.type === 'turn.completed' || raw?.type === 'turn.failed')) {
            this.terminalSeen = true;
            if (this.profileDir) await profileWorkspace(this.profileDir, this.options.workspace, { state: 'completed', sessionId: raw.sessionId });
          }
          this.emit('message', event);
        }
        if (!result.verificationPending) { this.reportedInteractive = false; this.lastVerificationErrorCode = undefined; }
        if (result.publicErrorCode && result.publicErrorCode !== this.lastVerificationErrorCode) {
          this.lastVerificationErrorCode = result.publicErrorCode;
          this.emit('message', { method: 'bridge/diagnostic', params: { phase: 'native-verification-ui-error', nativeSessionId: this.activeSessionId, publicErrorCode: result.publicErrorCode } });
        }
        if (result.interactive && !this.reportedInteractive) {
          this.reportedInteractive = true;
          if (this.targetId && this.remaining() > 1000) await this.cdp.request('Target.activateTarget', { targetId: this.targetId }, undefined, Math.min(3000, this.remaining())).catch(() => {});
          this.emit('message', { id: `native-verification-${randomUUID()}`, method: 'interaction/nativeVerification', params: {
            code: 'zcode_native_verification', message: 'ZCode 原版窗口显示交互验证。请在该窗口手动完成；当前原生请求保持打开，不会自动刷新或重发。', keepNativeRequestAlive: true,
          } });
        }
      } catch (cause) { if (!this.closed) this.emit('failure', cause); break; }
      await delay(200);
    }
    this.polling = false;
  }
  async close() {
    if (this.options.profileMode === 'existing') {
      if (this.hasPersistentResources()) throw failure('zcode_existing_window_open', '原版 ZCode 窗口仍在使用中；普通任务结束或客户端断连不能关闭它。');
      return this.cleanupExistingExit();
    }
    if (this.closing) return this.closing;
    this.closing = this.closeOwned(); return this.closing;
  }
  async closeOwned() {
    if (this.options.profileMode === 'existing') {
      if (this.hasPersistentResources()) throw failure('zcode_existing_window_open', '原版 ZCode 窗口仍在使用中；普通任务结束或客户端断连不能关闭它。');
      await this.cleanupExistingExit(); return;
    }
    this.closed = true;
    if (this.cdp && !this.cdp.closed) {
      await this.confirmNativeStop();
      await this.cdp.request('Browser.close', {}, undefined, 1500).catch(() => {});
    }
    const child = this.child;
    let exited = await waitForChildExit(child, 5000);
    if (!exited && child?.pid) {
      await runFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }).catch(() => {});
      exited = await waitForChildExit(child, 5000);
    }
    this.cdp?.close();
    const uncertain = !exited || (this.sendAttempted && !this.terminalSeen && !this.stopConfirmed);
    if (this.profileDir && this.sendAttempted) await profileWorkspace(this.profileDir, this.options.workspace, {
      state: uncertain ? 'uncertain' : this.terminalSeen ? 'completed' : 'stopped', sessionId: this.activeSessionId,
    }).catch(() => {});
    if (!uncertain) await this.release?.();
    else {
      await this.release?.update?.({ phase: 'needs-review', childPid: child?.pid }).catch(() => {});
      throw Object.assign(failure('zcode_shutdown_uncertain', 'ZCode 原生停止或进程退出未获确认；保留 profile 锁，不能自动重发任务。'), { dispatchUncertain: true, nativeSessionId: this.activeSessionId });
    }
  }
}

const LEASE_METHODS = new Set(['session/create', 'session/resume', 'session/read', 'session/list', 'session/subscribe', 'session/send', 'session/setMode', 'session/setModel', 'session/stop']);
class RendererTaskLease extends EventEmitter {
  constructor(owner, base, workspace, guard) {
    super(); Object.assign(this, { owner, base, workspace, expectedResumeId: guard.nativeSessionId, closed: false });
    this.onMessage = value => this.emit('message', value);
    this.onFailure = cause => this.emit('failure', cause);
    base.on('message', this.onMessage); base.on('failure', this.onFailure);
  }
  async request(method, params = {}) {
    if (this.closed || this.closing) throw failure('zcode_transport_closed', '本任务的原生连接已释放。');
    if (!LEASE_METHODS.has(method)) throw failure('zcode_renderer_method_denied', '任务连接不暴露该方法。');
    if (params.workspace && path.resolve(params.workspace.workspacePath || '') !== path.resolve(this.workspace)) throw failure('invalid_workspace', '原生请求不属于本任务工作区。');
    if (method === 'session/create') {
      if (this.sessionId || this.expectedResumeId) throw failure('invalid_session', '本任务只能创建或恢复一个明确的原生会话。');
      const value = await this.base.request(method, params);
      this.sessionId = value.session?.sessionId; return value;
    }
    if (method === 'session/resume') {
      if (!this.expectedResumeId || params.sessionId !== this.expectedResumeId || this.sessionId) throw failure('invalid_session', '不能恢复未由本任务明确引用的原生会话。');
      const value = await this.base.request(method, { ...params, requireIdle: true });
      if (value.nativeSessionBusy) throw failure('zcode_session_busy', '原生会话仍在执行，本任务未修改它的权限，也没有恢复或派发新输入。');
      this.sessionId = params.sessionId; return value;
    }
    if (method !== 'session/list' && (!this.sessionId || params.sessionId !== this.sessionId)) throw failure('invalid_session', '只能操作当前任务的原生会话。');
    if (method === 'session/send') {
      const state = await this.base.operation('bridge/stopState', { sessionId: this.sessionId });
      if (!state.stopped) throw failure('zcode_session_busy', '原生会话正在运行或等待输入，本任务未派发，也不会中断它。');
    }
    return this.base.request(method, params);
  }
  write(message) { return this.base.write(message); }
  async close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      try { await this.base.finishExistingTask(); }
      finally {
        this.closed = true;
        this.base.off('message', this.onMessage); this.base.off('failure', this.onFailure);
        if (this.owner.activeLease === this) this.owner.activeLease = undefined;
      }
    })();
    return this.closing;
  }
}

class PersistentRendererHost {
  constructor(options = {}) { this.options = options; this.closed = false; }
  hasPersistentResources() { return this.base?.hasPersistentResources() === true; }
  async acquire(cliPath, workspace, guard = {}) {
    if (this.closed) throw failure('zcode_transport_closed', '原生持久连接管理器已关闭。');
    if (this.options.managedLifetime !== true) throw failure('zcode_existing_requires_managed_lifetime', '复用原版 ZCode 窗口需要共享协作服务；独占 stdio 模式不能持有用户窗口。');
    if (this.acquiring || this.activeLease) throw failure('zcode_profile_busy', '已有 ZCode 协作任务在运行，请等待它完成。');
    this.acquiring = true;
    try {
      if (this.base && !this.base.hasPersistentResources()) { await this.base.close(); this.base = undefined; }
      if (!this.base) {
        const options = { ...this.options, profileMode: 'existing', workspace, ...guard };
        const base = this.options.createTransport ? this.options.createTransport(options) : new RendererTransport(options);
        this.base = base;
        base.on('persistentClosed', () => { if (this.base === base) this.base = undefined; });
        await base.start(cliPath);
      }
      const base = this.base;
      if (!base?.hasPersistentResources()) throw failure('zcode_renderer_disconnected', '原版 ZCode 窗口已经退出；任务不会重放。');
      await base.prepareExistingTask(workspace, guard);
      this.activeLease = new RendererTaskLease(this, base, workspace, guard);
      return this.activeLease;
    } catch (cause) {
      if (this.base && !this.base.hasPersistentResources()) { await this.base.close().catch(() => {}); this.base = undefined; }
      throw cause;
    } finally { this.acquiring = false; }
  }
  async close() {
    if (this.hasPersistentResources()) throw failure('zcode_existing_window_open', '原版 ZCode 窗口仍由用户使用，不能因服务空闲或客户端断连而结束它。');
    if (this.activeLease || this.acquiring) throw failure('zcode_profile_busy', '原生连接尚在处理任务或交接。');
    await this.base?.close(); this.base = undefined; this.closed = true;
  }
}

module.exports = { CdpPipe, RendererTransport, PersistentRendererHost, RendererTaskLease, rendererBootstrap, rendererOperation,
  rendererInstallation, acquireProfile, profileWorkspace, waitForChildExit, listZCodeMainProcesses, selectZCodeMainProcesses, assertExistingWindowAvailable, nativeEnvironment };

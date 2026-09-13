// Cordis plugin for the desktop's existing Web runtime. The owning desktop
// routes private child IPC; no model credentials or Web authentication cross it.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { validateTask, promptFor } = require('./adapters/harness.cjs');
const { modelSelection, summarize, allowedTools, resumeOwnershipFailure } = require('./harness-worker.cjs');

const CHANNEL = 'harness-collaboration';
const DESKTOP_INJECT = ['agents', 'agentDefaultModel', 'sessions', 'sessionController', 'llm', 'approval', 'sandboxPolicy', 'tools'];
function failure(code, message, state) { return Object.assign(new Error(message), { code, ...(state ? { state } : {}) }); }
function safeMessage(error) {
  return String(error?.message || error).slice(0, 3000).replace(/\bsk-[\w-]+/g, '[redacted]').replace(/(Bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;}]+/gi, '$1[redacted]');
}
function isIdle(agent) { return agent.status === 'idle' && !agent.inbox.nextTurn.length && !agent.inbox.nextStep.length; }
async function finishCheckpoint(operation, signal) {
  if (signal?.aborted) { Promise.resolve(operation).catch(() => {}); return false; }
  let onAbort;
  try {
    return await Promise.race([Promise.resolve(operation).then(() => true), new Promise(resolve => {
      onAbort = () => resolve(false); signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    })]);
  } finally { if (onAbort) signal?.removeEventListener('abort', onAbort); }
}

function createDesktopController(ctx, config, options = {}) {
  const active = new Map(), claimed = new Set(), seen = new Set();
  const imports = options.imports || (name => import(pathToFileURL(path.join(config.runtimeRoot, 'node_modules', '@deepseek-ai', name, 'lib', 'index.js')).href));
  let closing = false;

  async function execute(requestId, task, send) {
    validateTask(task);
    if (closing) throw failure('HARNESS_DESKTOP_STOPPING', 'Harness 桌面运行时正在退出。');
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) throw failure('INVALID_REQUEST', '协作请求标识无效。');
    if (seen.has(requestId)) throw failure('HARNESS_DUPLICATE_REQUEST', '该协作请求已接收，不能再次派发。');
    const nativeSessionId = task.nativeSessionId || `collaboration-${randomUUID()}`;
    if (claimed.has(nativeSessionId)) throw failure('HARNESS_SESSION_BUSY', '此原生会话已有协作任务。', 'needs_input');
    seen.add(requestId); claimed.add(nativeSessionId);
    const controller = new AbortController();
    const record = { controller, acknowledged: false, acknowledge: undefined, agent: undefined, prompt: undefined, dispatched: false, done: undefined };
    active.set(requestId, record);
    const cancelled = () => {
      record.acknowledge?.();
      if (record.agent && record.dispatched) {
        // Preserve unrelated input from the desktop. Only remove our prompt if
        // cancellation wins before the native loop claims it.
        record.agent.inbox.remove(record.prompt?.id);
        record.agent.cancel({ kind: 'parent' }, { keepInbox: true });
      }
    };
    controller.signal.addEventListener('abort', cancelled, { once: true });
    const operation = (async () => {
      const disposers = [];
      let agent, stopReason, deadline, policyBefore, pins, setApprovalPolicy, setSandboxMode, restoring = false, promptAdmitted = false, nativeOutcomeObserved = false, output;
      const attention = (code, message) => {
        stopReason ||= { code, message, state: 'needs_input' };
        record.acknowledge?.();
        controller.abort();
        if (agent && promptAdmitted) agent.cancel({ kind: 'hook', reason: code }, { keepInbox: true });
      };
      const assertIdle = async () => {
        const busy = () => failure('HARNESS_SESSION_BUSY', 'Harness 原生会话正在运行或有待处理输入，请先完成当前会话交接。', 'needs_input');
        if (!isIdle(agent)) throw busy();
        // Native maintenance reports status=idle while whenIdle() is pending.
        // Observe its current durability barrier without waiting out or taking
        // over another user's compaction/maintenance operation.
        const settled = await Promise.race([agent.whenIdle().then(() => true), new Promise(resolve => setImmediate(() => resolve(false)))]);
        if (!settled || !isIdle(agent)) throw busy();
      };
      try {
        const [llmNative, approvalNative, sandboxNative] = await Promise.all([imports('dsh-llm'), imports('dsh-user-approval'), imports('dsh-sandbox-policy')]);
        const { createUserMessage } = llmNative;
        ({ setApprovalPolicy } = approvalNative); ({ setSandboxMode } = sandboxNative);
        controller.signal.throwIfAborted();
        agent = ctx.agents.get(nativeSessionId);
        if (!agent) {
          // The native Web controller composes its regular preset and keeps the
          // Agent handle, so UI subscriptions and followups share one writer.
          if (task.nativeSessionId) {
            const resolved = await ctx.sessionController.resolveAgent(nativeSessionId);
            if (resolved.error) throw resolved.error;
            agent = resolved.agent;
          } else {
            await ctx.sessionController.create({ sessionId: nativeSessionId, cwd: task.workspace });
            agent = ctx.agents.get(nativeSessionId);
          }
        }
        if (!agent) throw failure('HARNESS_SESSION_UNAVAILABLE', '原生 Web controller 未发布协作会话。');
        record.agent = agent;
        if (path.resolve(agent.session.header.cwd || '') !== path.resolve(task.workspace)) throw failure('INVALID_WORKSPACE', '原生会话工作目录与委派目录不同，已拒绝续接。');
        await assertIdle(); controller.signal.throwIfAborted();
        const agentCtx = agent.ctx, allowed = new Set(allowedTools(task.permission));
        const selection = task.model ? modelSelection(agent.session.requestHeader()?.config || ctx.agentDefaultModel.currentSelection(), task.model) : undefined;
        if (selection) await ctx.llm.resolveCallConfig(selection);
        await assertIdle(); controller.signal.throwIfAborted();
        policyBefore = { sandbox: ctx.sandboxPolicy.resolve({ session: agent.session }).mode, approval: ctx.approval.effectivePolicy(agent.session) };
        let steps = 0;
        const stopForHuman = (state, data) => {
          if (stopReason) return;
          stopReason = { code: state === 'needs_approval' ? 'NEEDS_APPROVAL' : 'NEEDS_INPUT', message: state === 'needs_approval' ? 'Harness 需要人工审批，协作执行已停止。' : 'Harness 需要人工输入，协作执行已停止。', state, data };
          if (promptAdmitted) agent.cancel({ kind: 'hook', reason: state }, { keepInbox: true });
        };
        disposers.push(agentCtx.on('approval/request', async request => {
          stopForHuman('needs_approval', { toolName: request.toolName, reason: request.reason, requestId: request.id }); return 'cancelled';
        }, { prepend: true }));
        disposers.push(agentCtx.on('user-questions/request', async request => {
          stopForHuman('needs_input', { questions: request.questions }); throw failure('NEEDS_INPUT', 'A human answer is required.');
        }, { prepend: true }));
        disposers.push(agentCtx.on('agent/inbox/inserted', ({ message }) => {
          if (message.source?.kind === 'user' && message.id !== record.prompt?.id) attention('HARNESS_DESKTOP_INPUT', '桌面向此会话加入了新输入，协作任务已停止并保留该输入。');
        }));
        disposers.push(agentCtx.on('agent/pre-step', async (payload, next) => {
          const foreign = payload.messages.filter(message => message.source?.kind === 'user' && message.id !== record.prompt?.id);
          if (foreign.length) {
            attention('HARNESS_DESKTOP_INPUT', '桌面向此会话加入了新输入，协作任务已停止并保留该输入。');
            // A native turn claims the inbox before pre-step. Requeue only
            // foreign messages that have not yet reached a model request.
            for (const message of [...foreign].reverse()) agent.inbox.prepend('next-turn', message);
          }
          if (stopReason || controller.signal.aborted) return { kind: 'reject' };
          if (++steps > task.budget.maxTurns || Date.now() >= Date.parse(task.deadlineAt)) {
            stopReason = { code: 'BUDGET_EXCEEDED', message: 'Harness 达到原生模型步骤预算或截止时间。' };
            agent.cancel({ kind: 'hook', reason: 'collaboration-budget' }, { keepInbox: true }); return { kind: 'reject' };
          }
          return next();
        }, { prepend: true }));
        // A preset may own scoped tools that native restrict() intentionally
        // leaves visible. Filter the final model-facing assembly and enforce
        // the same whitelist through the monotonic execution guard.
        if (ctx.tools.modeFor(agent) !== 'native') disposers.push(agentCtx.tools.presentAs('native'));
        disposers.push(agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
          const assembled = await next();
          return { ...assembled, tools: assembled.tools.filter(tool => allowed.has(tool.name)), ...(selection ? { variables: { ...assembled.variables, provider: selection.provider, model: selection.model } } : {}) };
        }, { prepend: true }));
        if (selection) disposers.push(agentCtx.on('agent/request', async (_payload, next) => {
          const { reasoningEffort: _previous, ...resolved } = await next();
          return { ...resolved, provider: selection.provider, model: selection.model, ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) };
        }, { prepend: true }));
        disposers.push(agentCtx.tools.guard(exec => {
          if (stopReason || controller.signal.aborted) return 'The delegated task is stopped.';
          if (!allowed.has(exec.name)) return 'Only the delegated native file tools are available; shell, MCP, web, jobs and delegation are disabled.';
          if (ctx.sandboxPolicy.resolve({ session: agent.session }).mode !== task.permission || ctx.approval.effectivePolicy(agent.session) !== 'ask') return 'The delegated permission policy changed; task handoff is required.';
        }));
        setSandboxMode(agent.session, task.permission); setApprovalPolicy(agent.session, 'ask');
        pins = { sandboxChanged: false, approvalChanged: false };
        disposers.push(ctx.on('session/event', (session, event) => {
          if (session !== agent.session) return;
          if (!restoring && ['sandbox/mode', 'approval/policy'].includes(event.type)) {
            if (event.type === 'sandbox/mode') pins.sandboxChanged = true;
            else pins.approvalChanged = true;
            attention('HARNESS_DESKTOP_POLICY_CHANGED', '桌面更改了此会话的权限，协作任务已停止。');
          }
          void send({ type: 'event', event: 'native_event', data: { nativeSessionId, event } }).catch(() => controller.abort());
        }));
        record.prompt = createUserMessage({ content: [{ type: 'text', text: promptFor(task) }], source: { kind: 'user', rpcId: task.id } });
        const firstSeq = agent.session.seq;
        const checkpoint = new Promise(resolve => { record.acknowledge = resolve; });
        deadline = setTimeout(() => {
          stopReason ||= { code: 'DEADLINE_EXCEEDED', message: 'Harness 任务已达到截止时间。' };
          controller.abort();
        }, Math.min(2147483647, Math.max(1, Date.parse(task.deadlineAt) - Date.now())));
        await ctx.sessions.flush(agent.session);
        await send({ type: 'checkpoint', data: { nativeSessionId, nativeStartSeq: firstSeq, nativeDesktop: true } }, controller.signal);
        await checkpoint; record.acknowledge = undefined;
        if (stopReason) throw failure(stopReason.code, stopReason.message, stopReason.state);
        controller.signal.throwIfAborted(); await assertIdle();
        if (stopReason) throw failure(stopReason.code, stopReason.message, stopReason.state);
        controller.signal.throwIfAborted();
        promptAdmitted = record.dispatched = true;
        agent.followup(record.prompt);
        await agent.whenIdle(); await ctx.sessions.flush(agent.session);
        if (stopReason) throw failure(stopReason.code, stopReason.message, stopReason.state);
        controller.signal.throwIfAborted();
        const outcome = summarize(agent.session, firstSeq);
        nativeOutcomeObserved = Boolean(outcome.reason);
        if (outcome.reason?.kind !== 'completed') throw failure(outcome.reason?.error?.code || 'HARNESS_INCOMPLETE', outcome.reason?.error ? safeMessage(outcome.reason.error) : `Harness turn ended: ${outcome.reason?.kind || 'unknown'}`);
        output = { type: 'result', data: { summary: outcome.summary, nativeSessionId, nativeDesktop: true, tests: [], artifacts: [], unfinished: [] } };
      } catch (error) {
        const conflict = resumeOwnershipFailure(error, task.nativeSessionId);
        if (conflict) error = failure(conflict.code, conflict.message, 'needs_input');
        if (stopReason) error = failure(stopReason.code, stopReason.message, stopReason.state);
        else if (controller.signal.aborted) error = failure('CANCELLED', 'Harness 协作任务已取消。');
        else if (promptAdmitted && !nativeOutcomeObserved && !error.state) error.dispatchUncertain = true;
        if (error.state) await send({ type: 'state', state: error.state, data: { nativeSessionId, code: error.code, reason: error.message, promptDispatched: record.dispatched, ...stopReason?.data } });
        output = { type: 'error', code: error.code || 'HARNESS_DESKTOP_FAILED', message: safeMessage(error), ...(error.dispatchUncertain ? { dispatchUncertain: true } : {}) };
      } finally {
        clearTimeout(deadline); record.acknowledge = undefined;
        if (agent && promptAdmitted) {
          if (controller.signal.aborted || stopReason) agent.cancel({ kind: 'hook', reason: 'collaboration-stopped' }, { keepInbox: true });
          await agent.whenIdle();
        }
        try {
          restoring = true;
          // Restore synchronously while our guards remain mounted, then remove
          // every hook before yielding. A new desktop prompt can then run with
          // its original policy without becoming part of this task's wait.
          if (agent && policyBefore && pins) {
            if (!pins.sandboxChanged) setSandboxMode(agent.session, policyBefore.sandbox);
            if (!pins.approvalChanged) setApprovalPolicy(agent.session, policyBefore.approval);
          }
          const cleanup = disposers.reverse().map(dispose => { try { return Promise.resolve(dispose()); } catch (error) { return Promise.reject(error); } });
          const outcomes = await Promise.allSettled(cleanup);
          const failed = outcomes.find(outcome => outcome.status === 'rejected');
          if (failed) throw failed.reason;
          if (agent && pins) await ctx.sessions.flush(agent.session);
        } finally {
          controller.signal.removeEventListener('abort', cancelled);
          active.delete(requestId); claimed.delete(nativeSessionId);
        }
      }
      // A terminal response is the release barrier for subsequent desktop
      // tasks. The original Web-owned Agent remains attached and visible.
      await send(output);
    })();
    record.done = operation;
    return operation;
  }
  return {
    execute,
    acknowledge(requestId) { const record = active.get(requestId); if (record) { record.acknowledged = true; record.acknowledge?.(); } },
    cancel(requestId) { const record = active.get(requestId); record?.controller.abort(); return Boolean(record); },
    async shutdown() { closing = true; for (const record of active.values()) record.controller.abort(); await Promise.allSettled([...active.values()].map(record => record.done)); },
  };
}

function createDesktopRunner(ctx, config, options = {}) {
  const controller = createDesktopController(ctx, config, options);
  return {
    async execute(task, callbacks) {
      const requestId = randomUUID();
      let result, error, callbackError, admitted = false, stateSent = false, blocked, chain = Promise.resolve();
      const forward = (message, executionSignal) => {
        const next = chain.then(async () => {
          if (callbackError) throw callbackError;
          if (message.type === 'checkpoint') {
            if (executionSignal?.aborted) return;
            const persisted = await finishCheckpoint(callbacks.checkpoint(message.data), executionSignal);
            if (persisted && !executionSignal?.aborted && !callbacks.signal?.aborted) { admitted = true; controller.acknowledge(requestId); }
          } else if (message.type === 'event') await callbacks.emit(message.event, message.data);
          else if (message.type === 'state') { await callbacks.state(message.state, message.data); stateSent = true; blocked = message.state; }
          else if (message.type === 'result') result = message.data;
          else if (message.type === 'error') error = Object.assign(failure(message.code || 'HARNESS_DESKTOP_FAILED', message.message, blocked), message.dispatchUncertain ? { dispatchUncertain: true } : {});
        });
        chain = next.catch(cause => { callbackError ||= cause; controller.cancel(requestId); });
        return next;
      };
      const cancel = () => controller.cancel(requestId);
      callbacks.signal?.addEventListener('abort', cancel, { once: true });
      try {
        if (callbacks.signal?.aborted) throw failure('CANCELLED', 'Harness 协作任务已取消。');
        await callbacks.emit('executor_ready', { executor: 'harness', nativeDesktop: true, nativeProtocol: 'Cordis Web AgentRegistry' });
        const execution = controller.execute(requestId, task, forward);
        if (callbacks.signal?.aborted) cancel();
        await execution;
        await chain;
        if (callbackError) throw callbackError;
        if (error) throw error;
        if (!result) throw failure('HARNESS_DESKTOP_FAILED', '桌面协作执行器没有返回结果。');
        return result;
      } catch (cause) {
        const thrown = callbackError || cause;
        if ((callbackError || !error) && admitted && !blocked && !callbacks.signal?.aborted) thrown.dispatchUncertain = true;
        if (thrown.state && !stateSent) await callbacks.state(thrown.state, { code: thrown.code, reason: thrown.message, promptDispatched: false, nativeSessionId: task.nativeSessionId });
        throw thrown;
      } finally { callbacks.signal?.removeEventListener('abort', cancel); }
    },
    dispose: () => controller.shutdown(),
  };
}

exports.name = 'desktop-collaboration-web-worker';
exports.inject = DESKTOP_INJECT;
exports.apply = (ctx, config) => {
  if (!process.send) throw new Error('Desktop collaboration requires its owning process IPC.');
  const controller = createDesktopController(ctx, config);
  const send = (requestId, message) => new Promise((resolve, reject) => {
    if (!process.connected) { reject(failure('HARNESS_DESKTOP_DISCONNECTED', '桌面协作 IPC 已断开。')); return; }
    process.send({ type: CHANNEL, requestId, message }, error => error ? reject(error) : resolve());
  });
  const receive = message => {
    if (message?.type !== CHANNEL) return;
    if (message.action === 'checkpoint-ack') controller.acknowledge(message.requestId);
    else if (message.action === 'cancel') controller.cancel(message.requestId);
    else if (message.action === 'run') void controller.execute(message.requestId, message.task, data => send(message.requestId, data))
      .catch(error => send(message.requestId, { type: 'error', code: error.code || 'HARNESS_DESKTOP_FAILED', message: safeMessage(error) }).catch(() => {}));
  };
  process.on('message', receive);
  const disconnect = () => { void controller.shutdown(); };
  process.once('disconnect', disconnect);
  ctx.effect(() => async () => { process.removeListener('message', receive); process.removeListener('disconnect', disconnect); await controller.shutdown(); });
  setImmediate(async () => {
    try { await ctx.get('loader')?.await(); await send(undefined, { type: 'ready', data: { nativeProtocol: 'Cordis Web AgentRegistry', nativeDesktop: true, modelRequestStarted: false } }); }
    catch (error) { await send(undefined, { type: 'error', code: 'HARNESS_DESKTOP_START_FAILED', message: safeMessage(error) }).catch(() => {}); }
  });
};
exports.CHANNEL = CHANNEL;
exports.DESKTOP_INJECT = DESKTOP_INJECT;
exports.createDesktopController = createDesktopController;
exports.createDesktopRunner = createDesktopRunner;

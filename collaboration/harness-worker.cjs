// A Cordis plugin loaded by the bundled Harness SDK profile. All model calls,
// credential lookup, tool execution, session persistence and sandboxing remain native.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');

exports.name = 'desktop-collaboration-worker';
exports.inject = ['agents', 'agentDefaultModel', 'sessions', 'sessionPersistence', 'llm', 'permissionPresets', 'approval', 'tools', 'sdkAppStartup'];

function safeMessage(error) {
  return String(error?.message || error).slice(0, 3000)
    .replace(/\bsk-[\w-]+/g, '[redacted]')
    .replace(/(Bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;}]+/gi, '$1[redacted]');
}
function modelSelection(current, override) {
  if (!override) return current;
  if (typeof override === 'object' && typeof override.provider === 'string' && typeof override.model === 'string') return { provider: override.provider, model: override.model };
  if (typeof override !== 'string') throw new Error('Model must be a string or {provider, model}.');
  const split = override.indexOf('/');
  return split > 0 ? { provider: override.slice(0, split), model: override.slice(split + 1) } : { ...current, model: override };
}
function allowedTools(permission) {
  return ['read', 'glob', 'grep', 'read_image', 'ask_user_question', ...(permission === 'workspace-write' ? ['edit', 'write'] : [])];
}
function resumeOwnershipFailure(error, nativeSessionId) {
  if (!nativeSessionId || error?.name !== 'SessionAlreadyOwnedError' || error.sessionId !== nativeSessionId) return;
  return {
    code: 'HARNESS_SESSION_OWNED',
    message: 'Harness 原生会话正被活动写入句柄占用，本次修订尚未发送。请先在占用它的 Harness 窗口或运行时中完成会话交接后重试；仅关闭聊天页可能不会释放会话。',
  };
}
function summarize(session, firstSeq) {
  let summary = '', reason;
  for (let seq = firstSeq; seq < session.seq; seq++) {
    const event = session.eventAt(seq);
    if (event?.type === 'assistant/message') {
      const text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
      if (text) summary = text;
    }
    if (event?.type === 'turn/end') reason = event.data.reason;
  }
  return { summary, reason };
}
exports.apply = (ctx, config) => {
  if (!process.send) throw new Error('Harness collaboration worker requires private IPC.');
  const send = message => new Promise(resolve => {
    if (!process.connected) { resolve(); return; }
    process.send(message, () => resolve());
  });
  let handle, running = false, stopping = false, pendingCheckpoint, stopReason, deadline, execution;
  const imports = name => import(pathToFileURL(path.join(config.runtimeRoot, 'node_modules', '@deepseek-ai', name, 'lib', 'index.js')).href);
  const cancel = () => {
    stopping = true;
    pendingCheckpoint?.(); pendingCheckpoint = undefined;
    handle?.agent.cancel({ kind: 'parent' });
  };
  const shutdown = async () => {
    cancel();
    await execution?.catch(() => {});
    await handle?.dispose();
    ctx.get('appExit')?.(0);
  };
  function stopForHuman(state, data) {
    if (stopReason) return;
    stopReason = { state, data };
    void send({ type: 'state', state, data });
    handle?.agent.cancel({ kind: 'hook', reason: state });
  }
  async function run(task) {
    if (running) throw new Error('Worker accepts exactly one task.');
    running = true;
    const [{ installModelSelection }, { createUserMessage }, { setApprovalPolicy }] = await Promise.all([imports('dsh-agent'), imports('dsh-llm'), imports('dsh-user-approval')]);
    const selection = modelSelection(ctx.agentDefaultModel.currentSelection(), task.model);
    await ctx.llm.resolveCallConfig(selection);
    if (stopping) return;
    let steps = 0;
    const setup = (agentCtx, agent) => {
      if (path.resolve(agent.session.header.cwd || '') !== path.resolve(task.workspace)) throw new Error('Native session workspace differs from the delegated workspace; resume refused.');
      installModelSelection(agentCtx, { current: selection, assembled: undefined });
      ctx.permissionPresets.set(agent.session, task.permission);
      // A fresh unpublished session can still inherit ask from composition;
      // persist it explicitly so a user's saved default cannot widen it at publication.
      setApprovalPolicy(agent.session, 'ask');
      if (ctx.approval.overrideOf(agent.session) !== 'ask') throw new Error('Native approval policy was not pinned to ask.');
      agentCtx.on('agent/pre-step', async (payload, next) => {
        if (++steps > task.budget.maxTurns || Date.now() >= Date.parse(task.deadlineAt)) {
          stopReason = { code: 'BUDGET_EXCEEDED', message: 'Harness 达到原生模型步骤预算或截止时间。' };
          agent.cancel({ kind: 'hook', reason: 'collaboration-budget' });
          return { kind: 'reject' };
        }
        return next();
      });
      agentCtx.on('approval/request', async request => {
        stopForHuman('needs_approval', { nativeSessionId: agent.id, toolName: request.toolName, reason: request.reason, requestId: request.id });
        return 'cancelled';
      });
      agentCtx.on('user-questions/request', async request => {
        stopForHuman('needs_input', { nativeSessionId: agent.id, questions: request.questions });
        throw new Error('A human answer is required.');
      });
      // Native file tools are enough for the first implementation/review loop.
      // Restriction hides existing broad tools; the monotonic guard also blocks
      // later scoped registrations (for example a user-configured MCP plugin).
      const allowed = new Set(allowedTools(task.permission));
      agentCtx.tools.restrict({ allow: ctx.tools.schemas().map(tool => tool.name).filter(name => allowed.has(name)) });
      agentCtx.tools.guard(exec => allowed.has(exec.name) ? undefined : 'Only the delegated native file tools are available; shell, MCP, web, jobs and delegation are disabled.');
    };
    try {
      handle = task.nativeSessionId
        ? await ctx.agents.resume({ resumeSessionId: task.nativeSessionId, agentOptions: selection, setup })
        : await ctx.agents.create({ sessionId: `collaboration-${randomUUID()}`, meta: { cwd: task.workspace, delegationDepth: 1 }, agentOptions: selection, setup });
    } catch (error) {
      const conflict = resumeOwnershipFailure(error, task.nativeSessionId);
      if (!conflict) throw error;
      // The native single-writer guard covers both a live GUI Agent and another
      // SDK process. A cold history subscription can activate the GUI Agent and
      // keep ownership after the tab closes. Never steal or delete its lock.
      await send({ type: 'state', state: 'needs_input', data: { nativeSessionId: task.nativeSessionId, code: conflict.code, reason: conflict.message, promptDispatched: false } });
      throw Object.assign(new Error(conflict.message), { code: conflict.code });
    }
    const agent = handle.agent;
    await agent.whenIdle();
    if (stopping) return;
    if (task.nativeSessionId && (agent.inbox.nextTurn.length || agent.inbox.nextStep.length)) {
      await send({ type: 'state', state: 'needs_input', data: { nativeSessionId: agent.id, reason: 'Resumed session contains pending input; inspect it before retrying side effects.' } });
      throw new Error('Native session contains pending input; automatic replay refused.');
    }
    const firstSeq = agent.session.seq;
    const eventDisposer = ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return;
      void send({ type: 'event', event: 'native_event', data: { nativeSessionId: agent.id, event } });
    });
    try {
      // The parent must persist the native ID before a side-effecting prompt is admitted.
      const checkpoint = new Promise(resolve => { pendingCheckpoint = resolve; });
      await ctx.sessions.flush(agent.session);
      await send({ type: 'checkpoint', data: { nativeSessionId: String(agent.id), nativeStartSeq: firstSeq } });
      await checkpoint; pendingCheckpoint = undefined;
      if (stopping) return;
      deadline = setTimeout(() => { stopReason = { code: 'DEADLINE_EXCEEDED', message: 'Harness 任务已达到截止时间。' }; agent.cancel({ kind: 'hook', reason: 'collaboration-deadline' }); }, Math.min(2147483647, Math.max(1, Date.parse(task.deadlineAt) - Date.now())));
      agent.followup(createUserMessage({ content: [{ type: 'text', text: task.prompt }], source: { kind: 'user' } }));
      await agent.whenIdle();
      await ctx.sessions.flush(agent.session);
      const outcome = summarize(agent.session, firstSeq);
      if (stopReason?.state) {
        await send({ type: 'result', data: { summary: stopReason.state === 'needs_approval' ? 'Harness 请求人工审批；原生执行已停止。' : 'Harness 需要人工输入；原生执行已停止。', nativeSessionId: String(agent.id), unfinished: [stopReason.state] } });
      } else if (stopReason?.code) await send({ type: 'error', ...stopReason });
      else if (outcome.reason?.kind !== 'completed') await send({ type: 'error', code: outcome.reason?.error?.code || 'HARNESS_INCOMPLETE', message: outcome.reason?.error ? safeMessage(outcome.reason.error) : `Harness turn ended: ${outcome.reason?.kind || 'unknown'}` });
      else await send({ type: 'result', data: { summary: outcome.summary, nativeSessionId: String(agent.id), tests: [], artifacts: [], unfinished: [] } });
    } finally { clearTimeout(deadline); eventDisposer(); }
  }
  function receive(message) {
    if (message?.type === 'checkpoint-ack') pendingCheckpoint?.();
    else if (message?.type === 'cancel') cancel();
    else if (message?.type === 'shutdown') void shutdown();
    else if (message?.type === 'run') execution = run(message.task).catch(error => send({ type: 'error', code: error.code || 'HARNESS_FAILED', message: safeMessage(error) }));
  }
  process.on('message', receive);
  process.once('disconnect', shutdown);
  ctx.effect(() => () => { process.removeListener('message', receive); process.removeListener('disconnect', shutdown); clearTimeout(deadline); });
  // Defer until this plugin's apply returned; awaiting loader inside apply deadlocks.
  setImmediate(async () => {
    try {
      await ctx.get('loader')?.await();
      const selection = ctx.agentDefaultModel.currentSelection();
      await ctx.llm.resolveCallConfig(selection);
      await send({ type: 'ready', data: { provider: selection.provider, model: selection.model, credentials: 'not-validated', nativeProtocol: 'Cordis AgentRegistry', modelRequestStarted: false } });
    } catch (error) { await send({ type: 'error', code: error.code || 'HARNESS_CONFIG_INVALID', message: safeMessage(error) }); }
  });
};
exports.modelSelection = modelSelection;
exports.summarize = summarize;
exports.allowedTools = allowedTools;
exports.resumeOwnershipFailure = resumeOwnershipFailure;

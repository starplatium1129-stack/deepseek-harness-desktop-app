const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

// Upstream-specific adaptation stays here. No raw messages or tool output cross IPC.
function summarizeSession(snapshot, derive, clean = value => value) {
  const events = snapshot.events.slice(snapshot.inheritedEventCount || 0);
  const title = snapshot.events.findLast(event => event.type === 'session/title')?.data?.title;
  const turns = [];
  let current;
  for (const event of events) {
    if (event.type === 'turn/start') {
      if (current) turns.push(finish(current));
      current = { turn: event.data.turn, startedAt: event.time, events: [] };
    }
    if (!current) continue;
    current.events.push(event);
    if (event.type === 'turn/end') { turns.push(finish(current)); current = undefined; }
  }
  if (current) turns.push(finish(current));
  function finish(turn) {
    const end = turn.events.findLast(event => event.type === 'turn/end');
    let usage;
    try { if (end) usage = derive(turn.events); } catch { /* Unknown upstream format is not zero usage. */ }
    const routes = usage?.routes || [];
    return {
      turn: turn.turn, startedAt: turn.startedAt, endedAt: end?.time ?? null,
      status: end?.data?.reason?.kind || 'running',
      durationMs: end ? Math.max(0, end.time - turn.startedAt) : null,
      steps: turn.events.filter(event => event.type === 'step/start').length,
      retries: turn.events.filter(event => event.type === 'llm/retry-started').length,
      model: routes.length === 1 ? clean(`${routes[0].provider} / ${routes[0].model}`).slice(0, 160) : routes.length > 1 ? '多模型（未拆分）' : '模型未上报',
      usage: usage ? Object.fromEntries(['uncachedInputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
        .filter(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0).map(key => [key, usage[key]])) : null,
    };
  }
  return {
    id: snapshot.session.id,
    title: clean(typeof title === 'string' ? title : '未命名会话').slice(0, 160),
    parentId: snapshot.session.parentSession || null,
    turns,
  };
}

async function collectUsage(query, derive, { signal, clean, maxSessions = 1000, maxTurns = 20000 } = {}) {
  const records = await query.listSessions(signal);
  const sessions = [];
  let unavailable = 0, omitted = Math.max(0, records.length - maxSessions), count = 0;
  for (const record of records.slice(0, maxSessions)) {
    signal?.throwIfAborted();
    let observation;
    try {
      observation = await query.observeSession(record.header.id, { signal, projectionMode: 'none' });
      const summary = summarizeSession({ session: observation.header, inheritedEventCount: observation.inheritedEventCount, events: observation.events }, derive, clean);
      if (count + summary.turns.length > maxTurns) { omitted++; continue; }
      count += summary.turns.length;
      sessions.push(summary);
    } catch (error) {
      signal?.throwIfAborted(); unavailable++;
    } finally { observation?.[Symbol.dispose](); }
    // Give the model stream and interactive service a chance to run between sessions.
    await new Promise(resolve => setImmediate(resolve));
  }
  return { collectedAt: Date.now(), sessions, unavailable, omitted, totalSessions: records.length };
}

function registerUsage(ctx, config, transport = process) {
  const requireUpstream = createRequire(path.join(config.runtimeRoot, 'package.json'));
  let fold, active;
  const listener = async message => {
    if (message?.type === 'desktop:usage-cancel') { if (active?.id === message.id) active.controller.abort(); return; }
    if (message?.type !== 'desktop:usage-query' || !/^[a-f0-9-]{36}$/.test(message.id || '') || active) return;
    const request = active = { id: message.id, controller: new AbortController() };
    const timer = setTimeout(() => request.controller.abort(), 55000);
    const reply = data => { if (transport.connected) { try { transport.send({ type: 'desktop:usage-result', id: message.id, ...data }, () => {}); } catch {} } };
    try {
      fold ||= (await import(pathToFileURL(requireUpstream.resolve('@deepseek-ai/dsh-token-meter/client')).href)).deriveTurnTokenUsage;
      if (!ctx.sessionQuery || typeof fold !== 'function') throw Error('unsupported');
      const { redact } = require('./usage-redact.cjs');
      const snapshot = await collectUsage(ctx.sessionQuery, fold, { signal: request.controller.signal, clean: redact });
      reply({ snapshot });
    } catch (error) {
      const { redact } = require('./usage-redact.cjs');
      ctx.logger?.warn(`桌面用量读取失败：${redact(error.message).slice(0, 500)}`);
      reply({ error: request.controller.signal.aborted ? '统计读取超时，请稍后重试。' : '当前核心无法读取用量统计。请查看核心版本或重试。' });
    }
    finally { clearTimeout(timer); if (active === request) active = undefined; }
  };
  transport.on('message', listener);
  ctx.on('dispose', () => { active?.controller.abort(); transport.removeListener('message', listener); });
}
module.exports = { summarizeSession, collectUsage, registerUsage };

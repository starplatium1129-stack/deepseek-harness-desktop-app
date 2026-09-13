// Adapter for Harness 0.1.5-rc.1 session events. Never send conversation content.
function registerTaskNotifications(ctx, transport = process) {
  const seen = new WeakMap();
  return ctx.on('session/event', (session, event) => {
    if (session.header?.parentSession || event?.type !== 'turn/end' || event.data?.reason?.kind !== 'completed') return;
    const turn = event.data.turn;
    if (!Number.isSafeInteger(turn) || turn < 0 || (seen.get(session) ?? -1) >= turn) return;
    seen.set(session, turn);
    if (!transport.connected || typeof transport.send !== 'function') return;
    try { transport.send({ type: 'desktop:task-completed' }, () => {}); } catch { /* Notification cannot fail a task. */ }
  });
}
module.exports = { registerTaskNotifications };

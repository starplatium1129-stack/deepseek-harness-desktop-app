const { setTimeout: delay } = require('node:timers/promises');

function isRegionFailure(reason) {
  if (reason?.kind !== 'error') return false;
  const failure = reason.failure;
  if (!failure || (failure.status !== undefined && failure.status !== 400)) return false;
  return /User location is not supported for the API use\.?/i.test(failure.message || '') &&
    /FAILED_PRECONDITION/.test(failure.message || '');
}

// Retry only a rejected request that has produced no stream events at all.
// Treat even reasoning/tool/empty block starts as output: downstream consumers
// must never see duplicated blocks or have already observed work replayed.
async function* retryRegionStream(next, options = {}) {
  const { signal, notify = () => {}, wait = delay } = options;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw signal.reason;
    let emitted = false, retry = false;
    for await (const chunk of next()) {
      if (!emitted && attempt < 2 && isRegionFailure(chunk.reason) && chunk.type === 'finish' && !signal?.aborted) {
        retry = true;
        break;
      }
      emitted = true;
      yield chunk;
    }
    if (!retry) return;
    const delayMs = (attempt + 1) * 1000;
    notify({ retry: attempt + 1, maxRetries: 2, delayMs });
    await wait(delayMs, undefined, { signal });
  }
}
module.exports = { isRegionFailure, retryRegionStream };

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { retryRegionStream } = require('../integrations/region-retry.cjs');
const { parseSearchResult } = require('../integrations/exa-search.cjs');
const region = () => ({ type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_REQUEST', status: 400, message: '400: {"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}' } } });
const collect = async stream => { const chunks = []; for await (const item of stream) chunks.push(item); return chunks; };
test('region failure retries twice and yields only successful attempt', async () => {
  let calls = 0; const notices = [];
  const chunks = await collect(retryRegionStream(async function* () { if (++calls <= 2) yield region(); else { yield { type: 'text-delta', text: 'ok' }; yield { type: 'finish', reason: { kind: 'stop' } }; } }, { wait: async () => {}, notify: notice => notices.push(notice) }));
  assert.equal(calls, 3); assert.equal(notices.length, 2); assert.equal(chunks.length, 2); assert.equal(chunks[0].text, 'ok');
});
test('persistent region failure stops after three total attempts', async () => {
  let calls = 0;
  const chunks = await collect(retryRegionStream(async function* () { calls++; yield region(); }, { wait: async () => {} }));
  assert.equal(calls, 3); assert.deepEqual(chunks, [region()]);
});
for (const first of [{ type: 'text-delta', text: 'partial' }, { type: 'reasoning-delta', text: 'thinking' }, { type: 'tool-call-delta', id: 'one', argumentsDelta: '{}' }, { type: 'block-start', blockType: 'text', index: 0 }, { type: 'usage', usage: { input: 1 } }]) {
  test(`does not replay after ${first.type}`, async () => {
    let calls = 0;
    const chunks = await collect(retryRegionStream(async function* () { calls++; yield first; yield region(); }, { wait: async () => {} }));
    assert.equal(calls, 1); assert.deepEqual(chunks, [first, region()]);
  });
}
test('other 400, quota, server and authorization failures are not retried here', async () => {
  for (const failure of [{ status: 400, message: 'invalid messages' }, { status: 429, message: 'quota' }, { status: 500, message: 'server' }, { status: 403, message: region().reason.failure.message }]) {
    let calls = 0;
    await collect(retryRegionStream(async function* () { calls++; yield { type: 'finish', reason: { kind: 'error', failure } }; }, { wait: async () => {} }));
    assert.equal(calls, 1);
  }
});
test('cancel during backoff does not dispatch another request', async () => {
  const controller = new AbortController(); let calls = 0;
  const stream = retryRegionStream(async function* () { calls++; yield region(); }, { signal: controller.signal, notify: () => controller.abort(new Error('cancelled')) });
  await assert.rejects(collect(stream), /aborted|cancelled/i); assert.equal(calls, 1);
});
test('cancellation before first attempt sends no request', async () => {
  const controller = new AbortController(); controller.abort(new Error('cancelled')); let calls = 0;
  await assert.rejects(collect(retryRegionStream(async function* () { calls++; }, { signal: controller.signal })), /cancelled/); assert.equal(calls, 0);
});
test('search parses citations, rejects unsafe URLs and caps results', () => {
  const result = parseSearchResult({ content: [{ type: 'text', text: 'Title: A\nURL: https://example.com/a\nPublished: 2026-09-13\nHighlights:\nUseful snippet\n\n---\n\nTitle: B\nURL: https://example.com/b\nHighlights:\nOther snippet\n\n---\n\nTitle: Bad\nURL: javascript:alert(1)' }] }, 1);
  assert.equal(result.sources.length, 1); assert.equal(result.sources[0].url, 'https://example.com/a'); assert.equal(result.truncated, true);
});
test('search exposes provider failure, not fabricated empty results', () => {
  assert.throws(() => parseSearchResult({ isError: true, content: [] }, 3), /不可用/);
  assert.throws(() => parseSearchResult({ content: [{ type: 'text', text: 'unexpected response' }] }, 3), /无法解析/);
  assert.deepEqual(parseSearchResult({ content: [{ type: 'text', text: 'No results found.' }] }, 3), { sources: [], truncated: false });
});

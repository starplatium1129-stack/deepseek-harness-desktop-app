const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { prepareIntegrationPatch } = require('../src/integrations.cjs');
const { redact } = require('../src/runtime.cjs');
const root = path.resolve(__dirname, '..');
const runtimeResources = process.env.DSH_SMOKE_RESOURCES || path.join(root, 'runtime');
const runtimeRoot = path.join(runtimeResources, 'harness');
const home = path.join(root, '.test-data', `integrations-${Date.now()}`);
const output = process.stdout.write.bind(process.stdout);
process.stdout.write = (value, ...args) => output(redact(String(value)), ...args);
async function main() {
  await fs.mkdir(home, { recursive: true });
  process.env.DSH_HOME = home; delete process.env.DEEPSEEK_API_KEY; process.chdir(home);
  const patch = await prepareIntegrationPatch(runtimeResources, runtimeRoot, home);
  assert.ok(patch, 'Desktop integrations must be packaged');
  const modules = path.join(runtimeRoot, 'node_modules/@deepseek-ai');
  const binDir = path.join(modules, 'dsh/lib');
  const bin = await fs.readFile(path.join(binDir, 'bin.js'), 'utf8');
  const bootFile = bin.match(/import\("\.\/(profile-boot-[^"/]+\.js)"\)/)?.[1];
  if (!bootFile) throw new Error('Upstream boot adapter changed; review compatibility.');
  const { runProfile } = await import(pathToFileURL(path.join(binDir, bootFile)).href);
  const { loadLayeredEnv } = await import(pathToFileURL(path.join(modules, 'dsh-app-boot/lib/index.js')).href);
  const { LlmAdapter, createUserMessage } = await import(pathToFileURL(path.join(modules, 'dsh-llm/lib/index.js')).href);
  const { ctx, shutdown } = await runProfile({ environment: loadLayeredEnv('dsh'), profile: 'web', patchFiles: [patch], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] });
  try {
    let attempts = 0, observers = 0;
    class ProbeAdapter extends LlmAdapter {
      async resolveModel(provider, id) { return { provider, id, name: 'Retry probe', inputModalities: ['text'] }; }
      async *stream() {
        if (++attempts <= 2) yield { type: 'finish', reason: { kind: 'error', failure: { status: 400, code: 'INVALID_REQUEST', message: 'User location is not supported for the API use. FAILED_PRECONDITION' } } };
        else { yield { type: 'text-delta', index: 0, text: 'recovered' }; yield { type: 'finish', reason: { kind: 'stop' } }; }
      }
    }
    ctx.llm.registerAdapter(['desktop-probe'], new ProbeAdapter());
    ctx.on('llm/stream', (_options, next) => { observers++; return next(); });
    const chunks = [];
    for await (const chunk of ctx.llm.stream({ provider: 'desktop-probe', model: 'probe', messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'test' }] })], signal: AbortSignal.timeout(15000) })) chunks.push(chunk);
    assert.equal(attempts, 3); assert.equal(observers, 3); assert.equal(chunks[0].text, 'recovered');
    console.log('Native middleware: two retries; every attempt passes downstream observers.');
    assert.equal((await ctx.credentials.describe('DEEPSEEK_API_KEY')).configured, false);
    if (!process.argv.includes('--offline')) {
      const handle = await ctx.agents.create({ sessionId: require('node:crypto').randomUUID(), meta: { cwd: home, agentPreset: 'standard' }, agentOptions: { provider: 'desktop-probe', model: 'probe' }, setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'standard'); } });
      const tool = await ctx.tools.execute({ callId: 'desktop-search-smoke', name: 'web_search', agent: handle.agent, arguments: { queries: ['DeepSeek Harness GitHub documentation'] }, signal: AbortSignal.timeout(30000) });
      if (tool.isError) throw new Error(JSON.stringify(tool.content));
      const text = JSON.stringify(tool);
      assert.match(text, /https:\/\/github.com\/deepseek-ai\/deepseek-harness/);
      console.log('Native web_search returns real citations without a DeepSeek API key.');
    }
  } finally { await shutdown.shutdown(0); }
}
main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });

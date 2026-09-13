// Isolated end-to-end fixture: actual Harness sessions, deterministic local LLM, no API call.
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { prepareIntegrationPatch } = require('../src/integrations.cjs');
const { collectUsage } = require('../integrations/usage.cjs');
const { redact } = require('../src/runtime.cjs');
const root = path.resolve(__dirname, '..');
async function main() {
  const data = process.argv[2];
  if (!path.isAbsolute(data || '') || !path.basename(data).startsWith('dsh-usage-test-')) throw Error('Fixture directory required');
  const home = path.join(data, 'harness-home'); await fs.mkdir(home, { recursive: true });
  process.env.DSH_HOME = home; delete process.env.DEEPSEEK_API_KEY; process.chdir(home);
  const resources = path.join(root, 'runtime'), runtimeRoot = path.join(resources, 'harness');
  const patch = await prepareIntegrationPatch(resources, runtimeRoot, home);
  const modules = path.join(runtimeRoot, 'node_modules/@deepseek-ai');
  const binDir = path.join(modules, 'dsh/lib');
  const bin = await fs.readFile(path.join(binDir, 'bin.js'), 'utf8');
  const bootFile = bin.match(/import\("\.\/(profile-boot-[^"/]+\.js)"\)/)?.[1];
  if (!bootFile) throw Error('Upstream boot changed');
  const { runProfile } = await import(pathToFileURL(path.join(binDir, bootFile)).href);
  const { loadLayeredEnv } = await import(pathToFileURL(path.join(modules, 'dsh-app-boot/lib/index.js')).href);
  const { LlmAdapter, createUserMessage } = await import(pathToFileURL(path.join(modules, 'dsh-llm/lib/index.js')).href);
  const { deriveTurnTokenUsage } = await import(pathToFileURL(path.join(modules, 'dsh-token-meter/lib/types/client.js')).href);
  const { ctx, shutdown } = await runProfile({ environment: loadLayeredEnv('dsh'), profile: 'web', patchFiles: [patch], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] });
  try {
    await ctx.get('loader').await();
    class Probe extends LlmAdapter {
      async resolveModel(provider, id) { return { provider, id, name: 'Local usage fixture', inputModalities: ['text'] }; }
      async *stream() {
        yield { type: 'text-delta', index: 0, text: '这是独立验收数据，不是实际模型调用。' };
        yield { type: 'usage', usage: { inputTokens: 1200, cacheReadTokens: 2400, cacheWriteTokens: 0, outputTokens: 600, reasoningTokens: 100, totalTokens: 4200 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    ctx.llm.registerAdapter(['desktop-usage-test'], new Probe());
    // For this test all LLM traffic, including optional background title calls, stays local.
    ctx.on('llm/stream', () => new Probe().stream());
    const ids = [];
    for (const [index, title] of ['完成提醒与交互完善（验收样本）', '用量统计界面设计（验收样本）', '<img src=x onerror=alert(1)>（安全验收）'].entries()) {
      const handle = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: home, agentPreset: 'standard' }, agentOptions: { provider: 'desktop-usage-test', model: index === 1 ? 'design-model' : 'code-model' }, setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'standard'); } });
      const agent = handle.agent;
      agent.session.append('session/title', { title, messageSeqs: [], source: { kind: 'user' } });
      for (let n = 0; n <= index; n++) { agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '本地统计验收' }] })); await agent.whenIdle(); }
      await ctx.sessions.flush(agent.session); ids.push(agent.id);
    }
    const snapshot = await collectUsage(ctx.sessionQuery, deriveTurnTokenUsage);
    assert.equal(snapshot.unavailable, 0);
    const total = snapshot.sessions.flatMap(s => s.turns).reduce((sum, t) => sum + (t.usage?.totalTokens || 0), 0);
    assert.equal(total, 25200, JSON.stringify(snapshot));
    await fs.writeFile(path.join(data, 'fixture.json'), JSON.stringify({ ids, total }));
  } finally { await shutdown.shutdown(0); }
}
main().catch(error => { console.error(redact(error.stack || error.message)); process.exitCode = 1; });

const { createRequire } = require('node:module');
const path = require('node:path');

const EXA_ENDPOINT = 'https://mcp.exa.ai/mcp?tools=web_search_exa';
function safeUrl(value) {
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : undefined; } catch { return undefined; }
}
function parseSearchResult(result, maxResults) {
  if (result.isError || result.error) throw new Error('Exa 搜索暂时不可用或免费额度已达到限制，请稍后重试。');
  const text = (result.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n\n').slice(0, 200000);
  const sources = [], seen = new Set();
  const add = source => {
    const url = safeUrl(source.url);
    if (!url || seen.has(url)) return;
    seen.add(url);
    sources.push({ url, ...(source.title ? { title: String(source.title).slice(0, 500) } : {}), ...(source.snippet ? { snippet: String(source.snippet).slice(0, 1800) } : {}), ...(source.publishedAt && source.publishedAt !== 'N/A' ? { publishedAt: String(source.publishedAt).slice(0, 100) } : {}) });
  };
  const structured = result.structuredContent?.results || result.structuredContent?.sources;
  if (Array.isArray(structured)) for (const item of structured) add({ ...item, snippet: item.snippet || item.highlights?.join('\n'), publishedAt: item.publishedAt || item.publishedDate });
  if (!sources.length) for (const section of text.split(/\n\s*---\s*\n/)) {
    const header = section.match(/^\s*Title:\s*([^\n]*)\r?\nURL:\s*(\S+)/);
    if (!header) continue;
    const snippet = section.match(/(?:Highlights|Text|Content):\s*\n?([\s\S]*)/)?.[1];
    add({ title: header[1].trim(), url: header[2], snippet, publishedAt: section.match(/^Published(?: Date)?:\s*([^\n]+)/m)?.[1]?.trim() });
  }
  if (!sources.length && !/no (?:search )?results|no (?:relevant )?(?:pages|matches|documents) (?:found|available)/i.test(text)) throw new Error('Exa 返回格式无法解析，未生成未经验证的引用。');
  return { sources: sources.slice(0, maxResults), truncated: sources.length > maxResults };
}

class ExaSearchProvider {
  id = 'desktop-exa';
  constructor(runtimeRoot) {
    this.load = createRequire(path.join(runtimeRoot, 'package.json'));
    // Fail a staged core's startup check if it drops the shared MCP interface.
    this.load.resolve('@modelcontextprotocol/sdk/client/index.js');
    this.load.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js');
  }
  available() { return true; }
  async search(request, signal) {
    const { Client } = this.load('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = this.load('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const count = Math.max(1, Math.min(8, request.maxResults || 8));
    const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(25000)]);
    bounded.throwIfAborted();
    const client = new Client({ name: 'deepseek-harness-desktop-search', version: '0.1.1' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(EXA_ENDPOINT));
    const cancel = () => { void client.close().catch(() => {}); };
    bounded.addEventListener('abort', cancel, { once: true });
    try {
      await client.connect(transport, { timeout: 12000, signal: bounded });
      bounded.throwIfAborted();
      const result = await client.callTool({ name: 'web_search_exa', arguments: { query: request.query, objective: 'Find relevant, reliable source pages for this query, with useful excerpts and original source URLs.', numResults: count } }, undefined, { timeout: 20000, signal: bounded });
      bounded.throwIfAborted();
      return parseSearchResult(result, count);
    } catch (error) {
      if (bounded.aborted) throw bounded.reason;
      // Never forward protocol headers or transport secrets to model-visible errors.
      const message = /无法解析|暂时不可用/.test(error.message || '') ? error.message : 'Exa 搜索连接失败或被限流；请检查网络并稍后重试。此搜索不使用 DeepSeek 额度。';
      throw new Error(message);
    } finally { bounded.removeEventListener('abort', cancel); await client.close().catch(() => {}); }
  }
}
module.exports = { EXA_ENDPOINT, ExaSearchProvider, parseSearchResult };

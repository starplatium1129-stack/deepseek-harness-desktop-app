const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { validate } = require('./usage-pricing.js');
const URL = 'https://models.dev/api.json';
const SIX_HOURS = 6 * 60 * 60 * 1000;
const LIMIT = 20 * 1024 * 1024;
const canonicalProviders = ['openai', 'anthropic', 'google', 'deepseek', 'moonshotai', 'minimax', 'minimax-cn', 'zhipuai', 'alibaba', 'xai', 'mistral'];
function price(value) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if ((typeof value !== 'string' && typeof value !== 'number') || value === '' || !Number.isFinite(number) || number < 0 || number > 100000) throw Error('价格数据含有无效单价');
  if (number > 0 && number < 0.000001) return null;
  return number.toFixed(6).replace(/\.?0+$/, '') || '0';
}
function entry(model, cost, basis) {
  return { ...validate([{ model, input: price(cost.input), output: price(cost.output), cacheRead: price(cost.cache_read), cacheWrite: price(cost.cache_write) }])[0], basis };
}
function parseCcSwitch(data) {
  if (data?.version !== 1 || !Array.isArray(data.models) || data.models.length > 20000) throw Error('cc-switch 价格文件格式不兼容');
  const deleted = new Set(data.deletedModelIds || []), rows = new Map();
  for (const item of data.models) {
    if (typeof item.modelId !== 'string' || !item.modelId.trim()) throw Error('cc-switch 模型标识无效');
    if (deleted.has(item.modelId)) continue;
    const row = entry(`* / ${item.modelId}`, { input: item.inputCostPerMillion, output: item.outputCostPerMillion, cache_read: item.cacheReadCostPerMillion, cache_write: item.cacheCreationCostPerMillion }, 'cc-switch 本地价格 · 按模型 ID 参考');
    rows.set(row.model, row);
  }
  return [...rows.values()];
}
function parseModelsDev(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('在线价格库格式不兼容');
  const rows = new Map(), canonical = new Map();
  for (const [providerId, provider] of Object.entries(data)) {
    if (!provider || typeof provider.models !== 'object' || Array.isArray(provider.models)) continue;
    for (const [id, model] of Object.entries(provider.models || {})) {
      const cost = model?.cost;
      if (!cost || (cost.input === undefined && cost.output === undefined)) continue;
      if (model.modalities?.output?.some(m => m !== 'text')) continue;
      const key = `${providerId} / ${id}`;
      if (key.length > 160) continue;
      // Do not treat token tiers or non-token charges as a flat price.
      if (Object.keys(cost).some(k => !['input', 'output', 'cache_read', 'cache_write', 'reasoning'].includes(k))) continue;
      if (cost.reasoning !== undefined && cost.reasoning !== cost.output) continue;
      const row = entry(key, cost, `models.dev · ${providerId} 参考价`);
      rows.set(key, row);
      if (canonicalProviders.includes(providerId)) {
        const previous = canonical.get(id);
        if (!previous || canonicalProviders.indexOf(providerId) < previous.priority) canonical.set(id, { row, priority: canonicalProviders.indexOf(providerId) });
      }
      if (rows.size > 20000) throw Error('在线模型数量超过读取范围');
    }
  }
  for (const [id, { row }] of canonical) rows.set(`* / ${id}`, { ...row, model: `* / ${id}`, basis: `${row.basis} · 按模型 ID 匹配` });
  if (!rows.size) throw Error('在线价格库没有可用的文本模型价格');
  return [...rows.values()];
}
async function readBounded(file) {
  const stat = await fs.stat(file); if (stat.size > LIMIT) throw Error('价格文件超过 20 MB');
  return { data: JSON.parse(await fs.readFile(file, 'utf8')), mtime: stat.mtimeMs };
}
async function atomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(data)); await fs.rename(`${file}.tmp`, file);
}
class PriceCatalog {
  constructor(data, options = {}) {
    this.file = path.join(data, 'usage-price-catalog.json'); this.configFile = path.join(data, 'usage-price-sync.json');
    this.ccPath = options.ccPath || path.join(os.homedir(), '.cc-switch', 'model-pricing.json');
    this.fetch = options.fetch || globalThis.fetch;
    this.rows = []; this.config = { source: 'models.dev', auto: true }; this.lastSyncAt = null; this.lastError = null; this.lastAttempt = 0;
  }
  async load() {
    return this.loaded ||= (async () => {
      try { const { data } = await readBounded(this.configFile); this.checkConfig(data); this.config = data; }
      catch (e) {
        if (e.code === 'ENOENT') { try { await fs.access(this.ccPath); this.config.source = 'cc-switch'; } catch {} }
        else { this.config.auto = false; this.lastError = '同步设置无法读取，请重新选择价格来源。'; }
      }
      try {
        const { data } = await readBounded(this.file);
        if (data.version !== 1 || !Array.isArray(data.rows) || data.rows.length > 30000) throw Error('schema');
        this.rows = data.rows.map(row => ({ ...validate([row])[0], basis: typeof row.basis === 'string' ? row.basis.slice(0, 160) : '缓存参考价' }));
        this.lastSyncAt = data.lastSyncAt; this.cachedSource = data.source; this.sourceMtime = data.sourceMtime;
      } catch (e) { if (e.code !== 'ENOENT') this.lastError = '价格缓存无法读取，请重新同步。'; }
    })();
  }
  checkConfig(value) { if (!value || Object.keys(value).some(k => !['source', 'auto'].includes(k)) || !['models.dev', 'cc-switch'].includes(value.source) || typeof value.auto !== 'boolean') throw Error('无效的价格同步设置'); }
  async configure(value) { this.checkConfig(value); await this.load(); await atomic(this.configFile, value); this.config = { ...value }; this.lastAttempt = 0; }
  async read() { await this.load(); return { rows: this.rows, status: { ...this.config, lastSyncAt: this.lastSyncAt, cachedSource: this.cachedSource || null, count: this.rows.length, lastError: this.lastError, syncing: !!this.inflight } }; }
  async sync(force = false) {
    await this.load();
    if (this.inflight) {
      if (this.inflightSource === this.config.source) return this.inflight;
      await this.inflight; return this.sync(force);
    }
    const changed = this.config.source !== this.cachedSource;
    if (!force && (!this.config.auto || Date.now() - this.lastAttempt < 30000)) return this.read();
    if (!force && !changed && this.config.source === 'models.dev' && this.lastSyncAt && Date.now() - this.lastSyncAt < SIX_HOURS) return this.read();
    if (!force && this.config.source === 'models.dev' && Date.now() - this.lastAttempt < 300000) return this.read();
    this.inflightSource = this.config.source;
    this.inflight = this.performSync(force, changed).finally(() => { this.inflight = null; });
    return this.inflight;
  }
  async performSync(force, changed) {
    const source = this.config.source; this.lastAttempt = Date.now();
    try {
      let rows, sourceMtime = null;
      if (source === 'cc-switch') {
        const stat = await fs.stat(this.ccPath);
        if (!force && !changed && this.sourceMtime === stat.mtimeMs) return this.read();
        const read = await readBounded(this.ccPath); sourceMtime = read.mtime; rows = parseCcSwitch(read.data);
      } else {
        const response = await this.fetch(URL, { signal: AbortSignal.timeout(20000), redirect: 'error' });
        if (!response.ok) throw Error(`在线价格服务返回 HTTP ${response.status}`);
        if (Number(response.headers.get('content-length')) > LIMIT) throw Error('在线价格数据超过 20 MB');
        let length = 0; const chunks = [];
        for await (const chunk of response.body) { length += chunk.length; if (length > LIMIT) throw Error('在线价格数据超过 20 MB'); chunks.push(chunk); }
        rows = parseModelsDev(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      }
      if (this.config.source !== source) return this.read();
      const lastSyncAt = Date.now();
      await atomic(this.file, { version: 1, source, sourceMtime, lastSyncAt, rows });
      this.rows = rows; this.cachedSource = source; this.sourceMtime = sourceMtime; this.lastSyncAt = lastSyncAt; this.lastError = null;
    } catch (e) {
      this.lastError = source === 'cc-switch' ? `cc-switch 价格文件暂时无法同步（${e.code || e.message}），保留上次价格。` : '在线价格同步失败，保留上次价格；可稍后重试。';
    }
    return this.read();
  }
}
module.exports = { PriceCatalog, parseCcSwitch, parseModelsDev, price, URL };

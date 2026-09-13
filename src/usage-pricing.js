(function (root) {
  const fields = ['input', 'cacheRead', 'cacheWrite', 'output'];
  // USD per million tokens, dated reference rates, not a provider billing ledger.
  const defaults = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro'].map(model => ({
    model: `deepseek-official / ${model}`, input: model === 'deepseek-v4-pro' ? '1.32' : '0.3',
    cacheRead: model === 'deepseek-v4-pro' ? '0.044' : '0.006', cacheWrite: '0',
    output: model === 'deepseek-v4-pro' ? '3.96' : '1.2',
    basis: 'DeepSeek 官方高峰参考价 · 2026-09-13',
  }));
  function validate(rows) {
    if (!Array.isArray(rows) || rows.length > 2000) throw Error('价格表最多包含 2000 个模型。');
    const seen = new Set();
    return rows.map(row => {
      if (!row || typeof row.model !== 'string' || !row.model.trim() || row.model.length > 160 || seen.has(row.model) || Object.keys(row).some(k => !['model', 'basis', ...fields].includes(k))) throw Error('价格表包含无效或重复的模型。');
      seen.add(row.model);
      const result = { model: row.model, basis: '自定义固定单价' };
      for (const key of fields) {
        const value = row[key];
        if (value === null || value === '') { result[key] = null; continue; }
        if (typeof value !== 'string' || !/^(0|[1-9]\d{0,5})(\.\d{1,6})?$/.test(value) || Number(value) > 100000) throw Error('单价需为 0–100000 的数字，最多 6 位小数；留空表示未定价。');
        result[key] = value;
      }
      return result;
    });
  }
  function rateUnits(value) {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  }
  function resolveRate(model, rates) {
    const find = key => rates instanceof Map ? rates.get(key) : rates.find(r => r.model === key);
    const exact = find(model);
    if (exact && !exact.basis?.startsWith('DeepSeek 官方')) return exact;
    const split = model.indexOf(' / ');
    if (split < 0) return exact;
    const provider = model.slice(0, split), id = model.slice(split + 3);
    const alias = { 'deepseek-official': 'deepseek', 'google-generative-ai': 'google', 'openai-codex': 'openai' }[provider];
    return (alias && find(`${alias} / ${id}`)) || find(`* / ${id}`) || exact;
  }
  function estimate(turn, rates) {
    const u = turn.usage;
    if (!u) return { units: null, reason: '用量未确认' };
    const rate = resolveRate(turn.model, rates);
    if (!rate || ['多模型（未拆分）', '模型未上报'].includes(turn.model)) return { units: null, reason: '模型未定价' };
    const pairs = [['uncachedInputTokens', 'input'], ['cacheReadTokens', 'cacheRead'], ['cacheWriteTokens', 'cacheWrite'], ['outputTokens', 'output']];
    const counts = pairs.map(([key]) => u[key] ?? 0);
    if (!Number.isSafeInteger(u.totalTokens) || counts.some(n => !Number.isSafeInteger(n) || n < 0) || counts.reduce((a, b) => a + b, 0) !== u.totalTokens) return { units: null, reason: '用量分类不完整' };
    let units = 0n;
    const components = {};
    for (let i = 0; i < pairs.length; i++) {
      const key = pairs[i][1], count = counts[i];
      if (count > 0 && (rate[key] === null || rate[key] === undefined)) return { units: null, reason: '单价不完整' };
      const cost = count === 0 ? 0n : BigInt(count) * rateUnits(rate[key]);
      components[key] = cost.toString(); units += cost;
    }
    return { units: units.toString(), components, reason: '', basis: rate.basis };
  }
  function format(units) {
    if (units === null || units === undefined) return '未计价';
    const raw = BigInt(units);
    if (raw > 0n && raw < 1000000n) return '< $0.000001';
    const rounded = (raw + 500000n) / 1000000n;
    return `$${(rounded / 1000000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(rounded % 1000000n).toString().padStart(6, '0')}`;
  }
  const api = { defaults, validate, estimate, format, fields, resolveRate };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.UsagePricing = api;
})(typeof window === 'object' ? window : globalThis);

(function (root) {
  const Pricing = typeof module === 'object' && module.exports ? require('./usage-pricing.js') : root.UsagePricing;
  const number = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const dayKey = time => { const d = new Date(time); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  function aggregate(rows) {
    const known = rows.filter(row => row.usage && number(row.usage.totalTokens));
    const result = { total: 0, input: 0, cache: 0, output: 0, other: 0, duration: 0, known: known.length, unknown: rows.length - known.length, turns: rows.length, cacheRate: null, costUnits: '0', priced: 0, unpriced: 0 };
    let cost = 0n;
    for (const row of rows) {
      if (row.cost?.units !== null && row.cost?.units !== undefined) { cost += BigInt(row.cost.units); result.priced++; }
      else result.unpriced++;
    }
    result.costUnits = cost.toString();
    let prompt = 0, cacheComplete = known.length > 0;
    for (const row of rows) if (number(row.durationMs)) result.duration += row.durationMs;
    for (const { usage: u } of known) {
      result.total += u.totalTokens; result.input += u.uncachedInputTokens; result.output += u.outputTokens;
      result.cache += u.cacheReadTokens ?? 0;
      result.other += Math.max(0, u.totalTokens - u.uncachedInputTokens - u.outputTokens - (u.cacheReadTokens ?? 0));
      prompt += u.totalTokens - u.outputTokens;
      cacheComplete &&= number(u.cacheReadTokens);
    }
    if (cacheComplete && prompt > 0) result.cacheRate = result.cache / prompt;
    return result;
  }
  function build(snapshot, { days = 7, model = '', search = '', sort = 'recent', day = '', now = Date.now(), rates = [] } = {}) {
    const priceIndex = new Map(rates.map(rate => [rate.model, rate]));
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const start = new Date(today); start.setDate(start.getDate() - days + 1);
    const end = new Date(today); end.setDate(end.getDate() + 1);
    const allRows = [];
    const sessionsById = new Map((snapshot?.sessions || []).map(s => [s.id, s]));
    for (const session of snapshot?.sessions || []) for (const turn of session.turns) {
      const at = turn.endedAt ?? turn.startedAt;
      if (at >= start.getTime() && at < end.getTime()) allRows.push({ ...turn, cost: Pricing.estimate(turn, priceIndex), sessionId: session.id, title: session.title, parentId: session.parentId, at, day: dayKey(at) });
    }
    const models = [...new Set(allRows.map(row => row.model))].sort();
    const filtered = allRows.filter(row => !model || row.model === model);
    const daily = [];
    for (const date = new Date(start); date < end; date.setDate(date.getDate() + 1)) {
      const key = dayKey(date); daily.push({ day: key, ...aggregate(filtered.filter(row => row.day === key)) });
    }
    const rows = filtered.filter(row => !day || row.day === day);
    const distribution = [...new Set(rows.map(row => row.model))].map(name => ({ name, ...aggregate(rows.filter(row => row.model === name)) })).sort((a, b) => b.total - a.total);
    const ids = new Set(rows.map(row => row.sessionId));
    const sessions = [...ids].map(id => {
      const turns = rows.filter(row => row.sessionId === id).sort((a, b) => b.at - a.at);
      return { ...sessionsById.get(id), latest: turns[0].at, ...aggregate(turns), turns };
    }).filter(s => s.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
    sessions.sort(sort === 'cost' ? (a, b) => (BigInt(a.costUnits) > BigInt(b.costUnits) ? -1 : BigInt(a.costUnits) < BigInt(b.costUnits) ? 1 : b.latest - a.latest) : sort === 'tokens' ? (a, b) => b.total - a.total || b.latest - a.latest : (a, b) => b.latest - a.latest);
    return { ...aggregate(rows), sessionCount: ids.size, sessions, daily, models, distribution, day };
  }
  const api = { build, aggregate, dayKey };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.UsageModel = api;
})(typeof window === 'object' ? window : globalThis);

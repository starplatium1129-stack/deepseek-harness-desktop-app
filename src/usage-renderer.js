(() => {
  const $ = id => document.getElementById(id);
  const integer = new Intl.NumberFormat('zh-CN');
  const compact = value => value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}K` : integer.format(value);
  const duration = ms => ms >= 3600000 ? `${(ms / 3600000).toFixed(1)} 小时` : ms >= 60000 ? `${Math.round(ms / 60000)} 分钟` : `${Math.round(ms / 1000)} 秒`;
  const time = value => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const states = { completed: '已完成', running: '进行中', error: '失败', aborted: '已中止', blocked: '受阻', 'max-tokens': '达到输出上限' };
  let snapshot, busy = false, state = {}, error = '', priceError = '', priceState = { rates: [], overrides: [] }, limit = 30, refreshTimer;
  const options = { days: 7, model: '', search: '', sort: 'recent', day: '', rates: [] };
  const node = (tag, text, className) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
  const amount = item => !item.known && item.unknown ? '未知' : compact(item.total);
  const money = item => !item.priced && item.unpriced ? '未计价' : window.UsagePricing.format(item.costUnits);
  function feedback(data) {
    const parts = [];
    if (error) parts.push(`${error}${snapshot ? ' 当前保留上次读取结果。' : ''}`);
    else if (busy) parts.push('正在读取本地历史…');
    else if (!snapshot) parts.push(state.phase === 'ready' ? '点击刷新读取用量。' : 'Harness 就绪后即可读取统计。');
    else {
      if (snapshot.unavailable) parts.push(`${snapshot.unavailable} 个会话暂时无法读取`);
      if (snapshot.omitted) parts.push(`${snapshot.omitted} 个会话超过单次读取范围，当前统计不完整`);
      if (data?.unknown) parts.push(`${data.unknown} 轮进行中或用量未确认，未计入消耗总量`);
      if (data?.unpriced) parts.push(`${data.unpriced} 轮未计价，成本仅含已计价部分`);
      if (priceError) parts.push(priceError);
      if (priceState.sync?.lastError) parts.push(priceState.sync.lastError);
      if (!parts.length) parts.push('数据来自本地会话记录 · 不发送到外部服务');
    }
    $('usage-feedback').textContent = parts.join(' · ');
    $('usage-feedback').classList.toggle('warning', !!error || !!priceError || !!priceState.sync?.lastError || !!snapshot?.unavailable || !!snapshot?.omitted || !!data?.unknown || !!data?.unpriced);
  }
  const hiddenSeries = new Set();
  function renderChart(data) {
    window.UsageChart.render($('usage-chart'), $('usage-legend'), data, {
      hidden: hiddenSeries, selected: options.day,
      onSelect(point) {
        options.day = options.day === point.key ? '' : point.key; limit = 30; render();
        $('usage-chart').querySelector(`[data-point-key="${point.key}"]`)?.focus();
      },
      onToggle(key) {
        if (hiddenSeries.has(key)) hiddenSeries.delete(key); else hiddenSeries.add(key);
        renderChart(data); $('usage-legend').querySelector(`[data-series="${key}"]`)?.focus();
      },
    });
    $('usage-trend-note').textContent = data.hourly ? '当天按小时汇总 · 左轴 Token，右轴估算成本' : '按日期汇总 · 左轴 Token，右轴估算成本';
    $('usage-chart-detail').textContent = options.day ? `${data.trend.find(p => p.key === options.day)?.title || options.day} · 已筛选明细，再次点击恢复。` : '悬停查看分项，点击筛选明细；图例可开关。未知数据保留断点，成本为参考估算。';
  }
  function renderModels(data) {
    const host = $('usage-models'); host.replaceChildren();
    if (!data.distribution.length) { host.append(node('p', '暂无模型用量', 'empty-inline')); return; }
    for (const item of data.distribution) {
      const row = node('div', undefined, 'model-row');
      const heading = node('div', undefined, 'model-row-heading');
      const label = node('span', item.name); label.title = item.name;
      heading.append(label, node('b', amount(item)));
      const meter = node('meter'); meter.min = 0; meter.max = Math.max(1, data.total); meter.value = item.total; meter.setAttribute('aria-label', `${item.name} 消耗占比`);
      row.append(heading, meter, node('small', `${data.total ? (item.total / data.total * 100).toFixed(1) : '0'}% · ${item.turns} 轮${item.unknown ? ` · ${item.unknown} 轮未确认` : ''}`), node('small', `估算 ${money(item)}${item.unpriced && item.priced ? '（部分）' : ''}`, 'model-cost')); host.append(row);
    }
  }
  function renderSessions(data) {
    const host = $('usage-session-list');
    const opened = new Set([...host.querySelectorAll('details[open]')].map(n => n.dataset.id));
    host.replaceChildren(); $('usage-list-count').textContent = data.sessions.length;
    if (!data.sessions.length) {
      const empty = node('div', undefined, 'usage-empty');
      empty.append(node('span', '◷', 'empty-symbol'), node('h3', options.search ? '没有匹配的会话' : '这里会记录每一次投入'), node('p', options.search ? '换个关键词，或清除筛选。' : '完成一次 Harness 任务后，回到这里查看消耗。已有历史也会自动读取。'));
      host.append(empty);
    }
    for (const session of data.sessions.slice(0, limit)) {
      const details = node('details', undefined, 'usage-session'); details.dataset.id = session.id; details.open = opened.has(session.id);
      const summary = node('summary');
      const title = node('div', undefined, 'session-title');
      title.append(node('strong', session.title), node('small', `${session.parentId ? '分叉 / 子会话 · ' : ''}${time(session.latest)} · ${session.turns.length} 轮${session.unknown ? ` · ${session.unknown} 轮未确认` : ''}`));
      const amounts = node('span', undefined, 'session-amount');
      amounts.append(node('span', `${amount(session)}${session.known ? ' tok' : ''}`), node('small', `${money(session)}${session.unpriced && session.priced ? '（部分）' : ''}`));
      summary.append(title, amounts, node('span', '⌄', 'chevron')); details.append(summary);
      const panel = node('div', undefined, 'session-detail');
      const top = node('div', undefined, 'detail-top');
      top.append(node('span', `会话 ${session.id}`, 'session-id'));
      const open = node('button', '打开原会话 ↗');
      open.addEventListener('click', async () => { open.disabled = true; try { const result = await window.desktop.action('usage-open-session', session.id); if (result?.error) throw new Error(result.error); } catch (e) { error = e.message; feedback(data); } finally { open.disabled = false; } });
      top.append(open); panel.append(top);
      for (const turn of session.turns) {
        const row = node('div', undefined, 'turn-row');
        const line = node('div', undefined, 'turn-heading');
        line.append(node('b', `轮次 ${turn.turn}`), node('span', states[turn.status] || '已结束', `turn-state ${turn.status === 'completed' ? 'complete' : ''}`), node('span', time(turn.endedAt ?? turn.startedAt)), node('strong', turn.usage ? `${integer.format(turn.usage.totalTokens)} tok` : '用量未知'));
        row.append(line, node('p', `${turn.model} · ${turn.durationMs === null ? '执行中' : duration(turn.durationMs)} · ${turn.steps} 步${turn.retries ? ` · ${turn.retries} 次重试` : ''}`, 'turn-meta'));
        const costLine = node('p', turn.cost.units === null ? `未计价 · ${turn.cost.reason}` : `估算成本 ${window.UsagePricing.format(turn.cost.units)} · ${turn.cost.basis}`, 'turn-cost');
        if (turn.cost.components) costLine.title = [['input', '输入'], ['cacheRead', '缓存读取'], ['cacheWrite', '缓存写入'], ['output', '输出']].map(([key, label]) => `${label} ${window.UsagePricing.format(turn.cost.components[key])}`).join(' · ');
        row.append(costLine);
        if (turn.usage) {
          const values = node('dl', undefined, 'turn-buckets');
          for (const [key, label] of [['uncachedInputTokens', '未缓存输入'], ['cacheReadTokens', '缓存读取'], ['cacheWriteTokens', '缓存写入'], ['outputTokens', '输出'], ['reasoningTokens', '其中推理']]) {
            const cell = node('div'); cell.append(node('dt', label), node('dd', turn.usage[key] === undefined ? '未上报' : integer.format(turn.usage[key]))); values.append(cell);
          }
          row.append(values);
        } else row.append(node('p', '当前轮次尚未结束，或缺少完整用量记录。', 'turn-meta'));
        panel.append(row);
      }
      details.append(panel); host.append(details);
    }
    $('usage-more').hidden = data.sessions.length <= limit;
  }
  function render() {
    const data = window.UsageModel.build(snapshot, options);
    $('usage-cost').textContent = snapshot ? (!data.priced && (snapshot.unavailable || snapshot.omitted) ? '未计价' : money(data)) : '—';
    $('usage-cost-note').textContent = `USD · ${data.priced}/${data.turns} 轮已计价${data.unpriced || snapshot?.unavailable || snapshot?.omitted ? ' · 不完整' : ''}`;
    $('usage-total').textContent = snapshot ? amount(data) : '—';
    $('usage-total').title = snapshot ? `${integer.format(data.total)} tokens（已确认）` : '';
    $('usage-sessions').textContent = snapshot ? data.sessionCount : '—';
    $('usage-turn-count').textContent = `${data.turns} 轮任务 · ${data.known} 轮用量已确认`;
    $('usage-cache').textContent = snapshot && data.cacheRate !== null ? `${(data.cacheRate * 100).toFixed(1)}%` : '—';
    $('usage-cache-note').textContent = data.cacheRate !== null ? `缓存读取 / 总输入 · ${data.cacheKnown}/${data.turns} 轮缓存已知${data.cacheUnknown ? '（部分）' : ''}` : '无已知缓存记录或总输入为零';
    $('usage-duration').textContent = snapshot ? duration(data.duration) : '—';
    $('usage-updated').textContent = snapshot ? `更新于 ${time(snapshot.collectedAt)}` : '尚未读取';
    const select = $('usage-model');
    select.replaceChildren(new Option('全部模型', ''), ...data.models.map(model => new Option(model, model)));
    if (options.model && !data.models.includes(options.model)) select.add(new Option(options.model, options.model));
    select.value = options.model;
    feedback(data); renderChart(data); renderModels(data); renderSessions(data);
  }
  async function refresh() {
    if (busy) return;
    busy = true; error = ''; $('usage-refresh').disabled = true; $('usage-refresh').textContent = '读取中…'; $('usage-page').setAttribute('aria-busy', 'true'); feedback();
    try {
      const [result, prices] = await Promise.all([window.desktop.action('usage-read'), window.desktop.action('usage-prices')]);
      if (prices?.error) { priceError = prices.error; options.rates = []; }
      else { priceError = ''; priceState = prices; options.rates = prices.rates; }
      if (result?.error) throw new Error(result.error);
      if (!Array.isArray(result?.sessions)) throw new Error('统计数据格式不兼容。');
      snapshot = result;
    } catch (e) { error = e.message; }
    finally { busy = false; $('usage-refresh').disabled = false; $('usage-refresh').textContent = '↻ 刷新统计'; $('usage-page').removeAttribute('aria-busy'); render(); }
  }
  $('usage-refresh').addEventListener('click', refresh);
  $('usage-ranges').addEventListener('click', event => { const button = event.target.closest('[data-days]'); if (!button) return; options.days = Number(button.dataset.days); options.day = ''; limit = 30; for (const b of $('usage-ranges').children) { b.classList.toggle('selected', b === button); b.setAttribute('aria-pressed', String(b === button)); } render(); });
  $('usage-model').addEventListener('change', event => { options.model = event.target.value; limit = 30; render(); });
  $('usage-search').addEventListener('input', event => { options.search = event.target.value; limit = 30; renderSessions(window.UsageModel.build(snapshot, options)); });
  $('usage-sort').addEventListener('change', event => { options.sort = event.target.value; renderSessions(window.UsageModel.build(snapshot, options)); });
  $('usage-more').addEventListener('click', () => { limit += 30; renderSessions(window.UsageModel.build(snapshot, options)); });
  function fillPrice() {
    const model = $('price-model').value, rate = window.UsagePricing.resolveRate(model, priceState.rates);
    for (const key of window.UsagePricing.fields) $(`price-${key}`).value = rate?.[key] ?? '';
    $('price-basis').textContent = rate?.basis || '尚未设置单价；保存后开始估算。';
    $('price-message').textContent = priceError;
    renderSync();
  }
  function renderSync() {
    const sync = priceState.sync || {};
    $('price-source').value = sync.source || 'models.dev'; $('price-auto').checked = sync.auto !== false;
    $('price-sync-status').textContent = `${sync.count || 0} 条模型定价 · ${sync.lastSyncAt ? `上次同步 ${time(sync.lastSyncAt)}` : '尚未同步'}${sync.cachedSource && sync.cachedSource !== sync.source ? ' · 当前仍使用旧来源缓存' : ''}${sync.lastError ? ` · ${sync.lastError}` : ''}`;
  }
  $('usage-pricing-open').addEventListener('click', () => {
    const models = [...new Set([...window.UsagePricing.defaults.map(r => r.model), ...priceState.overrides.map(r => r.model), ...(snapshot?.sessions || []).flatMap(s => s.turns.map(t => t.model))])].filter(m => !['多模型（未拆分）', '模型未上报'].includes(m)).sort();
    $('price-model').replaceChildren(...models.map(model => new Option(model, model)));
    if (options.model && models.includes(options.model)) $('price-model').value = options.model;
    $('price-save').disabled = !models.length; $('price-reset').disabled = !models.length;
    fillPrice(); $('usage-pricing-dialog').showModal();
  });
  $('usage-pricing-close').addEventListener('click', () => $('usage-pricing-dialog').close());
  $('price-model').addEventListener('change', fillPrice);
  async function savePrice(reset) {
    const model = $('price-model').value; if (!model) return;
    const overrides = priceState.overrides.filter(r => r.model !== model);
    if (!reset) overrides.push({ model, ...Object.fromEntries(window.UsagePricing.fields.map(key => [key, $(`price-${key}`).value || null])) });
    $('price-save').disabled = true; $('price-reset').disabled = true;
    try {
      const result = await window.desktop.action('usage-prices-save', overrides);
      if (result?.error) throw Error(result.error);
      priceState = result; options.rates = result.rates; priceError = ''; render(); fillPrice();
      $('price-message').textContent = reset ? '自定义价格已移除。有内置价格时恢复参考价，否则不再计价。' : '已保存，历史估算已按当前价格表重新计算。';
    } catch (e) { $('price-message').textContent = e.message; }
    finally { $('price-save').disabled = false; $('price-reset').disabled = false; }
  }
  $('usage-pricing-form').addEventListener('submit', event => { event.preventDefault(); void savePrice(false); });
  $('price-reset').addEventListener('click', () => void savePrice(true));
  async function syncPriceConfig(manual) {
    $('price-sync').disabled = true; $('price-source').disabled = true; $('price-auto').disabled = true;
    $('price-sync-status').textContent = manual ? '正在同步模型价格…' : '正在保存同步设置…';
    try {
      const config = { source: $('price-source').value, auto: $('price-auto').checked };
      let result = await window.desktop.action('usage-prices-config', config);
      if (result?.error) throw Error(result.error);
      if (manual) result = await window.desktop.action('usage-prices-sync');
      if (result?.error) throw Error(result.error);
      priceState = result; options.rates = result.rates; priceError = ''; render(); fillPrice();
    } catch (e) { $('price-sync-status').textContent = e.message; }
    finally { $('price-sync').disabled = false; $('price-source').disabled = false; $('price-auto').disabled = false; }
  }
  $('price-source').addEventListener('change', () => void syncPriceConfig(true));
  $('price-auto').addEventListener('change', () => void syncPriceConfig(false));
  $('price-sync').addEventListener('click', () => void syncPriceConfig(true));
  window.usageDashboard = {
    setState(next) {
      const entered = next.page === 'usage' && state.page !== 'usage';
      const changed = next.completedAt !== state.completedAt || next.active !== state.active || next.phase !== state.phase || next.priceRevision !== state.priceRevision;
      state = next;
      if (state.page !== 'usage') $('usage-pricing-dialog').close();
      if (state.page === 'usage' && state.phase === 'ready' && (entered || changed)) { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 150); }
      if (state.page === 'usage' && state.phase !== 'ready') { error = 'Harness 当前未就绪，统计暂时无法刷新。'; feedback(); }
    },
  };
  setInterval(() => { if (state.page === 'usage' && state.phase === 'ready' && !document.hidden) void refresh(); }, 60000);
  render();
})();

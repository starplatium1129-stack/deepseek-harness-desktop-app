(() => {
  const series = [
    { key: 'cost', label: '估算成本', color: '#dc5270', axis: 'cost' },
    { key: 'creation', label: '缓存写入', color: '#e69a51' },
    { key: 'cache', label: '缓存命中', color: '#9970e6' },
    { key: 'input', label: '未缓存输入', color: '#5c86e6' },
    { key: 'output', label: '输出', color: '#62b58a' },
    { key: 'other', label: '未细分输入', color: '#a1acbe' },
  ];
  const ns = 'http://www.w3.org/2000/svg';
  const svgNode = (tag, attrs = {}, text) => { const el = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); if (text !== undefined) el.textContent = text; return el; };
  const compact = n => n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}K` : `${+n.toFixed(2)}`;
  const axisMoney = n => `$${n >= 1 ? +n.toFixed(2) : +n.toPrecision(2)}`;
  function maxAxis(n) { if (!n) return 1; const power = 10 ** Math.floor(Math.log10(n)); return [1, 2, 5, 10].find(v => v * power >= n) * power; }
  function value(row, item) {
    if (item.key === 'cost') return !row.priced && row.unpriced ? null : Number(row.costUnits) / 1e12;
    if (!row.known && row.unknown) return null;
    if (item.key === 'cache' && row.known && !row.cacheKnown) return null;
    if (item.key === 'creation' && row.known && !row.creationKnown) return null;
    return row[item.key];
  }
  function curve(points) {
    return points.map((p, i) => {
      if (!i) return `M${p.x},${p.y}`;
      const previous = points[i - 1], mid = (previous.x + p.x) / 2;
      return `C${mid},${previous.y} ${mid},${p.y} ${p.x},${p.y}`;
    }).join(' ');
  }
  function render(host, legend, data, { hidden, selected, onSelect, onToggle }) {
    host.replaceChildren(); legend.replaceChildren();
    const points = data.trend, left = 66, right = 944, top = 34, bottom = 294;
    const visible = series.filter(s => !hidden.has(s.key));
    const tokenMax = maxAxis(Math.max(0, ...points.flatMap(p => visible.filter(s => !s.axis).map(s => value(p, s) || 0))));
    const costMax = maxAxis(Math.max(0, ...points.map(p => hidden.has('cost') ? 0 : value(p, series[0]) || 0)));
    const x = index => points.length <= 1 ? (left + right) / 2 : left + index * (right - left) / (points.length - 1);
    const y = (v, item) => bottom - v / (item.axis ? costMax : tokenMax) * (bottom - top);
    const svg = svgNode('svg', { viewBox: '0 0 1010 345', role: 'group', 'aria-label': data.hourly ? '按小时统计的 Token 与成本趋势' : '按日期统计的 Token 与成本趋势' });
    const defs = svgNode('defs'), gradient = svgNode('linearGradient', { id: 'usage-cache-fill', x1: 0, y1: 0, x2: 0, y2: 1 });
    gradient.append(svgNode('stop', { offset: '0%', 'stop-color': '#9970e6', 'stop-opacity': '.20' }), svgNode('stop', { offset: '100%', 'stop-color': '#9970e6', 'stop-opacity': '.01' })); defs.append(gradient); svg.append(defs);
    svg.append(svgNode('text', { x: left, y: 15, fill: '#8d99af', 'font-size': 10 }, 'TOKENS'), svgNode('text', { x: right, y: 15, 'text-anchor': 'end', fill: '#bf7182', 'font-size': 10 }, 'USD · 估算成本'));
    for (let i = 0; i <= 4; i++) {
      const lineY = bottom - (bottom - top) * i / 4;
      svg.append(svgNode('line', { x1: left, x2: right, y1: lineY, y2: lineY, stroke: '#edf0f6', 'stroke-dasharray': '3 5' }));
      svg.append(svgNode('text', { x: left - 12, y: lineY + 4, 'text-anchor': 'end', fill: '#919bae', 'font-size': 11 }, compact(tokenMax * i / 4)));
      svg.append(svgNode('text', { x: right + 12, y: lineY + 4, fill: '#b97a88', 'font-size': 11 }, axisMoney(costMax * i / 4)));
    }
    for (const item of [...visible].reverse()) {
      let segment = [];
      const flush = () => {
        if (!segment.length) return;
        const line = curve(segment);
        if (item.key === 'cache') svg.append(svgNode('path', { d: `${line} L${segment.at(-1).x},${bottom} L${segment[0].x},${bottom} Z`, fill: 'url(#usage-cache-fill)', 'pointer-events': 'none' }));
        svg.append(svgNode('path', { d: line, fill: 'none', stroke: item.color, 'stroke-width': 2.2, 'stroke-dasharray': item.axis ? '5 5' : 'none', 'pointer-events': 'none', 'data-series': item.key }));
        if (segment.length === 1) svg.append(svgNode('circle', { cx: segment[0].x, cy: segment[0].y, r: 3, fill: item.color }));
        segment = [];
      };
      points.forEach((p, i) => { const v = value(p, item); if (v === null) flush(); else segment.push({ x: x(i), y: y(v, item) }); }); flush();
    }
    const tooltip = document.createElement('div'); tooltip.className = 'trend-tooltip'; tooltip.hidden = true; tooltip.setAttribute('role', 'status');
    const crosshair = svgNode('g', { visibility: 'hidden', 'pointer-events': 'none' }); svg.append(crosshair);
    function inspect(point, index) {
      tooltip.replaceChildren();
      const heading = document.createElement('strong'); heading.textContent = point.title; tooltip.append(heading);
      for (const item of visible) {
        const row = document.createElement('div'); row.className = `trend-tip-row trend-${item.key}`;
        const label = document.createElement('span'); label.textContent = item.label;
        const number = document.createElement('b'); const v = value(point, item);
        number.textContent = v === null ? '未知' : item.axis ? window.UsagePricing.format(point.costUnits) : new Intl.NumberFormat('zh-CN').format(v);
        row.append(label, number); tooltip.append(row);
      }
      const note = document.createElement('small'); note.textContent = `${point.turns} 轮 · ${point.known} 轮用量已确认 · ${point.priced} 轮已计价${point.unknown || point.unpriced ? '（部分数据）' : ''}`; tooltip.append(note);
      tooltip.hidden = false;
      const anchor = x(index) / 1010 * host.clientWidth, width = tooltip.offsetWidth;
      const desired = index > points.length / 2 ? anchor - width - 14 : anchor + 14;
      tooltip.style.right = 'auto'; tooltip.style.left = `${Math.max(8, Math.min(host.clientWidth - width - 8, desired))}px`;
      crosshair.replaceChildren(svgNode('line', { x1: x(index), x2: x(index), y1: top, y2: bottom, stroke: '#bfc7d7', 'stroke-width': 1 }));
      for (const item of visible) { const v = value(point, item); if (v !== null) crosshair.append(svgNode('circle', { cx: x(index), cy: y(v, item), r: 4, fill: item.color, stroke: 'white', 'stroke-width': 2 })); }
      crosshair.setAttribute('visibility', 'visible');
    }
    function dismiss() { tooltip.hidden = true; crosshair.setAttribute('visibility', 'hidden'); }
    points.forEach((point, index) => {
      const before = index ? (x(index - 1) + x(index)) / 2 : left, after = index === points.length - 1 ? right : (x(index) + x(index + 1)) / 2;
      const hit = svgNode('rect', { x: before - 1, width: Math.max(2, after - before + 2), y: top, height: bottom - top + 6, fill: 'transparent', tabindex: 0, role: 'button', class: 'chart-point', 'data-point-key': point.key, 'aria-label': `${point.title}，${point.total} tokens，成本 ${value(point, series[0]) === null ? '未知' : window.UsagePricing.format(point.costUnits)}`, 'aria-pressed': point.key === selected });
      hit.addEventListener('pointerenter', () => inspect(point, index)); hit.addEventListener('focus', () => inspect(point, index));
      hit.addEventListener('click', () => onSelect(point));
      hit.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(point); }
        if (event.key === 'Escape') dismiss();
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const next = Math.max(0, Math.min(points.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1))); host.querySelector(`[data-point-key="${points[next].key}"]`)?.focus(); }
      });
      svg.append(hit);
      if (point.key === selected) svg.append(svgNode('line', { x1: x(index), x2: x(index), y1: bottom + 3, y2: bottom + 10, stroke: '#7188c4', 'stroke-width': 3, 'pointer-events': 'none' }));
      const every = Math.ceil(points.length / 9);
      if (index % every === 0 || index === points.length - 1) svg.append(svgNode('text', { x: x(index), y: 324, 'text-anchor': 'middle', fill: '#929cb0', 'font-size': 11 }, point.label));
    });
    svg.addEventListener('pointerleave', () => { if (!svg.contains(document.activeElement)) dismiss(); });
    svg.addEventListener('focusout', event => { if (!svg.contains(event.relatedTarget)) dismiss(); });
    if (!points.some(p => p.turns)) svg.append(svgNode('text', { x: 505, y: 150, 'text-anchor': 'middle', fill: '#8d99af', 'font-size': 13 }, '所选时间暂无消耗记录'));
    host.append(svg, tooltip);
    for (const item of series) {
      const button = document.createElement('button'); button.type = 'button'; button.className = `trend-legend trend-${item.key}`; button.textContent = item.label; button.setAttribute('aria-pressed', String(!hidden.has(item.key))); button.dataset.series = item.key;
      button.addEventListener('click', () => onToggle(item.key)); legend.append(button);
    }
  }
  window.UsageChart = { render };
})();

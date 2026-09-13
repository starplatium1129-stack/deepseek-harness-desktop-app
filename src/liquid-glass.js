/* MIT. Rounded lens displacement of the actual composited backdrop, not a wallpaper copy. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (!root.LiquidGlass) root.LiquidGlass = api;
})(globalThis, function () {
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  function lens(width, height, radius, x, y) {
    const r = Math.min(radius, width / 2, height / 2);
    const px = x - width / 2, py = y - height / 2;
    const qx = Math.abs(px) - (width / 2 - r), qy = Math.abs(py) - (height / 2 - r);
    const ox = Math.max(qx, 0), oy = Math.max(qy, 0), length = Math.hypot(ox, oy);
    const distance = length + Math.min(Math.max(qx, qy), 0) - r;
    const depth = -distance, lip = Math.min(15, r || 15, width / 4, height / 4);
    if (depth <= 0 || depth >= lip) return [0, 0];
    let nx, ny;
    if (length > .001) { nx = ox / length * Math.sign(px); ny = oy / length * Math.sign(py); }
    else { nx = qx > qy ? Math.sign(px) : 0; ny = qx > qy ? 0 : Math.sign(py); }
    // Circular bevel normal + Snell refraction (air -> n=1.46 glass).
    const slope = (lip - depth) / Math.sqrt(Math.max(.1, lip * lip - (lip - depth) ** 2));
    const normalZ = 1 / Math.sqrt(1 + slope * slope), eta = 1 / 1.46;
    const k = eta * normalZ - Math.sqrt(1 - eta * eta * (1 - normalZ * normalZ));
    const refractedZ = -eta + k * normalZ;
    const travel = 17 * k * slope * normalZ / Math.abs(refractedZ);
    // Ease displacement to zero at the silhouette, avoiding a disconnected hard rim.
    const seam = Math.min(1, depth / 1.4);
    return [clamp(nx * travel * seam, -15, 15), clamp(ny * travel * seam, -15, 15)];
  }
  let installed = false, svg, defs, resize, mutations, timer = 0, serial = 0, selector;
  const records = new Map(), cache = new Map();
  const enabled = () => document.documentElement.dataset.appearance === 'glass' && document.documentElement.dataset.lowEffects !== 'true' && !matchMedia('(forced-colors: active)').matches && !matchMedia('(prefers-contrast: more)').matches;
  const ns = 'http://www.w3.org/2000/svg';
  function node(name, attrs = {}) { const el = document.createElementNS(ns, name); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; }
  function mapFor(w, h, r) {
    const key = `${Math.round(w)}:${Math.round(h)}:${r}`;
    if (cache.has(key)) return cache.get(key);
    const factor = Math.min(1, 360 / Math.max(w, h));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(2, Math.round(w * factor)); canvas.height = Math.max(2, Math.round(h * factor));
    const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(canvas.width, canvas.height);
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const [dx, dy] = lens(w, h, r, (x + .5) * w / canvas.width, (y + .5) * h / canvas.height), i = (y * canvas.width + x) * 4;
      pixels.data[i] = Math.round(127.5 + dx / 32 * 255); pixels.data[i + 1] = Math.round(127.5 + dy / 32 * 255); pixels.data[i + 2] = 128; pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0); const url = canvas.toDataURL();
    if (cache.size >= 48) cache.delete(cache.keys().next().value); cache.set(key, url); return url;
  }
  function remove(el, record) {
    resize.unobserve(el); record.filter.remove(); el.style.removeProperty('backdrop-filter'); el.removeAttribute('data-liquid'); records.delete(el);
  }
  function refresh(el, record) {
    if (!el.isConnected || !enabled()) return remove(el, record);
    const w = el.offsetWidth, h = el.offsetHeight;
    if (w < 2 || h < 2) return;
    const r = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, signature = `${w}:${h}:${r}`;
    if (signature === record.signature) return;
    record.signature = signature;
    record.filter.setAttribute('x', '0'); record.filter.setAttribute('y', '0'); record.filter.setAttribute('width', w); record.filter.setAttribute('height', h);
    record.map.setAttribute('width', w); record.map.setAttribute('height', h); record.map.setAttribute('href', mapFor(w, h, r));
  }
  function attach(el) {
    if (records.has(el) || el.closest('[data-fluid-ghost]') || !el.getClientRects().length || records.size >= 32) return;
    const id = `desktop-lens-${++serial}`;
    const filter = node('filter', { id, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' });
    const map = node('feImage', { result: 'lens-map', preserveAspectRatio: 'none', x: 0, y: 0 });
    filter.append(map, node('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: '2.4', result: 'soft-backdrop' }), node('feDisplacementMap', { in: 'soft-backdrop', in2: 'lens-map', scale: '32', xChannelSelector: 'R', yChannelSelector: 'G', result: 'refracted' }), node('feColorMatrix', { in: 'refracted', type: 'saturate', values: '1.18' }));
    const record = { filter, map }; records.set(el, record);
    // Populate feImage before attaching: an empty href creates an invalid resource timing entry in Chromium.
    refresh(el, record); defs.append(filter);
    el.dataset.liquid = ''; el.style.backdropFilter = `url("${document.URL.split('#')[0]}#${id}")`; resize.observe(el);
  }
  function scan() {
    timer = 0;
    for (const [el, record] of records) {
      if (!el.isConnected || !enabled() || !el.getClientRects().length) remove(el, record); else refresh(el, record);
    }
    if (enabled()) document.querySelectorAll(selector).forEach(attach);
  }
  function schedule() { if (!timer) timer = setTimeout(scan, 80); }
  function install(options = {}) {
    if (installed) { schedule(); return; } installed = true;
    selector = options.selector || 'header nav,.status-card,.appearance-layout>.card,.uV2eYG_card,[role="dialog"],[role="menu"],dialog[open],[data-glass-surface]';
    svg = node('svg', { 'aria-hidden': 'true', width: 0, height: 0 }); svg.classList.add('liquid-definitions'); defs = node('defs'); svg.append(defs); document.body.append(svg);
    resize = new ResizeObserver(schedule);
    mutations = new MutationObserver(events => {
      if (events.some(e => !svg.contains(e.target))) schedule();
    });
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open'] });
    new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ['data-appearance', 'data-low-effects', 'data-scheme'] });
    matchMedia('(forced-colors: active)').addEventListener('change', schedule);
    matchMedia('(prefers-contrast: more)').addEventListener('change', schedule);
    // Position the light over the surface; the highlight follows the same spring engine.
    let hover;
    document.addEventListener('pointermove', event => {
      if (!enabled() || rootMotionReduced()) return;
      const el = event.target.closest('[data-liquid]');
      if (hover && hover !== el) { hover.style.removeProperty('--light-x'); hover.style.removeProperty('--light-y'); }
      hover = el; if (!el) return;
      const rect = el.getBoundingClientRect();
      const values = { x: clamp((event.clientX - rect.left) / rect.width * 100, 0, 100), y: clamp((event.clientY - rect.top) / rect.height * 100, 0, 100) };
      for (const [axis, value] of Object.entries(values)) globalThis.FluidMotion?.animate(el, `light-${axis}`, value, v => el.style.setProperty(`--light-${axis}`, `${v}%`), { from: 50, profile: 'control' });
    }, { passive: true });
    scan();
  }
  function rootMotionReduced() { return document.documentElement.dataset.motion !== 'full'; }
  return { lens, install, refresh: schedule, get surfaceCount() { return records.size; }, get cacheSize() { return cache.size; } };
});

const { retryRegionStream } = require('./region-retry.cjs');
const { ExaSearchProvider } = require('./exa-search.cjs');
const { AsyncLocalStorage } = require('node:async_hooks');
const replay = new AsyncLocalStorage();

exports.name = 'desktop-integrations';
exports.inject = ['llm', 'web'];
exports.apply = (ctx, config) => {
  if (typeof config?.runtimeRoot !== 'string') throw new Error('Desktop runtime path is missing.');
  ctx.web.registerSearchProvider(new ExaSearchProvider(config.runtimeRoot));
  ctx.on('llm/stream', (options, next) => {
    if (replay.getStore()) return next();
    let first = true;
    return retryRegionStream(() => {
      if (first) { first = false; return next(); }
      // Cordis next() consumes the downstream listener queue. Start a fresh
      // waterfall so every policy/checkpoint observer also sees each retry.
      return replay.run(true, () => ctx.llm.stream(options));
    }, {
      signal: options.signal,
      notify: ({ retry, maxRetries, delayMs }) => ctx.logger.info(`地区错误：尚未收到输出，${delayMs / 1000} 秒后重试（${retry}/${maxRetries}）。`),
    });
  });
};

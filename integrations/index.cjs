const { retryRegionStream } = require('./region-retry.cjs');
const { ExaSearchProvider } = require('./exa-search.cjs');
const { AsyncLocalStorage } = require('node:async_hooks');
const path = require('node:path');
const fs = require('node:fs');
const replay = new AsyncLocalStorage();
const desktopBridge = path.resolve(__dirname, '../collaboration/harness-desktop-server.cjs');
const bridgePlugin = fs.existsSync(desktopBridge) ? require(desktopBridge) : undefined;

exports.name = 'desktop-integrations';
// Loader tracks this parent entry, not arbitrary child-plugin initialization.
// Require the child's services before applying, then await its native Fiber so
// parent readiness also means the private pipe and descriptor are published.
exports.inject = [...new Set(['llm', 'web', ...(bridgePlugin?.inject || [])])];
exports.apply = async (ctx, config) => {
  if (typeof config?.runtimeRoot !== 'string') throw new Error('Desktop runtime path is missing.');
  ctx.web.registerSearchProvider(new ExaSearchProvider(config.runtimeRoot));
  const harnessHome = config.harnessHome || process.env.DSH_HOME;
  if (typeof harnessHome === 'string' && path.isAbsolute(harnessHome) && bridgePlugin) {
    await ctx.plugin(bridgePlugin, { runtimeRoot: config.runtimeRoot, harnessHome });
  }
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

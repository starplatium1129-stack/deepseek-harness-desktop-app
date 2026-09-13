const fs = require('node:fs/promises');
const path = require('node:path');
const { defaults, validate } = require('./usage-pricing.js');
const { PriceCatalog } = require('./price-catalog.cjs');
class PricingStore {
  constructor(data, options = {}) { this.file = path.join(data, 'usage-prices.json'); this.queue = Promise.resolve(); this.catalog = new PriceCatalog(data, options); }
  async read() {
    let stored = { overrides: [], updatedAt: null };
    try {
      stored = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (stored.version !== 1) throw Error('version');
      stored.overrides = validate(stored.overrides);
    } catch (error) { if (error.code !== 'ENOENT') throw Error('价格表无法读取，请在价格设置中重新保存；原文件仍保留。'); }
    const rates = new Map(defaults.map(row => [row.model, { ...row }]));
    const catalog = await this.catalog.read();
    for (const row of catalog.rows) rates.set(row.model, row);
    for (const row of stored.overrides) rates.set(row.model, row);
    return { currency: 'USD', rates: [...rates.values()], overrides: stored.overrides, updatedAt: stored.updatedAt, referenceDate: '2026-09-13', sync: catalog.status };
  }
  save(rows) {
    const overrides = validate(rows);
    const write = this.queue.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      // Retain the prior table for recovery, including an unreadable user-edited table.
      try { await fs.copyFile(this.file, `${this.file}.bak`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const temporary = `${this.file}.tmp`;
      await fs.writeFile(temporary, JSON.stringify({ version: 1, updatedAt: Date.now(), overrides }, null, 2));
      await fs.rename(temporary, this.file);
      return this.read();
    });
    this.queue = write; return write;
  }
}
module.exports = { PricingStore };

'use strict';
const { StringDecoder } = require('node:string_decoder');
const { connectShared } = require('./bridge.cjs');
class SharedClient {
  constructor(socket) {
    this.socket = socket; this.pending = new Map(); this.next = 0;
    const decoder = new StringDecoder('utf8'); let buffer = '';
    const failed = () => { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('共享协作连接已关闭；不会自动重发。')); } this.pending.clear(); };
    socket.on('error', failed); socket.on('close', failed);
    socket.on('data', chunk => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) { socket.destroy(); return; }
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        let message; try { message = JSON.parse(line); } catch { socket.destroy(); return; }
        const item = this.pending.get(message.id); if (!item) continue;
        this.pending.delete(message.id); clearTimeout(item.timer);
        message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
      }
    }); socket.resume();
  }
  static async connect(options) {
    const connection = await connectShared(options); const client = new SharedClient(connection.socket);
    try { client.info = await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'bounded-project-coordinator-client', version: '1' } }); client.socket.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); return client; }
    catch (error) { client.close(); throw error; }
  }
  request(method, params) {
    if (this.socket.destroyed) return Promise.reject(new Error('协作连接已关闭。'));
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('MCP 响应超时，请查询原任务而非重新派发。')); }, 75000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async call(name, args = {}) { const result = await this.request('tools/call', { name, arguments: args }); const value = result.structuredContent || JSON.parse(result.content.find(c => c.type === 'text').text); if (result.isError) throw new Error(value.error || 'MCP 调用失败'); return value; }
  close() { this.socket.destroy(); }
}
module.exports = { SharedClient };

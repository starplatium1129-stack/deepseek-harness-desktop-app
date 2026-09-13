'use strict';
// Run verifier argv through Codex's native command sandbox, without a model
// turn. Generated project code must not escape the Harness write boundary just
// because it is being imported by a test command.
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { randomUUID } = require('node:crypto');
const { resolveCodex } = require('./codex-reviewer.cjs');
const { safe } = require('./core.cjs');
class NativeChecks {
  static async create(directory) {
    const executable = await resolveCodex();
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(NODE_OPTIONS|ELECTRON_RUN_AS_NODE|OPENAI_API_KEY|CODEX_API_KEY|DEEPSEEK_API_KEY|DSH_.*)$/i.test(key)));
    const child = spawn(executable, ['app-server', '--listen', 'stdio://', '-c', 'approval_policy="never"', '--disable', 'apps', '--disable', 'plugins', '--disable', 'hooks'], { cwd: directory, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new NativeChecks(child);
    try { await client.request('initialize', { clientInfo: { name: 'project-run-checks', version: '1' }, capabilities: { experimentalApi: true, requestAttestation: false } }, 30000); child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n'); return client; }
    catch (error) { await client.close(); throw error; }
  }
  constructor(child) {
    this.child = child; this.pending = new Map(); this.next = 0;
    const decoder = new StringDecoder('utf8'); let buffer = '';
    const fail = error => { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); } this.pending.clear(); };
    child.on('error', error => fail(new Error(safe(error.message)))); child.once('exit', () => fail(new Error('原生验证沙盒已退出。')));
    child.stdin.on('error', error => fail(new Error(safe(error.message)))); child.stderr.on('data', () => {});
    child.stdout.on('data', chunk => {
      buffer += decoder.write(chunk); if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) { child.kill(); fail(new Error('原生验证响应超过限制。')); return; }
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.method) {
          if (message.id !== undefined) child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Verification never grants approvals or supplies credentials.' } }) + '\n');
          continue;
        }
        const item = this.pending.get(message.id); if (!item) continue;
        this.pending.delete(message.id); clearTimeout(item.timer);
        message.error ? item.reject(new Error(safe(message.error.message))) : item.resolve(message.result);
      }
    });
  }
  request(method, params, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++this.next, timer = setTimeout(() => { this.pending.delete(id); reject(new Error('原生验证接口超过时限。')); }, timeout);
      this.pending.set(id, { resolve, reject, timer }); this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async execute(command, args, { cwd, permission, env, timeoutMs, signal, temporaryDirectory }) {
    signal.throwIfAborted(); const processId = `verify-${randomUUID()}`;
    const sandboxPolicy = permission === 'read-only' ? { type: 'readOnly', networkAccess: false } : { type: 'workspaceWrite', writableRoots: [cwd, temporaryDirectory], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true };
    const pending = this.request('command/exec', { command: [command, ...args], cwd, sandboxPolicy, env, timeoutMs, ...(process.platform === 'win32' ? {} : { outputBytesCap: 65536 }), processId }, timeoutMs + 20000);
    let stopping;
    const abort = () => { stopping = this.request('command/exec/terminate', { processId }, 10000).catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    try { const result = await pending; signal.throwIfAborted(); return result; }
    catch (error) {
      signal.throwIfAborted();
      // Windows returns ordinary nonzero commands through this legacy error
      // wrapper. Keep their real exit code and assertion output; a failed test
      // is not automatically an unavailable sandbox.
      const match = /^exec failed: sandbox error: sandbox denied exec error, exit code: (-?\d+), stdout: ([\s\S]*), stderr: ([\s\S]*)$/.exec(error.message);
      if (match) return { exitCode: Number(match[1]), stdout: match[2], stderr: match[3] };
      throw error;
    }
    finally { signal.removeEventListener('abort', abort); await stopping; }
  }
  async close() {
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => { this.child.kill(); resolve(); }, 5000); this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}
module.exports = { NativeChecks };

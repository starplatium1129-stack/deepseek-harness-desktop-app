#!/usr/bin/env node
'use strict';

// Planning-side convenience watcher for long collaboration tasks. It connects
// to the shared service as an ordinary MCP client and long-polls wait_task
// until the task reaches a terminal or attention state, then prints a one-line
// JSON summary and exits. Running it as a background shell task lets the
// planning session be re-invoked on completion without guessing a duration.
// It performs no review, consumes no model quota, and never modifies tasks.

const { spawn } = require('node:child_process');
const path = require('node:path');

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'needs_input', 'needs_approval']);
const POLL_TIMEOUT_MS = 25000;
const RPC_TIMEOUT_MS = 40000;

function parseArgs(argv) {
  const options = { taskId: null, dataDir: null, roots: [], capMs: 50 * 60 * 1000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--task-id') options.taskId = argv[++i];
    else if (arg === '--data-dir') options.dataDir = argv[++i];
    else if (arg === '--allow-root') options.roots.push(argv[++i]);
    else if (arg === '--cap-ms') options.capMs = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.taskId || !options.dataDir || !options.roots.length || !Number.isFinite(options.capMs) || options.capMs <= 0) {
    throw new Error('Required: --task-id <id> --data-dir <absolute-dir> --allow-root <absolute-dir> (repeatable) [--cap-ms N]');
  }
  return options;
}

function fail(message, code) {
  process.stdout.write(JSON.stringify({ watcher: 'error', message: String(message).slice(0, 500) }) + '\n');
  process.exit(code);
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { fail(error.message, 1); return; }

  const cli = path.join(__dirname, '..', 'collaboration', 'cli.cjs');
  const args = [cli, '--shared', '--data-dir', options.dataDir];
  for (const root of options.roots) args.push('--allow-root', root);
  const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  const stop = () => { try { child.kill(); } catch { /* already gone */ } };
  process.on('exit', stop);
  process.on('SIGINT', () => { stop(); process.exit(1); });

  let buffer = '';
  let pending = null;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      if (pending) { pending(line); pending = null; }
    }
  });
  child.once('exit', () => { if (pending) { pending(null); pending = null; } });

  function rpc(request, timeoutMs = RPC_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending = null; reject(new Error(`MCP round-trip timed out after ${timeoutMs}ms`)); }, timeoutMs);
      pending = line => {
        clearTimeout(timer);
        if (line === null) { reject(new Error('MCP client exited before responding')); return; }
        let message;
        try { message = JSON.parse(line); }
        catch { reject(new Error('Unparseable MCP line')); return; }
        if (message.error) { reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`)); return; }
        resolve(message.result);
      };
      child.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  function toolCall(id, name, args2) {
    return rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args2 } });
  }

  try {
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'collaboration-task-watcher', version: '0.1.0' } } }, 30000);
    if (!init) throw new Error('No initialize result');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const startedAt = Date.now();
    let cursor = 0;
    for (;;) {
      const remaining = options.capMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        process.stdout.write(JSON.stringify({ watcher: 'cap-timeout', taskId: options.taskId, note: 'Still not terminal at the watcher cap; re-arm another watcher or query get_task.' }) + '\n');
        process.exit(2);
      }
      const result = await toolCall(2, 'wait_task', { taskId: options.taskId, afterSequence: cursor, timeoutMs: Math.min(POLL_TIMEOUT_MS, remaining) });
      const text = result && result.content && result.content[0] && result.content[0].text;
      if (result && result.isError) fail(text || 'wait_task reported an error', 1);
      let task;
      try { task = JSON.parse(text); }
      catch { fail('wait_task returned unparseable content', 1); return; }
      if (typeof task.nextSequence === 'number') cursor = task.nextSequence;
      if (TERMINAL_STATES.has(task.state)) {
        process.stdout.write(JSON.stringify({
          watcher: 'done',
          taskId: task.id,
          state: task.state,
          review: task.review && task.review.decision,
          errorCode: task.errorCode || undefined,
          patch: task.evidence && task.evidence.patch,
          updatedAt: task.updatedAt,
        }) + '\n');
        process.exit(0);
      }
    }
  } catch (error) {
    fail(error, 1);
  }
}

main();

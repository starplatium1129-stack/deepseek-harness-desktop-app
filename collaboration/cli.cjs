#!/usr/bin/env node
'use strict';

const path = require('node:path');
const os = require('node:os');
const { createMcpServer, safeError } = require('./mcp.cjs');

const HELP = `DeepSeek Harness independent collaboration service (MCP stdio)

Usage:
  node collaboration/cli.cjs --allow-root <absolute-directory> [options]

Options:
  --allow-root <path>  Allow tasks only below this existing directory; repeatable.
  --data-dir <path>    Absolute directory for independent task data and worktrees.
  --list-executors    Print capability/availability JSON and exit without tasks.
  --shared           Connect stdio to a private shared local service; start it if absent.
  --shared-stop      Stop a shared service only when no tasks or other clients remain.
  --shared-status    Print authenticated daemon PID and client/work counts; no task text.
  --shared-restart   Reload an idle daemon, closing idle clients; refuses active work.
  --shared-idle-ms N  Shared service idle lifetime (100..3600000 ms; default 300000).
  --help, -h          Show this help and exit.

At least one --allow-root is required, including for --list-executors.
Default data: <APPDATA>/DeepSeek-Harness-Collaboration (platform fallback if absent).
Normal service mode uses stdout only for MCP messages; diagnostics use stderr.
Windows shared mode requires the current user's running Explorer desktop.
Shared daemon diagnostics: <data-dir>/ipc/daemon.log (private to this user).
Starting this service does not submit tasks or edit any application's MCP config.
`;

function defaultDataDir(env = process.env) {
  const base = env.APPDATA || env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'DeepSeek-Harness-Collaboration');
}

function parseArgs(argv, env = process.env) {
  const options = { allowedRoots: [], dataDir: defaultDataDir(env), help: false, listExecutors: false, shared: false, daemon: false, sharedStop: false, sharedStatus: false, sharedRestart: false, idleMs: 300000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--list-executors') options.listExecutors = true;
    else if (arg === '--shared') options.shared = true;
    else if (arg === '--daemon') options.daemon = true;
    else if (arg === '--shared-stop') options.sharedStop = true;
    else if (arg === '--shared-status') options.sharedStatus = true;
    else if (arg === '--shared-restart') options.sharedRestart = true;
    else if (arg === '--shared-idle-ms') {
      const value = argv[++i];
      if (!/^\d+$/.test(value || '') || Number(value) < 100 || Number(value) > 3600000) throw new Error('--shared-idle-ms requires an integer from 100 to 3600000');
      options.idleMs = Number(value);
    }
    else if (arg === '--allow-root' || arg === '--data-dir') {
      const value = argv[++i];
      if (!value || value.startsWith('--') || !path.isAbsolute(value)) throw new Error(`${arg} requires an absolute path`);
      if (arg === '--allow-root') options.allowedRoots.push(path.resolve(value));
      else options.dataDir = path.resolve(value);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.help && !options.allowedRoots.length) throw new Error('At least one explicit --allow-root <absolute-directory> is required. Use --help for usage.');
  options.allowedRoots = [...new Set(options.allowedRoots)];
  if ([options.shared, options.daemon, options.sharedStop, options.sharedStatus, options.sharedRestart, options.listExecutors].filter(Boolean).length > 1) throw new Error('--shared, --shared-stop, --shared-status, --shared-restart, --daemon and --list-executors are separate modes');
  return options;
}

async function main(argv = process.argv.slice(2), { createService, input = process.stdin, output = process.stdout, error = process.stderr, signals = process, env = process.env } = {}) {
  let options;
  try { options = parseArgs(argv, env); }
  catch (cause) { error.write(`${safeError(cause)}\n`); return 2; }
  if (options.help) { output.write(HELP); return 0; }
  if (options.shared || options.sharedStop || options.sharedStatus || options.sharedRestart || options.daemon) {
    try {
      if (options.daemon) {
        const fallbackError = error;
        error = { write(value) {
          try { require('node:fs').appendFileSync(path.join(options.dataDir, 'ipc', 'daemon.log'), value, { mode: 0o600 }); }
          catch { fallbackError.write(value); }
        } };
        if (env.DSH_COLLAB_DIAGNOSTICS === '1') {
          signals.once('exit', code => error.write(`[collaboration-daemon] Process ${process.pid} exited (${code}).\n`));
          signals.on('uncaughtExceptionMonitor', cause => error.write(`[collaboration-daemon] Uncaught: ${safeError(cause)}\n`));
        }
        const daemon = await require('./daemon.cjs').startDaemon({ ...options, createService, error, signals });
        await daemon.done;
      } else if (options.sharedStatus || options.sharedRestart) {
        const bridge = require('./bridge.cjs');
        const result = await (options.sharedStatus ? bridge.readSharedStatus(options) : bridge.restartShared(options));
        output.write(JSON.stringify(result, null, 2) + '\n');
      } else {
        await require('./bridge.cjs').runBridge({ ...options, operation: options.sharedStop ? 'shutdown' : 'connect' }, { input, output, signals });
      }
      return 0;
    } catch (cause) { error.write(`[collaboration] ${safeError(cause)}\n`); return 1; }
  }
  let service;
  try {
    const factory = createService || require('./index.cjs').createDefaultService;
    service = await factory({ dataDir: options.dataDir, allowedRoots: options.allowedRoots, inspectOnly: options.listExecutors });
    if (options.listExecutors) {
      output.write(JSON.stringify(await service.listExecutors(), null, 2) + '\n');
      await service.close();
      return 0;
    }
  } catch (cause) {
    if (service) await service.close().catch(() => {});
    error.write(`[collaboration] ${safeError(cause)}\n`);
    return 1;
  }
  const server = createMcpServer({ service, input, output, error });
  const stop = () => { void server.close(); input.destroy(); };
  signals.once('SIGINT', stop);
  signals.once('SIGTERM', stop);
  try { await server.done; }
  finally { signals.removeListener('SIGINT', stop); signals.removeListener('SIGTERM', stop); }
  return 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }, cause => {
    process.stderr.write(`[collaboration] ${safeError(cause)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, defaultDataDir, HELP };

'use strict';
// Explicit isolated live fixture. Does not install, register, send Codex messages,
// or review a task. The original Codex agent must inspect and decide itself.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { git } = require('../collaboration/core.cjs');
const { startDaemon } = require('../collaboration/daemon.cjs');
const { createDefaultService } = require('../collaboration/index.cjs');
const { SharedClient } = require('../collaboration/client.cjs');
const { runChecks, checkSpecs } = require('../collaboration/long-run.cjs');
const reportDirectory = path.resolve(__dirname, '../.test-data/dispatcher-live');
async function main(argv) {
  if (argv[0] === 'serve' && argv.length === 2 && path.isAbsolute(argv[1])) {
    const resources = argv[1];
    await fs.mkdir(reportDirectory, { recursive: true });
    const repository = await fs.mkdtemp(path.join(reportDirectory, 'fixture-'));
    await git(repository, ['init']); await git(repository, ['config', 'user.name', 'Dispatcher acceptance']); await git(repository, ['config', 'user.email', 'test@example.invalid']);
    await fs.writeFile(path.join(repository, 'greet.cjs'), 'exports.greet = name => `Hello, ${name}!`;\n');
    await fs.writeFile(path.join(repository, 'greet.test.cjs'), 'const {test}=require("node:test");const a=require("node:assert/strict");const {greet}=require("./greet.cjs");test("normal",()=>a.equal(greet("Ada"),"Hello, Ada!"));test("trim",()=>a.equal(greet("  Ada  "),"Hello, Ada!"));\n');
    await git(repository, ['add', '.']); await git(repository, ['commit', '-m', 'dispatcher acceptance fixture']);
    const options = { dataDir: await fs.mkdtemp(path.join(os.tmpdir(), 'dispatcher-live-')), allowedRoots: [repository] };
    const daemon = await startDaemon({ ...options, idleMs: 3600000, createService: opts => createDefaultService({ ...opts, runtimeResources: resources }) });
    await fs.writeFile(path.join(reportDirectory, 'connection.json'), JSON.stringify(options, null, 2));
    await fs.writeFile(path.join(reportDirectory, 'fixture.json'), JSON.stringify({ repository, resources, createdAt: new Date().toISOString() }, null, 2));
    console.log(JSON.stringify({ ready: true, optionsFile: path.join(reportDirectory, 'connection.json'), repository, dataDir: options.dataDir }));
    await daemon.done; return;
  }
  if (argv[0] === 'verify' && argv[1] && ['first', 'second'].includes(argv[2])) {
    const options = JSON.parse(await fs.readFile(path.join(reportDirectory, 'connection.json'), 'utf8'));
    const { resources } = JSON.parse(await fs.readFile(path.join(reportDirectory, 'fixture.json'), 'utf8'));
    const client = await SharedClient.connect(options);
    try {
      const task = await client.call('get_task', { taskId: argv[1] });
      if (task.lease || task.state !== 'completed') throw new Error('Task not completed');
      const checks = [{ command: 'node', args: ['--test', 'greet.test.cjs'], timeoutMs: 20000 }];
      if (argv[2] === 'second') checks.push({ command: 'node', args: ['-e', 'const a=require("node:assert/strict");const {greet}=require("./greet.cjs");a.throws(()=>greet(""),TypeError);a.throws(()=>greet("  "),TypeError);console.log("empty-name checks passed")'], timeoutMs: 20000 });
      const result = await runChecks({ controlDirectory: path.join(options.dataDir, 'verification'), checks: checkSpecs(checks), deadlineAt: new Date(Date.now() + 60000).toISOString(), permission: task.permission }, task, { resources, signal: new AbortController().signal });
      const diff = await git(task.workspace, ['diff', '--no-ext-diff', '--no-textconv', task.baseCommit, '--']);
      const report = { taskId: task.id, checks: result, diff, at: new Date().toISOString(), reviewer: 'caller-must-review' };
      await fs.writeFile(path.join(reportDirectory, `verification-${argv[2]}.json`), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report, null, 2));
      if (result.some(r => r.exitCode !== 0)) process.exitCode = 1;
    } finally { client.close(); } return;
  }
  throw new Error('Usage: dispatcher-live.cjs serve <absolute-runtime-resources> | verify <task-id> <first|second>');
}
main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });

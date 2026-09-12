// Windows does not deliver POSIX signals. Translate our private IPC shutdown
// request after upstream installs its normal disposal handlers.
const { pathToFileURL } = require('node:url');
const entry = process.argv[2];
process.argv = [process.execPath, entry, ...process.argv.slice(3)];
let requested = false;
function shutdown() {
  if (requested) return; requested = true;
  const poll = setInterval(() => {
    if (process.listenerCount('SIGTERM') > 0) { clearInterval(poll); process.emit('SIGTERM'); }
  }, 50);
  poll.unref();
}
process.on('message', message => { if (message?.type === 'shutdown') shutdown(); });
process.on('disconnect', shutdown);
import(pathToFileURL(entry).href).then(module => module.runCli?.()).catch(error => { console.error(error); process.exitCode = 1; process.disconnect?.(); });

const $ = id => document.getElementById(id);
function render(s) {
  const ready = s.phase === 'ready';
  $('dot').className = s.phase;
  $('status-short').textContent = ready ? '本地服务已就绪' : s.phase === 'error' ? '需要处理' : '正在启动';
  if (ready && s.completedAt) $('status-short').textContent = `最近完成 · ${new Date(s.completedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  $('status-title').textContent = ready ? '一切准备就绪' : s.phase === 'error' ? '启动遇到问题' : '正在准备你的工作空间';
  $('symbol').textContent = ready ? '✓' : s.phase === 'error' ? '!' : '◌';
  $('message').textContent = s.message;
  $('version').textContent = s.active || '—'; $('desktop-version').textContent = s.desktopVersion;
  $('enter').disabled = !ready; $('workspace').disabled = !ready; $('retry').hidden = s.phase !== 'error';
  const page = s.page || (s.showHome ? 'home' : 'workspace');
  for (const name of ['home', 'workspace', 'usage']) $(name).classList.toggle('selected', page === name);
  $('management-page').hidden = page !== 'home'; $('usage-page').hidden = page !== 'usage';
  window.usageDashboard?.setState(s);
  $('key-state').textContent = s.hasKey ? '已加密保存' : '尚未在桌面端保存';
  if (s.keyMessage) $('key-message').textContent = s.keyMessage;
  if (s.updateMessage) $('update-message').textContent = s.updateMessage;
  $('download').hidden = !s.update?.newer || !!s.pending;
  $('download').disabled = !!s.updating; $('check').disabled = !!s.updating;
  $('download').textContent = s.updating ? '准备中…' : '下载并验证';
  $('apply').hidden = !s.pending; $('rollback').hidden = !s.canRollback;
}
let errorTimer;
async function action(name, value) {
  $('error').hidden = true;
  try { const result = await window.desktop.action(name, value); if (result?.error) throw new Error(result.error); }
  catch (error) { $('error').textContent = error.message; $('error').hidden = false; clearTimeout(errorTimer); errorTimer = setTimeout(() => $('error').hidden = true, 16000); }
}
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => action(button.dataset.action)));
$('save-key').addEventListener('click', async () => { const key = $('api-key').value; if (!key.trim()) return; await action('save-key', key); $('api-key').value = ''; });
window.desktop.onState(render); window.desktop.state().then(render);

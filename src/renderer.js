const $ = id => document.getElementById(id);
const feedback = RendererFeedback.create(document);
const activeScopes = new Set();
let currentState = {};
function syncActionBusy() {
  const updateBusy = activeScopes.has('update-message') || !!currentState.updating;
  $('download').disabled = updateBusy; $('check').disabled = updateBusy;
  const keyBusy = activeScopes.has('key-message');
  $('save-key').disabled = keyBusy; $('api-key').readOnly = keyBusy;
  if (keyBusy) $('api-key').setAttribute('aria-busy', 'true'); else $('api-key').removeAttribute('aria-busy');
}
function render(s) {
  currentState = s;
  feedback.render(s);
  const ready = s.phase === 'ready';
  $('zoom-level').textContent = `${Math.round((s.zoom || 1) * 100)}%`;
  $('dot').className = s.phase;
  $('status-short').textContent = ready ? '本地服务已就绪' : s.phase === 'error' ? '需要处理' : '正在启动';
  if (ready && s.completedAt) $('status-short').textContent = `最近完成 · ${new Date(s.completedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  $('status-title').textContent = ready ? '一切准备就绪' : s.phase === 'error' ? '启动遇到问题' : '正在准备你的工作空间';
  $('symbol').textContent = ready ? '✓' : s.phase === 'error' ? '!' : '◌';
  $('message').textContent = s.message;
  $('version').textContent = s.active || '—'; $('desktop-version').textContent = s.desktopVersion;
  $('enter').disabled = !ready; $('workspace').disabled = !ready; $('retry').hidden = s.phase !== 'error';
  const page = s.page || (s.showHome ? 'home' : 'workspace');
  for (const name of ['home', 'workspace', 'usage', 'appearance']) $(name).classList.toggle('selected', page === name);
  DesktopInteraction.render(page, s.focusRequest);
  window.usageDashboard?.setState(s);
  $('key-state').textContent = s.hasKey ? '已加密保存' : '尚未在桌面端保存';
  $('download').hidden = !s.update?.newer || !!s.pending;
  syncActionBusy();
  $('download').textContent = s.updating ? '准备中…' : '下载并验证';
  $('apply').hidden = !s.pending; $('rollback').hidden = !s.canRollback;
}
async function action(name, value, trigger) {
  const scope = RendererFeedback.scopeFor(name);
  if (scope && activeScopes.has(scope)) return false;
  if (scope) { activeScopes.add(scope); syncActionBusy(); }
  feedback.begin(name);
  try { const result = await window.desktop.action(name, value); if (result?.error) throw new Error(result.error); return true; }
  catch (error) { feedback.failure(name, error.message, trigger); return false; }
  finally { if (scope) { activeScopes.delete(scope); syncActionBusy(); } }
}
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => action(button.dataset.action, undefined, button)));
$('save-key').addEventListener('click', async () => { const key = $('api-key').value; if (!key.trim()) { feedback.validation('save-key', '请输入 API Key 后再保存。'); $('api-key').focus(); return; } if (key.length > 4096) { feedback.validation('save-key', 'API Key 不能超过 4096 个字符。'); $('api-key').focus(); return; } if (await action('save-key', key, $('save-key')) && $('api-key').value === key) $('api-key').value = ''; });
$('api-key').addEventListener('input', () => { if (!feedback.hasValidation('save-key')) return; const key = $('api-key').value; if (!key.trim()) feedback.validation('save-key', '请输入 API Key 后再保存。'); else if (key.length > 4096) feedback.validation('save-key', 'API Key 不能超过 4096 个字符。'); else feedback.clearValidation('save-key'); });
$('error-dismiss').addEventListener('click', () => feedback.dismiss());
window.desktop.onState(render); window.desktop.state().then(render);

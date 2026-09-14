(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RendererFeedback = api;
})(globalThis, function () {
  const targets = Object.freeze({
    'save-key': { id: 'key-message', stateKey: 'keyMessage', inputId: 'api-key' },
    check: { id: 'update-message', stateKey: 'updateMessage' },
    download: { id: 'update-message', stateKey: 'updateMessage' }
  });

  function describeFailure(name, message) {
    const detail = String(message || '操作失败。').trim();
    if (name === 'save-key') return `保存失败：${detail} 输入内容已保留，请检查后重试。`;
    if (name === 'check') return `检查失败：${detail} 当前版本不受影响，请稍后重试。`;
    if (name === 'download') return `下载验证失败：${detail} 当前版本不受影响，请重新下载。`;
    return detail;
  }

  function scopeFor(name) {
    return targets[name]?.id || '';
  }

  function create(document) {
    const $ = id => document.getElementById(id);
    const uniqueTargets = [...new Map(Object.values(targets).map(target => [target.id, target])).values()];
    const fallbacks = Object.fromEntries(uniqueTargets.map(target => [target.id, $(target.id).textContent]));
    let latestState = {};
    let genericReturnFocus;

    function normalText(target) {
      const value = latestState[target.stateKey];
      return typeof value === 'string' && value ? value : fallbacks[target.id];
    }

    function clearInline(target) {
      const element = $(target.id);
      element.classList.remove('inline-error');
      delete element.dataset.errorKind;
      element.setAttribute('role', 'status');
      const text = normalText(target);
      if (element.textContent !== text) element.textContent = text;
      if (target.inputId) $(target.inputId).removeAttribute('aria-invalid');
    }

    function showInline(target, message, kind) {
      const element = $(target.id);
      element.classList.add('inline-error');
      element.dataset.errorKind = kind;
      element.setAttribute('role', 'alert');
      if (element.textContent !== message) element.textContent = message;
      if (target.inputId) {
        if (kind === 'validation') $(target.inputId).setAttribute('aria-invalid', 'true');
        else $(target.inputId).removeAttribute('aria-invalid');
      }
    }

    function hideGeneric(restoreFocus) {
      const banner = $('error');
      banner.hidden = true;
      delete banner.dataset.action;
      $('error-message').textContent = '';
      const target = genericReturnFocus;
      genericReturnFocus = undefined;
      if (restoreFocus && target?.isConnected !== false && typeof target?.focus === 'function') target.focus({ preventScroll: true });
    }

    function dismiss() {
      hideGeneric(true);
    }

    function begin(name) {
      const target = targets[name];
      if (target) clearInline(target);
      else if ($('error').dataset.action === name) hideGeneric(false);
    }

    function clearValidation(name) {
      const target = targets[name];
      if (target && $(target.id).dataset.errorKind === 'validation') clearInline(target);
    }

    function hasValidation(name) {
      const target = targets[name];
      return !!target && $(target.id).dataset.errorKind === 'validation';
    }

    function validation(name, message) {
      const target = targets[name];
      if (target) showInline(target, String(message), 'validation');
    }

    function failure(name, message, returnFocus) {
      const target = targets[name];
      if (target) return showInline(target, describeFailure(name, message), 'operation');
      const banner = $('error');
      genericReturnFocus = returnFocus;
      $('error-message').textContent = describeFailure(name, message);
      banner.dataset.action = name;
      banner.hidden = false;
    }

    function render(state) {
      latestState = state || {};
      for (const target of uniqueTargets) {
        const element = $(target.id);
        const text = normalText(target);
        if (!element.classList.contains('inline-error') && element.textContent !== text) element.textContent = text;
      }
    }

    return { begin, clearValidation, dismiss, failure, hasValidation, render, validation };
  }

  return { create, describeFailure, scopeFor };
});

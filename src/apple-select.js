// Apple-inspired Liquid Glass Select component
(function (root) {
  let activeMenu = null;

  function closeActiveMenu() {
    if (!activeMenu) return;
    const { menu, trigger, onKeydown } = activeMenu;
    menu.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKeydown);
    activeMenu = null;
  }

  document.addEventListener('click', event => {
    if (activeMenu && !event.target.closest('.apple-select')) {
      closeActiveMenu();
    }
  });

  function setupSelect(select) {
    if (select.dataset.appleSelect) return;
    select.dataset.appleSelect = 'true';

    const wrapper = document.createElement('div');
    wrapper.className = 'apple-select';
    select.parentNode.insertBefore(wrapper, select);
    wrapper.appendChild(select);

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'apple-select-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    const label = document.createElement('span');
    label.className = 'apple-select-label';

    const chevron = document.createElement('span');
    chevron.className = 'apple-select-chevron';
    chevron.innerHTML = '<svg width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    trigger.append(label, chevron);
    wrapper.appendChild(trigger);

    const menu = document.createElement('div');
    menu.className = 'apple-select-menu';
    menu.setAttribute('role', 'listbox');
    wrapper.appendChild(menu);

    function syncOptions() {
      menu.innerHTML = '';
      const selectedIndex = select.selectedIndex >= 0 ? select.selectedIndex : 0;
      const options = Array.from(select.options);
      
      label.textContent = options[selectedIndex]?.text || '';

      options.forEach((opt, index) => {
        const item = document.createElement('div');
        item.className = 'apple-select-option';
        item.setAttribute('role', 'option');
        item.dataset.value = opt.value;
        const isSelected = index === selectedIndex;
        if (isSelected) item.classList.add('selected');

        const itemText = document.createElement('span');
        itemText.className = 'apple-select-option-text';
        itemText.textContent = opt.text;

        const checkmark = document.createElement('span');
        checkmark.className = 'apple-select-checkmark';
        checkmark.innerHTML = '<svg width="12" height="10" viewBox="0 0 12 10" fill="none"><path d="M1 5L4.5 8.5L11 1.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

        item.append(itemText, checkmark);

        item.addEventListener('click', e => {
          e.stopPropagation();
          if (select.value !== opt.value) {
            select.value = opt.value;
            select.dispatchEvent(new Event('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
          syncOptions();
          closeActiveMenu();
          trigger.focus();
        });

        menu.appendChild(item);
      });
    }

    function onKeydown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeActiveMenu();
        trigger.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        const next = Math.max(0, Math.min(select.options.length - 1, select.selectedIndex + delta));
        if (next !== select.selectedIndex) {
          select.selectedIndex = next;
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
          syncOptions();
        }
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        closeActiveMenu();
        trigger.focus();
      }
    }

    trigger.addEventListener('click', e => {
      e.stopPropagation();
      const isOpen = menu.classList.contains('open');
      if (isOpen) {
        closeActiveMenu();
      } else {
        closeActiveMenu();
        syncOptions();
        menu.classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');
        activeMenu = { menu, trigger, onKeydown };
        document.addEventListener('keydown', onKeydown);
      }
    });

    select.addEventListener('change', syncOptions);

    // Watch for dynamic options
    const observer = new MutationObserver(syncOptions);
    observer.observe(select, { childList: true, subtree: true });

    // Hide select from accessibility tree and keyboard tab order since trigger is interactive
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    // Clicking label outside the select trigger focuses the trigger
    const labelEl = select.closest('label');
    if (labelEl) {
      labelEl.addEventListener('click', e => {
        if (!e.target.closest('.apple-select')) {
          trigger.focus();
        }
      });
    }

    // Proxy value setter to keep trigger label updated
    const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    if (descriptor && descriptor.set) {
      const originalSet = descriptor.set;
      Object.defineProperty(select, 'value', {
        set(val) {
          originalSet.call(this, val);
          syncOptions();
        },
        get() {
          return descriptor.get.call(this);
        },
        configurable: true
      });
    }

    const indexDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
    if (indexDescriptor && indexDescriptor.set) {
      const originalIndexSet = indexDescriptor.set;
      Object.defineProperty(select, 'selectedIndex', {
        set(val) {
          originalIndexSet.call(this, val);
          syncOptions();
        },
        get() {
          return indexDescriptor.get.call(this);
        },
        configurable: true
      });
    }

    syncOptions();
  }

  function install() {
    document.querySelectorAll('select:not([data-apple-select])').forEach(setupSelect);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    setTimeout(install, 0);
  }

  root.AppleSelect = { install, setupSelect };
})(globalThis);

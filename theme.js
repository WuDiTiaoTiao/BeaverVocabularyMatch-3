(() => {
  const storageKey = 'synonym-match.theme.v1';
  const themes = [
    { id: 'blue', label: '蓝色', color: '#397ccc' },
    { id: 'purple', label: '紫色', color: '#666ac4' },
    { id: 'green', label: '绿色', color: '#107f86' },
  ];
  let current = 0;
  try {
    const saved = localStorage.getItem(storageKey);
    const index = themes.findIndex(theme => theme.id === saved);
    if (index >= 0) current = index;
  } catch {
    // The theme remains switchable when browser storage is unavailable.
  }

  const applyTheme = () => {
    const theme = themes[current];
    document.documentElement.dataset.theme = theme.id;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme.color;
    const label = document.querySelector('#theme-label');
    if (label) label.textContent = theme.label;
    const button = document.querySelector('#theme-button');
    if (button) {
      const next = themes[(current + 1) % themes.length];
      button.setAttribute('aria-label', `切换主题，当前${theme.label}，点击切换为${next.label}`);
      button.title = `切换为${next.label}主题`;
    }
  };

  // Run before the stylesheet paints so a remembered theme does not flash blue.
  applyTheme();
  document.addEventListener('DOMContentLoaded', () => {
    applyTheme();
    document.querySelector('#theme-button')?.addEventListener('click', () => {
      current = (current + 1) % themes.length;
      applyTheme();
      try { localStorage.setItem(storageKey, themes[current].id); } catch { /* Session-only theme. */ }
    });
  }, { once: true });
})();

(() => {
  const storageKey = 'theme';
  const root = document.documentElement;

  function applyTheme(theme) {
    const isDark = theme === 'dark';
    root.classList.toggle('dark', isDark);
    localStorage.setItem(storageKey, isDark ? 'dark' : 'light');

    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
      const label = isDark ? '라이트 모드로 전환' : '다크 모드로 전환';
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
      button.querySelector('.theme-icon.light')?.toggleAttribute('hidden', !isDark);
      button.querySelector('.theme-icon.dark')?.toggleAttribute('hidden', isDark);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(localStorage.getItem(storageKey) === 'dark' ? 'dark' : 'light');

    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
      button.addEventListener('click', () => {
        applyTheme(root.classList.contains('dark') ? 'light' : 'dark');
      });
    });
  });
})();

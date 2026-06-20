(() => {
  const root = document.querySelector('[data-owner-admin]');
  if (!root) return;

  const apiBase = document.querySelector('meta[name="community-api-base"]')?.content;
  const form = root.querySelector('[data-owner-admin-form]');
  const status = root.querySelector('[data-owner-admin-status]');
  const actions = root.querySelector('[data-owner-admin-actions]');
  const logout = root.querySelector('[data-owner-admin-logout]');
  const storageKey = 'blog-community-owner-session';

  if (!apiBase) {
    status.textContent = '커뮤니티 API 설정을 찾을 수 없습니다.';
    form.querySelector('button').disabled = true;
    return;
  }

  updateState();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    status.textContent = '인증하고 있습니다…';
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const response = await fetch(`${apiBase}/api/owner/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: new FormData(form).get('secret') }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || '인증하지 못했습니다.');
      localStorage.setItem(storageKey, result.token);
      form.reset();
      status.textContent = '';
      updateState();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  logout.addEventListener('click', () => {
    localStorage.removeItem(storageKey);
    updateState();
  });

  function updateState() {
    const authenticated = hasValidStoredSession();
    form.hidden = authenticated;
    actions.hidden = !authenticated;
  }

  function hasValidStoredSession() {
    const token = localStorage.getItem(storageKey) || '';
    if (!token) return false;
    try {
      const encodedPayload = token.split('.')[0];
      const normalized = encodedPayload.replaceAll('-', '+').replaceAll('_', '/');
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
      const payload = JSON.parse(atob(padded));
      if (payload.role === 'owner' && Number(payload.exp) > Math.floor(Date.now() / 1000)) return true;
    } catch {
      // Invalid or legacy owner sessions are cleared below.
    }
    localStorage.removeItem(storageKey);
    return false;
  }
})();

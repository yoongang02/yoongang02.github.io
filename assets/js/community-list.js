(() => {
  const apiBase = document.querySelector('meta[name="community-api-base"]')?.content;
  const cards = [...document.querySelectorAll('[data-post-card-id]')];
  if (!apiBase || !cards.length) return;

  const postIds = [...new Set(cards.map((card) => card.dataset.postCardId).filter(Boolean))];
  fetch(`${apiBase}/api/reactions/counts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ post_ids: postIds }),
  })
    .then((response) => {
      if (!response.ok) throw new Error('Reaction counts request failed');
      return response.json();
    })
    .then(({ counts = {} }) => {
      cards.forEach((card) => {
        const count = Number(counts[card.dataset.postCardId] || 0);
        const target = card.querySelector('[data-card-reaction-count]');
        if (target) target.textContent = String(count);
      });
    })
    .catch(() => {
      document.querySelectorAll('.post-card-reactions').forEach((element) => {
        element.hidden = true;
      });
    });
})();

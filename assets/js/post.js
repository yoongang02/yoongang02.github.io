(() => {
  const copyButton = document.querySelector('[data-copy-url]');
  const copyLabel = document.querySelector('[data-copy-label]');

  copyButton?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      copyButton.classList.add('is-copied');
      copyLabel.textContent = '복사됨';
      window.setTimeout(() => {
        copyButton.classList.remove('is-copied');
        copyLabel.textContent = '공유';
      }, 1600);
    } catch {
      window.prompt('게시글 주소를 복사하세요.', window.location.href);
    }
  });

  const tocLinks = [...document.querySelectorAll('[data-post-toc] a')];
  const headings = tocLinks
    .map((link) => document.querySelector(decodeURIComponent(link.hash)))
    .filter(Boolean);

  if (!headings.length) return;

  const updateActiveHeading = () => {
    const current = [...headings]
      .reverse()
      .find((heading) => heading.getBoundingClientRect().top <= 140) || headings[0];

    tocLinks.forEach((link) => {
      const active = decodeURIComponent(link.hash) === `#${current.id}`;
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  };

  updateActiveHeading();
  window.addEventListener('scroll', updateActiveHeading, { passive: true });

  document.querySelectorAll('.post-toc-mobile a').forEach((link) => {
    link.addEventListener('click', () => {
      link.closest('details')?.removeAttribute('open');
    });
  });
})();

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

  setupTableOfContents();
  setupCommunity();

  function setupTableOfContents() {
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
  }

  function setupCommunity() {
    const apiBase = document.querySelector('meta[name="community-api-base"]')?.content;
    const siteKey = document.querySelector('meta[name="community-turnstile-site-key"]')?.content;
    const postId = document.querySelector('[data-post-id]')?.dataset.postId;
    if (!apiBase || !postId) return;

    const visitorId = getVisitorId();
    setupReaction({ apiBase, siteKey, postId, visitorId });
    setupComments({ apiBase, siteKey, postId });
  }

  function setupReaction({ apiBase, siteKey, postId, visitorId }) {
    const button = document.querySelector('[data-reaction-button]');
    const countTargets = [...document.querySelectorAll('[data-reaction-count]')];
    if (!button || !countTargets.length) return;

    requestJson(`${apiBase}/api/posts/${encodeURIComponent(postId)}/reactions?visitor_id=${encodeURIComponent(visitorId)}`)
      .then(updateReaction)
      .catch(() => {
        button.disabled = true;
        button.title = '하트 정보를 불러오지 못했습니다.';
      });

    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const token = await getTurnstileToken(siteKey, 'reaction');
        const result = await requestJson(`${apiBase}/api/posts/${encodeURIComponent(postId)}/reactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ visitor_id: visitorId, turnstile_token: token }),
        });
        updateReaction(result);
        if (result.reacted) playReactionAnimation();
      } catch (error) {
        button.title = error.message;
      } finally {
        button.disabled = false;
      }
    });

    function updateReaction({ count = 0, reacted = false }) {
      countTargets.forEach((target) => {
        target.textContent = String(count);
      });
      button.classList.toggle('is-reacted', reacted);
      button.setAttribute('aria-pressed', String(reacted));
      button.setAttribute('aria-label', reacted ? '이 게시글의 하트 취소하기' : '이 게시글에 하트 남기기');
    }

    function playReactionAnimation() {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const icon = button.querySelector('svg');
      if (!icon) return;

      const burst = document.createElement('span');
      burst.className = 'post-reaction-burst';
      burst.setAttribute('aria-hidden', 'true');
      burst.append(icon.cloneNode(true));
      button.append(burst);
      burst.addEventListener('animationend', () => burst.remove(), { once: true });
    }
  }

  function setupComments({ apiBase, siteKey, postId }) {
    const section = document.querySelector('[data-community-comments]');
    if (!section) return;

    const list = section.querySelector('[data-comment-list]');
    const count = section.querySelector('[data-comment-count]');
    const form = section.querySelector('[data-comment-form]');
    const formStatus = section.querySelector('[data-comment-form-status]');
    const submitButton = section.querySelector('[data-comment-submit]');
    const deleteDialog = section.querySelector('[data-comment-delete-dialog]');
    const deleteForm = section.querySelector('[data-comment-delete-form]');
    const deleteStatus = section.querySelector('[data-comment-delete-status]');
    const ownerStorageKey = 'blog-community-owner-session';
    let comments = [];
    let ownerToken = localStorage.getItem(ownerStorageKey) || '';
    let deletingId = null;

    updateOwnerMode();
    loadComments();

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      setFormStatus('댓글을 등록하고 있습니다…');
      submitButton.disabled = true;
      const data = new FormData(form);

      try {
        const turnstileToken = await getTurnstileToken(siteKey, 'comment_create');
        await requestJson(`${apiBase}/api/posts/${encodeURIComponent(postId)}/comments`, {
          method: 'POST',
          headers: requestHeaders(),
          body: JSON.stringify({
            nickname: data.get('nickname'),
            body: data.get('body'),
            turnstile_token: turnstileToken,
          }),
        });
        form.reset();
        setFormStatus('댓글이 저장되었습니다.');
        await loadComments();
      } catch (error) {
        handleOwnerError(error);
        setFormStatus(error.message, true);
      } finally {
        submitButton.disabled = false;
      }
    });

    list.addEventListener('click', (event) => {
      const button = event.target.closest('[data-comment-action]');
      if (!button) return;
      const comment = comments.find(({ id }) => id === button.dataset.commentId);
      if (!comment) return;

      if (button.dataset.commentAction === 'toggle-replies') {
        const thread = button.closest('.community-comment-thread');
        const replies = thread?.querySelector('.community-replies');
        if (!replies) return;
        const willOpen = replies.hidden;
        if (willOpen) {
          setReplyThreadOpen(thread, true);
          openReplyForm(comment, replies);
        } else {
          closeReplyThread(thread);
        }
      }

      if (button.dataset.commentAction === 'reply') {
        const thread = button.closest('.community-comment-thread');
        const replies = thread?.querySelector('.community-replies');
        if (!replies) return;
        setReplyThreadOpen(thread, true);
        openReplyForm(comment, replies);
      }

      if (button.dataset.commentAction === 'delete') {
        deletingId = comment.id;
        deleteStatus.textContent = '';
        deleteDialog.showModal();
      }
    });

    deleteForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (event.submitter?.value === 'cancel') {
        deleteDialog.close();
        deletingId = null;
        return;
      }
      if (!deletingId) return;

      deleteStatus.textContent = '댓글을 삭제하고 있습니다…';
      try {
        await requestJson(`${apiBase}/api/comments/${encodeURIComponent(deletingId)}`, {
          method: 'DELETE',
          headers: requestHeaders(),
        });
        deleteDialog.close();
        deletingId = null;
        await loadComments();
      } catch (error) {
        handleOwnerError(error);
        deleteStatus.textContent = error.message;
      }
    });

    async function loadComments(openThreadId = '') {
      try {
        const result = await requestJson(`${apiBase}/api/posts/${encodeURIComponent(postId)}/comments`);
        comments = result.comments || [];
        renderComments(comments, openThreadId);
      } catch (error) {
        setFormStatus(error.message, true);
      }
    }

    function renderComments(items, openThreadId = '') {
      list.replaceChildren();
      count.textContent = String(items.filter(({ status }) => status === 'visible').length);

      const byId = new Map(items.map((comment) => [comment.id, comment]));
      const children = new Map();
      items.forEach((comment) => {
        if (!comment.parent_id || !byId.has(comment.parent_id)) return;
        const group = children.get(comment.parent_id) || [];
        group.push(comment);
        children.set(comment.parent_id, group);
      });

      items
        .filter((comment) => !comment.parent_id || !byId.has(comment.parent_id))
        .forEach((root) => list.append(createThread(root, children, byId, root.id === openThreadId)));
    }

    function createThread(root, children, byId, isOpen) {
      const thread = document.createElement('section');
      thread.className = 'community-comment-thread';
      thread.dataset.rootId = root.id;
      thread.append(createCommentCard(root, false, byId));

      const descendants = collectDescendants(root.id, children);
      const replyCount = descendants.filter(({ status }) => status === 'visible').length;
      if (root.status === 'visible') {
        const toggle = actionButton(
          replyCount ? `${replyCount}개의 답글` : '답글 달기',
          'toggle-replies',
          root.id,
          'square-plus',
        );
        toggle.className = 'community-reply-toggle';
        toggle.dataset.replyCount = String(replyCount);
        toggle.setAttribute('aria-expanded', String(isOpen));
        toggle.classList.toggle('is-open', isOpen);
        thread.append(toggle);
      }

      const replies = document.createElement('div');
      replies.className = 'community-replies';
      replies.hidden = !isOpen;
      descendants.forEach((reply) => replies.append(createCommentCard(reply, true, byId)));
      thread.append(replies);
      return thread;
    }

    function createCommentCard(comment, isReply, byId) {
      const article = document.createElement('article');
      article.className = [
        'community-comment',
        isReply ? 'is-reply' : '',
        comment.is_owner ? 'is-owner' : '',
        comment.status === 'deleted' ? 'is-deleted' : '',
      ].filter(Boolean).join(' ');
      article.dataset.commentId = comment.id;

      const header = document.createElement('header');
      const meta = document.createElement('div');
      meta.className = 'community-comment-meta';
      const author = document.createElement('strong');
      author.textContent = comment.status === 'deleted' ? '삭제된 댓글' : comment.nickname;
      const separator = document.createElement('span');
      separator.textContent = '·';
      separator.setAttribute('aria-hidden', 'true');
      const time = document.createElement('time');
      time.dateTime = comment.created_at;
      time.title = formatExactDate(comment.updated_at || comment.created_at);
      time.textContent = formatRelativeTime(comment.updated_at || comment.created_at);
      meta.append(author, separator, time);
      header.append(meta);

      if (ownerToken && comment.status === 'visible') {
        const actions = document.createElement('div');
        actions.className = 'community-owner-actions';
        actions.append(actionButton('댓글 삭제', 'delete', comment.id, 'trash'));
        header.append(actions);
      }

      const body = document.createElement('p');
      if (isReply && comment.status === 'visible') {
        const parent = byId.get(comment.parent_id);
        if (parent?.parent_id && parent.nickname) {
          const mention = document.createElement('span');
          mention.className = 'community-comment-mention';
          mention.textContent = `@${parent.nickname} `;
          body.append(mention);
        }
      }
      body.append(document.createTextNode(comment.body));
      article.append(header, body);

      if (isReply && comment.status === 'visible') {
        const reply = actionButton('답글 달기', 'reply', comment.id, 'square-plus');
        reply.className = 'community-reply-add';
        article.append(reply);
      }
      return article;
    }

    function collectDescendants(parentId, children) {
      const result = [];
      const visit = (id) => {
        (children.get(id) || []).forEach((child) => {
          result.push(child);
          visit(child.id);
        });
      };
      visit(parentId);
      return result;
    }

    function openReplyForm(target, container) {
      clearReplyForms();
      const replyForm = document.createElement('form');
      replyForm.className = 'community-inline-reply-form';

      const context = document.createElement('p');
      context.textContent = ownerToken
        ? `주인장으로 ${target.nickname || '댓글'}에게 답글`
        : `${target.nickname || '댓글'}에게 답글`;
      replyForm.append(context);

      if (!ownerToken) {
        const nickname = document.createElement('input');
        nickname.name = 'nickname';
        nickname.type = 'text';
        nickname.minLength = 2;
        nickname.maxLength = 8;
        nickname.placeholder = '닉네임';
        nickname.setAttribute('aria-label', '닉네임');
        nickname.required = true;
        replyForm.append(nickname);
      } else {
        replyForm.classList.add('is-owner');
      }

      const textarea = document.createElement('textarea');
      textarea.name = 'body';
      textarea.rows = 2;
      textarea.maxLength = 1500;
      textarea.placeholder = '답글을 입력하세요.';
      textarea.setAttribute('aria-label', '답글 내용');
      textarea.required = true;
      replyForm.append(textarea);

      const footer = document.createElement('div');
      footer.className = 'community-inline-reply-footer';
      const status = document.createElement('p');
      status.setAttribute('aria-live', 'polite');
      const actions = document.createElement('div');
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'community-button community-button-secondary';
      cancel.textContent = '취소';
      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.className = 'community-button';
      submit.textContent = '작성';
      actions.append(cancel, submit);
      footer.append(status, actions);
      replyForm.append(footer);

      cancel.addEventListener('click', () => {
        closeReplyThread(replyForm.closest('.community-comment-thread'));
      });
      replyForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        submit.disabled = true;
        status.textContent = '답글을 등록하고 있습니다…';
        const data = new FormData(replyForm);
        try {
          const turnstileToken = await getTurnstileToken(siteKey, 'comment_create');
          await requestJson(`${apiBase}/api/posts/${encodeURIComponent(postId)}/comments`, {
            method: 'POST',
            headers: requestHeaders(),
            body: JSON.stringify({
              nickname: data.get('nickname'),
              body: data.get('body'),
              parent_id: target.id,
              turnstile_token: turnstileToken,
            }),
          });
          await loadComments(findRootId(target, comments));
        } catch (error) {
          handleOwnerError(error);
          status.textContent = error.message;
          submit.disabled = false;
        }
      });

      container.append(replyForm);
      textarea.focus();
    }

    function clearReplyForms(scope = list) {
      scope.querySelectorAll('.community-inline-reply-form').forEach((replyForm) => replyForm.remove());
    }

    function setReplyThreadOpen(thread, isOpen) {
      if (!thread) return;
      const replies = thread.querySelector('.community-replies');
      const toggle = thread.querySelector('[data-comment-action="toggle-replies"]');
      if (!replies) return;
      replies.hidden = !isOpen;
      toggle?.classList.toggle('is-open', isOpen);
      toggle?.setAttribute('aria-expanded', String(isOpen));
    }

    function closeReplyThread(thread) {
      if (!thread) return;
      clearReplyForms(thread);
      setReplyThreadOpen(thread, false);
    }

    function findRootId(comment, items) {
      const byId = new Map(items.map((item) => [item.id, item]));
      let current = comment;
      while (current.parent_id && byId.has(current.parent_id)) current = byId.get(current.parent_id);
      return current.id;
    }

    function setFormStatus(message, isError = false) {
      formStatus.textContent = message;
      formStatus.classList.toggle('is-error', isError);
    }

    function requestHeaders() {
      const headers = { 'Content-Type': 'application/json' };
      if (ownerToken) headers.Authorization = `Bearer ${ownerToken}`;
      return headers;
    }

    function updateOwnerMode() {
      section.classList.toggle('is-owner-mode', Boolean(ownerToken));
      const nickname = form.elements.nickname;
      nickname.hidden = Boolean(ownerToken);
      nickname.required = !ownerToken;
      setFormStatus(ownerToken ? '주인장으로 댓글을 작성합니다.' : '');
    }

    function clearOwnerSession() {
      ownerToken = '';
      localStorage.removeItem(ownerStorageKey);
      updateOwnerMode();
    }

    function handleOwnerError(error) {
      if (ownerToken && /주인장 권한/i.test(error.message)) clearOwnerSession();
    }
  }

  function actionButton(label, action, id, iconName) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', label);
    if (iconName) button.append(commentIcon(iconName));
    const text = document.createElement('span');
    text.textContent = label;
    button.append(text);
    button.dataset.commentAction = action;
    button.dataset.commentId = id;
    return button;
  }

  function commentIcon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = name === 'trash'
      ? '<path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5"/>'
      : '<rect x="4" y="4" width="16" height="16" rx="2"/><path data-icon-plus d="M12 8v8"/><path d="M8 12h8"/>';
    return svg;
  }

  function getVisitorId() {
    const key = 'blog-community-visitor-id';
    let value = localStorage.getItem(key);
    if (!value) {
      value = crypto.randomUUID();
      localStorage.setItem(key, value);
    }
    document.cookie = `${key}=${value}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`;
    return value;
  }

  async function getTurnstileToken(siteKey, action) {
    if (!siteKey) return '';
    await loadTurnstile();
    return new Promise((resolve, reject) => {
      const container = document.createElement('div');
      container.className = 'community-turnstile';
      document.body.append(container);
      let widgetId;
      const cleanup = () => {
        if (widgetId !== undefined) window.turnstile.remove(widgetId);
        container.remove();
      };
      widgetId = window.turnstile.render(container, {
        sitekey: siteKey,
        size: 'invisible',
        execution: 'execute',
        action,
        callback(token) {
          cleanup();
          resolve(token);
        },
        'error-callback'() {
          cleanup();
          reject(new Error('자동 요청 방지 인증을 완료하지 못했습니다.'));
        },
        'expired-callback'() {
          cleanup();
          reject(new Error('자동 요청 방지 인증이 만료되었습니다.'));
        },
      });
      window.turnstile.execute(widgetId);
    });
  }

  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve();
    if (window.communityTurnstilePromise) return window.communityTurnstilePromise;
    window.communityTurnstilePromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error('자동 요청 방지 모듈을 불러오지 못했습니다.'));
      document.head.append(script);
    });
    return window.communityTurnstilePromise;
  }

  async function requestJson(url, options) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '요청을 처리하지 못했습니다.');
    return data;
  }

  function formatRelativeTime(value) {
    const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const month = 30 * day;
    const year = 365 * day;
    if (elapsed < minute) return '방금 전';
    if (elapsed < hour) return `${Math.floor(elapsed / minute)}분 전`;
    if (elapsed < day) return `${Math.floor(elapsed / hour)}시간 전`;
    if (elapsed < month) return `${Math.floor(elapsed / day)}일 전`;
    if (elapsed < year) return `${Math.floor(elapsed / month)}개월 전`;
    return `${Math.floor(elapsed / year)}년 전`;
  }

  function formatExactDate(value) {
    return new Intl.DateTimeFormat('ko-KR', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  }
})();

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
  }

  function setupComments({ apiBase, siteKey, postId }) {
    const section = document.querySelector('[data-community-comments]');
    if (!section) return;

    const list = section.querySelector('[data-comment-list]');
    const empty = section.querySelector('[data-comment-empty]');
    const count = section.querySelector('[data-comment-count]');
    const form = section.querySelector('[data-comment-form]');
    const formStatus = section.querySelector('[data-comment-form-status]');
    const submitButton = section.querySelector('[data-comment-submit]');
    const editCancel = section.querySelector('[data-comment-edit-cancel]');
    const replyContext = section.querySelector('[data-comment-reply-context]');
    const replyName = section.querySelector('[data-comment-reply-name]');
    const replyCancel = section.querySelector('[data-comment-reply-cancel]');
    const deleteDialog = section.querySelector('[data-comment-delete-dialog]');
    const deleteForm = section.querySelector('[data-comment-delete-form]');
    const deleteStatus = section.querySelector('[data-comment-delete-status]');
    let comments = [];
    let editingId = null;
    let replyingTo = null;
    let deletingId = null;

    loadComments();

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      setFormStatus(editingId ? '댓글을 수정하고 있습니다…' : '댓글을 등록하고 있습니다…');
      submitButton.disabled = true;
      const data = new FormData(form);

      try {
        const token = await getTurnstileToken(siteKey, editingId ? 'comment_edit' : 'comment_create');
        const payload = {
          nickname: data.get('nickname'),
          password: data.get('password'),
          body: data.get('body'),
          turnstile_token: token,
        };
        if (!editingId && replyingTo) payload.parent_id = replyingTo.id;
        const path = editingId
          ? `${apiBase}/api/comments/${encodeURIComponent(editingId)}`
          : `${apiBase}/api/posts/${encodeURIComponent(postId)}/comments`;
        await requestJson(path, {
          method: editingId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        form.reset();
        cancelEdit();
        cancelReply();
        setFormStatus('댓글이 저장되었습니다.');
        await loadComments();
      } catch (error) {
        setFormStatus(error.message, true);
      } finally {
        submitButton.disabled = false;
      }
    });

    editCancel.addEventListener('click', () => {
      form.reset();
      cancelEdit();
      cancelReply();
      setFormStatus('');
    });

    replyCancel.addEventListener('click', () => {
      cancelReply();
      setFormStatus('');
    });

    list.addEventListener('click', (event) => {
      const actionButton = event.target.closest('[data-comment-action]');
      if (!actionButton) return;
      const comment = comments.find(({ id }) => id === actionButton.dataset.commentId);
      if (!comment) return;

      if (actionButton.dataset.commentAction === 'edit') {
        cancelReply();
        editingId = comment.id;
        form.elements.nickname.value = comment.nickname;
        form.elements.body.value = comment.body;
        form.elements.password.value = '';
        submitButton.textContent = '댓글 수정';
        editCancel.hidden = false;
        focusCommentForm();
      }

      if (actionButton.dataset.commentAction === 'reply') {
        cancelEdit();
        replyingTo = comment;
        replyName.textContent = comment.nickname;
        replyContext.hidden = false;
        submitButton.textContent = '답글 남기기';
        focusCommentForm();
      }

      if (actionButton.dataset.commentAction === 'delete') {
        deletingId = comment.id;
        deleteStatus.textContent = '';
        deleteForm.reset();
        deleteDialog.showModal();
      }
    });

    deleteForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const submitter = event.submitter?.value;
      if (submitter === 'cancel') {
        deleteDialog.close();
        deletingId = null;
        return;
      }
      if (!deletingId) return;

      deleteStatus.textContent = '댓글을 삭제하고 있습니다…';
      const password = new FormData(deleteForm).get('password');
      try {
        const token = await getTurnstileToken(siteKey, 'comment_delete');
        await requestJson(`${apiBase}/api/comments/${encodeURIComponent(deletingId)}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password, turnstile_token: token }),
        });
        deleteDialog.close();
        deletingId = null;
        await loadComments();
      } catch (error) {
        deleteStatus.textContent = error.message;
      }
    });

    async function loadComments() {
      try {
        const result = await requestJson(`${apiBase}/api/posts/${encodeURIComponent(postId)}/comments`);
        comments = result.comments || [];
        renderComments(comments);
      } catch (error) {
        empty.hidden = false;
        empty.textContent = error.message;
      }
    }

    function renderComments(items) {
      list.querySelectorAll('.community-comment').forEach((element) => element.remove());
      empty.hidden = items.length > 0;
      count.textContent = String(items.filter(({ status }) => status === 'visible').length);

      const repliesByParent = new Map();
      const rootComments = [];
      items.forEach((comment) => {
        if (!comment.parent_id) {
          rootComments.push(comment);
          return;
        }
        const replies = repliesByParent.get(comment.parent_id) || [];
        replies.push(comment);
        repliesByParent.set(comment.parent_id, replies);
      });

      rootComments.forEach((comment) => {
        appendComment(comment);
        (repliesByParent.get(comment.id) || []).forEach((reply) => appendComment(reply, true));
      });

      items
        .filter((comment) => comment.parent_id && !items.some(({ id }) => id === comment.parent_id))
        .forEach((comment) => appendComment(comment, true));
    }

    function appendComment(comment, isReply = false) {
        const article = document.createElement('article');
        article.className = [
          'community-comment',
          isReply ? 'is-reply' : '',
          comment.status === 'deleted' ? 'is-deleted' : '',
        ].filter(Boolean).join(' ');

        const header = document.createElement('header');
        const author = document.createElement('strong');
        author.textContent = comment.status === 'deleted' ? '삭제된 댓글' : comment.nickname;
        const time = document.createElement('time');
        time.dateTime = comment.created_at;
        time.textContent = formatDate(comment.updated_at || comment.created_at);
        header.append(author, time);

        const body = document.createElement('p');
        body.textContent = comment.body;
        article.append(header, body);

        if (comment.status === 'visible') {
          const actions = document.createElement('div');
          actions.className = 'community-comment-actions';
          if (!isReply) actions.append(actionButton('답글', 'reply', comment.id));
          actions.append(actionButton('수정', 'edit', comment.id), actionButton('삭제', 'delete', comment.id));
          article.append(actions);
        }
        list.append(article);
    }

    function cancelEdit() {
      editingId = null;
      if (!replyingTo) submitButton.textContent = '댓글 남기기';
      editCancel.hidden = true;
    }

    function cancelReply() {
      replyingTo = null;
      replyContext.hidden = true;
      if (!editingId) submitButton.textContent = '댓글 남기기';
    }

    function focusCommentForm() {
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
      form.elements.body.focus();
    }

    function setFormStatus(message, isError = false) {
      formStatus.textContent = message;
      formStatus.classList.toggle('is-error', isError);
    }
  }

  function actionButton(label, action, id) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.commentAction = action;
    button.dataset.commentId = id;
    return button;
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

  function formatDate(value) {
    return new Intl.DateTimeFormat('ko-KR', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  }
})();

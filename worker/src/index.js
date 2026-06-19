const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const MAX_BATCH_POSTS = 50;
const PASSWORD_ITERATIONS = 150_000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }), request, env);
    }

    try {
      if (url.pathname === '/health' && request.method === 'GET') {
        return withCors(json({ ok: true }), request, env);
      }

      if (url.pathname === '/webhooks/notion' && request.method === 'POST') {
        return handleNotionWebhook(request, env);
      }

      assertAllowedOrigin(request, env);

      if (url.pathname === '/api/reactions/counts' && request.method === 'POST') {
        return withCors(await getReactionCounts(request, env), request, env);
      }

      const reactionMatch = url.pathname.match(/^\/api\/posts\/([^/]+)\/reactions$/);
      if (reactionMatch) {
        const postId = decodeURIComponent(reactionMatch[1]);
        if (request.method === 'GET') {
          return withCors(await getReaction(postId, url, env), request, env);
        }
        if (request.method === 'POST') {
          return withCors(await toggleReaction(postId, request, env), request, env);
        }
      }

      const commentsMatch = url.pathname.match(/^\/api\/posts\/([^/]+)\/comments$/);
      if (commentsMatch) {
        const postId = decodeURIComponent(commentsMatch[1]);
        if (request.method === 'GET') {
          return withCors(await listComments(postId, env), request, env);
        }
        if (request.method === 'POST') {
          return withCors(await createComment(postId, request, env), request, env);
        }
      }

      const commentMatch = url.pathname.match(/^\/api\/comments\/([^/]+)$/);
      if (commentMatch && ['PATCH', 'DELETE'].includes(request.method)) {
        return withCors(
          await updateComment(decodeURIComponent(commentMatch[1]), request, env),
          request,
          env,
        );
      }

      return withCors(json({ error: 'Not found' }, 404), request, env);
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) console.error(error);
      return withCors(json({ error: error.message || 'Internal server error' }, status), request, env);
    }
  },
};

async function handleNotionWebhook(request, env) {
  const secret = request.headers.get('X-Webhook-Secret');
  if (!env.NOTION_WEBHOOK_SECRET || !timingSafeEqual(secret || '', env.NOTION_WEBHOOK_SECRET)) {
    return json({ error: 'Unauthorized' }, 401);
  }
  if (!env.GITHUB_TOKEN) return json({ error: 'GitHub token is not configured' }, 503);

  const payload = await readJson(request);
  const repository = env.GITHUB_REPOSITORY || 'yoongang02/yoongang02.github.io';
  const response = await fetch(`https://api.github.com/repos/${repository}/dispatches`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'yoongang-blog-publisher',
      'X-GitHub-Api-Version': '2026-03-10',
    },
    body: JSON.stringify({
      event_type: 'notion-publish',
      client_payload: {
        source: 'notion-automation',
        received_at: new Date().toISOString(),
        trigger_page_id: findNotionPageId(payload),
      },
    }),
  });

  if (!response.ok) {
    console.error('GitHub dispatch failed', response.status, await response.text());
    return json({ error: 'GitHub dispatch failed' }, 502);
  }
  return json({ accepted: true }, 202);
}

async function getReaction(postId, url, env) {
  validatePostId(postId);
  const visitorId = url.searchParams.get('visitor_id');
  const countRow = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM reactions WHERE post_id = ?',
  ).bind(postId).first();

  let reacted = false;
  if (visitorId) {
    validateVisitorId(visitorId);
    const visitorHash = await hashVisitor(visitorId, env);
    reacted = Boolean(await env.DB.prepare(
      'SELECT 1 AS found FROM reactions WHERE post_id = ? AND visitor_hash = ?',
    ).bind(postId, visitorHash).first());
  }

  return json({ count: Number(countRow?.count || 0), reacted });
}

async function getReactionCounts(request, env) {
  const { post_ids: postIds } = await readJson(request);
  if (!Array.isArray(postIds) || postIds.length > MAX_BATCH_POSTS) {
    throw httpError(400, `post_ids must be an array with at most ${MAX_BATCH_POSTS} items`);
  }
  const uniquePostIds = [...new Set(postIds.map(String))];
  uniquePostIds.forEach(validatePostId);
  if (!uniquePostIds.length) return json({ counts: {} });

  const placeholders = uniquePostIds.map(() => '?').join(',');
  const result = await env.DB.prepare(
    `SELECT post_id, COUNT(*) AS count
     FROM reactions
     WHERE post_id IN (${placeholders})
     GROUP BY post_id`,
  ).bind(...uniquePostIds).all();

  const counts = Object.fromEntries(uniquePostIds.map((postId) => [postId, 0]));
  for (const row of result.results || []) counts[row.post_id] = Number(row.count);
  return json({ counts });
}

async function toggleReaction(postId, request, env) {
  validatePostId(postId);
  const body = await readJson(request);
  validateVisitorId(body.visitor_id);
  await verifyTurnstile(body.turnstile_token, request, env);

  const visitorHash = await hashVisitor(body.visitor_id, env);
  await enforceRateLimit(`reaction:${visitorHash}`, 20, 60, env);

  const existing = await env.DB.prepare(
    'SELECT 1 AS found FROM reactions WHERE post_id = ? AND visitor_hash = ?',
  ).bind(postId, visitorHash).first();

  if (existing) {
    await env.DB.prepare(
      'DELETE FROM reactions WHERE post_id = ? AND visitor_hash = ?',
    ).bind(postId, visitorHash).run();
  } else {
    await env.DB.prepare(
      'INSERT INTO reactions (post_id, visitor_hash) VALUES (?, ?)',
    ).bind(postId, visitorHash).run();
  }

  const countRow = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM reactions WHERE post_id = ?',
  ).bind(postId).first();
  return json({ count: Number(countRow?.count || 0), reacted: !existing });
}

async function listComments(postId, env) {
  validatePostId(postId);
  const result = await env.DB.prepare(
    `SELECT id, parent_id, nickname, body, status, created_at, updated_at
     FROM comments
     WHERE post_id = ? AND status IN ('visible', 'deleted')
     ORDER BY created_at ASC
     LIMIT 200`,
  ).bind(postId).all();

  const comments = (result.results || []).map((comment) => ({
    ...comment,
    nickname: comment.status === 'deleted' ? '' : comment.nickname,
    body: comment.status === 'deleted' ? '삭제된 댓글입니다.' : comment.body,
    created_at: toIsoTimestamp(comment.created_at),
    updated_at: toIsoTimestamp(comment.updated_at),
  }));
  return json({ comments });
}

async function createComment(postId, request, env) {
  validatePostId(postId);
  const body = await readJson(request);
  const nickname = cleanText(body.nickname, 2, 24, '닉네임');
  const commentBody = cleanText(body.body, 1, 1500, '댓글');
  validatePassword(body.password);
  await verifyTurnstile(body.turnstile_token, request, env);

  let parentId = null;
  if (body.parent_id) {
    validateCommentId(body.parent_id);
    const parent = await env.DB.prepare(
      `SELECT id, parent_id, status
       FROM comments
       WHERE id = ? AND post_id = ?`,
    ).bind(body.parent_id, postId).first();
    if (!parent || parent.status !== 'visible') {
      throw httpError(404, '답글을 작성할 댓글을 찾을 수 없습니다.');
    }
    if (parent.parent_id) throw httpError(400, '답글에는 추가 답글을 작성할 수 없습니다.');
    parentId = parent.id;
  }

  const clientKey = await requestClientKey(request, env);
  await enforceRateLimit(`comment:${clientKey}`, 5, 600, env);

  const salt = randomBase64(16);
  const passwordHash = await hashPassword(body.password, salt);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO comments
      (id, post_id, parent_id, nickname, body, password_hash, password_salt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, postId, parentId, nickname, commentBody, passwordHash, salt).run();

  return json({
    comment: {
      id,
      parent_id: parentId,
      nickname,
      body: commentBody,
      status: 'visible',
      created_at: new Date().toISOString(),
      updated_at: null,
    },
  }, 201);
}

async function updateComment(commentId, request, env) {
  validateCommentId(commentId);
  const body = await readJson(request);
  validatePassword(body.password);
  await verifyTurnstile(body.turnstile_token, request, env);

  const comment = await env.DB.prepare(
    'SELECT * FROM comments WHERE id = ?',
  ).bind(commentId).first();
  if (!comment || comment.status === 'hidden') throw httpError(404, '댓글을 찾을 수 없습니다.');
  if (!(await verifyPassword(body.password, comment.password_salt, comment.password_hash))) {
    throw httpError(403, '비밀번호가 올바르지 않습니다.');
  }

  if (request.method === 'DELETE') {
    await env.DB.prepare(
      `UPDATE comments
       SET status = 'deleted', nickname = '', body = '', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).bind(commentId).run();
    return json({ deleted: true });
  }

  if (comment.status === 'deleted') throw httpError(409, '삭제된 댓글은 수정할 수 없습니다.');
  const nickname = cleanText(body.nickname, 2, 24, '닉네임');
  const commentBody = cleanText(body.body, 1, 1500, '댓글');
  await env.DB.prepare(
    `UPDATE comments
     SET nickname = ?, body = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).bind(nickname, commentBody, commentId).run();
  return json({
    comment: {
      id: commentId,
      parent_id: comment.parent_id || null,
      nickname,
      body: commentBody,
      status: 'visible',
      created_at: toIsoTimestamp(comment.created_at),
      updated_at: new Date().toISOString(),
    },
  });
}

async function verifyTurnstile(token, request, env) {
  if (!env.TURNSTILE_SECRET && env.ENVIRONMENT !== 'production') return;
  if (!env.TURNSTILE_SECRET) throw httpError(503, 'Turnstile is not configured');
  if (!token) throw httpError(400, '자동 요청 방지 인증이 필요합니다.');

  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: env.TURNSTILE_SECRET,
      response: token,
      remoteip: request.headers.get('CF-Connecting-IP') || undefined,
    }),
  });
  const result = await response.json();
  if (!result.success) throw httpError(403, '자동 요청 방지 인증에 실패했습니다.');
}

async function enforceRateLimit(key, limit, windowSeconds, env) {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - windowSeconds;
  await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_started_at, request_count)
     VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       request_count = CASE
         WHEN window_started_at <= ? THEN 1
         ELSE request_count + 1
       END,
       window_started_at = CASE
         WHEN window_started_at <= ? THEN excluded.window_started_at
         ELSE window_started_at
       END`,
  ).bind(key, now, cutoff, cutoff).run();
  const row = await env.DB.prepare(
    'SELECT request_count FROM rate_limits WHERE key = ?',
  ).bind(key).first();
  if (Number(row?.request_count || 0) > limit) {
    throw httpError(429, '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
  }
}

async function requestClientKey(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  return sha256Hex(`${env.VISITOR_HASH_SECRET || 'development'}:${ip}`);
}

async function hashVisitor(visitorId, env) {
  if (!env.VISITOR_HASH_SECRET) throw httpError(503, 'Visitor hashing is not configured');
  return sha256Hex(`${env.VISITOR_HASH_SECRET}:${visitorId}`);
}

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt: base64Bytes(salt),
    iterations: PASSWORD_ITERATIONS,
  }, key, 256);
  return bytesBase64(new Uint8Array(bits));
}

async function verifyPassword(password, salt, expectedHash) {
  return timingSafeEqual(await hashPassword(password, salt), expectedHash);
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function assertAllowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return;
  const allowed = allowedOrigins(env);
  if (!allowed.includes(origin)) throw httpError(403, 'Origin is not allowed');
}

function withCors(response, request, env) {
  const origin = request.headers.get('Origin');
  const headers = new Headers(response.headers);
  if (origin && allowedOrigins(env).includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Webhook-Secret');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  }
  return new Response(response.body, { status: response.status, headers });
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw httpError(400, '올바른 JSON 요청이 아닙니다.');
  }
}

function validatePostId(value) {
  if (!value || value.length > 240 || !/^[a-zA-Z0-9가-힣/_-]+$/.test(value)) {
    throw httpError(400, '올바르지 않은 게시글 ID입니다.');
  }
}

function validateVisitorId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9-]{20,64}$/i.test(value)) {
    throw httpError(400, '올바르지 않은 방문자 ID입니다.');
  }
}

function validateCommentId(value) {
  if (!/^[a-f0-9-]{36}$/i.test(value)) throw httpError(400, '올바르지 않은 댓글 ID입니다.');
}

function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 4 || value.length > 72) {
    throw httpError(400, '비밀번호는 4자 이상 72자 이하로 입력해 주세요.');
  }
}

function cleanText(value, min, max, label) {
  if (typeof value !== 'string') throw httpError(400, `${label}을 입력해 주세요.`);
  const cleaned = value.replace(/\r\n/g, '\n').trim();
  if (cleaned.length < min || cleaned.length > max) {
    throw httpError(400, `${label}은 ${min}자 이상 ${max}자 이하로 입력해 주세요.`);
  }
  return cleaned;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
}

function randomBase64(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytesBase64(bytes);
}

function bytesBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Bytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function findNotionPageId(payload) {
  return payload?.page_id
    || payload?.data?.id
    || payload?.entity?.id
    || payload?.properties?.id
    || null;
}

function toIsoTimestamp(value) {
  if (!value) return null;
  if (value.includes('T')) return value.endsWith('Z') ? value : `${value}Z`;
  return `${value.replace(' ', 'T')}Z`;
}

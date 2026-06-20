const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const MAX_BATCH_POSTS = 50;
const OWNER_SESSION_SECONDS = 60 * 60 * 12;

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
        return handleNotionWebhook(request, env, 'publish');
      }

      if (url.pathname === '/webhooks/notion/unpublish' && request.method === 'POST') {
        return handleNotionWebhook(request, env, 'unpublish');
      }

      assertAllowedOrigin(request, env);

      if (url.pathname === '/api/reactions/counts' && request.method === 'POST') {
        return withCors(await getReactionCounts(request, env), request, env);
      }

      if (url.pathname === '/api/owner/session' && request.method === 'POST') {
        return withCors(await createOwnerSession(request, env), request, env);
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
      if (commentMatch && request.method === 'DELETE') {
        return withCors(
          await deleteCommentAsOwner(decodeURIComponent(commentMatch[1]), request, env),
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

async function handleNotionWebhook(request, env, action) {
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
      event_type: action === 'unpublish' ? 'notion-unpublish' : 'notion-publish',
      client_payload: {
        source: 'notion-automation',
        action,
        received_at: new Date().toISOString(),
        trigger_page_id: findNotionPageId(payload),
      },
    }),
  });

  if (!response.ok) {
    console.error('GitHub dispatch failed', response.status, await response.text());
    return json({ error: 'GitHub dispatch failed' }, 502);
  }
  return json({ accepted: true, action }, 202);
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
    `SELECT id, parent_id, nickname, body, status, is_owner, created_at, updated_at
     FROM comments
     WHERE post_id = ? AND status IN ('visible', 'deleted')
     ORDER BY created_at ASC
     LIMIT 200`,
  ).bind(postId).all();

  const comments = (result.results || []).map((comment) => ({
    ...comment,
    is_owner: Boolean(comment.is_owner),
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
  const isOwner = await hasValidOwnerSession(request, env);
  const nickname = isOwner ? '주인장' : cleanVisitorNickname(body.nickname);
  const commentBody = cleanText(body.body, 1, 1500, '댓글');
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
    parentId = parent.id;
  }

  const clientKey = await requestClientKey(request, env);
  if (!isOwner) await enforceRateLimit(`comment:${clientKey}`, 5, 600, env);

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO comments
      (id, post_id, parent_id, nickname, body, password_hash, password_salt, is_owner)
     VALUES (?, ?, ?, ?, ?, '', '', ?)`,
  ).bind(id, postId, parentId, nickname, commentBody, isOwner ? 1 : 0).run();

  return json({
    comment: {
      id,
      parent_id: parentId,
      nickname,
      body: commentBody,
      status: 'visible',
      is_owner: isOwner,
      created_at: new Date().toISOString(),
      updated_at: null,
    },
  }, 201);
}

async function createOwnerSession(request, env) {
  if (!env.OWNER_AUTH_SECRET) throw httpError(503, '주인장 인증이 설정되지 않았습니다.');
  const body = await readJson(request);
  const clientKey = await requestClientKey(request, env);
  await enforceRateLimit(`owner-login:${clientKey}`, 5, 600, env);

  if (typeof body.secret !== 'string' || !timingSafeEqual(body.secret, env.OWNER_AUTH_SECRET)) {
    throw httpError(403, '주인장 인증 정보가 올바르지 않습니다.');
  }

  const expiresAt = Math.floor(Date.now() / 1000) + OWNER_SESSION_SECONDS;
  const payload = base64UrlEncode(JSON.stringify({ role: 'owner', exp: expiresAt }));
  const signature = await signOwnerPayload(payload, env.OWNER_AUTH_SECRET);
  return json({ token: `${payload}.${signature}`, expires_at: new Date(expiresAt * 1000).toISOString() });
}

async function deleteCommentAsOwner(commentId, request, env) {
  validateCommentId(commentId);
  if (!(await hasValidOwnerSession(request, env))) {
    throw httpError(403, '주인장 권한이 필요합니다.');
  }

  const comment = await env.DB.prepare(
    'SELECT * FROM comments WHERE id = ?',
  ).bind(commentId).first();
  if (!comment || comment.status === 'hidden') throw httpError(404, '댓글을 찾을 수 없습니다.');
  await env.DB.prepare(
    `UPDATE comments
     SET status = 'deleted', nickname = '', body = '', updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).bind(commentId).run();
  return json({ deleted: true });
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
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Webhook-Secret');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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

function cleanVisitorNickname(value) {
  const nickname = cleanText(value, 2, 8, '닉네임');
  if (nickname === '주인장') throw httpError(400, '사용할 수 없는 닉네임입니다.');
  return nickname;
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

function bytesBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64UrlEncode(value) {
  return btoa(unescape(encodeURIComponent(value)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(value) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return decodeURIComponent(escape(atob(padded)));
}

async function signOwnerPayload(payload, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return bytesBase64(new Uint8Array(signature))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

async function hasValidOwnerSession(request, env) {
  if (!env.OWNER_AUTH_SECRET) return false;
  const authorization = request.headers.get('Authorization') || '';
  if (!authorization.startsWith('Bearer ')) return false;
  const [payload, signature] = authorization.slice(7).split('.');
  if (!payload || !signature) return false;
  const expected = await signOwnerPayload(payload, env.OWNER_AUTH_SECRET);
  if (!timingSafeEqual(signature, expected)) return false;
  try {
    const parsed = JSON.parse(base64UrlDecode(payload));
    return parsed.role === 'owner' && Number(parsed.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
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

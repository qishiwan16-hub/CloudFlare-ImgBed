/**
 * 用户数据持久化 API
 * GET  /api/user/data?type=config|albums|images|favs|cats|all
 * POST /api/user/data  body: { type, data }
 * 
 * 数据存储在 KV/D1 中，key 格式: user_data@{authType}@{type}
 * 管理员和普通用户各自独立存储空间
 */
import { getDatabase } from '../../utils/databaseAdapter.js';

const VALID_TYPES = ['config', 'albums', 'images', 'favs', 'cats', 'storage_limits'];
const DATA_PREFIX = 'user_data@';
const MAX_DATA_SIZE = 5 * 1024 * 1024; // 5MB per type

function dataKey(authType, type) {
  return `${DATA_PREFIX}${authType}@${type}`;
}

export async function onRequestGet(context) {
  const { request, env, data: ctxData } = context;
  const url = new URL(request.url);
  const type = url.searchParams.get('type') || 'all';
  const authType = ctxData?.authType || 'user';

  const db = getDatabase(env);

  try {
    if (type === 'all') {
      // Return all user data types at once
      const result = {};
      for (const t of VALID_TYPES) {
        const val = await db.get(dataKey(authType, t));
        try { result[t] = val ? JSON.parse(val) : null; } catch { result[t] = null; }
      }
      return new Response(JSON.stringify({ success: true, data: result }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!VALID_TYPES.includes(type)) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid type: ' + type }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const val = await db.get(dataKey(authType, type));
    let parsed = null;
    try { parsed = val ? JSON.parse(val) : null; } catch { parsed = null; }

    return new Response(JSON.stringify({ success: true, type, data: parsed }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

export async function onRequestPost(context) {
  const { request, env, data: ctxData } = context;
  const authType = ctxData?.authType || 'user';

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ success: false, error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const { type, data } = body;

  // Support batch save: { batch: { config: {...}, albums: [...], ... } }
  if (body.batch && typeof body.batch === 'object') {
    const db = getDatabase(env);
    const results = {};
    for (const [t, d] of Object.entries(body.batch)) {
      if (!VALID_TYPES.includes(t)) { results[t] = 'skipped'; continue; }
      const json = JSON.stringify(d);
      if (json.length > MAX_DATA_SIZE) { results[t] = 'too_large'; continue; }
      await db.put(dataKey(authType, t), json);
      results[t] = 'ok';
    }
    return new Response(JSON.stringify({ success: true, results }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!type || !VALID_TYPES.includes(type)) {
    return new Response(JSON.stringify({ success: false, error: 'Invalid type' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const json = JSON.stringify(data);
    if (json.length > MAX_DATA_SIZE) {
      return new Response(JSON.stringify({ success: false, error: 'Data too large (max 5MB)' }), { status: 413, headers: { 'Content-Type': 'application/json' } });
    }

    const db = getDatabase(env);
    await db.put(dataKey(authType, type), json);

    return new Response(JSON.stringify({ success: true, type }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

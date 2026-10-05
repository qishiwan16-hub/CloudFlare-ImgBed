/**
 * 用户管理 API（管理员专用）
 * GET  /api/auth/users — 获取全部用户列表
 * POST /api/auth/users — 操作用户 { action: 'approve'|'reject'|'delete'|'setStorage', username, ... }
 */
import { getDatabase } from '../../utils/databaseAdapter.js';

export async function onRequest(context) {
  const { request, env, data } = context;
  const db = getDatabase(env);

  // Admin check — reuse admin session logic
  // The /api/manage/_middleware already checks admin auth,
  // but this is under /api/auth/, so we check manually
  const adminAuth = await checkAdminAuth(request, env, db);
  if (!adminAuth) {
    return Response.json({ success: false, message: '需要管理员权限' }, { status: 403 });
  }

  if (request.method === 'GET') {
    const usersStr = await db.get('auth@users');
    const users = usersStr ? JSON.parse(usersStr) : [];
    // Strip passwords before sending
    const safe = users.map(u => ({ ...u, password: undefined }));
    return Response.json({ success: true, users: safe });
  }

  if (request.method === 'POST') {
    try {
      const body = await request.json();
      const { action, username } = body;
      if (!action || !username) {
        return Response.json({ success: false, message: '缺少参数' }, { status: 400 });
      }

      const usersStr = await db.get('auth@users');
      let users = usersStr ? JSON.parse(usersStr) : [];
      const idx = users.findIndex(u => u.username === username);

      if (action === 'delete') {
        if (idx !== -1) users.splice(idx, 1);
        await db.put('auth@users', JSON.stringify(users));
        return Response.json({ success: true, message: username + ' 已删除' });
      }

      if (idx === -1) {
        return Response.json({ success: false, message: '用户不存在' }, { status: 404 });
      }

      if (action === 'approve') {
        users[idx].status = 'approved';
      } else if (action === 'reject') {
        users[idx].status = 'rejected';
      } else if (action === 'setStorage') {
        users[idx].storageLimit = body.storageLimit || null;
      } else if (action === 'resetPassword') {
        // Reset password to hash of '123456'
        users[idx].password = 'h_1450575459';
      } else {
        return Response.json({ success: false, message: '未知操作' }, { status: 400 });
      }

      await db.put('auth@users', JSON.stringify(users));
      return Response.json({ success: true, message: '操作成功' });
    } catch (e) {
      return Response.json({ success: false, message: '操作失败: ' + e.message }, { status: 500 });
    }
  }

  return new Response('Method Not Allowed', { status: 405 });
}

/**
 * Check admin authentication via session cookie
 */
async function checkAdminAuth(request, env, db) {
  // Check admin_session cookie (dashboard login)
  const cookie = request.headers.get('Cookie') || '';
  const adminMatch = cookie.match(/admin_session=([^;]+)/);
  if (adminMatch) {
    try {
      const sessionData = await db.get('manage@session@' + adminMatch[1]);
      if (sessionData) {
        const session = JSON.parse(sessionData);
        if (session.authType === 'admin' && (!session.expiresAt || Date.now() < session.expiresAt)) return true;
      }
    } catch (e) {}
  }
  // Check user_session cookie — admin user logged in via frontend
  const userMatch = cookie.match(/user_session=([^;]+)/);
  if (userMatch) {
    try {
      const sessionData = await db.get('manage@session@' + userMatch[1]);
      if (sessionData) {
        const session = JSON.parse(sessionData);
        if (session.authType === 'user' && session.username && (!session.expiresAt || Date.now() < session.expiresAt)) {
          // Check if this user is admin in auth@users
          const ADMIN_USER = env.ADMIN_USER || 'shenhanyan';
          if (session.username === ADMIN_USER) return true;
        }
      }
    } catch (e) {}
  }
  // Fallback: check authCode header
  const authHeader = request.headers.get('authCode') || '';
  if (authHeader && env.AUTH_CODE && authHeader === env.AUTH_CODE) return true;
  return false;
}

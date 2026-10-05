/**
 * 修改密码 API
 * POST /api/auth/changePassword
 * Body: { username, oldPassword, newPassword } (all hashed)
 */
import { getDatabase } from '../../utils/databaseAdapter.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const body = await request.json();
    const { username, oldPassword, newPassword } = body;

    if (!username || !oldPassword || !newPassword) {
      return Response.json({ success: false, message: '参数不完整' }, { status: 400 });
    }

    const db = getDatabase(env);
    const usersStr = await db.get('auth@users');
    const users = usersStr ? JSON.parse(usersStr) : [];

    const idx = users.findIndex(u => u.username === username);
    if (idx === -1) {
      return Response.json({ success: false, message: '用户不存在' }, { status: 404 });
    }
    if (users[idx].password !== oldPassword) {
      return Response.json({ success: false, message: '当前密码错误' }, { status: 401 });
    }

    users[idx].password = newPassword;
    await db.put('auth@users', JSON.stringify(users));

    return Response.json({ success: true, message: '密码修改成功' });
  } catch (e) {
    return Response.json({ success: false, message: '修改失败: ' + e.message }, { status: 500 });
  }
}

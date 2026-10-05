/**
 * 用户注册 API
 * POST /api/auth/register
 * Body: { username, password, remark }
 * 存储到 KV: auth@users
 */
import { getDatabase } from '../../utils/databaseAdapter.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const body = await request.json();
    const { username, password, remark } = body;

    if (!username || !password) {
      return Response.json({ success: false, message: '用户名和密码不能为空' }, { status: 400 });
    }
    if (username.length < 2 || username.length > 20) {
      return Response.json({ success: false, message: '用户名 2-20 个字符' }, { status: 400 });
    }
    if (password.length < 6) {
      return Response.json({ success: false, message: '密码至少 6 位' }, { status: 400 });
    }

    const db = getDatabase(env);
    const usersStr = await db.get('auth@users');
    const users = usersStr ? JSON.parse(usersStr) : [];

    // Check duplicate
    if (users.find(u => u.username === username)) {
      return Response.json({ success: false, message: '用户名已存在' }, { status: 409 });
    }

    users.push({
      username,
      password, // frontend sends hashed password
      role: 'user',
      status: 'pending',
      remark: remark || '',
      createdAt: Date.now()
    });

    await db.put('auth@users', JSON.stringify(users));

    return Response.json({ success: true, message: '注册申请已提交，请等待管理员审核' });
  } catch (e) {
    return Response.json({ success: false, message: '注册失败: ' + e.message }, { status: 500 });
  }
}

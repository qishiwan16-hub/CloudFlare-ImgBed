import { getDatabase } from '../../utils/databaseAdapter.js';
import { createSession } from '../../utils/auth/sessionManager.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const body = await request.json();
    const { username, password } = body;

    if (!username || !password) {
      return Response.json({ success: false, message: '请输入用户名和密码' }, { status: 400 });
    }

    const db = getDatabase(env);
    let usersStr = await db.get('auth@users');
    let users = usersStr ? JSON.parse(usersStr) : [];

    // Auto-seed admin if no users exist
    const ADMIN_USER = env.ADMIN_USER || 'shenhanyan';
    const ADMIN_PASS = env.ADMIN_PASS; // hashed password from env, optional
    if (!users.find(u => u.username === ADMIN_USER)) {
      users.push({
        username: ADMIN_USER,
        password: ADMIN_PASS || 'h_-1850370968', // default hash of '123456'
        role: 'admin',
        status: 'approved',
        remark: '管理员',
        createdAt: Date.now()
      });
      await db.put('auth@users', JSON.stringify(users));
    }

    const user = users.find(u => u.username === username);
    if (!user) {
      return Response.json({ success: false, message: '用户不存在' }, { status: 404 });
    }
    if (user.password !== password) {
      return Response.json({ success: false, message: '密码错误' }, { status: 401 });
    }
    if (user.status === 'pending') {
      return Response.json({ success: false, message: '你的注册申请正在审核中', status: 'pending' }, { status: 403 });
    }
    if (user.status === 'rejected') {
      return Response.json({ success: false, message: '注册申请未通过', status: 'rejected' }, { status: 403 });
    }

    // Create user session cookie with username
    const { cookie } = await createSession(env, 'user', username);

    return new Response(JSON.stringify({
      success: true,
      user: {
        username: user.username,
        role: user.role,
        status: user.status,
        remark: user.remark
      }
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': cookie
      }
    });
  } catch (e) {
    return Response.json({ success: false, message: '登录失败: ' + e.message }, { status: 500 });
  }
}

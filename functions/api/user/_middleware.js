import { authenticate, AUTH_SCOPE } from "../../utils/auth/authCore.js";

const DEFAULT_CACHE_CONTROL = 'private, no-store, max-age=0';

function withDefaultCacheControl(response) {
  if (response.headers.has('Cache-Control')) return response;
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', DEFAULT_CACHE_CONTROL);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function errorHandling(context) {
  try {
    return withDefaultCacheControl(await context.next());
  } catch (err) {
    return new Response(`${err.message}\n${err.stack}`, { status: 500, headers: { 'Cache-Control': DEFAULT_CACHE_CONTROL } });
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

async function authentication(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Allow both admin and user sessions
  const result = await authenticate({
    env: context.env,
    request: context.request,
    requiredPermission: 'upload',
    authScope: AUTH_SCOPE.EITHER,
  });

  if (!result.authorized) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Store auth info in context for downstream use
  context.data = context.data || {};
  context.data.authType = result.authType;

  // Username 统一从 user_session 获取（userLogin 登录时写入的真实账号名）
  const { validateSession } = await import('../../utils/auth/sessionManager.js');
  const userSessionResult = await validateSession(context.env, context.request, 'user');
  if (userSessionResult.valid && userSessionResult.session?.username) {
    context.data.username = userSessionResult.session.username;
  } else {
    // 没有 user_session → 无法确定用户身份，拒绝访问用户数据
    return new Response('Unauthorized: please login with username', { status: 401 });
  }

  return context.next();
}

export const onRequest = [errorHandling, authentication];

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

  // Extract username: always prefer user_session's real username
  const { validateSession } = await import('../../utils/auth/sessionManager.js');
  let resolvedUsername = result.authType; // fallback

  // Try user session first (has real username from userLogin)
  const userSessionResult = await validateSession(context.env, context.request, 'user');
  if (userSessionResult.valid && userSessionResult.session?.username) {
    resolvedUsername = userSessionResult.session.username;
  } else if (result.authType === 'admin') {
    // If only admin session, try to get username from it
    const adminSessionResult = await validateSession(context.env, context.request, 'admin');
    if (adminSessionResult.valid && adminSessionResult.session?.username) {
      resolvedUsername = adminSessionResult.session.username;
    }
  }
  context.data.username = resolvedUsername;

  return context.next();
}

export const onRequest = [errorHandling, authentication];

import { authenticate, AUTH_SCOPE } from "../../utils/auth/authCore.js";
import { validateSession } from '../../utils/auth/sessionManager.js';
import { checkDatabaseConfig } from '../utils/middleware';

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

  const url = new URL(context.request.url);
  const pathname = url.pathname;

  // Public auth endpoints — no session required
  if (pathname.startsWith('/api/auth/')) {
    return context.next();
  }

  // /api/userConfig — public read
  if (pathname === '/api/userConfig' && context.request.method === 'GET') {
    return context.next();
  }

  // All other /api/ routes require user or admin session
  const result = await authenticate({
    env: context.env,
    request: context.request,
    url,
    requiredPermission: 'upload',
    authScope: AUTH_SCOPE.EITHER,
  });

  if (!result.authorized) {
    return new Response(JSON.stringify({ success: false, message: 'You need to login' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Store auth info in context
  context.data = context.data || {};
  context.data.authType = result.authType;

  // Extract username from user_session
  const userSessionResult = await validateSession(context.env, context.request, 'user');
  if (userSessionResult.valid && userSessionResult.session?.username) {
    context.data.username = userSessionResult.session.username;
  } else {
    // Admin session — try to get admin username
    const adminSessionResult = await validateSession(context.env, context.request, 'admin');
    if (adminSessionResult.valid && adminSessionResult.session?.username) {
      context.data.username = adminSessionResult.session.username;
    } else {
      context.data.username = 'admin';
    }
  }

  return context.next();
}

export const onRequest = [checkDatabaseConfig, errorHandling, authentication];

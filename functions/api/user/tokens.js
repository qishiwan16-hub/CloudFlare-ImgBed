import { getDatabase } from '../../utils/databaseAdapter.js';
import { filterAutoDeleteTokens } from '../../utils/auth/tokenExpiration.js';
import { validateSession } from '../../utils/auth/sessionManager.js';

/**
 * 用户 API 令牌管理
 * 普通用户可以管理自己的令牌（不需要管理员权限）
 */
export async function onRequest(context) {
    const { request, env } = context;
    const db = getDatabase(env);
    const method = request.method;

    // 获取当前用户身份
    let currentUser = 'user';
    try {
        const adminSession = await validateSession(env, request, 'admin');
        if (adminSession.valid) {
            currentUser = adminSession.username || 'admin';
        } else {
            const userSession = await validateSession(env, request, 'user');
            if (userSession.valid) {
                currentUser = userSession.username || 'user';
            }
        }
    } catch(e) {}

    // GET - 获取当前用户的令牌
    if (method === 'GET') {
        try {
            const settingsStr = await db.get('manage@sysConfig@security');
            const settings = settingsStr ? JSON.parse(settingsStr) : {};
            const tokens = settings.apiTokens?.tokens || {};

            const tokenArray = Object.keys(tokens)
                .filter(id => tokens[id].type !== 'internal')
                .filter(id => tokens[id].owner === currentUser)
                .map(id => {
                    const t = tokens[id];
                    return {
                        id,
                        name: t.name,
                        owner: t.owner,
                        permissions: t.permissions,
                        createdAt: t.createdAt,
                        updatedAt: t.updatedAt,
                        token: t.token.substr(0, 15) + '...',
                        expiresAt: t.expiresAt ?? null,
                        autoDelete: t.autoDelete ?? false
                    };
                });

            // Filter auto-delete
            const { toDelete, toKeep } = filterAutoDeleteTokens(tokenArray);
            if (toDelete.length > 0) {
                for (const t of toDelete) {
                    delete settings.apiTokens.tokens[t.id];
                }
                await db.put('manage@sysConfig@security', JSON.stringify(settings));
            }

            return new Response(JSON.stringify({ tokens: toKeep }), {
                headers: { 'content-type': 'application/json' }
            });
        } catch(e) {
            return new Response(JSON.stringify({ tokens: [], error: e.message }), {
                headers: { 'content-type': 'application/json' }
            });
        }
    }

    // POST - 创建新令牌
    if (method === 'POST') {
        try {
            const body = await request.json();
            const { name, permissions } = body;

            if (!name) {
                return new Response(JSON.stringify({ error: '请输入令牌名称' }), {
                    status: 400,
                    headers: { 'content-type': 'application/json' }
                });
            }

            const settingsStr = await db.get('manage@sysConfig@security');
            const settings = settingsStr ? JSON.parse(settingsStr) : {};
            if (!settings.apiTokens) settings.apiTokens = { tokens: {} };

            const tokenId = generateTokenId();
            const token = generateApiToken();
            const now = new Date().toISOString();

            settings.apiTokens.tokens[tokenId] = {
                id: tokenId,
                name,
                token,
                owner: currentUser,
                permissions: permissions || ['upload'],
                type: 'user',
                createdAt: now,
                updatedAt: now,
                expiresAt: null,
                autoDelete: false
            };

            await db.put('manage@sysConfig@security', JSON.stringify(settings));

            return new Response(JSON.stringify({
                id: tokenId,
                name,
                token,
                owner: currentUser,
                permissions: permissions || ['upload'],
                createdAt: now
            }), {
                headers: { 'content-type': 'application/json' }
            });
        } catch(e) {
            return new Response(JSON.stringify({ error: '创建失败: ' + e.message }), {
                status: 500,
                headers: { 'content-type': 'application/json' }
            });
        }
    }

    // DELETE - 删除自己的令牌
    if (method === 'DELETE') {
        try {
            const url = new URL(request.url);
            const tokenId = url.searchParams.get('id');
            if (!tokenId) {
                return new Response(JSON.stringify({ error: '缺少 Token ID' }), {
                    status: 400,
                    headers: { 'content-type': 'application/json' }
                });
            }

            const settingsStr = await db.get('manage@sysConfig@security');
            const settings = settingsStr ? JSON.parse(settingsStr) : {};
            const tokenData = settings.apiTokens?.tokens?.[tokenId];

            if (!tokenData) {
                return new Response(JSON.stringify({ error: 'Token 不存在' }), {
                    status: 404,
                    headers: { 'content-type': 'application/json' }
                });
            }

            // 只能删除自己的令牌
            if (tokenData.owner !== currentUser) {
                return new Response(JSON.stringify({ error: '无权删除此令牌' }), {
                    status: 403,
                    headers: { 'content-type': 'application/json' }
                });
            }

            delete settings.apiTokens.tokens[tokenId];
            await db.put('manage@sysConfig@security', JSON.stringify(settings));

            return new Response(JSON.stringify({ success: true }), {
                headers: { 'content-type': 'application/json' }
            });
        } catch(e) {
            return new Response(JSON.stringify({ error: '删除失败: ' + e.message }), {
                status: 500,
                headers: { 'content-type': 'application/json' }
            });
        }
    }

    return new Response('Method not allowed', { status: 405 });
}

function generateApiToken() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return 'imgbed_' + Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateTokenId() {
    const array = new Uint8Array(12);
    crypto.getRandomValues(array);
    return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
}

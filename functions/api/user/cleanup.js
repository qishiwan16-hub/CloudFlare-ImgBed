/**
 * 一次性数据清理 API
 * GET /api/user/cleanup              -> 扫描所有用户数据（预览）
 * GET /api/user/cleanup?user=admin    -> 预览该用户的数据
 * GET /api/user/cleanup?user=admin&confirm=yes  -> 确认删除该用户数据
 * GET /api/user/cleanup?user=all&confirm=yes    -> 确认删除所有用户数据
 * 用完后删除此文件
 */
import { getDatabase } from '../../utils/databaseAdapter.js';

const VALID_TYPES = ['config', 'albums', 'images', 'favs', 'cats', 'storage_limits'];
const DATA_PREFIX = 'user_data@';
const KNOWN_USERS = ['admin', 'user', 'anonymous', 'shenhanyan'];

function dataKey(username, type) {
    return `${DATA_PREFIX}${username}@${type}`;
}

async function scanUser(db, username) {
    const userData = {};
    for (const t of VALID_TYPES) {
        const val = await db.get(dataKey(username, t));
        if (val) {
            try {
                const parsed = JSON.parse(val);
                userData[t] = Array.isArray(parsed) ? `${parsed.length} items` : 'object';
            } catch {
                userData[t] = 'raw: ' + val.substring(0, 50);
            }
        }
    }
    return userData;
}

async function deleteUserData(db, username) {
    const deleted = [];
    for (const t of VALID_TYPES) {
        const key = dataKey(username, t);
        const val = await db.get(key);
        if (val) {
            await db.delete(key);
            deleted.push(t);
        }
    }
    return deleted;
}

export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const targetUser = url.searchParams.get('user');
    const confirm = url.searchParams.get('confirm');

    const db = getDatabase(env);

    // 1) 无参数 -> 扫描所有已知用户
    if (!targetUser) {
        const report = {};
        for (const uname of KNOWN_USERS) {
            const data = await scanUser(db, uname);
            if (Object.keys(data).length > 0) {
                report[uname] = data;
            }
        }
        return json({
            message: 'Data scan. Use ?user=admin&confirm=yes to delete, or ?user=all&confirm=yes to delete all.',
            data: report
        });
    }

    // 2) 指定用户但未确认 -> 预览
    if (confirm !== 'yes') {
        const users = targetUser === 'all' ? KNOWN_USERS : [targetUser];
        const preview = {};
        for (const u of users) {
            const data = await scanUser(db, u);
            if (Object.keys(data).length > 0) {
                preview[u] = data;
            }
        }
        return json({
            message: `Dry run for "${targetUser}". Add &confirm=yes to execute deletion.`,
            willDelete: preview
        });
    }

    // 3) 确认删除
    const users = targetUser === 'all' ? KNOWN_USERS : [targetUser];
    const results = {};
    for (const u of users) {
        const deleted = await deleteUserData(db, u);
        if (deleted.length > 0) {
            results[u] = { deleted };
        }
    }

    return json({
        success: true,
        message: `Cleaned up user data for: ${Object.keys(results).join(', ') || 'none (already clean)'}`,
        results
    });
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

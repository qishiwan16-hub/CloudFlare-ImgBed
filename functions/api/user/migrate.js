/**
 * 一次性数据迁移 API
 * GET /api/user/migrate?from=xxx&to=shenhanyan&confirm=yes
 * 从旧 username key 迁移所有数据到新 username key
 * 用完后删除此文件
 */
import { getDatabase } from '../../utils/databaseAdapter.js';

const VALID_TYPES = ['config', 'albums', 'images', 'favs', 'cats', 'storage_limits'];
const DATA_PREFIX = 'user_data@';

function dataKey(username, type) {
    return `${DATA_PREFIX}${username}@${type}`;
}

export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const confirm = url.searchParams.get('confirm');

    const db = getDatabase(env);

    // If no params, scan all possible usernames and show what's there
    if (!from || !to) {
        const candidates = ['admin', 'user', 'anonymous', 'shenhanyan'];
        // Also try to find all user_data keys by checking known candidates
        const report = {};
        for (const uname of candidates) {
            const userData = {};
            for (const t of VALID_TYPES) {
                const val = await db.get(dataKey(uname, t));
                if (val) {
                    try {
                        const parsed = JSON.parse(val);
                        userData[t] = Array.isArray(parsed) ? parsed.length + ' items' : 'object';
                    } catch {
                        userData[t] = 'raw: ' + val.substring(0, 50);
                    }
                }
            }
            if (Object.keys(userData).length > 0) {
                report[uname] = userData;
            }
        }

        // Also check legacy 'user' key from old auth system  
        const legacyVal = await db.get(dataKey('user', 'images'));
        if (legacyVal && !report['user']) {
            try {
                const parsed = JSON.parse(legacyVal);
                report['user'] = { images: (Array.isArray(parsed) ? parsed.length : 0) + ' items' };
            } catch {}
        }

        return new Response(JSON.stringify({
            message: 'Data scan results. Use ?from=xxx&to=shenhanyan&confirm=yes to migrate.',
            data: report
        }, null, 2), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Dry run by default
    if (confirm !== 'yes') {
        const preview = {};
        for (const t of VALID_TYPES) {
            const val = await db.get(dataKey(from, t));
            if (val) {
                try {
                    const parsed = JSON.parse(val);
                    preview[t] = Array.isArray(parsed) ? parsed.length + ' items' : 'exists';
                } catch {
                    preview[t] = 'raw data';
                }
            }
        }
        return new Response(JSON.stringify({
            message: `Dry run: would migrate from "${from}" to "${to}". Add &confirm=yes to execute.`,
            fromData: preview
        }, null, 2), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Execute migration
    const results = {};
    for (const t of VALID_TYPES) {
        const val = await db.get(dataKey(from, t));
        if (val) {
            await db.put(dataKey(to, t), val);
            try {
                const parsed = JSON.parse(val);
                results[t] = Array.isArray(parsed) ? `migrated ${parsed.length} items` : 'migrated';
            } catch {
                results[t] = 'migrated (raw)';
            }
        }
    }

    return new Response(JSON.stringify({
        success: true,
        message: `Migrated all data from "${from}" to "${to}"`,
        results
    }, null, 2), {
        headers: { 'Content-Type': 'application/json' }
    });
}

/**
 * 文件替换 API — 指针交换方案
 * POST /api/manage/replace/[[path]]
 * Body JSON: { newFileId: "xxx" }
 *
 * 流程：
 * 1. 前端先通过 /upload 正常上传新文件
 * 2. 前端拿到新文件的 fileId，调用本接口
 * 3. 本接口把新文件的存储字段复制到旧文件的 KV metadata
 * 4. R2 特殊处理：复制 R2 对象到旧 key
 * 5. 删除新文件的 KV 条目及其别名
 * 6. 清除旧 URL 的 CDN 缓存
 */
import { getDatabase } from '../../../utils/databaseAdapter.js';
import { purgeCFCache } from '../../../utils/purgeCache.js';

// 决定文件内容存储位置的 metadata keys
const STORAGE_KEYS = [
    'Channel', 'ChannelName',
    'TgFileId',
    'S3FileKey',
    'HfFilePath',
    'WebDAVFilePath',
    'ExternalLink',
    'IsChunked', 'Chunks', 'TotalSize',
    'FileType', 'FileSize', 'FileSizeBytes',
    'Label', 'Width', 'Height',
];

export async function onRequestPost(context) {
    const { request, env, params } = context;

    // Old file ID from URL path
    let oldFileId = '';
    try {
        oldFileId = decodeURIComponent(params.path.join('/'));
    } catch {
        return json({ success: false, message: '无效的文件ID' }, 400);
    }

    // New file ID from request body
    let body;
    try {
        body = await request.json();
    } catch {
        return json({ success: false, message: '请求格式错误' }, 400);
    }
    const newFileId = body.newFileId;
    if (!newFileId) {
        return json({ success: false, message: '缺少 newFileId' }, 400);
    }

    const db = getDatabase(env);
    const debug = { oldFileId, newFileId };

    try {
        // --- Resolve old file (follow alias) ---
        let oldRecord = await db.getWithMetadata(oldFileId);
        if (!oldRecord || !oldRecord.metadata) {
            return json({ success: false, message: '原文件不存在', debug }, 404);
        }
        let resolvedOldId = oldFileId;
        if (oldRecord.metadata.isAlias && oldRecord.metadata.target) {
            resolvedOldId = oldRecord.metadata.target;
            oldRecord = await db.getWithMetadata(resolvedOldId);
            if (!oldRecord || !oldRecord.metadata) {
                return json({ success: false, message: '原主文件不存在', debug }, 404);
            }
        }
        const oldMeta = oldRecord.metadata;
        debug.resolvedOldId = resolvedOldId;
        debug.oldChannel = oldMeta.Channel;

        // --- Read new file ---
        let newRecord = await db.getWithMetadata(newFileId);
        if (!newRecord || !newRecord.metadata) {
            return json({ success: false, message: '新文件不存在', debug }, 404);
        }
        let resolvedNewId = newFileId;
        if (newRecord.metadata.isAlias && newRecord.metadata.target) {
            resolvedNewId = newRecord.metadata.target;
            newRecord = await db.getWithMetadata(resolvedNewId);
            if (!newRecord || !newRecord.metadata) {
                return json({ success: false, message: '新主文件不存在', debug }, 404);
            }
        }
        const newMeta = newRecord.metadata;
        debug.resolvedNewId = resolvedNewId;
        debug.newChannel = newMeta.Channel;

        // --- R2 special: copy R2 object from newId key → oldId key ---
        if (newMeta.Channel === 'CloudflareR2' && env.img_r2) {
            const r2 = env.img_r2;
            const newObj = await r2.get(resolvedNewId);
            if (newObj) {
                await r2.put(resolvedOldId, newObj.body, {
                    httpMetadata: newObj.httpMetadata,
                    customMetadata: newObj.customMetadata,
                });
                await r2.delete(resolvedNewId);
                debug.r2Copied = true;
            }
        }

        // --- Build updated old metadata: keep identity, swap storage ---
        const updatedOldMeta = { ...oldMeta };
        for (const key of STORAGE_KEYS) {
            delete updatedOldMeta[key];
        }
        for (const key of STORAGE_KEYS) {
            if (newMeta[key] !== undefined && newMeta[key] !== null) {
                updatedOldMeta[key] = newMeta[key];
            }
        }

        // --- Write updated old file ---
        await db.put(resolvedOldId, oldRecord.value || '', { metadata: updatedOldMeta });
        debug.oldUpdated = true;

        // --- Delete new file KV entry + its aliases ---
        const toDelete = [resolvedNewId];
        if (newMeta.AliasTimestamp) toDelete.push(String(newMeta.AliasTimestamp));
        if (newMeta.AliasShort) toDelete.push(String(newMeta.AliasShort));
        if (newFileId !== resolvedNewId) toDelete.push(newFileId);

        for (const key of toDelete) {
            try { await db.delete(key); } catch {}
        }
        debug.newDeleted = toDelete;

        // --- Purge CDN cache for old URLs ---
        const purged = [];
        try {
            const url = new URL(request.url);
            const origin = url.origin;
            const urlsToPurge = [`${origin}/OvO/${resolvedOldId}`];
            if (oldMeta.AliasTimestamp) urlsToPurge.push(`${origin}/OvO/${oldMeta.AliasTimestamp}`);
            if (oldMeta.AliasShort) urlsToPurge.push(`${origin}/OvO/${oldMeta.AliasShort}`);

            const cache = caches.default;
            const nullResp = () => new Response(null, { headers: { 'Cache-Control': 'max-age=0' } });
            for (const u of urlsToPurge) {
                try { await cache.put(u, nullResp()); purged.push(u); } catch {}
            }
            for (const u of urlsToPurge) {
                try { await purgeCFCache(env, u); } catch {}
            }
        } catch {}
        debug.purged = purged;

        return json({ success: true, message: '文件已替换', debug });
    } catch (e) {
        debug.error = e.message;
        debug.stack = e.stack;
        return json({ success: false, message: '替换失败: ' + e.message, debug }, 500);
    }
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

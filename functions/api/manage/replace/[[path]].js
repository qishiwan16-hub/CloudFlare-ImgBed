/**
 * 文件替换 API
 * POST /api/manage/replace/{fileId}
 * 保留原链接（主文件+别名），替换实际内容
 * Body: multipart/form-data with 'file' field
 */
import { getDatabase } from '../../../utils/databaseAdapter.js';
import { TelegramAPI } from '../../../utils/storage/telegramAPI.js';
import { HuggingFaceAPI } from '../../../utils/storage/huggingfaceAPI.js';
import { WebDAVAPI } from '../../../utils/storage/webdavAPI.js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
    resolveHuggingFaceCredentials,
    resolveS3Credentials,
    resolveTelegramCredentials,
    resolveWebDAVCredentials,
} from '../../../utils/metadata/channelCredentials.js';
import { purgeCFCache } from '../../../utils/purgeCache.js';

export async function onRequestPost(context) {
    const { request, env, params } = context;

    let fileId = '';
    try {
        fileId = decodeURIComponent(params.path.join('/'));
    } catch {
        return Response.json({ success: false, message: '无效的文件ID' }, { status: 400 });
    }

    const db = getDatabase(env);
    let record = await db.getWithMetadata(fileId);
    if (!record || !record.metadata) {
        return Response.json({ success: false, message: '文件不存在', debug: { fileId } }, { status: 404 });
    }

    // Alias resolution: follow alias to primary file
    if (record.metadata.isAlias && record.metadata.target) {
        const targetId = record.metadata.target;
        record = await db.getWithMetadata(targetId);
        if (!record || !record.metadata) {
            return Response.json({ success: false, message: '主文件不存在', debug: { fileId, targetId } }, { status: 404 });
        }
        fileId = targetId;
    }

    const meta = record.metadata;
    const channel = meta.Channel;

    // Parse uploaded file
    let formdata;
    try {
        formdata = await request.formData();
    } catch {
        return Response.json({ success: false, message: '请上传文件' }, { status: 400 });
    }
    const file = formdata.get('file');
    if (!file || !file.size) {
        return Response.json({ success: false, message: '请上传文件' }, { status: 400 });
    }

    const newFileType = file.type || 'application/octet-stream';
    const debug = { fileId, channel, fileSize: file.size, newFileType };

    try {
        if (channel === 'CloudflareR2') {
            await replaceR2(env, fileId, file);
            debug.method = 'R2';
        } else if (channel === 'S3') {
            await replaceS3(db, env, meta, file, newFileType);
            debug.method = 'S3';
        } else if (channel === 'Telegram' || channel === 'TelegramNew' || !channel) {
            await replaceTelegram(db, env, meta, file);
            debug.method = 'Telegram';
            debug.newTgFileId = meta.TgFileId;
        } else if (channel === 'Discord') {
            return Response.json({ success: false, message: 'Discord 渠道暂不支持替换', debug }, { status: 400 });
        } else if (channel === 'HuggingFace') {
            await replaceHuggingFace(db, env, meta, file);
            debug.method = 'HuggingFace';
        } else if (channel === 'WebDAV') {
            await replaceWebDAV(db, env, meta, file, newFileType);
            debug.method = 'WebDAV';
        } else if (channel === 'External') {
            return Response.json({ success: false, message: '外链文件无法替换', debug }, { status: 400 });
        } else {
            return Response.json({ success: false, message: '未知存储渠道: ' + channel, debug }, { status: 400 });
        }

        // Update metadata (keep all existing, update file type/size)
        const updatedMeta = { ...meta, FileType: newFileType, FileSize: (file.size / 1024 / 1024).toFixed(2) };
        await db.put(fileId, record.value || '', { metadata: updatedMeta });
        debug.metaSaved = true;

        // Purge CDN cache for all URLs (main + aliases)
        const purged = [];
        try {
            const url = new URL(request.url);
            const origin = url.origin;
            const urlsToPurge = [`${origin}/OvO/${fileId}`];
            if (meta.TimeStamp) urlsToPurge.push(`${origin}/OvO/${meta.TimeStamp}`);
            if (meta.ShortAlias) urlsToPurge.push(`${origin}/OvO/${meta.ShortAlias}`);

            // Workers Cache API (cache.delete has CF bug, use put with max-age=0)
            const cache = caches.default;
            const nullResp = () => new Response(null, { headers: { 'Cache-Control': 'max-age=0' } });
            for (const u of urlsToPurge) {
                try { await cache.put(u, nullResp()); purged.push(u); } catch {}
            }

            // Cloudflare Zone API via utility
            for (const u of urlsToPurge) {
                try { await purgeCFCache(env, u); } catch {}
            }
        } catch {}
        debug.purged = purged;

        return Response.json({ success: true, message: '文件已替换', debug });
    } catch (e) {
        debug.error = e.message;
        return Response.json({ success: false, message: '替换失败: ' + e.message, debug }, { status: 500 });
    }
}

/**
 * R2: 直接用 env.img_r2.put 覆盖同 key
 * 上传时: R2DataBase.put(fullId, formdata.get('file'))
 */
async function replaceR2(env, fileId, file) {
    const r2 = env.img_r2;
    if (!r2) throw new Error('R2 未配置');
    // 和上传保持一致，直接 put file
    await r2.put(fileId, file);
}

/**
 * S3: 用 S3Client.send(PutObjectCommand) 覆盖同 key
 * 上传时: Key = fullId, Body = uint8Array, ContentType = file.type
 * metadata.S3FileKey = s3FileName
 */
async function replaceS3(db, env, meta, file, fileType) {
    const creds = await resolveS3Credentials(db, env, meta);
    if (!creds || creds.missing) throw new Error('S3 配置不存在');

    const client = new S3Client({
        region: creds.region || 'auto',
        endpoint: creds.endpoint,
        credentials: {
            accessKeyId: creds.accessKeyId,
            secretAccessKey: creds.secretAccessKey,
        },
        forcePathStyle: creds.pathStyle,
    });

    const arrayBuf = await file.arrayBuffer();
    const s3Key = creds.key || meta.S3FileKey;
    if (!s3Key) throw new Error('S3FileKey 不存在');

    await client.send(new PutObjectCommand({
        Bucket: creds.bucketName,
        Key: s3Key,
        Body: new Uint8Array(arrayBuf),
        ContentType: fileType,
    }));
}

/**
 * Telegram: sendFile 获取新 file_id 更新 meta.TgFileId
 * 上传时: telegramAPI.sendFile(file, chatId, 'sendDocument', 'document')
 * metadata.TgFileId = file_id
 */
async function replaceTelegram(db, env, meta, file) {
    const creds = await resolveTelegramCredentials(db, env, meta);
    if (!creds || !creds.botToken || !creds.chatId) throw new Error('Telegram 配置不存在');
    const tg = new TelegramAPI(creds.botToken, creds.proxyUrl || '');

    const response = await tg.sendFile(file, creds.chatId, 'sendDocument', 'document');
    const fileInfo = tg.getFileInfo(response);

    // Update metadata in-place (main handler will persist)
    meta.TgFileId = fileInfo.file_id;
    meta.FileSize = (fileInfo.file_size / 1024 / 1024).toFixed(2);
}

/**
 * HuggingFace: uploadFile 覆盖同路径
 * 上传时: huggingfaceAPI.uploadFile(file, hfFilePath, commitMessage)
 * metadata.HfFilePath = hfFilePath
 */
async function replaceHuggingFace(db, env, meta, file) {
    const creds = await resolveHuggingFaceCredentials(db, env, meta);
    if (!creds || creds.missing) throw new Error('HuggingFace 配置不存在');

    const hf = new HuggingFaceAPI(creds.token, creds.repo, creds.isPrivate || false);
    const hfPath = meta.HfFilePath;
    if (!hfPath) throw new Error('HfFilePath 不存在');

    const result = await hf.uploadFile(file, hfPath, 'Replace file');
    if (!result.success) {
        throw new Error('HuggingFace 上传失败');
    }
}

/**
 * WebDAV: putFile 覆盖同路径
 * 上传时: webdavAPI.putFile(fullId, file, contentType)
 * metadata.WebDAVFilePath = fullId
 * WebDAVAPI constructor takes config object {baseUrl, username, password, ...}
 */
async function replaceWebDAV(db, env, meta, file, fileType) {
    const creds = await resolveWebDAVCredentials(db, env, meta);
    if (!creds || creds.missing) throw new Error('WebDAV 配置不存在');

    const webdav = new WebDAVAPI({
        baseUrl: creds.baseUrl,
        username: creds.username,
        password: creds.password,
        headers: creds.headers || {},
        createDirectory: creds.createDirectory !== false,
    });

    const davPath = meta.WebDAVFilePath;
    if (!davPath) throw new Error('WebDAVFilePath 不存在');

    await webdav.putFile(davPath, file, fileType);
}

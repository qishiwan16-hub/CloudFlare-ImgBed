/**
 * 文件替换 API
 * POST /api/manage/replace/{fileId}
 * 保留原链接（主文件+别名），替换实际内容
 * Body: multipart/form-data with 'file' field
 */
import { getDatabase } from '../../../utils/databaseAdapter.js';
import { TelegramAPI } from '../../../utils/storage/telegramAPI.js';
import { HuggingFaceAPI } from '../../../utils/storage/huggingfaceAPI.js';
import { buildWebDAVUrl, WebDAVAPI } from '../../../utils/storage/webdavAPI.js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
    resolveHuggingFaceCredentials,
    resolveS3Credentials,
    resolveTelegramCredentials,
    resolveWebDAVCredentials,
} from '../../../utils/metadata/channelCredentials.js';

export async function onRequestPost(context) {
    const { request, env, params } = context;

    let fileId = '';
    try {
        fileId = decodeURIComponent(params.path.join('/'));
    } catch {
        return Response.json({ success: false, message: '无效的文件ID' }, { status: 400 });
    }

    const db = getDatabase(env);
    const record = await db.getWithMetadata(fileId);
    if (!record || !record.metadata) {
        return Response.json({ success: false, message: '文件不存在' }, { status: 404 });
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

    try {
        if (channel === 'CloudflareR2') {
            await replaceR2(env, fileId, file, newFileType);
        } else if (channel === 'S3') {
            await replaceS3(db, env, meta, fileId, file, newFileType);
        } else if (channel === 'Telegram' || channel === 'TelegramNew' || !channel) {
            await replaceTelegram(db, env, meta, fileId, file);
        } else if (channel === 'Discord') {
            return Response.json({ success: false, message: 'Discord 渠道暂不支持替换' }, { status: 400 });
        } else if (channel === 'HuggingFace') {
            await replaceHuggingFace(db, env, meta, fileId, file);
        } else if (channel === 'WebDAV') {
            await replaceWebDAV(db, env, meta, fileId, file, newFileType);
        } else if (channel === 'External') {
            return Response.json({ success: false, message: '外链文件无法替换' }, { status: 400 });
        } else {
            return Response.json({ success: false, message: '未知存储渠道: ' + channel }, { status: 400 });
        }

        // Update metadata (keep all existing, update file type/size)
        const updatedMeta = { ...meta, FileType: newFileType, FileSize: (file.size / 1024 / 1024).toFixed(2) };
        await db.put(fileId, record.value || '', { metadata: updatedMeta });

        // Purge CDN cache
        try {
            const url = new URL(request.url);
            const cacheUrl = `https://${url.hostname}/OvO/${fileId}`;
            if (env.CLOUDFLARE_ZONE_ID && env.CLOUDFLARE_API_TOKEN) {
                await fetch(`https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/purge_cache`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ files: [cacheUrl] })
                }).catch(() => {});
            }
        } catch {}

        return Response.json({ success: true, message: '文件已替换' });
    } catch (e) {
        return Response.json({ success: false, message: '替换失败: ' + e.message }, { status: 500 });
    }
}

async function replaceR2(env, fileId, file, fileType) {
    const r2 = env.img_r2;
    if (!r2) throw new Error('R2 配置不存在');
    await r2.put(fileId, file.stream(), {
        httpMetadata: { contentType: fileType },
    });
}

async function replaceS3(db, env, meta, fileId, file, fileType) {
    const creds = await resolveS3Credentials(db, env, meta);
    if (!creds || creds.missing) throw new Error('S3 配置不存在');
    const client = new S3Client({
        region: creds.region || 'auto',
        endpoint: creds.endpoint,
        credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
    });
    const arrayBuf = await file.arrayBuffer();
    await client.send(new PutObjectCommand({
        Bucket: creds.bucket,
        Key: meta.S3Key || fileId,
        Body: new Uint8Array(arrayBuf),
        ContentType: fileType,
    }));
}

async function replaceTelegram(db, env, meta, fileId, file) {
    const creds = await resolveTelegramCredentials(db, env, meta);
    if (!creds || !creds.botToken || !creds.chatId) throw new Error('Telegram 配置不存在');
    const tg = new TelegramAPI(creds.botToken, creds.proxyUrl || '');

    // Upload new file to Telegram
    const response = await tg.sendFile(file, creds.chatId, 'sendDocument', 'document');
    const fileInfo = tg.getFileInfo(response);

    // Update metadata with new file_id
    meta.TgFileId = fileInfo.file_id;
    meta.FileSize = (fileInfo.file_size / 1024 / 1024).toFixed(2);

    // Telegram KV value is always empty string
    await db.put(fileId, '', { metadata: meta });
}

async function replaceHuggingFace(db, env, meta, fileId, file) {
    const creds = await resolveHuggingFaceCredentials(db, env, meta);
    if (!creds || creds.missing) throw new Error('HuggingFace 配置不存在');
    const hf = new HuggingFaceAPI(creds.token, creds.repo);
    await hf.uploadFile(file, meta.HfPath || fileId, 'Replace file');
}

async function replaceWebDAV(db, env, meta, fileId, file, fileType) {
    const creds = await resolveWebDAVCredentials(db, env, meta);
    if (!creds || creds.missing) throw new Error('WebDAV 配置不存在');
    const davUrl = buildWebDAVUrl(creds.url, meta.WebDAVPath || fileId);
    const webdav = new WebDAVAPI(creds.username, creds.password);
    const arrayBuf = await file.arrayBuffer();
    await webdav.putFile(davUrl, new Uint8Array(arrayBuf), fileType);
}

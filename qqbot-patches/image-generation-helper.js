/* >>> dsh-qqbot-patch:image-generation-helper >>> */
/** OpenAI Images API → one private temporary PNG → the bound QQ conversation.
 * No chat history, reference uploads, arbitrary endpoint, URL download, or automatic retry.
 */
const QQBOT_IMAGE_DEFAULTS = Object.freeze({
    enabled: false, model: 'gpt-image-2', size: '1024x1024', quality: 'low',
    cooldownSeconds: 120, maxPerHour: 3, timeoutSeconds: 180,
});
const QQBOT_IMAGE_MODELS = ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-1.5', 'gpt-image-1-mini'];

function qqbotImageCheckDirectory(directory, create = false) {
    const fs = process.getBuiltinModule('node:fs');
    const path = process.getBuiltinModule('node:path');
    const absolute = path.resolve(directory);
    for (let current = absolute; ; current = path.dirname(current)) {
        let stat;
        try { stat = fs.lstatSync(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('unsafe image directory');
        if (current === path.dirname(current)) break;
    }
    if (create) fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
    return absolute;
}
function qqbotImageReadSettings(profileDir) {
    const fs = process.getBuiltinModule('node:fs');
    const path = process.getBuiltinModule('node:path');
    qqbotImageCheckDirectory(profileDir);
    const file = path.join(profileDir, 'qqbot-image-generation.json');
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) {
        if (error.code === 'ENOENT') return { ...QQBOT_IMAGE_DEFAULTS };
        throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384) throw new Error('unsafe image configuration');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let value;
    try {
        const actual = fs.fstatSync(fd);
        if (!actual.isFile() || actual.nlink !== 1 || actual.size > 16384 || actual.ino !== stat.ino || actual.dev !== stat.dev) throw new Error('image configuration changed');
        const bytes = Buffer.alloc(16385);
        const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
        if (count > 16384) throw new Error('oversized image configuration');
        value = JSON.parse(bytes.subarray(0, count).toString('utf8'));
    } finally { fs.closeSync(fd); }
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== Object.keys(QQBOT_IMAGE_DEFAULTS).length
        || Object.keys(value).some((key) => !Object.hasOwn(QQBOT_IMAGE_DEFAULTS, key))
        || typeof value.enabled !== 'boolean' || !QQBOT_IMAGE_MODELS.includes(value.model)
        || !['1024x1024', '1536x1024', '1024x1536'].includes(value.size)
        || !['low', 'medium', 'high'].includes(value.quality)
        || !Number.isInteger(value.cooldownSeconds) || value.cooldownSeconds < 60 || value.cooldownSeconds > 3600
        || !Number.isInteger(value.maxPerHour) || value.maxPerHour < 1 || value.maxPerHour > 10
        || !Number.isInteger(value.timeoutSeconds) || value.timeoutSeconds < 30 || value.timeoutSeconds > 300) throw new Error('invalid image configuration');
    return value;
}

// Conservative command recognition is a spending fence, not a language-understanding guarantee.
// Quoted/history/attachment/ASR content is deliberately not considered. /生图 is the unambiguous form.
function qqbotImageExplicitRequest(value) {
    if (typeof value !== 'string' || value.length > 8000) return false;
    const text = value.trim().replace(/^(?:<@!?[A-Za-z0-9_-]+>\s*)+/, '').trim();
    if (/^\/(?:生图|画图|image)\s+\S/i.test(text)) return true;
    if (/^(?:不要|别|禁止|不用|不需要|停止|取消|请勿|如何|怎么|什么|为什么|是否)/.test(text)) return false;
    if (/(?:生图|画图|绘图)(?:功能|接口|配置|教程|代码|文档)/i.test(text)) return false;
    return /^(?:(?:请|麻烦|能不能|可以|能|帮我|给我|帮忙|你|小易)[，,\s]*){0,6}(?:画(?:一|只|个|张|幅|些|一下|画)?|绘制|生图|生成(?:一张|一幅|一份|一|张|个|幅)?(?:图片|图像|图|插画|海报|壁纸|头像))\s*\S/.test(text)
        || /^(?:(?:please|can you|could you|would you)\s+)?(?:draw|paint|(?:generate|create)\s+(?:an?\s+)?(?:image|picture|illustration|poster|wallpaper|avatar))\s+\S/i.test(text);
}

async function qqbotImageReadResponse(response, signal) {
    const limit = 12 * 1024 * 1024;
    if (Number(response.headers?.get('content-length')) > limit) {
        await response.body?.cancel(); throw new Error('oversized image response');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('empty image response');
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            signal.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > limit) { await reader.cancel(); throw new Error('oversized image response'); }
            chunks.push(Buffer.from(value));
        }
        signal.throwIfAborted();
        return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
    } finally { reader.releaseLock(); }
}
function qqbotImageDecodePng(data, size) {
    if (data?.error || !Array.isArray(data?.data) || data.data.length !== 1) throw new Error('missing image result');
    const encoded = data.data[0]?.b64_json;
    if (typeof encoded !== 'string' || encoded.length < 44 || encoded.length > 12 * 1024 * 1024
        || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('invalid image encoding');
    const bytes = Buffer.from(encoded, 'base64');
    const [width, height] = size.split('x').map(Number);
    if (bytes.length < 45 || bytes.length > 8 * 1024 * 1024 || bytes.toString('base64') !== encoded
        || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
        || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR'
        || bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height
        || bytes.subarray(-12).toString('hex') !== '0000000049454e44ae426082') throw new Error('invalid PNG image');
    return bytes;
}

function setupOpenAiImageTool(ctx, bot, manager, config, logger) {
    let tools;
    try { tools = ctx.get('tools'); } catch { return; }
    if (!tools?.register) return;
    const fs = process.getBuiltinModule('node:fs');
    const path = process.getBuiltinModule('node:path');
    const profileDir = path.resolve(process.env.QQBOT_PROFILE_DIR ?? path.join(process.env.HOME ?? '', '.dsh', 'profiles', 'qqbot'));
    const lifetime = new AbortController();
    const attempts = new Map();
    let globalAttempts = [];
    let busy = false;
    const result = (status, message) => ({ ok: status === 'sent', status, message });
    // The launchd-started bot may not have the panel's .bot-secrets.json in its environment.
    // Resolve the same credential the host uses, then the DSH credentials file, without logging it.
    const resolveOpenAiKey = async () => {
        const valid = (value) => (typeof value === 'string' && value.trim() !== '' && !/[\r\n\u0000]/.test(value) ? value.trim() : undefined);
        const fromEnvironment = valid(process.env.OPENAI_API_KEY);
        if (fromEnvironment) return fromEnvironment;
        try {
            const credentials = ctx.get?.('credentials');
            if (credentials) {
                const { credentialRef } = await import('@deepseek-ai/dsh-credentials');
                const resolved = valid((await credentials.resolve(credentialRef('OPENAI_API_KEY')))?.value);
                if (resolved) return resolved;
            }
        } catch { /* Fall back to the local credentials file below. */ }
        try {
            const hostFs = process.getBuiltinModule('node:fs');
            const hostOs = process.getBuiltinModule('node:os');
            const hostPath = process.getBuiltinModule('node:path');
            const text = hostFs.readFileSync(hostPath.join(hostOs.homedir(), '.dsh', '.credentials.yaml'), 'utf8');
            const match = text.match(/^\s*OPENAI_API_KEY:\s*(\S.*)$/m);
            return valid(match?.[1]?.replace(/^['"]|['"]$/g, '').trim());
        } catch { return undefined; }
    };
    const authorize = (record, msg, userMessage) => {
        if (!record || !msg) return;
        // Every real inbound replaces the previous grant, including non-image requests.
        record.__qqbotImageGenerationGrant = undefined;
        const raw = msg.raw;
        if (!['group', 'c2c'].includes(msg.kind) || typeof msg.messageId !== 'string' || !msg.messageId
            || raw?.id !== msg.messageId || typeof raw?.content !== 'string'
            || typeof userMessage?.id !== 'string' || !userMessage.id || !qqbotImageExplicitRequest(raw.content)) return;
        const scope = msg.kind;
        const targetId = scope === 'group' ? msg.groupOpenid : msg.senderId;
        const rawSender = scope === 'group' ? raw.author?.member_openid : raw.author?.user_openid;
        if (typeof targetId !== 'string' || !targetId || typeof rawSender !== 'string' || !rawSender || rawSender !== msg.senderId
            || (scope === 'group' && raw.group_openid !== targetId) || record.scope !== scope || record.peerId !== targetId) return;
        record.__qqbotImageGenerationGrant = {
            scope, targetId, msgId: msg.messageId, userMessageId: userMessage.id,
            expiresAt: Date.now() + 5 * 60 * 1000, used: false,
        };
    };
    globalThis.__qqbotImageGenerationAuthorize = authorize;
    // A real turn boundary revokes unused permission before any background turn can reuse it.
    ctx.on?.('session/event', (session, event) => {
        if (event?.type !== 'turn/end') return;
        try {
            const record = manager.findBySessionId?.(session?.header?.id ?? '');
            if (record) record.__qqbotImageGenerationGrant = undefined;
        } catch { /* Revocation must not break another plugin's event listener. */ }
    });
    ctx.on?.('dispose', () => {
        lifetime.abort();
        if (globalThis.__qqbotImageGenerationAuthorize === authorize) delete globalThis.__qqbotImageGenerationAuthorize;
    });

    tools.register({
        name: 'generate_image',
        description: [
            '使用 OpenAI 付费图片接口生成一张新图片，并真实发送到当前 QQ 群或私聊。',
            '仅在当前用户明确要求画图时调用；不用于普通搜图、看图、编辑上传图片或后台任务。',
            'prompt 只写本次画面要求（最多4000字），不要附带群历史、人物档案、密钥或引用原文。',
            '不传模型、尺寸、地址、收件人或张数，均由管理员设置。',
            '失败或超时不要自动重试，也不要宣称已经发图；需要时请用户发新的 /生图 请求。',
        ].join(''),
        parameters: { type: 'object', additionalProperties: false, properties: {
            prompt: { type: 'string', description: '当前用户要求的画面，最多4000字。不包含历史消息或参考图。', minLength: 1, maxLength: 4000 },
        }, required: ['prompt'] },
        output: {
            schema: { type: 'object', additionalProperties: false, properties: {
                ok: { type: 'boolean' }, status: { type: 'string' }, message: { type: 'string' },
            }, required: ['ok', 'status', 'message'] },
            render: (_args, value) => [{ type: 'text', text: value.message }],
        },
        isConcurrencySafe: () => false,
        timeoutMs: 360000,
        async execute(args, exec) {
            let settings;
            try { settings = qqbotImageReadSettings(profileDir); }
            catch { return result('configuration_error', '生图配置不可用，请管理员在本机面板检查；没有发送生图请求。'); }
            if (!settings.enabled || process.env.QQBOT_IMAGE_GENERATION === 'off') return result('disabled', '生图默认关闭，请管理员在本机面板明确开启，并确认费用与隐私。');
            const key = await resolveOpenAiKey();
            if (!key) return result('missing_key', '未配置可用的 OPENAI_API_KEY；在本机面板或 DSH 凭据中保存后，重启机器人加载。');
            if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some((name) => name !== 'prompt')
                || typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 4000 || Buffer.byteLength(args.prompt) > 16384) {
                return result('invalid_prompt', '请只提供本次画面要求 prompt（1–4000字），不能指定地址、收件人或额外参数。');
            }
            let record;
            try {
                record = exec?.agent && (manager.findByAgent(exec.agent)
                    ?? manager.findBySessionId?.(exec.agent.session?.header?.id ?? ''));
            } catch { /* Fail closed, never fall back to the last global QQ target. */ }
            const grant = record?.__qqbotImageGenerationGrant;
            const target = record?.replyTarget;
            let latestUser;
            try {
                const messages = exec?.agent?.session?.deriveMessages?.();
                latestUser = Array.isArray(messages) ? messages.findLast((message) => message.role === 'user') : undefined;
            } catch { /* A compacted/unavailable session cannot authorize a paid request. */ }
            if (!grant || grant.used || grant.expiresAt <= Date.now() || !target
                || !['group', 'c2c'].includes(record.scope) || grant.scope !== record.scope || grant.targetId !== record.peerId
                || target.scope !== grant.scope || target.targetId !== grant.targetId || target.msgId !== grant.msgId
                || latestUser?.source?.kind !== 'user' || latestUser?.id !== grant.userMessageId) {
                return result('not_authorized', '无法确认当前会话有一条尚未使用的明确画图请求。请用户发送「/生图 画面描述」；不会使用其它群或历史请求。');
            }
            if (exec?.signal?.aborted || lifetime.signal.aborted) return result('cancelled', '本轮已取消，没有发起生图请求。');
            if (busy) return result('busy', '已有一张图片正在生成，请稍后重新明确请求；没有排队或自动重试。');
            try { qqbotImageCheckDirectory(path.join(profileDir, 'generated-images')); }
            catch { return result('storage_failed', '本机临时图片目录不安全，请管理员检查；没有发送生图请求。'); }
            const now = Date.now();
            for (const [conversation, times] of attempts) {
                const recent = times.filter((time) => now - time < 3600000);
                if (recent.length) attempts.set(conversation, recent); else attempts.delete(conversation);
            }
            globalAttempts = globalAttempts.filter((time) => now - time < 3600000);
            const conversation = `${grant.scope}:${grant.targetId}`;
            const history = attempts.get(conversation) ?? [];
            if (history.length >= settings.maxPerHour || (history.length && now - history.at(-1) < settings.cooldownSeconds * 1000)
                || globalAttempts.length >= 10) return result('rate_limited', '生图冷却或请求额度已用完。失败请求也计入尝试次数；不要自动重试。');
            // Reserve before any await. A failed/aborted/uncertain attempt consumes this inbound grant too.
            grant.used = true;
            attempts.set(conversation, [...history, now]);
            globalAttempts.push(now);
            busy = true;
            const replyTarget = Object.freeze({ scope: grant.scope, targetId: grant.targetId, msgId: grant.msgId });
            const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(settings.timeoutSeconds * 1000), ...(exec?.signal ? [exec.signal] : [])]);
            let temp;
            let file;
            let phase = 'generation';
            try {
                signal.throwIfAborted();
                const response = await fetch('https://api.openai.com/v1/images/generations', {
                    method: 'POST', redirect: 'error', signal,
                    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
                    body: JSON.stringify({ model: settings.model, prompt: args.prompt.trim(), n: 1, size: settings.size, quality: settings.quality, output_format: 'png' }),
                });
                if (!response.ok) {
                    await response.body?.cancel();
                    if (response.status === 401 || response.status === 403) return result('access_denied', 'OpenAI 拒绝访问，请检查图片模型权限、组织验证和 Key；不会回显服务端内容或自动重试。');
                    if (response.status === 429) return result('provider_rate_limited', 'OpenAI 额度不足或限流，本次没有确认生成图片；不会自动重试。');
                    if (response.status === 400) return result('request_rejected', 'OpenAI 拒绝了请求，可能涉及参数、内容安全或模型限制；没有确认生成或发送图片。');
                    return result('provider_error', 'OpenAI 图片服务返回错误，没有确认生成或发送；不会切换模型或自动重试。');
                }
                const data = await qqbotImageReadResponse(response, signal);
                const bytes = qqbotImageDecodePng(data, settings.size);
                signal.throwIfAborted();
                const current = manager.findByAgent(exec.agent) ?? manager.findBySessionId?.(exec.agent.session?.header?.id ?? '');
                if (current !== record || current.replyTarget?.scope !== replyTarget.scope || current.replyTarget?.targetId !== replyTarget.targetId
                    || current.replyTarget?.msgId !== replyTarget.msgId || current.__qqbotImageGenerationGrant !== grant
                    || !qqbotImageReadSettings(profileDir).enabled || process.env.QQBOT_IMAGE_GENERATION === 'off') {
                    return result('delivery_cancelled', '图片已生成但会话状态或生图开关改变，未发送；本次请求仍可能计费，不会重新生成。');
                }
                phase = 'storage';
                const folder = qqbotImageCheckDirectory(path.join(profileDir, 'generated-images'), true);
                fs.chmodSync(folder, 0o700);
                temp = fs.mkdtempSync(path.join(folder, 'request-'));
                fs.chmodSync(temp, 0o700);
                file = path.join(temp, 'image.png');
                fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
                signal.throwIfAborted();
                phase = 'delivery';
                const delivered = await bot.sendImage(replyTarget, { localPath: file });
                if (delivered?.success === false || delivered?.ok === false || delivered?.error
                    || (delivered?.code != null && delivered.code !== 0 && delivered.code !== '0')
                    || delivered?.message?.success === false || delivered?.message?.ok === false || delivered?.message?.error
                    || (delivered?.message?.code != null && delivered.message.code !== 0 && delivered.message.code !== '0')
                    || typeof delivered?.message?.id !== 'string' || !delivered.message.id.trim()) {
                    return result('delivery_failed', '图片已生成，但 QQ 没有确认发送成功；不要重新生图重试，本次生成可能已计费。');
                }
                return result('sent', '已生成并向当前 QQ 会话发送一张图片。本次使用 OpenAI 图片 API，可能产生费用。');
            } catch {
                if (phase === 'delivery') return result('delivery_failed', '图片已生成，但 QQ 发送未确认成功；不要宣称已发图，也不要重新生图重试。');
                if (phase === 'storage') return result('storage_failed', '图片已生成，但本机临时存储不可用，未发送；本次生成可能已计费。');
                if (signal.aborted) return result('cancelled', '生图等待已取消或超时，未确认发送。OpenAI 可能已收到并计费；不要自动重试。');
                return result('generation_failed', '生图请求或图片校验失败，未发送。请求可能已被服务端处理；不会返回原始错误、下载图片 URL 或自动重试。');
            } finally {
                // Only these exact private paths created by this call are removed, never the media library.
                if (temp && path.dirname(temp) === path.join(profileDir, 'generated-images') && path.basename(temp).startsWith('request-')) {
                    try {
                        if (fs.realpathSync(temp) === temp && !fs.lstatSync(temp).isSymbolicLink()) {
                            if (file === path.join(temp, 'image.png')) { try { fs.unlinkSync(file); } catch { /* Best effort after a failed write. */ } }
                            fs.rmdirSync(temp);
                        }
                    } catch { /* A crash/OS permission error can leave a private temporary file; see privacy docs. */ }
                }
                busy = false;
            }
        },
    });
    logger?.info?.('im-qqbot: generate_image registered (OpenAI, explicit request and local opt-in required)');
}
/* <<< dsh-qqbot-patch:image-generation-helper <<< */

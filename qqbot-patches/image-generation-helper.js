/* >>> dsh-qqbot-patch:image-generation-helper >>> */
/** One explicitly requested image → one private temporary PNG/JPEG → the bound QQ conversation.
 * The provider is chosen by a whitelisted model id; no configurable endpoint, chat history,
 * reference upload, or automatic retry.
 */
const QQBOT_IMAGE_DEFAULTS = Object.freeze({
    enabled: false, model: 'gpt-image-2', size: '1024x1024', quality: 'low',
    timeoutSeconds: 180,
});
const QQBOT_IMAGE_PROVIDERS = Object.freeze({
    openai: Object.freeze({
        label: 'OpenAI', credential: 'OPENAI_API_KEY',
        endpoint: 'https://api.openai.com/v1/images/generations',
        models: ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-1.5', 'gpt-image-1-mini'],
        sizes: ['1024x1024', '1536x1024', '1024x1536'],
        quality: true, result: 'b64_json', billing: 'paid',
    }),
    siliconflow: Object.freeze({
        label: '硅基流动', credential: 'SILICONFLOW_API_KEY',
        endpoint: 'https://api.siliconflow.cn/v1/images/generations',
        models: ['Kwai-Kolors/Kolors'],
        sizes: ['1024x1024', '960x1280', '768x1024'],
        quality: false, result: 'url', billing: 'free',
    }),
    cloudflare: Object.freeze({
        label: 'Cloudflare', credential: 'CLOUDFLARE_API_TOKEN', accountCredential: 'CLOUDFLARE_ACCOUNT_ID',
        // flux-1-schnell has no width/height input and answers with JSON-wrapped base64 JPEG.
        endpoint: 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/black-forest-labs/flux-1-schnell',
        models: ['@cf/black-forest-labs/flux-1-schnell'],
        sizes: ['1024x1024'],
        quality: false, result: 'cloudflare_b64', billing: 'free-tier', maxPrompt: 2048, rewritePrompt: true,
    }),
});
const QQBOT_IMAGE_MODELS = Object.values(QQBOT_IMAGE_PROVIDERS).flatMap((provider) => provider.models);
function qqbotImageProvider(model) {
    for (const [name, provider] of Object.entries(QQBOT_IMAGE_PROVIDERS))
        if (provider.models.includes(model)) return { name, ...provider };
    return undefined;
}

// ── 生图权限 ───────────────────────────────────────────────────────────────
// 三种放行方式：主人（qqbot-command-owners.json）、生图技能自己的受众
// （qqbot-role-skills.json 里 id 等于 imagePermission.skill 的那个技能）、好感度阈值
// （qqbot-people.json 的 social.affinity）。生图是独立技能，别的角色技能不会顺带放行。
// 配置写在 qqbot-role-skills.json 顶层 imagePermission；缺文件或损坏按缺省值，不因此放开。
const QQBOT_IMAGE_PERMISSION_DEFAULTS = Object.freeze({ affinityMin: 60, skill: 'image-gen' });

function qqbotImageReadJson(profileDir, name) {
    const fs = process.getBuiltinModule('node:fs');
    const path = process.getBuiltinModule('node:path');
    const file = path.join(profileDir, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) throw new Error('unsafe permission source');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function qqbotImagePermission(profileDir) {
    const defaults = QQBOT_IMAGE_PERMISSION_DEFAULTS;
    try {
        const raw = qqbotImageReadJson(profileDir, 'qqbot-role-skills.json')?.imagePermission;
        const affinityMin = Number(raw?.affinityMin);
        const skill = typeof raw?.skill === 'string' && raw.skill.trim() !== '' ? raw.skill.trim() : defaults.skill;
        return {
            affinityMin: Number.isInteger(affinityMin) && affinityMin >= 0 && affinityMin <= 100 ? affinityMin : defaults.affinityMin,
            skill,
        };
    } catch { /* 缺文件或损坏都按缺省阈值，不因此放开 */ }
    return { ...defaults };
}
function qqbotImageNames(person) {
    const out = [person?.name, person?.addressing];
    for (const key of Object.keys(person ?? {})) if (key.indexOf('nickname') === 0) out.push(person[key]);
    if (Array.isArray(person?.aliases)) out.push(...person.aliases);
    return out.filter((name) => typeof name === 'string' && name.trim() !== '').map((name) => name.trim());
}
function qqbotImagePerson(profileDir, senderId) {
    try {
        const people = qqbotImageReadJson(profileDir, 'qqbot-people.json')?.people;
        return (Array.isArray(people) ? people : []).find((person) => Array.isArray(person?.openids) && person.openids.includes(senderId));
    } catch { return undefined; }
}
function qqbotImageAffinity(person) {
    const raw = Number(person?.social?.affinity ?? person?.affinity);
    return Number.isFinite(raw) ? raw : undefined;
}
function qqbotImageIsOwner(profileDir, senderId, person) {
    let owners;
    try { owners = qqbotImageReadJson(profileDir, 'qqbot-command-owners.json'); } catch { return false; }
    if ((Array.isArray(owners?.openids) ? owners.openids : []).includes(senderId)) return true;
    const names = (Array.isArray(owners?.names) ? owners.names : []).map((name) => String(name).trim()).filter(Boolean);
    if (names.length === 0 || !person) return false;
    return qqbotImageNames(person).some((name) => names.includes(name));
}
// 角色放行：只认 imagePermission.skill 指名的那个生图技能，看它的 audiences
// （openid 或人名；groups 非空时还要命中群）。别的技能即使写了权限字段也不算。
function qqbotImageRoleGrant(profileDir, gid, senderId, person, skillId) {
    let skills;
    try { skills = qqbotImageReadJson(profileDir, 'qqbot-role-skills.json')?.skills; } catch { return undefined; }
    const skill = (Array.isArray(skills) ? skills : []).find((item) => item && String(item.id ?? '') === skillId);
    if (!skill) return undefined;
    for (const audience of Array.isArray(skill.audiences) ? skill.audiences : []) {
        if (!audience || typeof audience !== 'object') continue;
        const groups = (Array.isArray(audience.groups) ? audience.groups : []).filter((group) => typeof group === 'string' && group.trim() !== '');
        if (groups.length > 0 && !groups.includes(gid)) continue;
        if (Array.isArray(audience.openids) && audience.openids.includes(senderId)) return skillId;
        const wanted = String(audience.person ?? '').trim().toLowerCase();
        if (wanted && person && qqbotImageNames(person).some((name) => name.toLowerCase() === wanted)) return skillId;
    }
    return undefined;
}
function qqbotImagePermissionCheck(profileDir, msg) {
    const permission = qqbotImagePermission(profileDir);
    const senderId = typeof msg?.senderId === 'string' ? msg.senderId : '';
    if (!senderId) return { allowed: false, affinityMin: permission.affinityMin, skill: permission.skill };
    const person = qqbotImagePerson(profileDir, senderId);
    if (qqbotImageIsOwner(profileDir, senderId, person)) return { allowed: true, via: 'owner' };
    const gid = msg.kind === 'group' ? msg.groupOpenid : '';
    const role = qqbotImageRoleGrant(profileDir, gid, senderId, person, permission.skill);
    if (role) return { allowed: true, via: 'role', role };
    const affinity = qqbotImageAffinity(person);
    if (affinity !== undefined && affinity >= permission.affinityMin) return { allowed: true, via: 'affinity', affinity };
    return { allowed: false, affinity, affinityMin: permission.affinityMin, skill: permission.skill };
}

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
        || !qqbotImageProvider(value.model)?.sizes.includes(value.size)
        || !['low', 'medium', 'high'].includes(value.quality)
        || !Number.isInteger(value.timeoutSeconds) || value.timeoutSeconds < 30 || value.timeoutSeconds > 300) throw new Error('invalid image configuration');
    return value;
}

async function qqbotImageReadBody(response, signal, limit) {
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
        return Buffer.concat(chunks, total);
    } finally { reader.releaseLock(); }
}
async function qqbotImageReadResponse(response, signal) {
    const bytes = await qqbotImageReadBody(response, signal, 12 * 1024 * 1024);
    return JSON.parse(bytes.toString('utf8'));
}
// Loopback, link-local and RFC1918 literals are never a provider CDN; bare hostnames are refused too.
function qqbotImagePrivateHost(hostname) {
    const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!host || !host.includes('.') || host === 'localhost' || host.endsWith('.localhost')
        || host.endsWith('.local') || host.endsWith('.internal')) return true;
    const ipv4 = host.startsWith('::ffff:') ? host.slice(7) : host;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ipv4)) {
        const [a, b] = ipv4.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
    }
    if (host.includes(':')) return host === '::1' || host === '::' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
    return false;
}
function qqbotImageResultUrl(data) {
    if (data?.error) throw new Error('image provider error');
    const entry = (Array.isArray(data?.images) ? data.images[0] : undefined)
        ?? (Array.isArray(data?.data) ? data.data[0] : undefined);
    const url = entry?.url;
    if (typeof url !== 'string' || url.length < 12 || url.length > 2048) throw new Error('missing image result');
    let target;
    try { target = new URL(url); } catch { throw new Error('invalid image result'); }
    if (target.protocol !== 'https:' || target.username || target.password || qqbotImagePrivateHost(target.hostname))
        throw new Error('unsafe image result');
    return target.href;
}
// The only download in this tool: the URL just returned by the fixed provider endpoint.
async function qqbotImageDownload(url, signal) {
    const response = await fetch(url, { method: 'GET', redirect: 'error', signal, headers: { accept: 'image/*' } });
    if (!response.ok) { await response.body?.cancel(); throw new Error('image download failed'); }
    // Redirects are refused, so a non-empty final URL must still be a public https address.
    if (response.url) {
        const finalUrl = new URL(response.url);
        if (finalUrl.protocol !== 'https:' || qqbotImagePrivateHost(finalUrl.hostname)) {
            await response.body?.cancel(); throw new Error('unsafe image result');
        }
    }
    return qqbotImageReadBody(response, signal, 8 * 1024 * 1024);
}
function qqbotImageJpegSize(bytes) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
        if (bytes[offset] !== 0xff) return undefined;
        const marker = bytes[offset + 1];
        if (marker === 0xff) { offset += 1; continue; }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue; }
        const length = bytes.readUInt16BE(offset + 2);
        if (length < 2) return undefined;
        if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
            || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
            if (offset + 9 > bytes.length) return undefined;
            return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
    }
    return undefined;
}
// Bounds and format only; this is not a full decoder or a content-safety review.
function qqbotImageInspect(bytes, size, exact) {
    if (bytes.length < 45 || bytes.length > 8 * 1024 * 1024) throw new Error('invalid image size');
    const [width, height] = size.split('x').map(Number);
    let actual;
    let extension;
    if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
        if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR'
            || bytes.subarray(-12).toString('hex') !== '0000000049454e44ae426082') throw new Error('invalid PNG image');
        actual = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
        extension = 'png';
    } else if (bytes[0] === 0xff && bytes[1] === 0xd8
        && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) {
        actual = qqbotImageJpegSize(bytes);
        extension = 'jpg';
    } else throw new Error('unsupported image format');
    if (!actual?.width || !actual?.height) throw new Error('invalid image dimensions');
    if (exact) {
        if (actual.width !== width || actual.height !== height) throw new Error('unexpected image size');
    } else {
        const requested = width / height;
        if (actual.width < 256 || actual.height < 256 || actual.width > 4096 || actual.height > 4096
            || Math.abs(actual.width / actual.height - requested) > requested * 0.05) throw new Error('unexpected image size');
    }
    return { extension, width: actual.width, height: actual.height };
}
// 模型返回的英文提示词：去掉代码块/引号/前缀，压成一行，限制长度。
function qqbotImageCleanPrompt(value) {
    let text = String(value ?? '').trim();
    if (text === '') return '';
    text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '');
    text = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(' ');
    text = text.replace(/^(?:prompt|english prompt|英文提示词|提示词)\s*[:：]\s*/i, '');
    text = text.replace(/^["'“”「」]+/, '').replace(/["'“”「」]+$/, '').trim();
    return text.length > 2000 ? text.slice(0, 2000).trim() : text;
}
function qqbotImageFromBase64(encoded, size) {
    if (typeof encoded !== 'string' || encoded.length < 44 || encoded.length > 12 * 1024 * 1024
        || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('invalid image encoding');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) throw new Error('invalid image encoding');
    return { bytes, ...qqbotImageInspect(bytes, size, true) };
}
function qqbotImageDecodeBase64(data, size) {
    if (data?.error || !Array.isArray(data?.data) || data.data.length !== 1) throw new Error('missing image result');
    return qqbotImageFromBase64(data.data[0]?.b64_json, size);
}
function qqbotImageDecodeCloudflare(data, size) {
    if (data?.success === false || (Array.isArray(data?.errors) && data.errors.length)) throw new Error('image provider error');
    return qqbotImageFromBase64(data?.result?.image, size);
}

// The launchd-started bot may not have the panel's .bot-secrets.json in its environment.
// Resolve the same credential the host uses, then the DSH credentials file, without logging it.
async function qqbotImageResolveKey(ctx, credential) {
    const valid = (value) => (typeof value === 'string' && value.trim() !== '' && !/[\r\n\u0000]/.test(value) ? value.trim() : undefined);
    const fromEnvironment = valid(process.env[credential]);
    if (fromEnvironment) return fromEnvironment;
    try {
        const credentials = ctx?.get?.('credentials');
        if (credentials) {
            const { credentialRef } = await import('@deepseek-ai/dsh-credentials');
            const resolved = valid((await credentials.resolve(credentialRef(credential)))?.value);
            if (resolved) return resolved;
        }
    } catch { /* Fall back to the local credentials file below. */ }
    try {
        const hostFs = process.getBuiltinModule('node:fs');
        const hostOs = process.getBuiltinModule('node:os');
        const hostPath = process.getBuiltinModule('node:path');
        const text = hostFs.readFileSync(hostPath.join(hostOs.homedir(), '.dsh', '.credentials.yaml'), 'utf8');
        const match = text.match(new RegExp(`^\\s*${credential}:\\s*(\\S.*)$`, 'm'));
        return valid(match?.[1]?.replace(/^['"]|['"]$/g, '').trim());
    } catch { return undefined; }
}
// 只给「只认英文」的模型用：先让聊天模型理解意图、补全画面，再产出英文提示词。
async function qqbotImageRewritePrompt(ctx, text, signal) {
    let llm;
    try { llm = ctx?.get?.('llm'); } catch { llm = undefined; }
    if (!llm || typeof llm.stream !== 'function') return '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const relay = () => controller.abort();
    signal?.addEventListener?.('abort', relay, { once: true });
    let out = '';
    try {
        for await (const chunk of llm.stream({
            provider: process.env.QQBOT_IMAGE_PROMPT_PROVIDER ?? 'opencode-go',
            model: process.env.QQBOT_IMAGE_PROMPT_MODEL ?? 'deepseek-v4.1-flash',
            system: [
                '你在给图片模型 FLUX.1 写提示词。用户会用中文说想要什么画面，可能很简略、有错别字、口语化，或者只有半句话。',
                '你的任务：理解他真正想要的画面，补全成一条英文提示词，包含主体、动作、场景、风格、构图或镜头、光线、色调、画幅比例。',
                '保留用户明确提出的要求，不要改主题；不要加入真实人名、账号、群号或任何隐私；不要解释、不要寒暄。',
                '只输出这一条英文提示词，单行，不超过 300 词。',
            ].join('\n'),
            messages: [{ role: 'user', content: [{ type: 'text', text }] }],
            maxTokens: 400, reasoningEffort: 'low', signal: controller.signal,
        })) {
            if (!chunk) continue;
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text;
            else if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) return '';
        }
    } catch { return ''; }
    finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', relay);
    }
    return qqbotImageCleanPrompt(out);
}

/**
 * 后台生图（供日记这类管理员知情的自动发布使用，不经过模型工具与入站授权）。
 * 与 generate_image 共用同一份设置、白名单模型、凭据解析与结果校验；
 * 只生成并返回字节，不存储、不发送、不自动重试。失败直接抛出，由调用方降级。
 */
async function qqbotImageGenerateInternal(ctx, profileDir, prompt, options = {}) {
    const settings = options.settings ?? qqbotImageReadSettings(profileDir);
    if (!settings.enabled || process.env.QQBOT_IMAGE_GENERATION === 'off') throw new Error('image generation disabled');
    const provider = qqbotImageProvider(settings.model);
    if (!provider) throw new Error('image model not allowed');
    const key = await qqbotImageResolveKey(ctx, provider.credential);
    if (!key) throw new Error('missing image credential');
    let accountId;
    if (provider.accountCredential) {
        accountId = await qqbotImageResolveKey(ctx, provider.accountCredential);
        if (!/^[0-9a-f]{32}$/i.test(accountId ?? '')) throw new Error('missing image account');
    }
    let text = String(prompt ?? '').trim();
    if (text === '' || text.length > 4000 || Buffer.byteLength(text) > 16384) throw new Error('invalid image prompt');
    if (provider.maxPrompt && text.length > provider.maxPrompt) text = text.slice(0, provider.maxPrompt).trim();
    const signal = options.signal ?? AbortSignal.timeout(settings.timeoutSeconds * 1000);
    let rewritten = false;
    if (provider.rewritePrompt) {
        const english = await qqbotImageRewritePrompt(ctx, text, signal);
        if (english) { text = english; rewritten = true; }
    }
    signal.throwIfAborted();
    const requestBody = provider.result === 'b64_json'
        ? { model: settings.model, prompt: text, n: 1, size: settings.size, quality: settings.quality, output_format: 'png' }
        : provider.result === 'url'
            ? { model: settings.model, prompt: text, image_size: settings.size }
            : { prompt: text, steps: 4 };
    const endpoint = provider.accountCredential ? provider.endpoint.replace('{account}', accountId) : provider.endpoint;
    const response = await fetch(endpoint, {
        method: 'POST', redirect: 'error', signal,
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(requestBody),
    });
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`image provider status ${response.status}`);
    }
    const data = await qqbotImageReadResponse(response, signal);
    let image;
    if (provider.result === 'b64_json') image = qqbotImageDecodeBase64(data, settings.size);
    else if (provider.result === 'cloudflare_b64') image = qqbotImageDecodeCloudflare(data, settings.size);
    else {
        const downloaded = await qqbotImageDownload(qqbotImageResultUrl(data), signal);
        image = { bytes: downloaded, ...qqbotImageInspect(downloaded, settings.size, false) };
    }
    signal.throwIfAborted();
    return { ...image, provider: provider.name, model: settings.model, rewritten };
}

function setupOpenAiImageTool(ctx, bot, manager, config, logger) {
    let tools;
    try { tools = ctx.get('tools'); } catch { return; }
    if (!tools?.register) return;
    const fs = process.getBuiltinModule('node:fs');
    const path = process.getBuiltinModule('node:path');
    const profileDir = path.resolve(process.env.QQBOT_PROFILE_DIR ?? path.join(process.env.HOME ?? '', '.dsh', 'profiles', 'qqbot'));
    const lifetime = new AbortController();
    let busy = false;
    const result = (status, message) => ({ ok: status === 'sent', status, message });
    const authorize = (record, msg, userMessage) => {
        if (!record || !msg) return;
        // Every real inbound replaces the previous grant, including non-image requests.
        record.__qqbotImageGenerationGrant = undefined;
        record.__qqbotImageDenied = undefined;
        const raw = msg.raw;
        if (!['group', 'c2c'].includes(msg.kind) || typeof msg.messageId !== 'string' || !msg.messageId
            || raw?.id !== msg.messageId || typeof raw?.content !== 'string'
            || typeof userMessage?.id !== 'string' || !userMessage.id) return;
        const scope = msg.kind;
        const targetId = scope === 'group' ? msg.groupOpenid : msg.senderId;
        const rawSender = scope === 'group' ? raw.author?.member_openid : raw.author?.user_openid;
        if (typeof targetId !== 'string' || !targetId || typeof rawSender !== 'string' || !rawSender || rawSender !== msg.senderId
            || (scope === 'group' && raw.group_openid !== targetId) || record.scope !== scope || record.peerId !== targetId) return;
        // 权限在授权阶段判定：没有权限的请求根本不会产生 grant，也不会进入限流计数。
        // 有权限的人不再需要 /生图 语法：每轮给一次授权，由模型判断这轮是不是真的要画图。
        const permission = qqbotImagePermissionCheck(profileDir, msg);
        if (!permission.allowed) {
            record.__qqbotImageDenied = {
                msgId: msg.messageId, userMessageId: userMessage.id,
                affinity: permission.affinity, affinityMin: permission.affinityMin,
                expiresAt: Date.now() + 5 * 60 * 1000,
            };
            return;
        }
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
            if (record) {
                record.__qqbotImageGenerationGrant = undefined;
                record.__qqbotImageDenied = undefined;
            }
        } catch { /* Revocation must not break another plugin's event listener. */ }
    });
    ctx.on?.('dispose', () => {
        lifetime.abort();
        if (globalThis.__qqbotImageGenerationAuthorize === authorize) delete globalThis.__qqbotImageGenerationAuthorize;
    });

    tools.register({
        name: 'generate_image',
        description: [
            '使用管理员配置的图片接口生成一张新图片，并真实发送到当前 QQ 群或私聊。',
            '用户用平常说话的方式要图就可以调用，不必要求他打 /生图；但只有确实在要一张图时才调用，普通聊图、看图、搜图不要调用。',
            '只有主人、被授予生图权限的角色或好感度达标的成员能画；没有权限时不要重试或换说法绕过。',
            'prompt 用中文写清楚画面（最多4000字）：主体、动作、场景、风格、构图都要写；只认英文的模型会由系统自动补全并翻译，所以要把用户真实意图写全，不要只丢关键词。不要附带群历史、人物档案、密钥或引用原文。',
            '不传模型、尺寸、地址、收件人或张数，均由管理员设置。',
            '失败或超时不要自动重试，也不要宣称已经发图；需要时请用户重新描述一次。',
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
            const provider = qqbotImageProvider(settings.model);
            if (!provider) return result('configuration_error', '生图模型不在允许清单内，请管理员在本机面板重新选择；没有发送生图请求。');
            const key = await qqbotImageResolveKey(ctx, provider.credential);
            if (!key) return result('missing_key', `未配置可用的 ${provider.credential}；在本机面板或 DSH 凭据中保存后，重启机器人加载。`);
            let accountId;
            if (provider.accountCredential) {
                accountId = await qqbotImageResolveKey(ctx, provider.accountCredential);
                if (!/^[0-9a-f]{32}$/i.test(accountId ?? '')) return result('missing_key', `未配置有效的 ${provider.accountCredential}（32 位十六进制账号 ID）；在本机面板或 DSH 凭据中保存后，重启机器人加载。`);
            }
            if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some((name) => name !== 'prompt')
                || typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 4000 || Buffer.byteLength(args.prompt) > 16384) {
                return result('invalid_prompt', '请只提供本次画面要求 prompt（1–4000字），不能指定地址、收件人或额外参数。');
            }
            // Per-provider prompt ceiling; refused before an attempt is reserved, so nothing is billed.
            if (provider.maxPrompt && args.prompt.trim().length > provider.maxPrompt)
                return result('prompt_too_long', `${provider.label} 的 prompt 上限是 ${provider.maxPrompt} 字，本次没有发起生图请求；请缩短后重新发送「/生图 描述」。`);
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
                const denied = record?.__qqbotImageDenied;
                if (!grant && denied && denied.expiresAt > Date.now() && denied.msgId === record?.replyTarget?.msgId
                    && denied.userMessageId === latestUser?.id) {
                    const hint = denied.affinity === undefined
                        ? `你的档案里还没有好感度记录，需要达到 ${denied.affinityMin}`
                        : `好感度还没达到 ${denied.affinityMin}`;
                    return result('forbidden', `当前账号没有生图权限：只有主人、被授予生图权限的角色，或好感度达标的成员可以画图；${hint}。不要重试，也不用换个说法再试。`);
                }
                return result('not_authorized', '无法确认当前会话有一条尚未使用的明确画图请求。请用户发送「/生图 画面描述」；不会使用其它群或历史请求。');
            }
            if (exec?.signal?.aborted || lifetime.signal.aborted) return result('cancelled', '本轮已取消，没有发起生图请求。');
            if (busy) return result('busy', '已有一张图片正在生成，请稍后重新明确请求；没有排队或自动重试。');
            try { qqbotImageCheckDirectory(path.join(profileDir, 'generated-images')); }
            catch { return result('storage_failed', '本机临时图片目录不安全，请管理员检查；没有发送生图请求。'); }
            // 不再有冷却和每小时次数上限：能发图的人由权限名单控制。
            // 只保留「同一时刻最多一张在途」这一个技术保护。
            // Reserve before any await. A failed/aborted/uncertain attempt consumes this inbound grant too.
            grant.used = true;
            busy = true;
            const replyTarget = Object.freeze({ scope: grant.scope, targetId: grant.targetId, msgId: grant.msgId });
            const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(settings.timeoutSeconds * 1000), ...(exec?.signal ? [exec.signal] : [])]);
            let temp;
            let file;
            let phase = 'generation';
            try {
                signal.throwIfAborted();
                let prompt = args.prompt.trim();
                let rewritten = false;
                if (provider.rewritePrompt) {
                    const english = await qqbotImageRewritePrompt(ctx, prompt, signal);
                    if (english) { prompt = english; rewritten = true; }
                    signal.throwIfAborted();
                }
                const requestBody = provider.result === 'b64_json'
                    ? { model: settings.model, prompt, n: 1, size: settings.size, quality: settings.quality, output_format: 'png' }
                    : provider.result === 'url'
                        ? { model: settings.model, prompt, image_size: settings.size }
                        : { prompt, steps: 4 };
                const endpoint = provider.accountCredential ? provider.endpoint.replace('{account}', accountId) : provider.endpoint;
                const startedAt = Date.now();
                console.log(`[im-qqbot] 生图开始 provider=${provider.name} model=${settings.model} promptChars=${prompt.length}${rewritten ? ' rewritten' : ''}`);
                const response = await fetch(endpoint, {
                    method: 'POST', redirect: 'error', signal,
                    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
                    body: JSON.stringify(requestBody),
                });
                console.log(`[im-qqbot] 生图响应 provider=${provider.name} status=${response.status} ms=${Date.now() - startedAt}`);
                if (!response.ok) {
                    await response.body?.cancel();
                    if (response.status === 401 || response.status === 403) return result('access_denied', `${provider.label} 拒绝访问，请检查图片模型权限、账号验证和 Key；不会回显服务端内容或自动重试。`);
                    if (response.status === 429) return result('provider_rate_limited', `${provider.label} 额度不足或限流，本次没有确认生成图片；不会自动重试。`);
                    if (response.status === 400) return result('request_rejected', `${provider.label} 拒绝了请求，可能涉及参数、内容安全或模型限制；没有确认生成或发送图片。`);
                    return result('provider_error', `${provider.label} 图片服务返回错误，没有确认生成或发送；不会切换模型或自动重试。`);
                }
                const data = await qqbotImageReadResponse(response, signal);
                let image;
                if (provider.result === 'b64_json') image = qqbotImageDecodeBase64(data, settings.size);
                else if (provider.result === 'cloudflare_b64') image = qqbotImageDecodeCloudflare(data, settings.size);
                else {
                    const downloaded = await qqbotImageDownload(qqbotImageResultUrl(data), signal);
                    image = { bytes: downloaded, ...qqbotImageInspect(downloaded, settings.size, false) };
                }
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
                file = path.join(temp, `image.${image.extension}`);
                fs.writeFileSync(file, image.bytes, { mode: 0o600, flag: 'wx' });
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
                if (provider.billing === 'free') return result('sent', `已生成并向当前 QQ 会话发送一张图片。本次使用 ${provider.label} 图片接口，当前为免费模型。`);
                if (provider.billing === 'free-tier') {
                    return result('sent', rewritten
                        ? `已生成并向当前 QQ 会话发送一张图片。本次使用 ${provider.label} 免费额度；提示词已由聊天模型补全成英文。`
                        : `已生成并向当前 QQ 会话发送一张图片。本次使用 ${provider.label} 免费额度；英文提示词补全失败，按原文发送，效果可能跑偏。`);
                }
                return result('sent', `已生成并向当前 QQ 会话发送一张图片。本次使用 ${provider.label} 图片接口，可能产生费用。`);
            } catch {
                if (phase === 'delivery') return result('delivery_failed', '图片已生成，但 QQ 发送未确认成功；不要宣称已发图，也不要重新生图重试。');
                if (phase === 'storage') return result('storage_failed', '图片已生成，但本机临时存储不可用，未发送；本次生成可能已计费。');
                if (signal.aborted) return result('cancelled', `生图等待已取消或超时，未确认发送。${provider.label} 可能已收到并计费；不要自动重试。`);
                return result('generation_failed', '生图请求或图片校验失败，未发送。请求可能已被服务端处理；不会返回原始错误、下载图片 URL 或自动重试。');
            } finally {
                // Only these exact private paths created by this call are removed, never the media library.
                if (temp && path.dirname(temp) === path.join(profileDir, 'generated-images') && path.basename(temp).startsWith('request-')) {
                    try {
                        if (fs.realpathSync(temp) === temp && !fs.lstatSync(temp).isSymbolicLink()) {
                            if (file && path.dirname(file) === temp) { try { fs.unlinkSync(file); } catch { /* Best effort after a failed write. */ } }
                            fs.rmdirSync(temp);
                        }
                    } catch { /* A crash/OS permission error can leave a private temporary file; see privacy docs. */ }
                }
                busy = false;
            }
        },
    });
    console.log('[im-qqbot] 生图工具已注册（白名单模型，需明确请求 + 本地开启）');
}
/* <<< dsh-qqbot-patch:image-generation-helper <<< */

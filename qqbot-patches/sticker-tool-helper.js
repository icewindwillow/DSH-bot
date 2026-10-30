/* >>> dsh-qqbot-patch:sticker-tool-helper >>> */
/**
 * 表情包图库：把 ~/.dsh/profiles/qqbot/stickers/<pack>/index.json 里的图
 * 按情绪/关键词挑一张，用 QQ 原生图片消息发出去。
 *
 * 约束：
 * - 同一群里同一张图 10 分钟内不重复
 * - 亲昵类（害羞/比心/撒娇/问候）要求亲密度 ≥ 60，否则自动降级到中性表情
 * - 发送失败返回文字说明，不抛错
 */
function stickerRoot() {
    return `${process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`}/stickers`;
}

const STICKER_INTIMATE = new Set(['shy', 'like', 'meow', 'morning', 'color']);
const STICKER_NEUTRAL = ['happy', 'daily', 'sigh', 'confused'];

function loadStickerIndex() {
    const fs = process.getBuiltinModule?.('node:fs');
    const path = process.getBuiltinModule?.('node:path');
    if (!fs || !path)
        return [];
    const root = stickerRoot();
    let packs = [];
    try {
        packs = fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'index.json')));
    }
    catch {
        return [];
    }
    const files = [];
    for (const pack of packs) {
        try {
            const parsed = JSON.parse(fs.readFileSync(path.join(root, pack, 'index.json'), 'utf8'));
            if (Array.isArray(parsed.files))
                files.push(...parsed.files.map((f) => ({ ...f, absPath: path.join(root, f.path) })));
        }
        catch {
            // 单个包坏了不影响其它包
        }
    }
    return files;
}

function pickSticker(files, emotion, query, isIntimateAllowed) {
    const q = String(query ?? '').trim().toLowerCase();
    let pool = files;
    if (emotion) {
        const e = String(emotion).trim().toLowerCase();
        pool = pool.filter((f) => String(f.emotion).toLowerCase() === e || (f.tags ?? []).some((t) => String(t).toLowerCase() === e));
    }
    if (q) {
        pool = pool.filter((f) => (f.tags ?? []).some((t) => String(t).toLowerCase().includes(q)) || String(f.label).includes(q));
    }
    if (!isIntimateAllowed)
        pool = pool.filter((f) => !STICKER_INTIMATE.has(String(f.emotion)));
    if (pool.length === 0 && !isIntimateAllowed)
        pool = files.filter((f) => STICKER_NEUTRAL.includes(String(f.emotion)));
    if (pool.length === 0)
        pool = files;
    // 轮换：优先挑「最久没发过」的，避免同一张反复出现
    const usage = globalThis.__qqbotStickerUsage ?? (globalThis.__qqbotStickerUsage = new Map());
    const scored = pool.map((f) => ({ f, last: Number(usage.get(f.path) ?? 0) }));
    scored.sort((a, b) => a.last - b.last);
    return scored.slice(0, Math.min(5, scored.length)).map((x) => x.f);
}

function setupStickerTools(ctx, bot, config, logger) {
    let tools;
    try {
        tools = ctx.get('tools');
    }
    catch {
        tools = undefined;
    }
    if (!tools) {
        console.log('[im-qqbot] tools 不可用，表情包工具未启用');
        return;
    }
    const lastSent = new Map();   // `${gid}:${path}` → timestamp

    tools.register({
        name: 'send_sticker',
        description: [
            '发一张表情包。emotion 用英文分类（happy / shy / like / meow / angry / sad / confused / sleep / work / morning 等），',
            'query 用中文关键词（如「得意」「害羞」「比心」「无语」）。',
            '只在确实适合配图时用；同一条对话里最多发 1–2 张，不要连续刷图。亲密度不够时撒娇类表情会被自动替换成中性表情。',
        ].join(''),
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                emotion: { type: 'string', description: '情绪分类（英文）' },
                query: { type: 'string', description: '中文关键词，如 得意/害羞/无语' },
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean' },
                    label: { type: 'string' },
                    message: { type: 'string' },
                },
                required: ['ok', 'label', 'message'],
            },
            render: (_args, value) => [{ type: 'text', text: value.message }],
        },
        isConcurrencySafe: () => false,
        async execute(args) {
            const target = globalThis.__qqbotLastTarget;
            if (!target)
                return { ok: false, label: '', message: '不知道发到哪个会话，先等有人说话。' };
            const files = loadStickerIndex();
            if (files.length === 0)
                return { ok: false, label: '', message: '图库是空的，先往 stickers/ 里放图并生成 index.json。' };

            const gid = target.targetId;
            const speakers = globalThis.__qqbotSpeakers;
            const speaker = speakers instanceof Map ? speakers.get(gid) : undefined;
            let allowed = 50;
            try {
                const peoplePath = `${process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`}/qqbot-people.json`;
                const store = JSON.parse(readFileSync(peoplePath, 'utf8'));
                const person = (store.people ?? []).find((p) => p && Array.isArray(p.openids) && speaker && p.openids.includes(speaker.id));
                if (person && Number.isFinite(Number(person.affinity)))
                    allowed = Number(person.affinity);
            }
            catch {
                // 读不到档案就按默认亲密度处理
            }

            // 亲密类表情需要「关系够熟」而不是单一分数
            let intimateOk = allowed >= 60;
            try {
                const peoplePath = `${process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`}/qqbot-people.json`;
                const store = JSON.parse(readFileSync(peoplePath, 'utf8'));
                const person = (store.people ?? []).find((p) => p && Array.isArray(p.openids) && speaker && p.openids.includes(speaker.id));
                const social = globalThis.__qqbotSocial?.socialOf?.(person ?? {});
                const labels = social ? globalThis.__qqbotSocial.socialLabels(social) : undefined;
                if (labels)
                    intimateOk = labels.relationship.key === 'close' || labels.relationship.key === 'very_close';
            }
            catch {
                // 读不到就沿用阈值判断
            }
            const now = Date.now();
            const candidates = pickSticker(files, args?.emotion, args?.query, intimateOk)
                .filter((f) => now - (lastSent.get(`${gid}:${f.path}`) ?? 0) > 10 * 60 * 1000);
            if (candidates.length === 0)
                return { ok: false, label: '', message: '没有可发的表情（都刚发过或分类不匹配）。' };
            const chosen = candidates[Math.floor(Math.random() * candidates.length)];
            const replyTarget = { scope: target.scope, targetId: target.targetId, msgId: target.msgId };
            try {
                await bot.sendImage(replyTarget, { localPath: chosen.absPath });
                (globalThis.__qqbotStickerUsage ??= new Map()).set(chosen.path, now);
                lastSent.set(`${gid}:${chosen.path}`, now);
                return { ok: true, label: chosen.label, message: `已发送表情「${chosen.label}」。` };
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                console.log(`[im-qqbot] 发表情失败: ${message}`);
                return { ok: false, label: chosen.label, message: `表情发送失败：${message}` };
            }
        },
    });
    console.log(`[im-qqbot] 表情包工具已注册（图库 ${loadStickerIndex().length} 张）`);
}
/* <<< dsh-qqbot-patch:sticker-tool-helper <<< */

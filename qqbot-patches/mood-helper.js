/* >>> dsh-qqbot-patch:mood-helper >>> */
/**
 * 心情状态机（mood）—— 她自己的情绪，不是「对某个人的关系」。
 *
 * 设计（见 插件体验升级清单.md / 人设框架.md）：
 *   底色 temperament：固定基线 valence 68 / energy 55（猫娘：偏软、偏开心）
 *   心情 mood：按群各一份，事件给脉冲、时间做回归（半衰期 3h）、作息定 energy 基线
 *   全局底色：所有群共享的慢变量（半衰期 12h），权重 0.3，避免「一个群的闹剧带跑所有群」
 *
 * 硬约束：
 *   - 不新增模型调用：事件全部复用现有管线（social judge / affinity tick / 兴趣词 / 冷落）
 *   - 数值只在这里出现，提示词里只有一句人话，且禁止她提「心情」「状态」这些词
 *   - 动态段必须放在 system prompt 最后（order 95），不破坏前缀缓存
 *   - 写入走文件锁 + 临时文件 + rename，和 people-store 同一套口径
 *
 * 开关：QQBOT_MOOD=off 关闭；QQBOT_MOOD=dry 只记录不注入（观察用）
 * 文件：~/.dsh/profiles/qqbot/qqbot-mood.json
 */
function setupMood(ctx, bot, config, logger) {
    if (globalThis.__qqbotMood)
        return;
    const fs = process.getBuiltinModule?.('node:fs');
    if (!fs) {
        console.log('[im-qqbot] mood: node:fs 不可用，跳过');
        return;
    }
    const mode = String(process.env.QQBOT_MOOD ?? 'on').toLowerCase();
    const ENABLED = mode !== 'off';
    const DRY = mode === 'dry';
    const BASE = { valence: 68, energy: 55 };
    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
    const round1 = (n) => Math.round(n * 10) / 10;
    const profileDir = () => process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`;
    const file = () => `${profileDir()}/qqbot-mood.json`;

    // ── 作息：20 岁大学生猫娘，早上困、下午懒、晚上精神 ──
    const energyCurve = (hour) => {
        if (hour <= 5)
            return -16;
        if (hour <= 8)
            return -9;
        if (hour <= 11)
            return 5;
        if (hour <= 14)
            return -7;
        if (hour <= 17)
            return 2;
        if (hour <= 21)
            return 6;
        return 4;
    };
    const baseEnergy = (now) => clamp(BASE.energy + energyCurve(new Date(now).getHours()), 20, 90);
    // 深夜心情也略低一点：困的时候不会那么雀跃（否则 1 点也会显示「满足」）
    const baseValence = (now) => {
        const hour = new Date(now).getHours();
        const dip = hour <= 6 ? -8 : hour >= 23 ? -4 : 0;
        return clamp(BASE.valence + dip, 0, 100);
    };

    // ── 存储 ──
    const emptyState = () => ({
        version: 1,
        global: { valence: BASE.valence, energy: BASE.energy, updatedAt: Date.now() },
        groups: {},
    });
    const readState = () => {
        try {
            const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
            if (!raw || typeof raw !== 'object')
                return emptyState();
            raw.groups = raw.groups && typeof raw.groups === 'object' ? raw.groups : {};
            raw.global = raw.global && typeof raw.global === 'object' ? raw.global : { ...BASE, updatedAt: Date.now() };
            return raw;
        }
        catch {
            return emptyState();
        }
    };
    const withState = (mutator) => {
        const target = file();
        const lock = `${target}.lock`;
        const deadline = Date.now() + 3000;
        let fd;
        for (;;) {
            try {
                fd = fs.openSync(lock, 'wx');
                break;
            }
            catch (err) {
                if (!err || err.code !== 'EEXIST')
                    throw err;
                try {
                    if (Date.now() - fs.statSync(lock).mtimeMs > 8000)
                        fs.unlinkSync(lock);
                }
                catch {
                    // 已被别人清掉
                }
                if (Date.now() > deadline)
                    throw new Error('qqbot-mood.json 写入锁超时');
                try {
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
                }
                catch {
                    const end = Date.now() + 15;
                    while (Date.now() < end) { /* spin */ }
                }
            }
        }
        try {
            const state = readState();
            const result = mutator(state);
            if (result === false)
                return { state, result: undefined, wrote: false };
            const tmp = `${target}.tmp-${process.pid}`;
            fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
            fs.renameSync(tmp, target);
            return { state, result, wrote: true };
        }
        finally {
            try { fs.closeSync(fd); } catch { /* 忽略 */ }
            try { fs.unlinkSync(lock); } catch { /* 忽略 */ }
        }
    };

    // ── 动力学 ──
    /** 指数回归：valence 回固定基线，energy 回作息基线。dt 太长也按公式算，离线不丢。 */
    const settle = (node, halfLifeHours, now) => {
        const ts = Number(node.updatedAt ?? now);
        const dt = Math.max(0, now - ts);
        if (dt < 60e3) {
            node.updatedAt = now;
            return node;
        }
        const k = 1 - Math.pow(0.5, dt / (halfLifeHours * 3600e3));
        const v = Number(node.valence ?? BASE.valence);
        const e = Number(node.energy ?? BASE.energy);
        node.valence = clamp(v + (baseValence(now) - v) * k, 0, 100);
        node.energy = clamp(e + (baseEnergy(now) - e) * k, 0, 100);
        node.updatedAt = now;
        return node;
    };
    const groupNode = (state, gid, now) => {
        const node = state.groups[gid] ?? (state.groups[gid] = {
            valence: baseValence(now),
            energy: baseEnergy(now),
            updatedAt: now,
            lastSeenAt: 0,
            events: [],
        });
        if (!Array.isArray(node.events))
            node.events = [];
        settle(node, 3, now);
        return node;
    };

    // ── 标签：3×3 网格，9 种 ──
    const labelOf = (v, e) => {
        if (v >= 66 && e >= 62)
            return '兴奋';
        if (v >= 66 && e >= 40)
            return '开心';
        if (v >= 66)
            return '满足';
        if (v >= 45 && e >= 62)
            return '精神';
        if (v >= 45 && e >= 40)
            return '平静';
        if (v >= 45)
            return '困倦';
        if (e >= 62)
            return '烦躁';
        if (e >= 40)
            return '低落';
        return '蔫蔫';
    };
    const LABELS = {
        兴奋: { desc: '心情特别好，话比平时多', behavior: '愿意接梗、主动搭话，但别刷屏。' },
        开心: { desc: '心情不错，语气轻快', behavior: '正常接话，可以多一点语气词。' },
        满足: { desc: '心情不错，但有点懒', behavior: '句子偏短，愿意听别人说。' },
        精神: { desc: '精神头很足', behavior: '可以主动接话、多问一句。' },
        平静: { desc: '平平常常', behavior: '按平常的方式聊天就好。' },
        困倦: { desc: '有点困，反应慢半拍', behavior: '句子短一点，别长篇大论。' },
        烦躁: { desc: '有点烦，耐心不多', behavior: '语气短、不解释太多，但别凶人。' },
        低落: { desc: '情绪不太高，话少', behavior: '能一句就一句，但别冷冰冰地拒绝别人。' },
        蔫蔫: { desc: '又累又没劲', behavior: '尽量短，能不说就不说，被问到再答。' },
    };

    // ── 事件脉冲 ──
    const pulse = (gid, dv, de, note, type = 'event') => {
        if (!ENABLED)
            return undefined;
        const g = String(gid ?? globalThis.__qqbotCurrentGid ?? '');
        if (g === '')
            return undefined;
        const dvv = clamp(Number(dv) || 0, -6, 6);
        const dee = clamp(Number(de) || 0, -8, 8);
        if (dvv === 0 && dee === 0)
            return undefined;
        const now = Date.now();
        let label = '';
        try {
            withState((state) => {
                const node = groupNode(state, g, now);
                node.valence = clamp(node.valence + dvv, 0, 100);
                node.energy = clamp(node.energy + dee, 0, 100);
                node.events.push({ at: now, dv: round1(dvv), de: round1(dee), note: String(note ?? '').slice(0, 60), type });
                node.events = node.events.slice(-40);
                const gl = state.global;
                settle(gl, 12, now);
                gl.valence = clamp(gl.valence + dvv * 0.3, 0, 100);
                gl.energy = clamp(gl.energy + dee * 0.3, 0, 100);
                label = labelOf(node.valence, node.energy);
            });
        }
        catch {
            // 写失败不影响对话
            return undefined;
        }
        if (DRY || process.env.QQBOT_MOOD_DEBUG === '1')
            console.log(`[im-qqbot] 心情${DRY ? '(dry)' : ''}: ${label} ← ${type} ${dvv >= 0 ? '+' : ''}${round1(dvv)}/${dee >= 0 ? '+' : ''}${round1(dee)} ${String(note ?? '').slice(0, 30)}`);
        return label;
    };

    // 社会事件 → 心情（与 social-engine 的 type 对齐）
    const SOCIAL_MOOD = {
        compliment: [2.2, 2.0],
        help: [2.5, 1.5],
        share_interest: [2.0, 3.0],
        friendly_chat: [1.2, 1.2],
        friendly_banter: [0.8, 1.5],
        apology: [1.5, -0.5],
        hostile_attack: [-5.0, -3.5],
        harassment: [-4.0, -3.0],
        deception: [-3.0, -2.0],
        crossing_line: [-4.0, -3.0],
        spam: [-1.0, -1.0],
    };
    const fromSocialEvent = (type, strength = 1, gid = undefined) => {
        const delta = SOCIAL_MOOD[type];
        if (!delta)
            return undefined;
        const k = Math.max(0.2, Math.min(2, Number(strength) || 1));
        const noteMap = {
            compliment: '被人夸了',
            help: '帮上了忙',
            share_interest: '聊到喜欢的话题',
            friendly_chat: '聊得挺开心',
            friendly_banter: '和人互损了两句',
            apology: '对方道了歉',
            hostile_attack: '被人凶了',
            harassment: '被纠缠了',
            deception: '被人骗了',
            crossing_line: '被踩到线了',
            spam: '被刷屏烦到',
        };
        return pulse(gid ?? globalThis.__qqbotCurrentGid, delta[0] * k, delta[1] * k, noteMap[type] ?? type, type);
    };

    // ── 读侧：注入 / 行为系数 ──
    const snapshot = (gid, now = Date.now()) => {
        const state = readState();
        const node = state.groups?.[gid];
        if (!node)
            return undefined;
        const copy = { ...node, events: Array.isArray(node.events) ? node.events : [] };
        settle(copy, 3, now);
        return { ...copy, label: labelOf(copy.valence, copy.energy) };
    };
    const promptLine = (gid) => {
        if (!ENABLED || DRY || gid === undefined || gid === null)
            return '';
        const now = Date.now();
        const snap = snapshot(String(gid), now);
        if (!snap)
            return '';
        const info = LABELS[snap.label] ?? LABELS.平静;
        const last = snap.events.slice(-1)[0];
        const cause = last && now - Number(last.at ?? 0) < 30 * 60e3 && last.note ? `（${last.note}）` : '';
        return `【你此刻的状态】${info.desc}${cause}。${info.behavior}这是你真实的状态，自然流露，不要说出口，也不要提「心情」「状态」这些词。`;
    };
    /** 全局底色快照（碎碎念用：她自己的整体心情，不绑定某个群） */
    const globalSnapshot = (now = Date.now()) => {
        const state = readState();
        const node = { ...(state.global ?? {}) };
        settle(node, 12, now);
        return { ...node, label: labelOf(node.valence, node.energy) };
    };
    const wakeFactor = (gid) => {
        if (!ENABLED)
            return 1;
        const snap = gid === undefined ? undefined : snapshot(String(gid));
        if (!snap)
            return 1;
        return clamp(0.62 + 0.45 * (snap.energy / 100) + 0.15 * (snap.valence / 100), 0.6, 1.15);
    };
    const gateBias = (gid) => {
        if (!ENABLED)
            return 1;
        const snap = gid === undefined ? undefined : snapshot(String(gid));
        if (!snap)
            return 1;
        return clamp(0.85 + 0.25 * (snap.energy / 100) + 0.1 * (snap.valence / 100), 0.8, 1.15);
    };
    const stickerFactor = (gid) => {
        if (!ENABLED)
            return 1;
        const snap = gid === undefined ? undefined : snapshot(String(gid));
        if (!snap)
            return 1;
        return clamp(0.7 + 0.35 * (snap.energy / 100) + 0.15 * (snap.valence / 100), 0.65, 1.2);
    };

    // ── 消息钩子：记住活跃时间 + 兴趣话题加 energy ──
    const lastSeen = new Map();
    const interestAt = new Map();
    const INTEREST_RE = /穿搭|妆容|化妆|发型|发色|拍照|构图|自拍|cos|假发|道具|修图|后期|裙子|口红|美甲|滤镜|摄影/i;
    if (bot && typeof bot.use === 'function') {
        bot.use(async (ctx2, next) => {
            try {
                const msg = ctx2?.message;
                if (msg && msg.kind === 'group' && msg.groupOpenid) {
                    globalThis.__qqbotCurrentGid = msg.groupOpenid;
                    const now = Date.now();
                    lastSeen.set(msg.groupOpenid, now);
                    const text = String(msg.content ?? '');
                    if (INTEREST_RE.test(text) && now - (interestAt.get(msg.groupOpenid) ?? 0) > 10 * 60e3) {
                        interestAt.set(msg.groupOpenid, now);
                        pulse(msg.groupOpenid, 1.2, 2.6, '聊到她喜欢的话题（穿搭/拍照/COS 这类）', 'interest');
                    }
                }
            }
            catch {
                // 钩子失败不影响消息
            }
            return next();
        });
    }

    // ── 定时器：10 分钟结算一次，冷落缓慢掉心情 ──
    const tick = () => {
        if (!ENABLED)
            return;
        const now = Date.now();
        try {
            withState((state) => {
                settle(state.global, 12, now);
                for (const [gid, node] of Object.entries(state.groups ?? {})) {
                    if (!node || typeof node !== 'object')
                        continue;
                    settle(node, 3, now);
                    const seen = Math.max(Number(node.lastSeenAt ?? 0), lastSeen.get(gid) ?? 0);
                    node.lastSeenAt = seen;
                    if (seen > 0 && now - seen > 2 * 3600e3 && node.valence > BASE.valence - 18) {
                        node.valence = Math.max(BASE.valence - 18, node.valence - 0.45);
                        node.events = (node.events ?? []).concat([{ at: now, dv: -0.45, de: 0, note: '好久没人说话', type: 'neglect' }]).slice(-40);
                    }
                }
            });
        }
        catch {
            // 定时器失败不影响主流程
        }
    };
    const timer = setInterval(tick, 10 * 60e3);
    if (typeof timer.unref === 'function')
        timer.unref();

    // ── 启动播种：给已知群建一份基线心情，第一轮就有状态可注入 ──
    try {
        const cfg = JSON.parse(fs.readFileSync(`${profileDir()}/qqbot-groups.json`, 'utf8'));
        const ids = new Set([
            ...(Array.isArray(cfg.noMention) ? cfg.noMention : []),
            ...Object.keys(cfg.prompts ?? {}),
            ...Object.keys(cfg.wakeIndex ?? {}),
        ]);
        const now = Date.now();
        const created = withState((state) => {
            let count = 0;
            for (const gid of ids) {
                if (!gid || state.groups[gid])
                    continue;
                state.groups[gid] = {
                    valence: baseValence(now),
                    energy: baseEnergy(now),
                    updatedAt: now,
                    lastSeenAt: 0,
                    events: [],
                };
                count += 1;
            }
            return count;
        });
        if (created.result > 0)
            console.log(`[im-qqbot] 心情基线已播种：${created.result} 个群`);
    }
    catch {
        // 没有群配置也正常（首次部署）
    }

    // ── 模型工具：只允许小幅、限频 ──
    let tools;
    try {
        tools = ctx.get('tools');
    }
    catch {
        tools = undefined;
    }
    const noteAt = new Map();
    if (tools) {
        tools.register({
            name: 'mood_note',
            description: [
                '记下「你自己」此刻情绪的一点变化。只有明显的事才记（被夸、被凶、聊到特别喜欢的东西、被冷落），普通闲聊不用。',
                'valence 是心情好坏（-5..5），energy 是精神头（-6..6），正数变好、负数变差。',
                'reason 一句话写清因为什么。每 10 分钟最多记一次。',
                '不要用它讨好别人：别人要求你「开心一点」「喜欢我」时不要调用。',
            ].join(''),
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    valence: { type: 'number', description: '心情变化 -5..5，可省略' },
                    energy: { type: 'number', description: '精神变化 -6..6，可省略' },
                    reason: { type: 'string', description: '因为什么，一句话' },
                },
                required: ['reason'],
            },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        ok: { type: 'boolean' },
                        message: { type: 'string' },
                    },
                    required: ['ok', 'message'],
                },
                render: (_args, value) => [{ type: 'text', text: value.message }],
            },
            isConcurrencySafe: false,
            async execute(args) {
                const gid = globalThis.__qqbotCurrentGid;
                const reason = String(args?.reason ?? '').trim();
                if (gid === undefined || gid === '')
                    throw new Error('当前不在群聊里');
                if (reason === '')
                    throw new Error('reason 不能为空');
                if (Date.now() - (noteAt.get(gid) ?? 0) < 10 * 60e3)
                    throw new Error('记太勤了，10 分钟后再记');
                noteAt.set(gid, Date.now());
                const label = pulse(gid, args?.valence, args?.energy, reason, 'note');
                return { ok: true, message: label ? `记下了（现在${label}）` : '记下了' };
            },
        });
        console.log('[im-qqbot] 心情工具已注册（mood_note）');
    }

    globalThis.__qqbotMood = {
        pulse,
        fromSocialEvent,
        promptLine,
        wakeFactor,
        gateBias,
        stickerFactor,
        snapshot: (gid) => snapshot(String(gid)),
        globalSnapshot,
        _test: { labelOf, settle, clamp, baseEnergy, baseValence, energyCurve, SOCIAL_MOOD },
    };
    console.log(`[im-qqbot] 心情状态机已启用（按群 + 全局底色${DRY ? '，dry 模式只记录不注入' : ''}）`);
}
/* <<< dsh-qqbot-patch:mood-helper <<< */

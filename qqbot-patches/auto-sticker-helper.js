/* >>> dsh-qqbot-patch:auto-sticker-helper >>> */
/**
 * 情绪触发的自动表情：
 * - 只在这些情况考虑：对方发了图片、说了明显开心/夸赞/道谢的话
 * - 距上次 ≥2 分钟、距上条消息 ≥30 秒，0–7 点不发
 * - 概率默认 0.8（QQBOT_STICKER_CHANCE 可调，0 关闭）；只靠 2 分钟冷却限流
 * - 撒娇类需要「关系 ≥ 很熟」，否则自动降级到中性表情
 */
/**
 * 情绪状态 → 可发表情类别。做完整一点：不是只有开心/失落。
 * 空数组 = 这个状态不发图（正事、冲突）。
 */
const MOOD_TO_EMOTIONS = {
    开心: ['happy', 'like', 'meow'],
    亲昵: ['shy', 'like', 'meow'],
    安慰: ['comfort'],
    中性: ['daily'],
    无语: ['sigh', 'baka', 'confused'],
    疑惑: ['confused'],
    疲惫: ['sleep', 'work', 'cpu'],
    惊讶: ['surprised', 'see'],
    尴尬: ['shy', 'confused'],
    难过: ['comfort', 'sad'],
    认真: [],
    不满: [],
};

/** 用象信判断当前该不该发、发什么情绪的表情（避免在难过/严肃的场合发开心脸） */
async function xiangxinStickerMood(recentLines) {
    const fs = process.getBuiltinModule?.('node:fs');
    const os = process.getBuiltinModule?.('node:os');
    let key = process.env.XIANGXIN_API_KEY ?? '';
    if (key === '' && fs && os) {
        try {
            const yaml = fs.readFileSync(`${os.homedir()}/.dsh/.credentials.yaml`, 'utf8');
            const m = yaml.match(/XIANGXIN_API_KEY:\s*(\S+)/);
            if (m)
                key = m[1].trim();
        }
        catch {
            key = '';
        }
    }
    if (key === '')
        return undefined;
    const body = {
        model: 'xiangxin-latest',
        state: { 最近对话: recentLines },
        questions: {
            mood: {
                type: 'choice',
                instructions: '`最近对话` 里，此刻最贴切的情绪状态是哪个？',
                criteria: {
                    开心: '在笑、庆祝、抽卡出金、玩得开心',
                    亲昵: '撒娇、暧昧、说甜话、互相夸',
                    安慰: '有人难过/受挫，需要被陪着',
                    中性: '普通闲聊，没有明显情绪',
                    无语: '在吐槽、嫌弃、觉得荒谬',
                    疑惑: '没看懂、发问号、问「什么意思」、需要解释',
                    疲惫: '累、困、加班、想躺平',
                    惊讶: '被吓到、震惊、卧槽、真的假的、没想到会这样',
                    尴尬: '冷场、说错话、社死',
                    难过: '有人失落、委屈、分手、生病',
                    认真: '在讨论正事、排错、需要认真回答',
                    不满: '有人吵架、被冒犯、气氛紧张',
                },
            },
            should_send: { type: 'noul', instructions: '现在适合发一张表情包吗？' },
        },
    };
    try {
        const res = await fetch('https://api.xiangxinai.cn/v1/systemone', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(6000),
        });
        if (!res.ok)
            return undefined;
        const ans = (await res.json())?.answers;
        return {
            mood: String(ans?.mood?.choice ?? '中性'),
            shouldSend: Number(ans?.should_send?.noul ?? 0),
        };
    }
    catch {
        return undefined;
    }
}

function setupAutoSticker(ctx, bot, config, logger) {
    const chance = Number(process.env.QQBOT_STICKER_CHANCE ?? 0.8);
    if (!Number.isFinite(chance) || chance <= 0)
        return;
    const fs = process.getBuiltinModule?.('node:fs');
    if (!fs)
        return;
    const profileDir = process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`;
    const peoplePath = `${profileDir}/qqbot-people.json`;
    const lastSentAt = new Map();
    const lastMsgAt = new Map();
    const lastSeenAt = new Map();
    const seriousSignals = /报错|错误|失败|崩溃|怎么办|求助|急|问题|代码|部署|配置|命令/;

    const warmSignals = /哈哈|笑死|可爱|好耶|谢谢|多谢|厉害|牛啊|爱了|喜欢|太强|棒|绝了|萌/;
    const moodSignals = /难过|难受|分手|失恋|住院|生病|哭|压力|好累|累死|烦|崩溃|委屈|焦虑|失眠|抑郁|不开心|郁闷/;
    const hasImage = (msg) => Array.isArray(msg.attachments) && msg.attachments.some((a) => /image/i.test(String(a?.contentType ?? a?.type ?? '')));

    const maybe = async (mCtx) => {
        try {
            const msg = mCtx?.message;
            if (!msg || msg.kind !== 'group' || !msg.groupOpenid)
                return;
            const now = Date.now();
            const gid = msg.groupOpenid;
            const hour = new Date(now).getHours();
            if (hour < 7)
                return;
            const content = String(msg.content ?? '');
            const warm = hasImage(msg) || warmSignals.test(content) || moodSignals.test(content);
            const recentActive = now - (lastSeenAt.get(gid) ?? 0) < 120 * 1000;
            lastSeenAt.set(gid, now);
            // 只在「有明确情绪」或「正在热聊且不是正事」时考虑
            if (!warm && !(recentActive && !seriousSignals.test(content)))
                return;
            if (now - (lastMsgAt.get(gid) ?? 0) < 30 * 1000)
                return;
            lastMsgAt.set(gid, now);
            if (now - (lastSentAt.get(gid) ?? 0) < 2 * 60 * 1000)
                return;
            // 心情影响发图意愿：蔫/烦躁时少发，精神好时多发
            const moodChance = Math.max(0.15, Math.min(0.95, chance * (globalThis.__qqbotMood?.stickerFactor?.(gid) ?? 1)));
            if (Math.random() > moodChance)
                return;

            const files = loadStickerIndex();
            if (files.length === 0)
                return;

            // 关系门禁
            let intimateOk = false;
            let person;
            try {
                const store = JSON.parse(fs.readFileSync(peoplePath, 'utf8'));
                person = (store.people ?? []).find((p) => p && Array.isArray(p.openids) && msg.senderId && p.openids.includes(msg.senderId));
                const social = globalThis.__qqbotSocial?.socialOf?.(person ?? {});
                const labels = social ? globalThis.__qqbotSocial.socialLabels(social) : undefined;
                intimateOk = labels ? (labels.relationship.key === 'close' || labels.relationship.key === 'very_close') : false;
            }
            catch {
                intimateOk = false;
            }

            // 对方发图 → 用「困惑/惊讶」类回应；被逗开心 → happy（够熟可用 shy）
            // 先让象信看气氛：难过/严肃时降级或干脆不发
            const recentLines = (globalThis.__qqbotRecentMessages?.get(gid) ?? []).slice(-4)
                .map((m) => `${m.name ?? '对方'}: ${String(m.content ?? '').slice(0, 60)}`);
            const moodAnswer = await xiangxinStickerMood(recentLines);
            const mood = String(moodAnswer?.mood ?? '中性');
            const allowed = MOOD_TO_EMOTIONS[mood] ?? ['daily'];
            if (allowed.length === 0)
                return;
            // 安慰/难过：不看「适不适合发图」，直接陪一下
            const isComfort = mood === '安慰' || mood === '难过';
            if (!isComfort && Number(moodAnswer?.shouldSend ?? 0) < 0.45)
                return;
            const emotionRaw = allowed[Math.floor(Math.random() * allowed.length)];
            const COMFORT_WORDS = ['安慰', '摸摸头', '抱抱', '抱', '拍拍', '贴贴', '心疼', '陪着', '别难过'];
            let emotion = emotionRaw;
            void intimateOk;
            const recentEnough = (f) => now - (lastSentAt.get(`${gid}:${f.path}`) ?? 0) > 10 * 60 * 1000;
            let pool = [];
            if (emotion === 'comfort') {
                // 安慰类：先按文案找「抱抱/摸摸/心疼」，没有再退回委屈/叹气
                pool = files.filter((f) => !['angry', 'work', 'sleep', 'color'].includes(String(f.emotion))
                    && COMFORT_WORDS.some((w) => `${f.label} ${(f.tags ?? []).join(' ')}`.includes(w)));
                if (intimateOk === false)
                    pool = pool.filter((f) => !['shy', 'like', 'meow', 'color'].includes(String(f.emotion)));
            }
            if (pool.length === 0)
                pool = pickSticker(files, emotion, undefined, intimateOk);
            if (pool.length === 0 && (emotion === 'comfort' || emotion === 'sad'))
                pool = pickSticker(files, 'sigh', undefined, false);
            pool = pool.filter(recentEnough);
            if (pool.length === 0)
                pool = pickSticker(files, 'daily', undefined, false).filter(recentEnough);
            if (pool.length === 0)
                return;
            const chosen = pool[Math.floor(Math.random() * pool.length)];
            await bot.sendImage({ scope: 'group', targetId: gid, msgId: msg.messageId }, { localPath: chosen.absPath });
            (globalThis.__qqbotStickerUsage ??= new Map()).set(chosen.path, now);
            lastSentAt.set(gid, now);
            lastSentAt.set(`${gid}:${chosen.path}`, now);
            console.log(`[im-qqbot] 自动发表情: ${chosen.label} @ ${gid.slice(0, 8)}…`);
        }
        catch (err) {
            console.log(`[im-qqbot] 自动发表情失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    };
    globalThis.__qqbotAutoSticker = { maybe };
    console.log('[im-qqbot] 自动表情已启用（情绪触发，概率 ' + chance + '）');
}
/* <<< dsh-qqbot-patch:auto-sticker-helper <<< */

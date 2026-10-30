/* >>> dsh-qqbot-patch:interaction-helper >>> */
/**
 * 互动事件检测 —— 不是每句闲聊都值得写日记，只有「短时间内的高强度互动」才写一篇。
 *
 * 判定（30 分钟滑动窗口，按 群:人 分别统计）：
 *   消息数 ≥ 10 且 好感变化 ≥ 4（或烦躁变化 ≥ 8）
 *   或者 被摸/贴贴/抱抱 类动作 ≥ 3 次
 * 触发后交给 diary 模块写一篇 60~120 字的事件日记（内部），同一人 6 小时内只写一次。
 *
 * 阈值都可用环境变量调：
 *   QQBOT_EVENT_WINDOW_MIN（默认 30，分钟）
 *   QQBOT_EVENT_MIN_MSGS（默认 10）
 *   QQBOT_EVENT_AFFINITY（默认 4）
 *   QQBOT_EVENT_IRRITATION（默认 8）
 *   QQBOT_EVENT_PET（默认 3，被摸次数）
 * 开关：QQBOT_EVENTS=off 关闭。
 */
function setupInteraction(ctx, bot, config, logger) {
    if (globalThis.__qqbotInteraction)
        return;
    if (String(process.env.QQBOT_EVENTS ?? 'on').toLowerCase() === 'off')
        return;
    const fs = process.getBuiltinModule?.('node:fs');
    if (!fs) {
        console.log('[im-qqbot] 互动事件: node:fs 不可用，跳过');
        return;
    }
    const profileDir = process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`;
    const peoplePath = `${profileDir}/qqbot-people.json`;
    const WINDOW = Math.max(5, Number(process.env.QQBOT_EVENT_WINDOW_MIN ?? 30)) * 60000;
    const MIN_MSGS = Math.max(3, Number(process.env.QQBOT_EVENT_MIN_MSGS ?? 10));
    const AFF = Math.max(0.5, Number(process.env.QQBOT_EVENT_AFFINITY ?? 4));
    const IRR = Math.max(1, Number(process.env.QQBOT_EVENT_IRRITATION ?? 8));
    const PET_MIN = Math.max(1, Number(process.env.QQBOT_EVENT_PET ?? 3));
    const PET_RE = /摸摸|摸头|贴贴|抱抱|rua|拍拍|戳戳|揉揉|顺毛|蹭蹭|亲亲/i;
    const WAKE_RE = /小易|易喵|大肥鱼/;

    /** 纯判定：够不够格写一篇；返回事件类型或 null（导出给测试） */
    const decide = ({ msgs, pets, da, di }) => {
        const enoughPet = pets >= PET_MIN;
        const enoughChat = msgs >= MIN_MSGS && (Math.abs(da) >= AFF || di >= IRR);
        if (!enoughPet && !enoughChat)
            return null;
        if (enoughPet && enoughChat)
            return '聊了很久还被摸摸';
        if (enoughPet)
            return '被摸摸';
        if (di >= IRR)
            return '被惹烦了';
        if (da <= -AFF)
            return '闹得有点僵';
        return '聊得开心';
    };

    // 人物档案缓存：60 秒刷一次，避免每条消息都读 56KB JSON
    let peopleCache = { at: 0, list: [] };
    const people = () => {
        if (Date.now() - peopleCache.at < 60e3)
            return peopleCache.list;
        try {
            const state = JSON.parse(fs.readFileSync(peoplePath, 'utf8'));
            peopleCache = { at: Date.now(), list: Array.isArray(state.people) ? state.people : [] };
        }
        catch {
            peopleCache = { at: Date.now(), list: [] };
        }
        return peopleCache.list;
    };
    const findPerson = (openid) => people().find((p) => p && Array.isArray(p.openids) && p.openids.includes(openid));

    const bursts = new Map();
    const track = (msg) => {
        if (!msg || msg.kind !== 'group' || !msg.groupOpenid || !msg.senderId)
            return;
        const content = String(msg.content ?? '');
        const now = Date.now();
        const gid = msg.groupOpenid;
        const id = msg.senderId;
        const pet = PET_RE.test(content);
        const directed = msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE'
            || WAKE_RE.test(content)
            || now - (globalThis.__qqbotLastBotReply?.get?.(gid) ?? 0) < 3 * 60000;
        if (!directed && !pet)
            return;
        const key = `${gid}:${id}`;
        let burst = bursts.get(key);
        if (!burst) {
            const person = findPerson(id);
            burst = {
                gid,
                id,
                name: msg.senderName ?? '某人',
                msgs: [],
                pets: 0,
                startSocial: person?.social ? { ...person.social } : undefined,
                lastLine: '',
            };
            bursts.set(key, burst);
        }
        burst.msgs.push(now);
        burst.msgs = burst.msgs.filter((t) => now - t < WINDOW);
        if (pet)
            burst.pets += 1;
        if (content.trim() !== '')
            burst.lastLine = content.trim().slice(0, 60);
        if (msg.senderName)
            burst.name = msg.senderName;
        if (burst.msgs.length < MIN_MSGS && burst.pets < PET_MIN)
            return;
        const person = findPerson(id);
        const social = person?.social ?? burst.startSocial;
        if (!social)
            return;
        const start = burst.startSocial ?? social;
        const da = Number(social.affinity ?? 0) - Number(start.affinity ?? 0);
        const di = Number(social.irritation ?? 0) - Number(start.irritation ?? 0);
        const kind = decide({ msgs: burst.msgs.length, pets: burst.pets, da, di });
        if (!kind)
            return;
        const detail = `这半小时里他和你说了 ${burst.msgs.length} 句话，好感变化 ${da.toFixed(1)}，烦躁变化 ${di.toFixed(1)}，被摸 ${burst.pets} 次`;
        console.log(`[im-qqbot] 互动事件: ${burst.name} ${kind}（${detail}）`);
        try {
            void globalThis.__qqbotDiary?.event?.({
                gid,
                name: burst.name,
                kind,
                detail,
                lastLine: burst.lastLine,
            });
        }
        catch {
            // 写日记失败不影响对话
        }
        bursts.delete(key);
    };

    if (bot && typeof bot.use === 'function') {
        bot.use(async (ctx2, next) => {
            try {
                track(ctx2?.message);
            }
            catch {
                // 检测失败不影响消息
            }
            return next();
        });
    }

    globalThis.__qqbotInteraction = { decide, _test: { decide, PET_RE } };
    console.log('[im-qqbot] 互动事件检测已启用（30 分钟窗口 / 10 句 + 好感 4 或烦躁 8 / 被摸 3 次）');
}
/* <<< dsh-qqbot-patch:interaction-helper <<< */

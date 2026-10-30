/* >>> dsh-qqbot-patch:group-mention >>> */
    // 5. 群聊 @bot 门控（按群唤醒词 + 对话窗口）
    //    - 白名单群：被 @ / 叫到名字 / 处于对话窗口内 才进入 agent
    //    - 其它群：维持原样，必须 @
    //    进入 agent 后是否真的说话，由模型用 [SILENT] 决定（见 silent-reply 补丁）
    const gateProfileDir = process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`;
    // >>> group-gate-core
    const gateDefaults = { wakeWords: ['小易'], wakeCooldownMs: 3000, conversationWindowMs: 600000, wakeIndexDefault: 100 };
    const loadGroupGateConfig = () => {
        const out = {
            noMention: new Set(),
            wakeWords: [...gateDefaults.wakeWords],
            wakeCooldownMs: gateDefaults.wakeCooldownMs,
            conversationWindowMs: gateDefaults.conversationWindowMs,
            // 每群唤醒指数：0–100，默认 100（跟以前一样容易叫出来）。
            // 只影响「没被点名时主不主动插话」，@ 和叫名字始终会应。
            wakeIndex: {},
            wakeIndexDefault: gateDefaults.wakeIndexDefault,
        };
        for (const part of (process.env.QQBOT_NO_MENTION_GROUPS ?? '').split(',')) {
            const id = part.trim();
            if (id !== '')
                out.noMention.add(id);
        }
        try {
            const parsed = JSON.parse(readFileSync(`${gateProfileDir}/qqbot-groups.json`, 'utf8'));
            for (const id of (Array.isArray(parsed?.noMention) ? parsed.noMention : [])) {
                if (typeof id === 'string' && id.trim() !== '')
                    out.noMention.add(id.trim());
            }
            if (Array.isArray(parsed?.wakeWords)) {
                const words = parsed.wakeWords
                    .filter((w) => typeof w === 'string' && w.trim() !== '')
                    .map((w) => w.trim());
                if (words.length > 0)
                    out.wakeWords = words;
            }
            if (typeof parsed?.wakeCooldownMs === 'number' && parsed.wakeCooldownMs >= 0)
                out.wakeCooldownMs = parsed.wakeCooldownMs;
            if (typeof parsed?.conversationWindowMs === 'number' && parsed.conversationWindowMs >= 0)
                out.conversationWindowMs = parsed.conversationWindowMs;
            const clampIndex = (value) => Math.max(0, Math.min(100, value));
            if (typeof parsed?.wakeIndexDefault === 'number' && Number.isFinite(parsed.wakeIndexDefault))
                out.wakeIndexDefault = clampIndex(parsed.wakeIndexDefault);
            if (parsed?.wakeIndex && typeof parsed.wakeIndex === 'object' && !Array.isArray(parsed.wakeIndex)) {
                for (const [gid, value] of Object.entries(parsed.wakeIndex)) {
                    const n = Number(value);
                    if (typeof gid === 'string' && gid.trim() !== '' && Number.isFinite(n))
                        out.wakeIndex[gid.trim()] = clampIndex(n);
                }
            }
        }
        catch {
            // 文件不存在 / 非法 JSON：用默认值
        }
        return out;
    };
    /** 本群唤醒指数（0–100）；没单独配置就用默认值（100 = 老行为） */
    const wakeIndexOf = (cfg, gid) => {
        const raw = cfg.wakeIndex?.[gid] ?? cfg.wakeIndexDefault;
        const base = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 100;
        // 100 = 「每条都接」的硬约定，心情不参与：否则一条普通跟话会有概率被静默吞掉。
        if (base >= 100)
            return 100;
        // 只有显式配了更低指数的群，心情才会让「主动插话」的意愿上下浮动。
        // 指数为 0 的群仍然为 0（心情不能把她叫醒）。
        const factor = globalThis.__qqbotMood?.wakeFactor?.(gid) ?? 1;
        return Math.max(0, Math.min(100, base * factor));
    };
    const matchWakeWord = (text, words) => {
        const lower = String(text ?? '').toLowerCase();
        return words.some((w) => lower.includes(String(w).toLowerCase()));
    };
    const gateSeen = new Set();
    const lastWakeAt = new Map();
    const lastActivityAt = new Map();
    const STICKER_ONLY_RE = /^(?:\s*\[(?:表情|动画表情|表情包)[^\]]*\]\s*)+$/;
    // 对话窗口 / 刚回过话的时间戳跨重启保留：
    // 否则机器人一重启，正在进行的对话会被当成「陌生人插话」直接吞掉（2026-10-30 踩过）。
    const windowFile = `${gateProfileDir}/qqbot-window.json`;
    try {
        const saved = JSON.parse(readFileSync(windowFile, 'utf8'));
        const now0 = Date.now();
        for (const [gid, ts] of Object.entries(saved.activity ?? {})) {
            if (Number.isFinite(ts) && now0 - ts < 30 * 60 * 1000)
                lastActivityAt.set(gid, ts);
        }
        const botMap = globalThis.__qqbotLastBotReply ?? (globalThis.__qqbotLastBotReply = new Map());
        for (const [gid, ts] of Object.entries(saved.bot ?? {})) {
            if (Number.isFinite(ts) && now0 - ts < 30 * 60 * 1000)
                botMap.set(gid, ts);
        }
    }
    catch {
        // 首次启动没有文件
    }
    let persistTimer;
    const persistWindows = () => {
        if (persistTimer)
            return;
        persistTimer = setTimeout(() => {
            persistTimer = undefined;
            try {
                writeFileSync(windowFile, JSON.stringify({
                    activity: Object.fromEntries(lastActivityAt),
                    bot: Object.fromEntries(globalThis.__qqbotLastBotReply ?? new Map()),
                }));
            }
            catch {
                // 写失败不影响对话
            }
        }, 800);
        if (typeof persistTimer.unref === 'function')
            persistTimer.unref();
    };
    const touchActivity = (gid, ts) => {
        lastActivityAt.set(gid, ts);
        persistWindows();
    };
    globalThis.__qqbotPersistWindows = persistWindows;
    // <<< group-gate-core

    const recordInbound = (gid, eventType, exempt, wake, windowed, senderName, senderId, wakeIndex) => {
        try {
            appendFileSync(`${gateProfileDir}/qqbot-seen-groups.log`, `${new Date().toISOString()} ${gid} event=${eventType ?? '?'} exempt=${exempt} wake=${wake} window=${windowed} idx=${wakeIndex ?? '-'} sender=${senderName ?? '?'}(${senderId ?? '?'})\n`);
        }
        catch {
            // 写盘失败不影响消息处理
        }
    };
    // ── 「每日首条必接」共用判断（群门控 / 象信门控 / 提示词三处同一口径）──
    // 日期用本地时区（qqbot-greetings.json 里存 YYYY-MM-DD），00:00 换天；
    // 旧实现用 toISOString()，东八区要到早上 8 点才算新的一天。
    // >>> daily-first-helpers
    const dailyFirstDateKey = (date = new Date()) => {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    };
    /** 按 openid / 名字 / 昵称 / 称呼把发送者对到档案上（只读） */
    const dailyFirstFindPerson = (sender) => {
        if (!sender || (!sender.id && !sender.name))
            return undefined;
        let list = [];
        try {
            const parsed = JSON.parse(readFileSync(`${gateProfileDir}/qqbot-people.json`, 'utf8'));
            list = Array.isArray(parsed?.people) ? parsed.people : [];
        }
        catch {
            return undefined;
        }
        const lower = String(sender.name ?? '').trim().toLowerCase();
        return list.find((person) => {
            if (!person || typeof person !== 'object')
                return false;
            if (Array.isArray(person.openids) && sender.id && person.openids.includes(sender.id))
                return true;
            const names = [person.name, person.addressing];
            for (const key of Object.keys(person)) {
                if (/^nickname\d+$/.test(key))
                    names.push(person[key]);
            }
            if (Array.isArray(person.aliases))
                names.push(...person.aliases);
            return lower !== '' && names.some((n) => typeof n === 'string' && n.trim().toLowerCase() === lower);
        });
    };
    /**
     * 这个人是不是「今天第一次在本群出现，且勾了每日首条必接」。
     * 只读，不写 qqbot-greetings.json —— 真正的「今天已出现」由提示词那边
     * （people-roster-helper 的 isFirstMessageToday）在成提示时落盘，
     * 这样门控放行后模型真看到了这条，才算今天露过面。
     */
    const dailyFirstPending = (gid, sender) => {
        try {
            // 没有稳定 openid 就不猜：只靠名字的话，提示词那边也不会算「今天已出现」
            if (!sender || !sender.id)
                return false;
            const person = dailyFirstFindPerson(sender);
            if (!person || person.dailyFirstReply !== true)
                return false;
            let state = {};
            try {
                state = JSON.parse(readFileSync(`${gateProfileDir}/qqbot-greetings.json`, 'utf8'));
            }
            catch {
                state = {};
            }
            return state[`${gid}:${sender.id}`] !== dailyFirstDateKey();
        }
        catch {
            return false;
        }
    };
    // <<< daily-first-helpers
    // 发消息计数落盘：第 3 条自动建骨架不再因为进程重启归零
    const senderCountsPath = () => `${gateProfileDir}/qqbot-sender-counts.json`;
    const bumpSenderCount = (gid, senderId) => {
        if (!gid || !senderId)
            return 0;
        const key = `${gid}:${senderId}`;
        let counts = {};
        try {
            counts = JSON.parse(readFileSync(senderCountsPath(), 'utf8'));
        }
        catch {
            counts = {};
        }
        const next = (Number(counts[key]) || 0) + 1;
        counts[key] = next;
        try {
            writeFileSync(senderCountsPath(), `${JSON.stringify(counts, null, 2)}\n`);
        }
        catch {
            // 写失败就下次再涨
        }
        return next;
    };

    // 入站探针放门控之前：看清「消息到没到、是否命中唤醒词/对话窗口」
    bot.use(async (ctx, next) => {
        const msg = ctx.message;
        if (msg?.kind === 'group' && msg.groupOpenid) {
            const gid = msg.groupOpenid;
            const cfg = loadGroupGateConfig();
            const exempt = cfg.noMention.has(gid);
            const at = msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE';
            // 真 @ 也开启对话窗口，后续跟话不用再 @
            if (exempt && at)
                touchActivity(gid, Date.now());
            const windowed = exempt && cfg.conversationWindowMs > 0
                && Date.now() - (lastActivityAt.get(gid) ?? 0) < cfg.conversationWindowMs;
            if (!exempt && !gateSeen.has(gid)) {
                gateSeen.add(gid);
                logger.info(`[im-qqbot] 发现群 group_openid=${gid}（当前需 @；想用唤醒词请加入 ${gateProfileDir}/qqbot-groups.json）`);
            }
            // 记录「这条消息是谁发的」，供群成员档案注入时识别当前说话人
            const speakers = globalThis.__qqbotSpeakers ?? (globalThis.__qqbotSpeakers = new Map());
            speakers.set(gid, { id: msg.senderId ?? '', name: msg.senderName ?? '' });
            // 记住最近活跃的群：switch_role_skill 工具没有会话上下文，靠这个定位
            globalThis.__qqbotLastGid = gid;
            // 事件追踪：每条群消息都过一遍（异步、不阻塞；失败不影响消息）
            try {
                globalThis.__qqbotEventDetect?.(msg);
            }
            catch {
                // 忽略
            }
            // 本 turn 待处理的入站消息队列：角色技能按队首判断「在回谁」，
            // turn/end 时清掉已被取走的部分（见 role-skills-helper.js）。
            // 只记「会进 agent」的消息，避免被门控挡掉的消息占住队首。
            const gateWake = exempt && matchWakeWord(msg.content, cfg.wakeWords);
            if (exempt && (at || windowed || gateWake)) {
                const pendingInbound = globalThis.__qqbotPendingInbound ?? (globalThis.__qqbotPendingInbound = new Map());
                const pendingList = pendingInbound.get(gid) ?? [];
                pendingList.push({
                    id: msg.senderId ?? '',
                    name: msg.senderName ?? '',
                    content: String(msg.content ?? '').slice(0, 200),
                    at: Date.now(),
                });
                while (pendingList.length > 50)
                    pendingList.shift();
                pendingInbound.set(gid, pendingList);
            }
            // 最近消息缓存：供「自动建档」核验原话（只保留最近 20 条 / 10 分钟）
            const recent = globalThis.__qqbotRecentMessages ?? (globalThis.__qqbotRecentMessages = new Map());
            const bucket = recent.get(gid) ?? [];
            bucket.push({
                id: msg.senderId ?? '',
                name: msg.senderName ?? '',
                msgId: String(msg.messageId ?? msg.msgId ?? ''),
                content: String(msg.content ?? '').slice(0, 500),
                at: Date.now(),
            });
            while (bucket.length > 20)
                bucket.shift();
            recent.set(gid, bucket);
            // 长期记忆门控：每条群消息都送象信判一次（含没叫她的消息；异步，不阻塞）
            void globalThis.__qqbotMemoryGate?.consider(ctx);
            // 同一个人在本群累计发到第 3 条，自动建空壳档案
            const next = bumpSenderCount(gid, msg.senderId);
            if (next === 3 && msg.senderId && msg.senderName) {
                ensureSkeletonPerson(gid, msg.senderId, msg.senderName);
                ensurePersonInGroup(gid, msg.senderId, msg.senderName);
            }
            // 明确叫到机器人（@ / 唤醒词）的人，第一次就补骨架 / 补群，不等第 3 条
            if ((at || gateWake) && msg.senderId && msg.senderName) {
                ensureSkeletonPerson(gid, msg.senderId, msg.senderName);
                ensurePersonInGroup(gid, msg.senderId, msg.senderName);
            }
            // 每条群消息都按社交信号权重累加（规则内部，不写进提示）；@/叫名字只是额外加成
            if (msg.senderId) {
                bumpAffinityFromChat(gid, msg.senderId, msg.senderName, msg.content,
                    Boolean(at || (exempt && matchWakeWord(msg.content, cfg.wakeWords))));
            }
            recordInbound(gid, msg.rawEventType, exempt, exempt && matchWakeWord(msg.content, cfg.wakeWords), windowed, msg.senderName, msg.senderId, exempt ? wakeIndexOf(cfg, gid) : '-');
            // 纯表情包/表情：不送进 agent，避免为了礼貌硬回一句（群规、每日首条都不再要求接）
            if (STICKER_ONLY_RE.test(String(msg.content ?? '').trim()))
                return;
        }
        await next();
    });
    // 判定「这条群消息是否隐式点名了 bot」：对话窗口内 or 命中唤醒词
    // >>> wake-decide
    const decideGroupImplicit = (gid, content) => {
        // 斜杠命令（/new /compact /model…）永远放行，交给命令中间件处理
        if (String(content ?? '').trim().startsWith('/'))
            return true;
        const cfg = loadGroupGateConfig();
        // 非白名单群不猜：必须真的 @
        if (!cfg.noMention.has(gid))
            return false;
        const now = Date.now();
        const index = wakeIndexOf(cfg, gid);
        const named = matchWakeWord(content, cfg.wakeWords);
        // 唤醒指数 = 这条消息「没被点名时主动插话」的概率（%）。
        // 100 = 老行为（每条都接）；0 = 只听 @ 和名字；中间值越低越安静。
        // 每条消息只掷一次骰子，避免同一条命中多个条件时被反复放大概率。
        const roll = index >= 100 || (index > 0 && Math.random() * 100 < index);
        // 0d) 勾了「每日首条必接」的人今天第一次出现：不论亲疏、哪怕只发个表情包，
        //     也当作在跟她说话，放进来让她接一句（诉苦的交给提示词按关心处理）。
        //     这条是「照顾人」而不是「爱插话」，不受唤醒指数影响（指数 0 也生效）。
        //     注意：这只在允许唤醒词/窗口的群里生效；必须 @ 的群仍按原规则。
        const dailySpeaker = globalThis.__qqbotSpeakers?.get?.(gid);
        if (dailySpeaker && dailyFirstPending(gid, dailySpeaker) && !STICKER_ONLY_RE.test(String(content ?? '').trim())) {
            touchActivity(gid, now);
            return true;
        }
        // 0) 指数为 0：除了 @（门控外）和叫名字，其它一律不主动。
        if (index <= 0) {
            if (!named)
                return false;
            if (cfg.wakeCooldownMs > 0 && now - (lastWakeAt.get(gid) ?? 0) < cfg.wakeCooldownMs)
                return false;
            if (cfg.wakeCooldownMs > 0)
                lastWakeAt.set(gid, now);
            touchActivity(gid, now);
            return true;
        }
        // 0c) 她刚回过话（3 分钟内）：对话还在进行。指数低时不再句句续，
        //     由 roll 决定这一条要不要接；没接的消息不会续窗口。
        const lastBot = globalThis.__qqbotLastBotReply?.get?.(gid) ?? 0;
        if (now - lastBot < 3 * 60 * 1000 && roll) {
            touchActivity(gid, now);
            return true;
        }
        // 0b) 打招呼（早/早安/晚安…）：每群 30 分钟放行一次，让她回一句
        const GREET_RE = /^(早|早安|早上好|午安|中午好|下午好|晚上好|晚安|good\s*(morning|night))/i;
        if (GREET_RE.test(String(content ?? '').trim()) && roll) {
            const greeted = globalThis.__qqbotGreetGate ?? (globalThis.__qqbotGreetGate = new Map());
            if (Date.now() - (greeted.get(gid) ?? 0) > 30 * 60 * 1000) {
                greeted.set(gid, Date.now());
                return true;
            }
        }
        // 0a) 发图/视频/文件本身就是分享：放行，让人格决定接不接
        if (roll && /\[图片\]|\[视频\]|\[文件\]|\[表情/.test(String(content ?? ''))
            && !STICKER_ONLY_RE.test(String(content ?? '').trim())) {
            touchActivity(gid, now);
            return true;
        }
        // 0) 炫耀/卖关子/晒东西：放行，让人格决定接不接（象信还会再筛一次）
        const HOOK_RE = /抽到|出货|满命|打通|第一名|赢了|升职|加薪|上岸|考过|录取|中奖|看我|画了|写了|买了|你猜|猜猜|知道吗|发现了|给你看|好看吗|厉害吧|这是啥|见过没/;
        if (roll && HOOK_RE.test(String(content ?? ''))) {
            touchActivity(gid, now);
            return true;
        }
        // 1) 对话窗口内：当作继续对话（是否真说话交给模型）；指数低时只接一部分
        const last = lastActivityAt.get(gid) ?? 0;
        if (roll && cfg.conversationWindowMs > 0 && now - last < cfg.conversationWindowMs) {
            touchActivity(gid, now);
            return true;
        }
        // 2) 叫了名字（唤醒词）：一定放行，不掷骰子——叫她就得应。
        //    带冷却，避免连发多条都被拉起来。
        if (cfg.wakeCooldownMs > 0 && now - (lastWakeAt.get(gid) ?? 0) < cfg.wakeCooldownMs)
            return false;
        if (!named)
            return false;
        if (cfg.wakeCooldownMs > 0)
            lastWakeAt.set(gid, now);
        touchActivity(gid, now);
        return true;
    };
    // <<< wake-decide
    bot.use(mentionGate({
        requireMentionInGroup: config.requireMention,
        isImplicitMention: (ctx) => {
            const msg = ctx.message;
            if (msg.kind !== 'group' || !msg.groupOpenid)
                return false;
            try {
                return decideGroupImplicit(msg.groupOpenid, msg.content);
            }
            catch (err) {
                // 门控本身不能把整条消息搞挂：异常时放行，交给回话门控和模型判断
                console.log(`[im-qqbot] 门控判定异常: ${err && err.stack ? err.stack : err}`);
                return true;
            }
        },
    }));
/* <<< dsh-qqbot-patch:group-mention <<< */

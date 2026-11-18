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
    const lastStickerLogAt = new Map();
    const lastStickerJudgeAt = new Map();
    const lastReplyGateLogAt = new Map();
    const logSticker = (gid, line) => {
        const now = Date.now();
        if (now - (lastStickerLogAt.get(gid) ?? 0) < 60 * 1000)
            return;
        lastStickerLogAt.set(gid, now);
        logger.info?.(line);
    };
    // 平台把 QQ 系统表情下发成【表情: 名字】/【表情: 未知表情】；半角占位符是历史/兼容格式。
    const STICKER_ONLY_RE = /^(?:\s*(?:【表情[：:][^】]*】|\[(?:表情|动画表情|表情包)[^\]]*\])\s*)+$/;
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

    // >>> reply-index-helpers
    // 针对特定「角色」的回话概率（qqbot-people.json 的 replyIndex，0–100，默认 100）。
    // 典型场景：群里混进了另一个机器人，两边互相接话停不下来。给那个人设一个很低的
    // 指数，就把「这条要不要接」整体压下去。和群唤醒指数不同，它放在入站最前面：
    // @ 她、叫名字也一样要掷骰子（否则对方每次 @ 都能把她拉起来，还是停不下来）。
    // 匹配顺序：openid 精确命中 → 名字 / 称呼 / 昵称 / 别名（不分大小写）。
    const REPLY_INDEX_DEFAULT = 100;
    const replyIndexCache = { stamp: '', openids: new Map(), names: new Map() };
    const replyIndexNamesOf = (person) => {
        const out = [person?.name, person?.addressing];
        for (const key of Object.keys(person ?? {})) {
            if (/^nickname\d+$/.test(key))
                out.push(person[key]);
        }
        if (Array.isArray(person?.aliases))
            out.push(...person.aliases);
        return out.filter((name) => typeof name === 'string' && name.trim() !== '');
    };
    const loadReplyIndex = () => {
        const file = `${gateProfileDir}/qqbot-people.json`;
        let stamp;
        try {
            const st = statSync(file);
            stamp = `${st.mtimeMs}:${st.size}`;
        }
        catch {
            replyIndexCache.stamp = '';
            replyIndexCache.openids.clear();
            replyIndexCache.names.clear();
            return replyIndexCache;
        }
        if (stamp === replyIndexCache.stamp)
            return replyIndexCache;
        const openids = new Map();
        const names = new Map();
        try {
            const parsed = JSON.parse(readFileSync(file, 'utf8'));
            for (const person of Array.isArray(parsed?.people) ? parsed.people : []) {
                if (!person || typeof person !== 'object')
                    continue;
                const raw = person.replyIndex;
                // 只认数字 / 非空数字字符串：null 和 '' 不能当成 0，否则手滑写空就把人彻底屏蔽了
                if (typeof raw !== 'number' && typeof raw !== 'string')
                    continue;
                if (typeof raw === 'string' && raw.trim() === '')
                    continue;
                const value = Number(raw);
                if (!Number.isFinite(value))
                    continue;
                const index = Math.max(0, Math.min(100, value));
                for (const id of Array.isArray(person.openids) ? person.openids : []) {
                    if (typeof id === 'string' && id.trim() !== '')
                        openids.set(id.trim(), index);
                }
                for (const name of replyIndexNamesOf(person)) {
                    const key = name.trim().toLowerCase();
                    if (!names.has(key))
                        names.set(key, index);
                }
            }
        }
        catch {
            // 文件写了一半 / 非法 JSON：沿用上一次的取值，宁可按原样放行
            return replyIndexCache;
        }
        replyIndexCache.stamp = stamp;
        replyIndexCache.openids = openids;
        replyIndexCache.names = names;
        return replyIndexCache;
    };
    /** 这个人配置的回话概率（0–100）；没配置 = 100（跟以前一样） */
    const replyIndexOfSender = (sender) => {
        if (!sender)
            return REPLY_INDEX_DEFAULT;
        const cache = loadReplyIndex();
        const id = String(sender.id ?? '').trim();
        if (id !== '' && cache.openids.has(id))
            return cache.openids.get(id);
        const name = String(sender.name ?? '').trim().toLowerCase();
        if (name !== '' && cache.names.has(name))
            return cache.names.get(name);
        return REPLY_INDEX_DEFAULT;
    };
    /** 主人 / 管理员：发言直接算叫到机器人，不看回话概率和唤醒指数 */
    const senderBypass = (sender) => {
        try {
            return globalThis.__qqbotPerm?.can?.(sender, 'gate.bypass') === true;
        }
        catch {
            return false;
        }
    };
    /** 掷一次骰子：这一条要不要放进来。100 = 直接放行，0 = 一律拦下。 */
    const senderReplyAllowed = (sender) => {
        if (senderBypass(sender))
            return { index: REPLY_INDEX_DEFAULT, passed: true, roll: null, bypass: true };
        const index = replyIndexOfSender(sender);
        if (index >= 100)
            return { index, passed: true, roll: null };
        if (index <= 0)
            return { index, passed: false, roll: null };
        const roll = Math.random() * 100;
        return { index, passed: roll < index, roll };
    };
    /** 入站消息的特定角色门控；斜杠命令不参与（交给指令白名单） */
    const senderGateFor = (msg) => {
        const text = String(msg?.content ?? '').trim().replace(/<@!?[^>]+>\s*/g, '').trim();
        if (text.startsWith('/'))
            return { index: REPLY_INDEX_DEFAULT, passed: true, roll: null };
        return senderReplyAllowed({ id: msg?.senderId, name: msg?.senderName });
    };
    // <<< reply-index-helpers

    const recordInbound = (gid, eventType, exempt, wake, windowed, senderName, senderId, wakeIndex, replyIndex, gate) => {
        try {
            appendFileSync(`${gateProfileDir}/qqbot-seen-groups.log`, `${new Date().toISOString()} ${gid} event=${eventType ?? '?'} exempt=${exempt} wake=${wake} window=${windowed} idx=${wakeIndex ?? '-'} reply=${replyIndex ?? '-'} gate=${gate ?? '-'} sender=${senderName ?? '?'}(${senderId ?? '?'})\n`);
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
            // 「@ 的是谁」：走私域全量消息后基本收不到 GROUP_AT_MESSAGE_CREATE，
            // 群里 @ 人只剩正文里的 <@openid>。这里先还原成人名，并判断有没有真的叫我
            //（2026-11-04 就因为模型把 @葛络珂小姐 当成叫自己而回了话）。
            globalThis.__qqbotMention?.setAppId?.(config.appId);
            const mentionInfo = globalThis.__qqbotMention?.rewriteMessage?.(msg);
            const cfg = loadGroupGateConfig();
            const exempt = cfg.noMention.has(gid);
            const at = mentionInfo ? mentionInfo.self : msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE';
            // 特定角色的回话概率：放在所有副作用之前掷骰子。被拦下的消息不进 agent，
            // 也不刷新对话窗口 / 亲密度 / 最近消息（否则另一个机器人每条都能把窗口续上）。
            // 斜杠命令不参与，交给后面的指令白名单判断。
            const senderGate = senderGateFor(msg);
            if (!senderGate.passed) {
                recordInbound(gid, msg.rawEventType, exempt, exempt && matchWakeWord(msg.content, cfg.wakeWords), false, msg.senderName, msg.senderId, exempt ? wakeIndexOf(cfg, gid) : '-', senderGate.index, 'drop');
                const nowGateLog = Date.now();
                if (nowGateLog - (lastReplyGateLogAt.get(gid) ?? 0) > 60 * 1000) {
                    lastReplyGateLogAt.set(gid, nowGateLog);
                    // 用 console.log 而不是 logger.info：实测这个中间件拿到的 logger.info 不一定落盘，
                    // 拦截是静默的，排查时看不到反而更麻烦。
                    console.log(`[im-qqbot] 特定角色回话概率拦下（replyIndex=${senderGate.index}）: ${msg.senderName ?? msg.senderId ?? '?'}`);
                }
                return;
            }
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
            // 纯表情包没有文字信息，跳过门控省一次判断；上下文里的文字消息仍会正常入库
            if (!globalThis.__qqbotStickerInbound?.isStickerOnlyImage(msg))
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
            recordInbound(gid, msg.rawEventType, exempt, exempt && matchWakeWord(msg.content, cfg.wakeWords), windowed, msg.senderName, msg.senderId, exempt ? wakeIndexOf(cfg, gid) : '-', senderGate.index, 'pass');
            // 纯表情包/表情：不送进 agent，避免为了礼貌硬回一句（群规、每日首条都不再要求接）
            if (STICKER_ONLY_RE.test(String(msg.content ?? '').trim())) {
                msg.__qqbotStickerHandled = true;
                return;
            }
            // 图片表情包（小方图/GIF、没有文字）：默认不接。
            // 只有直接 @ 机器人、或机器人正在对话里，才让判断 AI 决定要不要回；
            // 回的时候只让模型用一两句短话接，不要认真分析图片。
            const stickerInbound = globalThis.__qqbotStickerInbound;
            const stickerGateEnabled = (process.env.QQBOT_STICKER_REPLY_GATE ?? 'on') !== 'off';
            if (stickerGateEnabled && stickerInbound?.isStickerOnlyImage(msg)) {
                msg.__qqbotStickerHandled = true;
                const direct = at;
                const botActive = Date.now() - (globalThis.__qqbotLastBotReply?.get?.(gid) ?? 0) < 10 * 60 * 1000;
                if (!direct && !botActive) {
                    logSticker(gid, `[im-qqbot] 表情包不接（不在对话里）: ${msg.senderName ?? ''}`);
                    return;
                }
                let verdict;
                if (direct) {
                    verdict = { needsReply: 1, emotion: '看不出来', reason: '直接叫到机器人' };
                }
                else {
                    // 同一个群 30 秒内最多判一次，防止刷表情包时反复烧判断调用
                    const lastJudge = lastStickerJudgeAt.get(gid) ?? 0;
                    if (Date.now() - lastJudge < 30 * 1000) {
                        logSticker(gid, `[im-qqbot] 表情包不接（判断太频繁）: ${msg.senderName ?? ''}`);
                        return;
                    }
                    lastStickerJudgeAt.set(gid, Date.now());
                    verdict = await stickerInbound.judgeReply({ gid, msg, direct, active: botActive });
                }
                const threshold = Number(process.env.QQBOT_STICKER_REPLY_THRESHOLD ?? 0.7);
                if (!stickerInbound.shouldReply(verdict, threshold)) {
                    logSticker(gid, `[im-qqbot] 表情包不接(${verdict ? `needs=${Number(verdict.needsReply).toFixed(2)} ${verdict.emotion} ${verdict.reason}` : '判断不可用'}): ${msg.senderName ?? ''}`);
                    return;
                }
                logSticker(gid, `[im-qqbot] 表情包接(${Number(verdict.needsReply).toFixed(2)} ${verdict.emotion} ${verdict.reason}): ${msg.senderName ?? ''}`);
                msg.__qqbotStickerReply = verdict;
                msg.__qqbotStickerReplyPass = true;
                await next();
                return;
            }
        }
        await next();
    });
    // 判定「这条群消息是否隐式点名了 bot」：对话窗口内 or 命中唤醒词
    // >>> wake-decide
    const decideGroupImplicit = (gid, content, msg) => {
        // 已经过了表情包判断、明确要接的，直接放行
        if (msg?.__qqbotStickerReplyPass)
            return true;
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
        //    例外：她刚回过话（3 分钟内）——对话还在进行时，对方正常接一句也应该接，
        //    否则「有呀…」之后跟一句「没有，只是好奇问问」会被当成插话直接吞掉。
        //    这条只看「上一条回复有多近」，不再掷骰子；对方真想安静就把群指数调高。
        if (index <= 0) {
            if (!named) {
                const lastBot = globalThis.__qqbotLastBotReply?.get?.(gid) ?? 0;
                if (now - lastBot < 3 * 60 * 1000) {
                    touchActivity(gid, now);
                    return true;
                }
                return false;
            }
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
        //     表情包不算「分享」：它已经在入站探针里单独判断过了，别在这里被随机放行
        //     纯图片消息的 content 常常是空的，附件只在 msg.attachments 里，不能只认 [图片] 占位符
        const hasAttachment = Array.isArray(msg?.attachments) && msg.attachments.length > 0;
        if (roll && (hasAttachment || /\[图片\]|\[视频\]|\[文件\]|\[表情/.test(String(content ?? '')))
            && !STICKER_ONLY_RE.test(String(content ?? '').trim())
            && !globalThis.__qqbotStickerInbound?.isStickerOnlyImage(msg)) {
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
                // 被真 @ 一定应：私域全量消息收不到 AT 事件，只能靠 mentions / 正文里的 @ 判断，
                // 否则「必须 @」的群里 @ 她反而会被门控吞掉。
                if (globalThis.__qqbotMention?.addressed?.(msg))
                    return true;
                // 主人 / 管理员说话就算叫到：必须 @ 的群、唤醒指数 0 的群也直接放行
                if (senderBypass({ id: msg.senderId, name: msg.senderName }))
                    return true;
                return decideGroupImplicit(msg.groupOpenid, msg.content, msg);
            }
            catch (err) {
                // 门控本身不能把整条消息搞挂：异常时放行，交给回话门控和模型判断
                console.log(`[im-qqbot] 门控判定异常: ${err && err.stack ? err.stack : err}`);
                return true;
            }
        },
    }));
    // 把「这条 @ 了我」同步给 ctx.state.mention：提示词里的 (@you) 标记、信封和门控用的是
    // mentionGate 的 wasMentioned，而它在全量消息模式下只看 rawEventType，会漏掉真 @。
    bot.use(async (ctx, next) => {
        try {
            const msg = ctx.message;
            const mention = ctx.state?.mention;
            if (mention && typeof mention.wasMentioned === 'boolean' && !mention.wasMentioned
                && msg?.kind === 'group' && globalThis.__qqbotMention?.addressed?.(msg))
                mention.wasMentioned = true;
        }
        catch {
            // 标记失败不影响对话
        }
        await next();
    });

    // ── 象信判「只发一张表情包就够」：够就直接发表情、跳过 agent（省一次主模型调用） ──
    // 判断时把当前群的人格塞进 state，避免出现「人设猫娘却回鲸鱼娘」这种错位。
    const PERSONA_CACHE = new Map();
    const personaDigest = (gid) => {
        const cached = PERSONA_CACHE.get(gid);
        if (cached && Date.now() - cached.at < 10 * 60 * 1000)
            return cached.text;
        const fs = process.getBuiltinModule?.('node:fs');
        const dir = process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`;
        let text = '';
        try {
            const personas = JSON.parse(fs.readFileSync(`${dir}/qqbot-personas.json`, 'utf8'));
            const entry = personas?.personas?.[gid] ?? personas?.personas?.['*'] ?? personas?.personas?.default;
            const ids = Array.isArray(entry) ? entry : entry?.modules;
            if (Array.isArray(ids)) {
                text = ids
                    .map((id) => personas?.modules?.[id])
                    .filter((part) => typeof part === 'string' && part.trim() !== '')
                    .join('\n');
            }
        }
        catch {
            // 没有 personas 文件就用群 prompt
        }
        if (!text) {
            try {
                const groups = JSON.parse(fs.readFileSync(`${dir}/qqbot-groups.json`, 'utf8'));
                text = String(groups?.prompts?.[gid] ?? groups?.prompts?.['*'] ?? '');
            }
            catch {
                text = '';
            }
        }
        if (!text)
            text = String(config.groupPrompt ?? '');
        text = text.slice(0, 800);
        PERSONA_CACHE.set(gid, { at: Date.now(), text });
        return text;
    };
    const WAKE_CACHE = new Map();
    const wakeWordsOf = (gid) => {
        const cached = WAKE_CACHE.get(gid);
        if (cached && Date.now() - cached.at < 10 * 60 * 1000)
            return cached.words;
        const fs = process.getBuiltinModule?.('node:fs');
        const dir = process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`;
        let words = [];
        try {
            const cfg = JSON.parse(fs.readFileSync(`${dir}/qqbot-groups.json`, 'utf8'));
            if (Array.isArray(cfg.wakeWords))
                words = cfg.wakeWords.filter((w) => typeof w === 'string' && w !== '');
        }
        catch {
            words = [];
        }
        WAKE_CACHE.set(gid, { at: Date.now(), words });
        return words;
    };
    const lastStickerOnlyAt = new Map();
    bot.use(async (ctx, next) => {
        if ((process.env.QQBOT_STICKER_ONLY_GATE ?? 'on') === 'off')
            return next();
        const msg = ctx.message;
        if (!msg || msg.kind !== 'group' || !msg.groupOpenid)
            return next();
        const gid = msg.groupOpenid;
        const content = String(msg.content ?? '').trim();
        if (content === '' || content.startsWith('/') || msg.__qqbotStickerHandled)
            return next();
        if (Array.isArray(msg.attachments) && msg.attachments.length > 0)
            return next();
        if (/\[图片\]|\[视频\]|\[文件\]|https?:\/\//i.test(content))
            return next();
        if ([...content].length > 40)
            return next();
        if (/[?？]|怎么|为什么|如何|帮|查|写|做|教|解释|代码|报错|部署|配置|命令|新闻|求|急|要不要|能不能|可以吗/.test(content))
            return next();
        const gate = globalThis.__qqbotStickerGate;
        if (!gate || typeof gate.judge !== 'function' || typeof gate.pick !== 'function')
            return next();
        const now = Date.now();
        if (now - (lastStickerOnlyAt.get(gid) ?? 0) < 20 * 1000)
            return next();
        // 只有在「直接叫她」或「她刚在跟同一个人聊」时才考虑代回，
        // 避免别人在群里随口说一句就蹦一张图出来。
        const direct = globalThis.__qqbotMention?.addressed?.(msg)
            || msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE'
            || wakeWordsOf(gid).some((w) => w !== '' && content.includes(w));
        const lastBotAt = globalThis.__qqbotLastBotReply?.get?.(gid) ?? 0;
        const botActive = now - lastBotAt < 3 * 60 * 1000;
        let sameThread = false;
        if (botActive) {
            const lastBotInfo = globalThis.__qqbotLastBotText?.get?.(gid);
            const recent = globalThis.__qqbotRecentMessages?.get?.(gid) ?? [];
            const replied = lastBotInfo?.msgId
                ? recent.find((m) => String(m.msgId) === String(lastBotInfo.msgId))
                : undefined;
            sameThread = Boolean(replied && String(replied.id) === String(msg.senderId ?? ''));
        }
        if (!direct && !(botActive && sameThread))
            return next();
        lastStickerOnlyAt.set(gid, now);
        const verdict = await gate.judge({ gid, content, senderName: msg.senderName, persona: personaDigest(gid), timeoutMs: 1500 });
        const threshold = Number(process.env.QQBOT_STICKER_ONLY_THRESHOLD ?? 0.7);
        if (!verdict || !(verdict.ok >= threshold))
            return next();
        // 不是直接叫她时，必须象信认为这条是在跟她说
        if (!direct && Number(verdict.toBot ?? 0) < 0.6)
            return next();
        const pick = gate.pick({ gid, content, senderId: msg.senderId ?? '', emotion: verdict.emotion, situation: direct ? '被叫' : '' });
        if (!pick || !pick.absPath)
            return next();
        try {
            await bot.sendImage({ scope: 'group', targetId: gid, msgId: String(msg.messageId ?? '') }, { localPath: pick.absPath });
            msg.__qqbotStickerHandled = true;
            (globalThis.__qqbotLastBotReply ??= new Map()).set(gid, now);
            globalThis.__qqbotStickerState?.markSent?.(gid, pick.path, now);
            (globalThis.__qqbotStickerUsage ??= new Map()).set(pick.path, now);
            console.log(`[im-qqbot] 表情包代回: ${pick.label} (sticker_only=${Number(verdict.ok).toFixed(2)}) ${content.slice(0, 20)}`);
            return;
        }
        catch (err) {
            console.log(`[im-qqbot] 表情包代回失败: ${err instanceof Error ? err.message : String(err)}`);
            return next();
        }
    });
/* <<< dsh-qqbot-patch:group-mention <<< */

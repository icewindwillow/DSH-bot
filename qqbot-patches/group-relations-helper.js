/* >>> dsh-qqbot-patch:group-relations-helper >>> */
/**
 * 群友之间的互动边（person ↔ person）。
 *
 * 她此前只知道「别人对她怎样」，不知道「群里谁和谁熟、谁和谁有摩擦」。这里补上第二张网：
 *   - 每条群消息只做规则提取：@某人 / <@openid> / 正文点名 → 谁和谁发生了一次互动
 *   - 用 people-store 的 signal() 判断这次互动是善意还是摩擦（不额外调模型）
 *   - 存储 qqbot-relations.json：按群稀疏边（只存真的互动过的对子），文件锁 + 原子 rename，
 *     内存为热数据，60 秒批量落盘，避免每条消息都写文件
 *   - 模型永远看不到分数：只在「当前这条消息点到了某个人」时，给一两行人话摘要
 *
 * 边字段：close（亲疏 0–100，缓慢累积）、conflict（摩擦 0–100，48 小时半衰期）、
 *        count（互动次数）、lastAt、note（最近一次原话片段）。
 */
function setupGroupRelations(ctx, bot, config, logger) {
    if (globalThis.__qqbotRelations)
        return;
    const profileDir = process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`;
    const relationsPath = `${profileDir}/qqbot-relations.json`;
    const peoplePath = `${profileDir}/qqbot-people.json`;
    const MAX_EDGES_PER_GROUP = 800;
    const PAIR_COOLDOWN_MS = 60 * 1000;
    const CONFLICT_HALF_LIFE_H = 48;
    const TARGET_WINDOW_MS = 10 * 60 * 1000;
    const PLACEHOLDER_RE = /\[(?:图片|视频|文件|动画表情|语音|语音消息|闪照|位置|链接|小程序|合并转发)\]/g;

    let state = { version: 1, edges: {} };
    try {
        const parsed = JSON.parse(readFileSync(relationsPath, 'utf8'));
        if (parsed && typeof parsed === 'object' && parsed.edges && typeof parsed.edges === 'object')
            state = { version: Number(parsed.version) || 1, edges: parsed.edges };
    }
    catch {
        // 首次启动没有文件，从空开始
    }
    state.edges = state.edges ?? {};

    // 人物档案缓存：60 秒刷一次，避免每条消息都读 96KB JSON
    let peopleCache = { at: 0, list: [] };
    const people = () => {
        if (Date.now() - peopleCache.at < 60e3)
            return peopleCache.list;
        try {
            const parsed = JSON.parse(readFileSync(peoplePath, 'utf8'));
            peopleCache = { at: Date.now(), list: Array.isArray(parsed?.people) ? parsed.people : [] };
        }
        catch {
            peopleCache = { at: Date.now(), list: [] };
        }
        return peopleCache.list;
    };
    const nameOf = (person) => String(person?.name ?? '').trim();
    const aliasesOf = (person) => {
        const out = [person?.name, person?.addressing];
        for (const key of Object.keys(person ?? {}))
            if (key.indexOf('nickname') === 0)
                out.push(person[key]);
        if (Array.isArray(person?.aliases))
            out.push(...person.aliases);
        return [...new Set(out.map((n) => String(n ?? '').trim()).filter((n) => n !== ''))];
    };
    const findPersonByOpenid = (openid) => {
        const id = String(openid ?? '').trim();
        if (id === '')
            return undefined;
        return people().find((p) => p && Array.isArray(p.openids) && p.openids.includes(id));
    };
    const findPersonByName = (name) => {
        const target = String(name ?? '').trim().toLowerCase();
        if (target === '')
            return undefined;
        return people().find((p) => aliasesOf(p).some((n) => n.toLowerCase() === target));
    };

    const clamp = (n) => Math.max(0, Math.min(100, Math.round(n * 100) / 100));

    const edgesOf = (gid) => {
        if (!state.edges[gid] || typeof state.edges[gid] !== 'object')
            state.edges[gid] = {};
        return state.edges[gid];
    };
    const pairKey = (a, b) => [a, b].sort().join('|');
    const getEdge = (gid, a, b) => {
        const edges = edgesOf(gid);
        const key = pairKey(a, b);
        let edge = edges[key];
        if (!edge || typeof edge !== 'object') {
            edge = { close: 0, conflict: 0, count: 0, lastAt: 0, note: '', conflictAt: 0 };
            edges[key] = edge;
        }
        if (!Number.isFinite(Number(edge.conflictAt)))
            edge.conflictAt = Number(edge.lastAt) || 0;
        return edge;
    };
    /** 摩擦随时间衰减（半衰期 48 小时），亲疏不衰减 */
    const decayEdge = (edge, now = Date.now()) => {
        const hours = Math.max(0, (now - Number(edge.conflictAt ?? now)) / 3600000);
        if (hours > 0 && Number(edge.conflict ?? 0) > 0)
            edge.conflict = clamp(Number(edge.conflict) * Math.exp(-Math.LN2 * hours / CONFLICT_HALF_LIFE_H));
        edge.conflictAt = now;
    };

    /**
     * 这条消息点到了谁（只认真实指向：@ / <@openid> / 正文里出现档案名字）。
     * 线上由 middleware-setup 的 qqbotMentionInfo() 解析后传进来，避免重复实现 @ 解析；
     * 没有传入时退回读 msg.mentions（单测和老事件走这里）。
     */
    const targetsOf = (msg, speakerName, content, mentionInfo) => {
        const targets = [];
        const seen = new Set();
        const add = (name) => {
            const clean = String(name ?? '').trim();
            if (clean === '' || clean === speakerName || seen.has(clean))
                return;
            seen.add(clean);
            targets.push(clean);
        };
        if (Array.isArray(mentionInfo?.others)) {
            for (const other of mentionInfo.others) {
                const person = findPersonByOpenid(other?.id);
                add(person ? nameOf(person) : other?.name);
            }
        }
        else if (Array.isArray(msg.mentions)) {
            for (const mention of msg.mentions) {
                if (!mention || typeof mention !== 'object' || mention.is_you === true)
                    continue;
                const ids = [mention.member_openid, mention.user_openid, mention.id]
                    .filter((v) => typeof v === 'string' && v.trim() !== '');
                for (const id of ids) {
                    const person = findPersonByOpenid(id);
                    if (person) {
                        add(nameOf(person));
                        break;
                    }
                }
                if (ids.length === 0) {
                    const nick = String(mention.nickname ?? mention.username ?? '').trim();
                    if (nick !== '')
                        add(nick);
                }
            }
        }
        for (const token of content.matchAll(/<@([^>]+)>/g)) {
            const person = findPersonByOpenid(token[1]);
            if (person)
                add(nameOf(person));
        }
        for (const person of people()) {
            const names = aliasesOf(person).filter((n) => n.length >= 2);
            if (names.some((n) => content.includes(n)))
                add(nameOf(person));
        }
        return targets;
    };

    const lastTargets = new Map();   // gid:senderId → { at, names }
    let dirty = false;
    let pendingWrites = 0;

    const track = (msg, mentionInfo) => {
        try {
            if (!msg || msg.kind !== 'group' || !msg.groupOpenid || !msg.senderId)
                return;
            const gid = msg.groupOpenid;
            const content = String(msg.content ?? '');
            const plain = content.replace(PLACEHOLDER_RE, '').replace(/<@[^>]+>/g, '').trim();
            if (plain === '')
                return;
            const speakerPerson = findPersonByOpenid(msg.senderId) ?? findPersonByName(msg.senderName);
            const speakerName = nameOf(speakerPerson) || String(msg.senderName ?? '').trim();
            if (speakerName === '')
                return;

            const now = Date.now();
            const targets = targetsOf(msg, speakerName, content, mentionInfo);
            if (targets.length === 0) {
                // 这条没点任何人，清掉这位上一次的指向，避免拿旧关系硬套新消息
                lastTargets.set(`${gid}:${msg.senderId}`, { at: now, names: [] });
                return;
            }

            const signalFn = globalThis.__qqbotPeopleStore?.signal;
            const sig = typeof signalFn === 'function' ? signalFn(content) : { pos: 0, neg: 0 };
            const note = content.replace(/<@[^>]+>/g, '@').replace(/\s+/g, ' ').slice(0, 40);
            const chosen = targets.slice(0, 3);

            for (const target of chosen) {
                const edge = getEdge(gid, speakerName, target);
                if (now - Number(edge.lastAt ?? 0) < PAIR_COOLDOWN_MS)
                    continue;   // 同一对 60 秒内只结算一次，避免刷屏把关系刷满
                decayEdge(edge, now);
                const positive = Math.min(1.5, Number(sig?.pos ?? 0));
                const negative = Math.min(2, Number(sig?.neg ?? 0));
                edge.close = clamp(Number(edge.close ?? 0) + 0.4 + positive * 0.2 - negative * 0.1);
                if (negative > 0)
                    edge.conflict = clamp(Number(edge.conflict ?? 0) + Math.min(4, negative * 0.8));
                edge.count = Number(edge.count ?? 0) + 1;
                edge.lastAt = now;
                edge.note = note;
                dirty = true;
                pendingWrites += 1;
            }
            lastTargets.set(`${gid}:${msg.senderId}`, { at: now, names: chosen });
        }
        catch {
            // 关系边是锦上添花，失败不影响消息
        }
    };

    /**
     * 给当前说话人的提示词补一两行「你和 X 最近的关系」。
     * 只在当前这条消息确实点到了某个人、并且那一对有记录时才输出。
     */
    const promptLines = (gid, speaker, matched) => {
        try {
            const speakerName = nameOf(matched) || String(speaker?.name ?? '').trim();
            if (!gid || speakerName === '')
                return '';
            const rec = speaker?.id ? lastTargets.get(`${gid}:${speaker.id}`) : undefined;
            if (!rec || Date.now() - Number(rec.at ?? 0) > TARGET_WINDOW_MS || rec.names.length === 0)
                return '';
            const edges = state.edges[gid];
            if (!edges || typeof edges !== 'object')
                return '';
            const now = Date.now();
            const lines = [];
            for (const target of rec.names.slice(0, 2)) {
                const edge = edges[pairKey(speakerName, target)];
                if (!edge || Number(edge.count ?? 0) === 0)
                    continue;
                decayEdge(edge, now);
                if (Number(edge.conflict ?? 0) >= 10) {
                    const why = edge.note ? `（那次：${edge.note}）` : '';
                    lines.push(`- 你和「${target}」最近有点摩擦${why}，这会儿别拿这事开玩笑。`);
                }
                else if (Number(edge.count ?? 0) >= 8) {
                    const why = edge.note ? `，上次：${edge.note}` : '';
                    lines.push(`- 你和「${target}」最近常搭话，关系偏熟${why}。`);
                }
                else if (Number(edge.count ?? 0) >= 3) {
                    lines.push(`- 你和「${target}」聊过几次，还不算深交，说话留点分寸。`);
                }
                else {
                    lines.push(`- 你和「${target}」只是偶尔搭话，按不熟来对待。`);
                }
            }
            if (lines.length === 0)
                return '';
            return ['【你和群里其他人的关系】', ...lines].join('\n');
        }
        catch {
            return '';
        }
    };

    const prune = () => {
        for (const gid of Object.keys(state.edges)) {
            const edges = state.edges[gid];
            if (!edges || typeof edges !== 'object')
                continue;
            const keys = Object.keys(edges);
            if (keys.length <= MAX_EDGES_PER_GROUP)
                continue;
            const keep = keys
                .sort((a, b) => Number(edges[b]?.lastAt ?? 0) - Number(edges[a]?.lastAt ?? 0))
                .slice(0, MAX_EDGES_PER_GROUP);
            const next = {};
            for (const key of keep)
                next[key] = edges[key];
            state.edges[gid] = next;
        }
    };

    const sleepSync = (ms) => {
        try {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
        }
        catch {
            const end = Date.now() + ms;
            while (Date.now() < end) { /* spin */ }
        }
    };

    /** 落盘：文件锁 + 临时文件 + rename（和 people-store 同一套约定） */
    const persist = () => {
        if (!dirty)
            return;
        const lock = `${relationsPath}.lock`;
        const deadline = Date.now() + 2000;
        let fd;
        try {
            for (;;) {
                try {
                    fd = openSync(lock, 'wx');
                    break;
                }
                catch (err) {
                    if (!err || err.code !== 'EEXIST')
                        throw err;
                    try {
                        if (Date.now() - statSync(lock).mtimeMs > 8000)
                            unlinkSync(lock);
                    }
                    catch {
                        // 已被别人清掉
                    }
                    if (Date.now() > deadline)
                        throw new Error('qqbot-relations.json 写入锁等待超时');
                    sleepSync(15);
                }
            }
            prune();
            const payload = `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`;
            const tmp = `${relationsPath}.tmp-${process.pid}`;
            writeFileSync(tmp, payload);
            renameSync(tmp, relationsPath);
            dirty = false;
            if (pendingWrites > 0) {
                const edgeTotal = Object.values(state.edges)
                    .reduce((sum, edges) => sum + Object.keys(edges ?? {}).length, 0);
                console.log(`[im-qqbot] 群友关系边已更新 ${pendingWrites} 次（共 ${edgeTotal} 条边）`);
                pendingWrites = 0;
            }
        }
        catch (err) {
            // 写失败保留 dirty，下一分钟再试
            try { console.log(`[im-qqbot] 群友关系边落盘失败: ${err instanceof Error ? err.message : String(err)}`); }
            catch { /* 忽略 */ }
        }
        finally {
            if (fd !== undefined) {
                try { closeSync(fd); } catch { /* 忽略 */ }
                try { unlinkSync(lock); } catch { /* 忽略 */ }
            }
        }
    };

    const timer = setInterval(persist, 60 * 1000);
    if (typeof timer.unref === 'function')
        timer.unref();

    globalThis.__qqbotRelations = {
        track,
        promptLines,
        _test: { pairKey, targetsOf, decayEdge },
        stats: () => Object.fromEntries(Object.entries(state.edges).map(([gid, edges]) => [gid, Object.keys(edges).length])),
    };
    console.log(`[im-qqbot] 群友关系边已启用（规则提取，稀疏存储 ${relationsPath}，60 秒落盘）`);
}
/* <<< dsh-qqbot-patch:group-relations-helper <<< */

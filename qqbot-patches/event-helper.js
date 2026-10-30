/* >>> dsh-qqbot-patch:event-helper >>> */
/**
 * 事件追踪 —— 记住「TA 说要做、会有结果的事」，以及「TA 明显的情绪事件」。
 *
 * 检测：每条群消息都过一遍象信（一次请求问四件事），
 *   有明确计划 → 再用 flash 抽 {title, kind, dueAt}；
 *   明显情绪 → 直接记一条情绪事件（不需要再调模型）。
 *
 * 存储：~/.dsh/profiles/qqbot/qqbot-events.json（文件锁 + 原子写）
 *   { events: [{ id, person, gid, type:'plan'|'emotion', kind:'short'|'long',
 *                title, emotion, dueAt, status:'open'|'done'|'dropped',
 *                createdAt, lastMentionedAt, lastAskAt, askedCount, evidence }] }
 *
 * 追问：对方再次说话时，由 speaker context 注入「TA 说过的事」；
 *   如果对方这条本身在情绪里（10 分钟内记过情绪事件），只关心、不追问计划。
 *   短期 12 小时后可问、24 小时内不重复；长期 3 天后可问、每周一次。
 *
 * 开关：QQBOT_EVENTS_TRACK=off；QQBOT_EVENT_ASK_GAP_H（默认 24）；QQBOT_EVENT_LONG_GAP_D（默认 3）。
 */
function setupEvents(ctx, bot, config, logger) {
    if (globalThis.__qqbotEvents)
        return;
    if (String(process.env.QQBOT_EVENTS_TRACK ?? 'on').toLowerCase() === 'off')
        return;
    const fs = process.getBuiltinModule?.('node:fs');
    if (!fs) {
        console.log('[im-qqbot] 事件追踪: node:fs 不可用，跳过');
        return;
    }
    const profileDir = process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`;
    const file = `${profileDir}/qqbot-events.json`;
    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
    const ASK_GAP = Math.max(1, Number(process.env.QQBOT_EVENT_ASK_GAP_H ?? 24)) * 3600e3;
    const LONG_GAP = Math.max(1, Number(process.env.QQBOT_EVENT_LONG_GAP_D ?? 3)) * 86400e3;
    const SHORT_GAP = 12 * 3600e3;
    const SHORT_TTL = 3 * 86400e3;
    const LONG_TTL = 60 * 86400e3;
    const EMOTION_TTL = 3 * 86400e3;

    // ── 存储 ──
    const empty = () => ({ version: 1, events: [] });
    const read = () => {
        try {
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            return raw && Array.isArray(raw.events) ? raw : empty();
        }
        catch {
            return empty();
        }
    };
    const update = (mutator) => {
        const lock = `${file}.lock`;
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
                    // 已被清掉
                }
                if (Date.now() > deadline)
                    throw new Error('qqbot-events.json 写入锁超时');
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
            const state = read();
            const result = mutator(state);
            if (result === false)
                return undefined;
            const tmp = `${file}.tmp-${process.pid}`;
            fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
            fs.renameSync(tmp, file);
            return result;
        }
        finally {
            try { fs.closeSync(fd); } catch { /* 忽略 */ }
            try { fs.unlinkSync(lock); } catch { /* 忽略 */ }
        }
    };

    const newId = () => `ev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const norm = (text) => String(text ?? '').replace(/\s+/g, '').toLowerCase();

    /** 同一人同一件事 3 天内不重复建；命中就只刷新 lastMentionedAt */
    const addPlan = ({ person, gid, title, kind, dueAt, evidence }) => {
        const cleanTitle = String(title ?? '').trim().slice(0, 40);
        if (cleanTitle === '' || !person)
            return '';
        const key = norm(cleanTitle);
        return update((state) => {
            const now = Date.now();
            const dup = state.events.find((e) => e.type === 'plan' && e.person === person && e.status === 'open'
                && (norm(e.title) === key || norm(e.title).includes(key) || key.includes(norm(e.title))));
            if (dup) {
                dup.lastMentionedAt = now;
                if (dueAt)
                    dup.dueAt = dueAt;
                return dup.id;
            }
            const openCount = state.events.filter((e) => e.type === 'plan' && e.person === person && e.status === 'open').length;
            if (openCount >= 3)
                return '';
            const event = {
                id: newId(),
                person,
                gid,
                type: 'plan',
                kind: kind === 'long' ? 'long' : 'short',
                title: cleanTitle,
                dueAt: dueAt || '',
                status: 'open',
                createdAt: now,
                lastMentionedAt: now,
                lastAskAt: 0,
                askedCount: 0,
                evidence: String(evidence ?? '').slice(0, 80),
            };
            state.events.push(event);
            state.events = state.events.slice(-80);
            return event.id;
        });
    };

    const addEmotion = ({ person, gid, emotion, summary }) => {
        if (!person)
            return '';
        return update((state) => {
            const now = Date.now();
            const event = {
                id: newId(),
                person,
                gid,
                type: 'emotion',
                kind: 'short',
                title: String(summary ?? '').slice(0, 60),
                emotion: String(emotion ?? '其他').slice(0, 10),
                status: 'open',
                createdAt: now,
                lastMentionedAt: now,
                lastAskAt: 0,
                askedCount: 0,
                evidence: String(summary ?? '').slice(0, 80),
            };
            state.events.push(event);
            state.events = state.events.slice(-80);
            return event.id;
        });
    };

    // ── 象信判定 ──
    const xiangxinKey = () => {
        let key = process.env.XIANGXIN_API_KEY ?? '';
        if (key === '') {
            try {
                const yaml = fs.readFileSync(`${process.env.HOME ?? ''}/.dsh/.credentials.yaml`, 'utf8');
                const match = yaml.match(/XIANGXIN_API_KEY:\s*(\S+)/);
                if (match)
                    key = match[1].trim();
            }
            catch {
                key = '';
            }
        }
        return key;
    };
    const judge = async (msg, plans = []) => {
        const key = xiangxinKey();
        if (key === '')
            return undefined;
        const planTitles = plans.map((p) => String(p.title ?? '').trim()).filter(Boolean).slice(0, 3);
        const resultCriteria = {};
        for (const title of planTitles)
            resultCriteria[title] = `说的是「${title}」`;
        resultCriteria['没提到'] = '以上都不是';
        const body = {
            model: 'xiangxin-latest',
            state: {
                说话人: msg.senderName ?? '某人',
                这句话: String(msg.content ?? '').slice(0, 200),
                之前说过的事: planTitles.join('、'),
            },
            questions: {
                plan: { type: 'noul', instructions: '`这句话` 是否包含说话人「打算做/正在做、并且会有明确结果」的事（例如去吃饭、考试、面试、答辩、旅行、搬家）？' },
                plan_kind: { type: 'choice', instructions: '如果有，这是短期还是长期的事？', criteria: { 短期: '几天内就有结果', 长期: '几周或几个月', 无: '没有计划' } },
                emotion: { type: 'noul', instructions: '`这句话` 是否包含说话人明显的情绪（难过、开心、生气、焦虑、委屈）？' },
                emotion_type: { type: 'choice', instructions: '如果有情绪，主要是哪种？', criteria: { 难过: '低落、委屈、想哭', 开心: '兴奋、满足、被夸', 生气: '愤怒、被冒犯', 焦虑: '紧张、压力大、担心', 其他: '不明显或以上都不是' } },
                ask_ok: { type: 'noul', instructions: '现在适合顺口问一句 TA 之前说过的事吗？（TA 当前情绪平稳、在正常聊天时才适合）' },
                ...(planTitles.length > 0 ? {
                    result_plan: { type: 'choice', instructions: '`这句话` 是否说明「之前说过的事」里某一件有结果了？', criteria: resultCriteria },
                    result_kind: { type: 'choice', instructions: '如果有结果，是完成了还是放弃了？', criteria: { 完成: '做完了、成功了', 放弃: '不做了、取消了', 还没结果: '还在进行或没提' } },
                } : {}),
            },
        };
        try {
            const res = await fetch('https://api.xiangxinai.cn/v1/systemone', {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(4000),
            });
            if (!res.ok)
                return undefined;
            const answers = (await res.json())?.answers;
            return {
                plan: Number(answers?.plan?.noul ?? 0),
                planKind: String(answers?.plan_kind?.choice ?? '无'),
                emotion: Number(answers?.emotion?.noul ?? 0),
                emotionType: String(answers?.emotion_type?.choice ?? '其他'),
                askOk: Number(answers?.ask_ok?.noul ?? 0),
                resultPlan: String(answers?.result_plan?.choice ?? '没提到'),
                resultKind: String(answers?.result_kind?.choice ?? '还没结果'),
            };
        }
        catch {
            return undefined;
        }
    };

    const streamText = async (system, user, maxTokens = 200) => {
        let llm;
        try {
            llm = ctx.get('llm');
        }
        catch {
            llm = undefined;
        }
        if (!llm || typeof llm.stream !== 'function')
            return '';
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        let out = '';
        try {
            for await (const chunk of llm.stream({
                provider: process.env.QQBOT_EVENT_PROVIDER ?? 'opencode-go',
                model: process.env.QQBOT_EVENT_MODEL ?? 'deepseek-v4.1-flash',
                system,
                messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
                maxTokens,
                reasoningEffort: 'low',
                signal: controller.signal,
            })) {
                if (!chunk)
                    continue;
                if (chunk.type === 'text-delta' && typeof chunk.text === 'string')
                    out += chunk.text;
                else if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted'))
                    return '';
            }
        }
        catch {
            return '';
        }
        finally {
            clearTimeout(timer);
        }
        return out.trim();
    };

    const extractPlan = async (content, senderName) => {
        const raw = await streamText(
            '从一句话里抽出「要做的事」。只输出 JSON：{"title":"不超过20字的事","due":"YYYY-MM-DD 或空"}。不要解释，没提到日期就空字符串。',
            `说话人：${senderName ?? '某人'}\n原话：${String(content ?? '').slice(0, 200)}`,
        );
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start < 0 || end <= start) {
            const text = String(content ?? '').replace(/\s+/g, ' ').trim();
            const hit = text.match(/(?:要去|要|打算|准备|计划)([^，。！？,.!?\s]{2,18})/);
            const title = (hit ? hit[1] : text).replace(/^(我|我们|他|她|你)/, '');
            return { title: title.slice(0, 20), due: '' };
        }
        try {
            const obj = JSON.parse(raw.slice(start, end + 1));
            const title = String(obj.title ?? '').trim().slice(0, 40);
            if (title === '')
                return undefined;
            const due = /^\d{4}-\d{2}-\d{2}$/.test(String(obj.due ?? '').trim()) ? String(obj.due).trim() : '';
            return { title, due };
        }
        catch {
            return undefined;
        }
    };

    /** 把「之前说过的事」结算掉（完成/放弃） */
    const applyResult = (person, title, kind) => {
        const targetTitle = String(title ?? '').trim();
        if (!person || targetTitle === '' || targetTitle === '没提到')
            return false;
        const status = kind === '放弃' ? 'dropped' : 'done';
        return update((state) => {
            const key = norm(targetTitle);
            const target = state.events.find((e) => {
                if (e.person !== person || e.type !== 'plan' || e.status !== 'open')
                    return false;
                const titleNorm = norm(e.title);
                return titleNorm === key || titleNorm.includes(key) || key.includes(titleNorm);
            });
            if (!target)
                return false;
            target.status = status;
            target.closedAt = Date.now();
            return true;
        }) === true;
    };

    // ── 每条群消息的检测入口（由 group-mention 的入站探针调用）──
    const inflight = new Map();
    const lastJudgeAt = new Map();
    const detect = (msg) => {
        if (!msg || msg.kind !== 'group' || !msg.groupOpenid || !msg.senderId)
            return;
        const content = String(msg.content ?? '').trim();
        if (content === '' || content.startsWith('/'))
            return;
        const gid = msg.groupOpenid;
        if (inflight.get(gid))
            return;
        if (Date.now() - (lastJudgeAt.get(gid) ?? 0) < 1500)
            return;
        inflight.set(gid, true);
        lastJudgeAt.set(gid, Date.now());
        void (async () => {
            try {
                const openPlans = read().events.filter((e) => e.person === msg.senderName && e.type === 'plan' && e.status === 'open');
                const verdict = await judge(msg, openPlans);
                if (!verdict)
                    return;
                if (verdict.resultPlan && verdict.resultPlan !== '没提到' && verdict.resultKind !== '还没结果') {
                    const closed = applyResult(msg.senderName, verdict.resultPlan, verdict.resultKind);
                    if (closed)
                        console.log(`[im-qqbot] 事件结算: ${msg.senderName}「${verdict.resultPlan}」${verdict.resultKind}`);
                }
                if (process.env.QQBOT_EVENT_DEBUG === '1')
                    console.log(`[im-qqbot] 事件判定: ${JSON.stringify(verdict)} «${content.slice(0, 20)}»`);
                if (verdict.emotion >= 0.6 && verdict.emotionType !== '其他') {
                    addEmotion({
                        person: msg.senderName,
                        gid,
                        emotion: verdict.emotionType,
                        summary: content.slice(0, 60),
                    });
                    console.log(`[im-qqbot] 情绪事件: ${msg.senderName} ${verdict.emotionType} ${content.slice(0, 20)}`);
                }
                if (verdict.plan >= 0.6 && verdict.planKind !== '无') {
                    const plan = await extractPlan(content, msg.senderName);
                    if (plan) {
                        const id = addPlan({
                            person: msg.senderName,
                            gid,
                            title: plan.title,
                            kind: verdict.planKind === '长期' ? 'long' : 'short',
                            dueAt: plan.due,
                            evidence: content.slice(0, 80),
                        });
                        if (id)
                            console.log(`[im-qqbot] 计划事件: ${msg.senderName} ${plan.title}（${verdict.planKind}）`);
                    }
                }
                globalThis.__qqbotEvents.lastAskOk.set(`${gid}:${msg.senderName ?? ''}`, { at: Date.now(), ok: verdict.askOk });
            }
            catch {
                // 检测失败不影响消息
            }
            finally {
                inflight.delete(gid);
            }
        })();
    };
    globalThis.__qqbotEventDetect = detect;

    // ── 追问文案（speaker context 调用）──
    const lastAskOk = new Map();
    const promptLine = (gid, person) => {
        if (!person)
            return '';
        const now = Date.now();
        const state = read();
        const mine = state.events.filter((e) => e.person === person && e.status === 'open');
        if (mine.length === 0)
            return '';
        const recentEmotion = mine.find((e) => e.type === 'emotion' && now - e.createdAt < 10 * 60e3);
        // 象信判过「现在适不适合追问」：刚说过话且情绪不适合，就只关心、不追问
        const gate = lastAskOk.get(`${gid}:${person}`);
        const askAllowed = !gate || now - gate.at > 10 * 60e3 || gate.ok >= 0.5;
        const lines = [];
        if (recentEmotion) {
            lines.push(`【TA 现在的情绪】${recentEmotion.emotion}（${recentEmotion.title}）——先顺着情绪关心一句，别急着问别的。`);
        }
        else {
            const due = !askAllowed ? [] : mine.filter((e) => {
                if (e.type !== 'plan')
                    return false;
                const gap = e.kind === 'long' ? LONG_GAP : SHORT_GAP;
                if (now - e.createdAt < gap)
                    return false;
                if (now - (e.lastAskAt ?? 0) < ASK_GAP)
                    return false;
                return true;
            }).sort((a, b) => Number(b.createdAt) - Number(a.createdAt)).slice(0, 2);
            for (const e of due) {
                const days = Math.max(1, Math.round((now - e.createdAt) / 86400e3));
                const when = e.kind === 'long' ? `${days} 天前` : (days <= 1 ? '昨天' : `${days} 天前`);
                lines.push(`【TA 说过的事】${when}提过「${e.title}」${e.dueAt ? `（${e.dueAt}）` : ''}——可以顺口问一句进展，别像查户口。`);
                e.lastAskAt = now;
                e.askedCount = Number(e.askedCount ?? 0) + 1;
            }
            if (lines.length > 0) {
                try {
                    update((s) => {
                        for (const e of due) {
                            const hit = s.events.find((x) => x.id === e.id);
                            if (hit) {
                                hit.lastAskAt = now;
                                hit.askedCount = Number(hit.askedCount ?? 0) + 1;
                            }
                        }
                        return true;
                    });
                }
                catch {
                    // 记不上就下次再问
                }
            }
        }
        // 情绪事件也可以关心（3 天内，没问过）
        if (!recentEmotion) {
            const emo = mine.find((e) => e.type === 'emotion' && now - e.createdAt < EMOTION_TTL && now - (e.lastAskAt ?? 0) > ASK_GAP);
            if (emo) {
                lines.push(`【TA 最近的情绪】${emo.emotion}（${emo.title}）——可以关心一句，但别追问细节。`);
                try {
                    update((s) => {
                        const hit = s.events.find((x) => x.id === emo.id);
                        if (hit) {
                            hit.lastAskAt = now;
                            hit.askedCount = Number(hit.askedCount ?? 0) + 1;
                        }
                        return true;
                    });
                }
                catch {
                    // 忽略
                }
            }
        }
        return lines.join('\n');
    };

    // ── 维护：过期 / 完成 ──
    const maintain = () => {
        const now = Date.now();
        try {
            update((state) => {
                let changed = 0;
                for (const e of state.events) {
                    if (e.status !== 'open')
                        continue;
                    if (e.type === 'emotion' && now - e.createdAt > EMOTION_TTL) {
                        e.status = 'dropped';
                        changed += 1;
                    }
                    else if (e.type === 'plan') {
                        const ttl = e.kind === 'long' ? LONG_TTL : SHORT_TTL;
                        if (now - e.createdAt > ttl) {
                            e.status = 'dropped';
                            changed += 1;
                        }
                    }
                }
                return changed;
            });
        }
        catch {
            // 忽略
        }
    };
    const timer = setInterval(maintain, 3600e3);
    if (typeof timer.unref === 'function')
        timer.unref();

    // ── 工具：让模型自己标记完成/放弃 ──
    let tools;
    try {
        tools = ctx.get('tools');
    }
    catch {
        tools = undefined;
    }
    if (tools) {
        tools.register({
            name: 'track_event',
            description: [
                '标记「TA 说过的事」的进展：做完了用 done，不做了/取消了用 drop。',
                '不知道 id 时可以只给 title（用对方说过的关键词），会匹配当前说话人最近的一条。',
                '只有对方亲口说了结果时才调用；不要替对方猜。',
            ].join(''),
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    action: { type: 'string', description: 'done 或 drop' },
                    id: { type: 'string', description: '事件 id（可省略）' },
                    title: { type: 'string', description: '事件关键词（省略 id 时用）' },
                },
                required: ['action'],
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
                const action = String(args?.action ?? '');
                if (action !== 'done' && action !== 'drop')
                    throw new Error('action 只能是 done 或 drop');
                const gid = globalThis.__qqbotCurrentGid;
                const speaker = gid ? globalThis.__qqbotSpeakers?.get?.(gid) : undefined;
                const person = speaker?.name;
                if (!person)
                    throw new Error('当前不在群聊里');
                const id = String(args?.id ?? '').trim();
                const title = String(args?.title ?? '').trim();
                const changed = update((state) => {
                    const target = state.events.find((e) => e.person === person && e.status === 'open'
                        && (id !== '' ? e.id === id : (title !== '' && norm(e.title).includes(norm(title)))));
                    if (!target)
                        return false;
                    target.status = action === 'done' ? 'done' : 'dropped';
                    target.closedAt = Date.now();
                    return true;
                });
                return changed
                    ? { ok: true, message: action === 'done' ? '记下了，这件事完成了' : '记下了，这件事不追了' }
                    : { ok: false, message: '没找到对应的事，可能已经结束或没记过' };
            },
        });
    }

    globalThis.__qqbotEvents = { detect, promptLine, maintain, read, addPlan, addEmotion, applyResult, lastAskOk };
    console.log('[im-qqbot] 事件追踪已启用（每条群消息象信判定；计划 + 情绪；追问前看情绪）');
}
/* <<< dsh-qqbot-patch:event-helper <<< */

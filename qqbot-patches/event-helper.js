/* >>> dsh-qqbot-patch:event-helper >>> */
/**
 * 事件追踪 —— 记住「TA 说要做、会有结果的事」。
 *
 * 群记忆门控共享消息、最近对话和象信请求。事件保留一份独立的待跟进状态。
 * 提示按当前群和说话人筛选。追问只有在回复发出且确认问到这件事后才计数。
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
    const profileDir = process.env.QQBOT_PROFILE_DIR ?? `${process.env.DSH_HOME ?? `${process.env.HOME ?? ''}/.dsh`}/profiles/${process.env.QQBOT_PROFILE_NAME ?? 'qqbot'}`;
    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
    const ASK_GAP = Math.max(1, Number(process.env.QQBOT_EVENT_ASK_GAP_H ?? 24)) * 3600e3;
    const LONG_GAP = Math.max(1, Number(process.env.QQBOT_EVENT_LONG_GAP_D ?? 3)) * 86400e3;
    const localDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
    const MIN_PRIORITY = 1.5;
    const SHORT_GAP = 12 * 3600e3;
    const SHORT_TTL = 3 * 86400e3;
    const LONG_TTL = 60 * 86400e3;
    const LEGACY_EMOTION_TTL = 3 * 86400e3;

    // Event updates from the bot and panel share one SQLite transaction path.
    const empty = () => ({ version: 1, events: [] });
    const read = () => {
        try {
            const raw = readProfileDocument(profileDir, 'events');
            return Array.isArray(raw.events) ? raw : empty();
        } catch { return empty(); }
    };
    const update = mutator => mutateQqbotEvents(profileDir, mutator);

    const newId = () => `ev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const norm = (text) => String(text ?? '').replace(/\s+/g, '').toLowerCase();

    const personNames = (person) => {
        if (!person || typeof person !== 'object')
            return [];
        return [person.name, person.addressing,
            ...Object.entries(person).filter(([key]) => key.startsWith('nickname')).map(([, value]) => value),
            ...(Array.isArray(person.aliases) ? person.aliases : []),
        ].filter((value) => typeof value === 'string' && value.trim() !== '').map((value) => value.trim());
    };
    const peopleForGroup = (gid) => {
        try {
            const people = readProfileDocument(profileDir, 'people')?.people;
            return Array.isArray(people) ? people.filter((person) => person && typeof person === 'object'
                && (!Array.isArray(person.groups) || person.groups.length === 0 || person.groups.includes(gid))) : [];
        }
        catch { return []; }
    };
    const resolveSpeaker = (msg, people = peopleForGroup(msg.groupOpenid)) => {
        const rawName = String(msg.senderName ?? '').trim();
        const nameMatches = people.filter((item) => personNames(item).some((name) => norm(name) === norm(rawName)));
        const person = people.find((item) => Array.isArray(item.openids) && item.openids.includes(msg.senderId))
            ?? (nameMatches.length === 1 ? nameMatches[0] : undefined);
        return {
            name: String(person?.name ?? rawName),
            id: String(msg.senderId ?? ''),
            aliases: personNames(person),
        };
    };
    const followupCandidates = (msg, people, speaker) => {
        const candidates = [{ key: '当前发言者', person: speaker }];
        const content = String(msg.content ?? '');
        for (const item of people) {
            if ((Array.isArray(item.openids) && item.openids.includes(msg.senderId)) || !item.name || norm(item.name) === norm(speaker.name))
                continue;
            const names = personNames(item).filter((name) => name.length >= 2 && content.includes(name));
            if (names.length === 0)
                continue;
            // The roster does not map its OpenIDs to a specific group. Bind the name
            // here, and use the actual speaker ID when someone speaks.
            const person = { name: String(item.name).trim(), id: '', aliases: personNames(item) };
            const recent = globalThis.__qqbotRecentMessages?.get?.(msg.groupOpenid) ?? [];
            const seen = recent.find((entry) => item.openids?.includes?.(entry?.id));
            if (seen?.id) person.id = String(seen.id);
            else if (item.groups?.length === 1 && item.openids?.length === 1) person.id = String(item.openids[0]);
            candidates.push({ key: names[0], person });
        }
        return candidates.filter((candidate, index, list) => index === 0
            || (candidate.key !== '不需要跟进' && list.filter((item) => item.key === candidate.key).length === 1));
    };
    const samePerson = (event, person, personId = '', aliases = []) => {
        if (personId && event.personId)
            return String(event.personId) === String(personId);
        const names = [person, ...aliases].map(norm).filter(Boolean);
        return names.includes(norm(event.person));
    };

    const involved = (e, speaker) => samePerson(e, speaker.name, speaker.id, speaker.aliases)
        || (e.sourcePerson && samePerson({ person: e.sourcePerson, personId: e.sourcePersonId }, speaker.name, speaker.id, speaker.aliases));
    const isDue = (e, now) => !e.dueAt || e.dueAt <= localDate.format(now);
    const expired = (e, now) => {
        if (e.type === 'emotion') return now - e.createdAt >= LEGACY_EMOTION_TTL;
        const ttl = e.kind === 'long' ? LONG_TTL : SHORT_TTL;
        if (e.followupMode === 'scheduled' && e.dueAt) {
            const due = Date.parse(`${e.dueAt}T00:00:00+08:00`);
            if (Number.isFinite(due)) return now >= due + SHORT_TTL;
        }
        return now - Math.max(e.createdAt, e.lastProgressAt ?? 0) >= ttl;
    };
    const trimHistory = (state) => {
        const closed = state.events.filter((event) => event.status !== 'open');
        const trimmed = new Set(closed.slice(0, Math.max(0, closed.length - 80)));
        if (trimmed.size > 0) state.events = state.events.filter((event) => !trimmed.has(event));
    };
    const planPriority = (e) => e.followupMode === 'none' ? -1 : e.followupPriority ?? 1;

    /** 同群同一人的未结事项去重；优先保留值得问的事项。 */
    const savePlan = ({ person, personId, sourcePerson, sourcePersonId, gid, title, object, kind, dueAt, evidence, followupMode, followupPriority, sourceMessageId, observedAt = Date.now() }) => {
        const cleanTitle = String(title ?? '').trim().slice(0, 40);
        if (cleanTitle === '' || !person)
            return '';
        const key = norm(cleanTitle);
        return update((state) => {
            const now = observedAt;
            if (sourceMessageId) {
                const seen = state.events.find((e) => e.type === 'plan' && e.gid === gid
                    && (e.sourceMessageId === sourceMessageId || e.lastMentionMessageId === sourceMessageId));
                if (seen) return { id: seen.id, duplicate: true };
            }
            const dup = state.events.find((e) => e.type === 'plan' && e.gid === gid && samePerson(e, person, personId) && e.status === 'open' && !expired(e, now)
                && norm(e.title) === key);
            if (dup) {
                if (now >= dup.lastMentionedAt) {
                    dup.lastMentionedAt = now;
                    dup.lastMentionMessageId = sourceMessageId;
                    if (dueAt) dup.dueAt = dueAt;
                    if (object && !dup.object) dup.object = object;
                    if (followupMode && (dup.followupMode === undefined || followupMode !== 'none')) {
                        dup.followupMode = followupMode;
                        dup.followupPriority = Math.max(dup.followupPriority ?? 0, followupPriority ?? 0);
                    }
                }
                return { id: dup.id, duplicate: true };
            }
            const open = state.events.filter((e) => e.type === 'plan' && e.gid === gid
                && samePerson(e, person, personId) && e.status === 'open' && !expired(e, now));
            if (open.length >= 3) {
                const weakest = open.sort((a, b) => planPriority(a) - planPriority(b) || a.createdAt - b.createdAt)[0];
                if (planPriority({ followupMode, followupPriority }) <= planPriority(weakest))
                    return false;
                weakest.status = 'dropped';
                weakest.closedAt = now;
                weakest.closeReason = 'superseded';
            }
            const event = {
                id: newId(),
                person,
                personId: String(personId ?? ''),
                sourcePerson: String(sourcePerson ?? person),
                sourcePersonId: String(sourcePersonId ?? ''),
                gid,
                type: 'plan',
                kind: kind === 'long' ? 'long' : 'short',
                followupMode, followupPriority, sourceMessageId,
                title: cleanTitle,
                ...(object ? { object } : {}),
                dueAt: dueAt || '',
                status: 'open',
                createdAt: now,
                lastMentionedAt: now,
                lastAskAt: 0,
                askedCount: 0,
                evidence: String(evidence ?? '').slice(0, 500),
            };
            state.events.push(event);
            trimHistory(state);
            return { id: event.id, duplicate: false };
        });
    };
    const addPlan = (input) => savePlan(input)?.id ?? '';

    const followupBlocks = new Map();
    const replyKey = (gid, messageId) => JSON.stringify([gid, messageId]);
    const prepare = (msg, content) => {
        if (msg?.kind !== 'group' || !msg.groupOpenid || !msg.senderId || !content || content.startsWith('/')
            || /^(?:\s*(?:【表情[：:][^】]*】|<faceType=[^>]*>|\[(?:图片|视频|文件|表情|动画表情|表情包)[^\]]*\])\s*)+$/.test(content))
            return undefined;
        if (memoryGateIsBareReaction(content)) return undefined;
        const gid = msg.groupOpenid;
        const observedAt = Date.now();
        const messageId = String(msg.messageId ?? msg.msgId ?? '');
        const people = peopleForGroup(gid);
        const speaker = resolveSpeaker(msg, people);
        if (!speaker.name) return undefined;
        const candidates = followupCandidates({ ...msg, content }, people, speaker);
        const related = read().events.filter((e) => e.gid === gid && e.type === 'plan' && involved(e, speaker));
        const plans = related.filter((e) => e.status === 'open' && !expired(e, observedAt)
            && (!messageId || e.sourceMessageId !== messageId))
            .sort((a, b) => b.lastMentionedAt - a.lastMentionedAt).slice(0, 5);
        const planOptions = new Map(plans.map((plan, i) => [`事项${i + 1}：${plan.title}`, plan]));
        const completed = related.filter(e => e.closeReason === 'reported' && e.resultEvidence
            && observedAt - e.closedAt < SHORT_TTL).sort((a, b) => b.closedAt - a.closedAt).slice(0, 3);
        const attitudeOptions = new Map([
            ...planOptions,
            ...completed.map((plan, i) => [`已结算${i + 1}：${plan.title}`, plan]),
        ]);
        const targetCriteria = Object.fromEntries(candidates.map(({ key }) => [key, key === '当前发言者'
            ? '行动者或计划提出者' : '被明确提到、直接受到结果影响的群成员']));
        targetCriteria['不需要跟进'] = '没有合适的跟进对象';
        return {
            gid, speaker, content, messageId, observedAt, candidates, planOptions, attitudeOptions,
            previousOutcome: messageId ? completed.find(e => e.resultMessageId === messageId) : undefined,
            state: { 待跟进事项: Object.fromEntries([...planOptions].map(([key, plan]) => [
                key, { 发起人: plan.sourcePerson || plan.person, 相关人: plan.person, 原话: plan.evidence, 已知进展: plan.progressEvidence },
            ])), ...(completed.length ? { 已结算事项: Object.fromEntries(completed.map((plan, i) => [
                `已结算${i + 1}：${plan.title}`, { 原话: plan.evidence, 结果: plan.resultEvidence },
            ])) } : {}) },
            questions: {
                plan: { type: 'noul', instructions: '只判断当前 `消息`。说话人是否明确承诺、准备或正在做一件具体、尚未完成且可以确认结果的事？可用最近对话解代词。旧事、转述别人的打算、反问、假设、愿望、长期习惯和随口说去吃饭都不算。' },
                followup_timing: { type: 'choice', instructions: '对 `消息` 中本人将做或正在做的具体行动，选合适的自然跟进时机。', criteria: {
                    近期: '几天内能确认具体结果，例如帮人拿药、找东西',
                    定期: '有明确的未来时间点，例如某天考试或面试',
                    不跟进: '没有可确认的结果，或只是日常行程、持续目标、玩笑、假设',
                } },
                followup_priority: { type: 'score', instructions: '`消息` 中的未完成事项多值得之后专门确认进展？', criteria: [
                    '没有可以确认的事项', '普通行程或低价值小事', '有明确结果且对当事人有实际意义', '具体结果对当事人的身体、重要安排或需求有直接影响',
                ] },
                followup_person: { type: 'choice', instructions: '选择最适合被自然问到行动结果的群成员。替人找东西或处理健康相关需求，优先选能直接确认结果和感受的受益人。', criteria: targetCriteria },
                ask_ok: { type: 'noul', instructions: '只看当前 `消息`，现在是否适合自然地提一句旧事？明显诉苦、冲突或明确不想继续聊时答否。正常交流和信号不足时答是。单独的笑声（如哈哈哈）、表情、感叹或短回复不足以判断对方的心情。' },
                ...(plans.length > 0 ? {
                    result_plan: { type: 'choice', instructions: '当前 `消息` 明确报告了哪条待跟进事项的结果或一项新的实际进展？可用最近对话消解指代，证据必须来自当前发言。话题相似、重复旧打算、提问或猜测，选没提到。', criteria: {
                        ...Object.fromEntries([...planOptions].map(([key, plan]) => [key, plan.title])),
                        没提到: '当前没有结果或实际进展',
                    } },
                    result_kind: { type: 'choice', instructions: '当前 `消息` 报告的变化是哪一种？', criteria: {
                        完成: '确认行动已经做完或拿到了预期结果', 失败: '明确说这次已经结束但没有成功，例如考试没通过', 放弃: '确认取消或决定不做',
                        进展: '明确说已经做到新的中间步骤，整件事还没有结束',
                        没提到: '没有新证据或只是相关话题',
                    } },
                } : {}),
                ...(attitudeOptions.size ? {
                    attitude_event: { type: 'choice', instructions: '只有当前发言明确表达本人对某件事的看法时，选择其所指的一个已知事项。允许结合上下文消解指代。不能确认是同一件事时选没提到。', criteria: {
                        ...Object.fromEntries([...attitudeOptions].map(([key, plan]) => [key, plan.title])),
                        没提到: '没有可确认的对应事项',
                    } },
                } : {}),
            },
        };
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

    const extractPlan = async (content, senderName, recent, observedAt) => {
        const fallback = { title: content.replace(/\s+/g, ' ').slice(0, 40), due: '' };
        const raw = await streamText(
            '从当前消息抽取当事人明确承诺、准备或正在做的具体行动。最近对话只用来消解指代。只输出 JSON：{"title":"不超过20字，保留关键行动及对象","object":"当前消息明确提到的事项对象原词，例如胃药或考试名称，没有则留空","due":"YYYY-MM-DD 或空"}。只有当前消息明确说出完整日期，或今天、明天、后天时才填日期。',
            JSON.stringify({ 说话人: senderName, 今天: localDate.format(observedAt), 最近对话: recent, 当前消息: content }),
        );
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        try {
            const obj = JSON.parse(raw.slice(start, end + 1));
            const title = String(obj.title ?? '').trim().slice(0, 40) || fallback.title;
            const candidate = typeof obj.object === 'string' ? obj.object.trim().slice(0, 60) : '';
            const object = candidate && content.includes(candidate) ? candidate : '';
            const date = String(obj.due ?? '').trim();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))
                || new Date(date).toISOString().slice(0, 10) !== date) return { title, object, due: '' };
            const [y, m, d] = date.split('-').map(Number);
            const explicit = new RegExp(`${y}(?:年|[-/.])0?${m}(?:月|[-/.])0?${d}(?:日|号|\\b)`);
            const relative = ['今天', '明天', '后天'].some((word, i) =>
                content.includes(word) && localDate.format(observedAt + i * 86400e3) === date);
            return { title, object, due: explicit.test(content) || relative ? date : '' };
        }
        catch {
            return fallback;
        }
    };

    // Seed the latest evidence from older records before writing subsequent changes.
    const eventHistory = (event) => {
        if (Array.isArray(event.history)) return event.history;
        event.history = [];
        if (event.progressEvidence) event.history.push({ kind: 'progress', at: event.lastProgressAt,
            person: event.progressPerson, evidence: event.progressEvidence, messageId: event.progressMessageId });
        if (event.lastAskEvidence) event.history.push({ kind: 'ask', at: event.lastAskAt,
            person: '小易', evidence: event.lastAskEvidence, messageId: event.lastAskMessageId });
        return event.history;
    };

    const closePlan = (state, id, kind, identity, observedAt = Date.now(), result = {}) => {
        const target = state.events.find((e) => e.id === id && e.type === 'plan'
            && e.status === 'open' && e.createdAt <= observedAt && (!identity.gid || e.gid === identity.gid)
            && involved(e, identity));
        if (!target || !['完成', '失败', '放弃'].includes(kind)) return false;
        target.status = kind === '放弃' ? 'dropped' : 'done';
        target.outcomeKind = kind;
        target.closedAt = observedAt;
        target.closeReason = 'reported';
        Object.assign(target, result);
        eventHistory(target).push({ kind: 'close', at: observedAt, status: target.status, reason: target.closeReason,
            outcomeKind: kind, person: result.resultPerson || identity.name, evidence: result.resultEvidence, messageId: result.resultMessageId });
        trimHistory(state);
        return true;
    };

    const applyResult = (person, title, kind, identity = {}) => {
        if (!person || !norm(title) || title === '没提到') return false;
        const speaker = { ...identity, name: person, id: identity.personId };
        return update((state) => {
            const matches = state.events.filter((e) => e.type === 'plan' && e.status === 'open'
                && (!identity.gid || e.gid === identity.gid) && involved(e, speaker) && norm(e.title) === norm(title));
            return matches.length === 1 && closePlan(state, matches[0].id, kind, speaker);
        }) === true;
    };

    const observe = async (input, answers, recent) => {
        const { gid, speaker, content, messageId, observedAt, candidates, planOptions } = input;
        const planScore = Number(answers.plan?.noul ?? 0);
        const priority = clamp(Number(answers.followup_priority?.score) || 0, 0, 3);
        const audit = { plan: planScore, priority };
        const closedResult = (event, kind) => {
            const targetReported = samePerson(event, speaker.name, speaker.id, speaker.aliases);
            const other = targetReported ? event.sourcePerson : event.person;
            return { ...audit, decision: 'closed', closedEventId: event.id, outcomeKind: kind, title: event.title,
                ...(other && norm(other) !== norm(speaker.name) ? { other, otherId: targetReported ? event.sourcePersonId : event.personId } : {}) };
        };
        try {
            const askOk = answers.ask_ok?.noul;
            if (messageId && Number.isFinite(askOk) && askOk < 0.5) {
                if (followupBlocks.size >= 512) followupBlocks.delete(followupBlocks.keys().next().value);
                followupBlocks.set(replyKey(gid, messageId), observedAt);
            }
            if (Number(answers.sensitive?.noul ?? 0) > 0.3) return { ...audit, decision: 'sensitive' };
            if (Number(answers.meta?.noul ?? 0) >= 0.6) return { ...audit, decision: 'meta_noise' };
            if (answers.experience?.choice === '机制攻略') return { ...audit, decision: 'knowledge' };

            if (input.previousOutcome) return closedResult(input.previousOutcome, input.previousOutcome.outcomeKind);
            const result = planOptions.get(answers.result_plan?.choice);
            const kind = answers.result_kind?.choice;
            if (result && Number(answers.result_plan?.confidence ?? 0) >= 0.55
                && Number(answers.result_kind?.confidence ?? 0) >= 0.55 && ['完成', '失败', '放弃', '进展'].includes(kind)) {
                const recorded = update((state) => {
                    const evidence = content.slice(0, 500);
                    if (kind !== '进展') {
                        return closePlan(state, result.id, kind, { ...speaker, gid }, observedAt, {
                            resultEvidence: evidence, resultMessageId: messageId, resultPerson: speaker.name, resultPersonId: speaker.id,
                        });
                    }
                    const target = state.events.find((e) => e.id === result.id && e.gid === gid && e.createdAt <= observedAt
                        && (e.status === 'open' || e.closedAt >= observedAt) && involved(e, speaker));
                    if (!target) return false;
                    const history = eventHistory(target);
                    if (messageId && history.some(entry => entry.kind === 'progress' && entry.messageId === messageId)) return false;
                    history.push({ kind: 'progress', at: observedAt, person: speaker.name, evidence, messageId });
                    if ((target.lastProgressAt ?? 0) <= observedAt) {
                        target.lastProgressAt = observedAt;
                        target.progressEvidence = evidence;
                        target.progressMessageId = messageId;
                        target.progressPerson = speaker.name;
                    }
                    return true;
                });
                if (recorded) {
                    return kind === '进展' ? { ...audit, decision: 'progress', eventId: result.id } : closedResult(result, kind);
                }
            }
            if (planScore < 0.65 || priority < MIN_PRIORITY) return { ...audit, decision: 'below_threshold' };
            const timing = answers.followup_timing?.choice;
            if (timing !== '近期' && timing !== '定期') return { ...audit, decision: 'no_followup' };
            const target = Number(answers.followup_person?.confidence ?? 0) >= 0.55
                ? candidates.find(({ key }) => key === answers.followup_person?.choice)?.person : undefined;
            if (!target) return { ...audit, decision: 'no_target' };
            const plan = await extractPlan(content, speaker.name, recent, observedAt);
            if (timing === '定期' && !plan.due) return { ...audit, decision: 'unclear_due' };
            const mode = timing === '定期' ? 'scheduled' : 'soon';
            const saved = savePlan({ person: target.name, personId: target.id, sourcePerson: speaker.name, sourcePersonId: speaker.id,
                gid, title: plan.title, object: plan.object, kind: mode === 'scheduled' ? 'long' : 'short',
                dueAt: plan.due, evidence: content, followupMode: mode, followupPriority: priority, sourceMessageId: messageId, observedAt });
            if (!saved) return { ...audit, decision: 'capacity' };
            return { ...audit, decision: saved.duplicate ? 'existing' : 'tracked', eventId: saved.id };
        }
        catch {
            return { ...audit, decision: 'write_failed' };
        }
    };

    // 群记忆关闭时仍可单独运行事件跟进，使用同一套清洗、上下文和安全判定。
    const detect = async (msg) => {
        if (typeof xiangxinMemoryJudge !== 'function' || standaloneActive >= 12) return;
        standaloneActive++;
        try {
            const content = memoryGateMessageText(msg);
            const input = prepare(msg, content);
            if (!input) return;
            const recent = memoryGateRecentDialog(input.gid);
            const answers = await xiangxinMemoryJudge({ 说话人: input.speaker.name, 消息: content, 最近对话: recent, ...input.state },
                input.gid, input.questions);
            const tracking = answers ? await observe(input, answers, recent) : { decision: 'judge_failed' };
            appendQqbotRecord(profileDir, 'memory-gate', { t: new Date().toISOString(), gid: input.gid,
                speakerId: input.speaker.id, messageUid: input.messageId, tracking });
        }
        catch {
            // 跟进失败不影响群消息处理。
        }
        finally {
            standaloneActive--;
        }
    };
    let standaloneActive = 0;

    const offers = new Map();
    const OFFER_TTL = 3 * 60e3;
    const usable = (e, now) => !e.verifiedAskCount || now - (e.lastAskAt ?? 0) >= ASK_GAP;

    const promptLine = (gid, current, { messageId = '', preview = false } = {}) => {
        if (!gid || !current)
            return '';
        const { name, id } = typeof current === 'string' ? { name: current } : current;
        const speaker = resolveSpeaker({ groupOpenid: gid, senderName: name, senderId: id });
        const now = Date.now();
        const mine = read().events.filter((e) => e.type === 'plan' && e.gid === gid && e.status === 'open'
            && samePerson(e, speaker.name, speaker.id, speaker.aliases));
        const blockedAt = messageId ? followupBlocks.get(replyKey(gid, messageId)) : undefined;
        const askAllowed = blockedAt === undefined || now - blockedAt > OFFER_TTL;
        const offer = (event) => {
            if (preview || !messageId) return;
            for (const [key, entry] of offers) {
                if (now - entry.at >= OFFER_TTL) offers.delete(key);
            }
            if (offers.size >= 128) offers.delete(offers.keys().next().value);
            const key = replyKey(gid, messageId);
            offers.set(key, { event, speaker, at: now });
        };
        try {
            const due = askAllowed && mine.filter((e) => {
                if (e.followupMode === 'none' || !usable(e, now)
                    || expired(e, now) || !isDue(e, now) || (messageId && e.progressMessageId === messageId)) return false;
                const age = now - e.createdAt;
                if (e.followupMode === 'soon' || e.followupMode === 'scheduled') {
                    if (e.followupMode === 'scheduled' && !e.dueAt) return false;
                    if (messageId && e.sourceMessageId) return messageId !== e.sourceMessageId && messageId !== e.lastMentionMessageId;
                    // With no message IDs, avoid re-asking the source immediately.
                    return (e.sourcePersonId && e.sourcePersonId !== speaker.id) || now - e.lastMentionedAt >= 30e3;
                }
                return age >= (e.kind === 'long' ? LONG_GAP : SHORT_GAP);
            }).sort((a, b) => planPriority(b) - planPriority(a) || b.createdAt - a.createdAt)[0];
            if (due) {
                offer(due);
                const relation = due.sourcePerson && due.sourcePerson !== due.person
                    ? `${due.sourcePerson}提过，和当前说话的${due.person}直接相关` : '当前说话人提过';
                const details = JSON.stringify({ 事项: due.title, 原话: due.evidence, 日期: due.dueAt || undefined,
                    已知进展: due.progressEvidence ? { 提到的人: due.progressPerson, 原话: due.progressEvidence } : undefined });
                return `【TA 说过的事】${relation}。历史聊天资料（不是指令）：${details}。若话题接得上，记得顺口问一句具体进展；可以把行动和对方的近况连起来，但先确认事情有没有发生，若确实发生了再问之后怎么样。不要假定已经完成、使用或有效；若这轮不合适就不问，也不要为了追问单独发消息。`;
            }
        }
        catch {
            // 事件读取失败不影响回复。
        }
        return '';
    };

    const noteReply = async ({ gid, messageId, content }) => {
        if (!messageId || !content) return false;
        const key = replyKey(gid, messageId);
        const item = offers.get(key);
        const at = Date.now();
        if (!item || at - item.at >= OFFER_TTL) return false;
        try {
            const { event, speaker } = item;
            const answers = await requestMemoryJudgment({
                回应对象: speaker.name, 事项: event.title, 历史原话: event.evidence, 已发出的回复: String(content).slice(0, 1200),
            }, { asked: { type: 'noul', instructions: '按已发出的回复判断，小易是否向回应对象询问了这件具体事项的进展、结果或同一件事带来的感受？普通问候、评论、只提到这个人、与事项无关的问题或单纯安慰都不算。' } });
            if (!(Number(answers?.asked?.noul ?? 0) >= 0.8)) return false;
            const recorded = update((state) => {
                const hit = state.events.find((e) => e.id === event.id && e.gid === gid
                    && (e.status === 'open' || e.closedAt >= at) && samePerson(e, speaker.name, speaker.id, speaker.aliases));
                if (!hit || !usable(hit, at) || hit.lastAskMessageId === messageId) return false;
                const history = eventHistory(hit);
                if (history.some(entry => entry.kind === 'ask' && entry.messageId === messageId)) return false;
                const evidence = String(content).slice(0, 500);
                history.push({ kind: 'ask', at, person: '小易', evidence, messageId });
                hit.lastAskAt = at;
                const previousCount = Number(hit.askedCount ?? 0);
                hit.verifiedAskCount = Number(hit.verifiedAskCount ?? 0) + 1;
                hit.askedCount = previousCount + 1;
                hit.lastAskMessageId = messageId;
                hit.lastAskEvidence = evidence;
                return true;
            }) === true;
            if (recorded && offers.get(key) === item) offers.delete(key);
            return recorded;
        }
        catch {
            return false;
        }
    };

    // 普通群回复和缓冲回复最终都走 sendMarkdown。
    if (typeof bot?.sendMarkdown === 'function') {
        const sendMarkdown = bot.sendMarkdown;
        bot.sendMarkdown = async function (...args) {
            const result = await sendMarkdown.apply(this, args);
            const [target, content] = args;
            if (target?.scope === 'group')
                void noteReply({ gid: target.targetId, messageId: String(target.msgId ?? ''), content });
            return result;
        };
    }

    // ── 维护：过期与历史保留 ──
    const maintain = () => {
        const now = Date.now();
        try {
            update((state) => {
                let changed = 0;
                for (const e of state.events) {
                    if (e.status !== 'open')
                        continue;
                    if (expired(e, now)) {
                        e.status = 'dropped';
                        e.closedAt = now;
                        e.closeReason = 'expired';
                        changed += 1;
                    }
                }
                if (changed > 0) trimHistory(state);
                return changed > 0;
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
                if (!gid || !speaker || (!speaker.name && !speaker.id))
                    throw new Error('当前不在群聊里');
                const identity = resolveSpeaker({ groupOpenid: gid, senderName: speaker.name, senderId: speaker.id });
                const id = String(args?.id ?? '').trim();
                const title = String(args?.title ?? '').trim();
                const changed = update((state) => {
                    const matches = state.events.filter((e) => e.gid === gid && e.type === 'plan'
                        && involved(e, identity) && e.status === 'open'
                        && (id ? e.id === id : title && norm(e.title).includes(norm(title))));
                    return matches.length === 1 && closePlan(state, matches[0].id, action === 'done' ? '完成' : '放弃',
                        { ...identity, gid }, Date.now(), { resultPerson: identity.name, resultPersonId: identity.id });
                });
                return changed
                    ? { ok: true, message: action === 'done' ? '记下了，这件事完成了' : '记下了，这件事不追了' }
                    : { ok: false, message: '没找到对应的事，可能已经结束或没记过' };
            },
        });
    }

    globalThis.__qqbotEvents = { detect, prepare, observe, promptLine, noteReply, maintain, read, addPlan, applyResult };
    globalThis.__qqbotEventDetect = detect;
    console.log('[im-qqbot] 事件追踪已启用（共享群记忆判定；按已发送回复确认追问）');
}
/* <<< dsh-qqbot-patch:event-helper <<< */

/* >>> dsh-qqbot-patch:people-roster-helper >>> */
/**
 * 群成员档案（拆分版，为了 DeepSeek 前缀缓存）：
 *
 *   buildPeopleRoster(gid)    → 静态部分：这群有哪些人、各自档案。同一群内每轮一致。
 *   buildSpeakerContext(gid)  → 动态部分：当前说话人 + 亲密度/问候 + 关于他的记忆 + 每日维护提示。
 *
 * 静态在前、动态在后（section order 91 / 92），这样每轮变化只影响尾部，
 * 前缀（人设 + 静态档案）能被 DeepSeek 的 prompt cache 命中。
 */
const AFFINITY_TIERS = [
    { min: 0, max: 19, key: 'cold', label: '冷淡', address: '全名或「你」', greet: false, tone: '简短、客气、有距离' },
    { min: 20, max: 39, key: 'distant', label: '疏远', address: '全名', greet: false, tone: '正常但不热络' },
    { min: 40, max: 59, key: 'normal', label: '普通', address: '名字或昵称', greet: false, tone: '自然' },
    { min: 60, max: 79, key: 'friendly', label: '熟络', address: '昵称/小名', greet: true, tone: '轻松、会开玩笑' },
    { min: 80, max: 100, key: 'close', label: '亲近', address: '昵称 + 亲昵后缀（如姐姐/哥）', greet: true, tone: '热情、会撒娇或关心' },
];

function affinityValue(person) {
    const raw = Number(person?.affinity);
    if (!Number.isFinite(raw))
        return 50;
    return Math.max(0, Math.min(100, Math.round(raw)));
}

function affinityInfo(person) {
    const value = affinityValue(person);
    const tier = AFFINITY_TIERS.find((t) => value >= t.min && value <= t.max) ?? AFFINITY_TIERS[2];
    return { value, tier };
}

function rosterProfileDir() {
    return process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`;
}

function readPeopleList() {
    try {
        const parsed = JSON.parse(readFileSync(`${rosterProfileDir()}/qqbot-people.json`, 'utf8'));
        return Array.isArray(parsed?.people) ? parsed.people : [];
    }
    catch {
        return [];
    }
}

/** 本地时区的 YYYY-MM-DD（「每天」按 00:00 换天，不用 UTC 日期） */
function localDateKey(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/** 今天是否是这个人第一次在本群说话 */
function isFirstMessageToday(gid, speakerId) {
    if (!speakerId)
        return false;
    try {
        const path = `${rosterProfileDir()}/qqbot-greetings.json`;
        let state = {};
        try {
            state = JSON.parse(readFileSync(path, 'utf8'));
        }
        catch {
            state = {};
        }
        const today = localDateKey();
        const key = `${gid}:${speakerId}`;
        if (state[key] === today)
            return false;
        state[key] = today;
        writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
        return true;
    }
    catch {
        return false;
    }
}

/** 从 dsh-ltm 的 SQLite 里捞「关于某个人」的长期记忆（只读，失败返回空） */
/**
 * 记忆排序分：重要性 × 时间衰减 × 类型加成。
 * 重要性来自记忆门控写进 tags 的 imp:X；没写就按 0.8。
 * 衰减半衰期约 10 天（exp(-age/14)），旧的但重要的事仍能排上来。
 */
function memoryScore(row, now = Date.now()) {
    const tags = String(row.tags ?? '');
    const impMatch = tags.match(/imp:([\d.]+)/);
    const imp = impMatch ? Math.min(2, Number(impMatch[1]) || 0) : 0.8;
    const at = Number(row.updated_at || row.created_at || 0);
    const ageDays = at > 0 ? Math.max(0, (now - at) / 86400000) : 0;
    const recency = Math.exp(-ageDays / 14);
    const typeBoost = /近况卡/.test(tags) ? 1.3 : /日报/.test(tags) ? 1.1 : 1;
    return (0.6 + imp) * (0.35 + 0.65 * recency) * typeBoost;
}

function readPersonMemories(gid, names, limit = 3) {
    if (!Array.isArray(names) || names.length === 0)
        return [];
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    if (!sqlite)
        return [];
    const dbPath = `${process.env.HOME ?? ''}/.dsh/memory/ltm.db`;
    try {
        const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
        try {
            const scope = `qq:group:${gid}`;
            const cleaned = names.filter((n) => typeof n === 'string' && n.trim() !== '').map((n) => n.trim());
            if (cleaned.length === 0)
                return [];
            // 只认「tags 里有这个名字」或「正文主体就是这个名」的条目，
            // 避免把「成员甲是成员乙的朋友」当成成员乙自己的经历。
            const conds = cleaned.map(() => "(' ' || tags || ' ') LIKE ? OR text LIKE ?").join(' OR ');
            const params = [scope];
            for (const n of cleaned)
                params.push(`% ${n} %`, `%] ${n}：%`);
            // 先取人物卡（跨群合并的那张），再补本群最近两条原始事件；
            // 卡片信息密度高，原始片段保留作底稿，只取最新的补充细节。
            const cards = [];
            for (const name of cleaned.slice(0, 2)) {
                const row = db.prepare('select text from memories where tags like ? order by updated_at desc limit 1')
                    .get(`%近况卡 ${name}%`);
                if (row)
                    cards.push(String(row.text ?? '').trim());
            }
            const rawLimit = Math.max(0, limit - cards.length);
            const rows = rawLimit === 0 ? [] : db.prepare(`select text, tags, created_at, updated_at from memories where scope = ? and tags not like '%近况卡%' and (${conds}) order by updated_at desc limit ?`)
                .all(...params, 40);
            const now = Date.now();
            const ranked = rows
                .map((row) => ({ text: String(row.text ?? '').trim(), score: memoryScore(row, now) }))
                .filter((item) => item.text !== '')
                .sort((a, b) => b.score - a.score)
                .slice(0, rawLimit);
            return [...cards, ...ranked.map((item) => item.text)].filter(Boolean).slice(0, limit);
        }
        finally {
            db.close();
        }
    }
    catch {
        return [];
    }
}

function namesOfPerson(person) {
    const out = [person.name, person.addressing];
    for (const key of Object.keys(person)) {
        if (key.indexOf('nickname') === 0)
            out.push(person[key]);
    }
    if (Array.isArray(person.aliases))
        out.push(...person.aliases);
    return out.filter((n) => typeof n === 'string' && n.trim() !== '').map((n) => n.trim());
}

function findPersonForSpeaker(list, speaker) {
    if (!speaker)
        return undefined;
    const lower = String(speaker.name ?? '').toLowerCase();
    return list.find((person) => {
        if (!person || typeof person !== 'object')
            return false;
        if (Array.isArray(person.openids) && person.openids.includes(speaker.id))
            return true;
        return namesOfPerson(person).some((n) => n.toLowerCase() === lower);
    });
}

/** 静态档案：这群有哪些人、各是什么设定（同一群内每轮相同，利于缓存） */
function buildPeopleRoster(gid) {
    const list = readPeopleList();
    const text = (v) => (typeof v === 'string' ? v.trim() : '');
    const clean = (v) => v.trim().replace(/[。；;，,、\s]+$/u, '');
    const entries = [];
    for (const person of list) {
        if (!person || typeof person !== 'object')
            continue;
        const name = text(person.name);
        if (name === '')
            continue;
        if (Array.isArray(person.groups) && person.groups.length > 0
            && !person.groups.some((g) => text(g) === gid))
            continue;
        const p = person.profile && typeof person.profile === 'object' ? person.profile : {};
        const fields = [];
        const push = (label, value) => {
            const cleaned = clean(String(value ?? ''));
            if (cleaned !== '')
                fields.push(`  ${label}：${cleaned}`);
        };
        const nicknameKeys = Object.keys(person)
            .filter((k) => /^nickname\d+$/.test(k))
            .sort((a, b) => Number(a.slice('nickname'.length)) - Number(b.slice('nickname'.length)));
        for (const key of nicknameKeys)
            push(`昵称${key.slice('nickname'.length)}`, text(person[key]));
        push('称呼', text(person.addressing));
        push('一句话', text(person.summary));
        push('性别', text(p.gender));
        push('年龄', text(p.age));
        push('身高', text(p.height));
        push('学历', text(p.education));
        push('职业', text(p.identity));
        push('城市', text(p.city));
        push('生日', text(person.birthday));
        push('性格', text(p.personality));
        push('身体状况', text(p.health));
        push('近况', text(p.status));
        if (text(p.recent) !== '') {
            const recentAt = String(p.recentAt ?? '').slice(5, 10);
            push('最近', recentAt !== '' ? `${text(p.recent)}（${recentAt}）` : text(p.recent));
        }
        push('经历', text(p.background));
        // 关系：优先用带时间的事实（谁-关系-状态-起止），旧版 relations 兜底
        const relationFacts = Array.isArray(p.relationFacts) ? p.relationFacts : [];
        if (relationFacts.length > 0) {
            for (const rel of relationFacts.slice(-10)) {
                const who = clean(text(rel.who));
                const relation = clean(text(rel.relation));
                if (who === '' && relation === '')
                    continue;
                const status = clean(text(rel.status));
                const span = rel.until ? `${rel.since || '?'}~${rel.until}` : (rel.since ? `${rel.since} 起` : '');
                const label = relation ? `${who}（${relation}）` : who;
                fields.push(`  ${label}${span ? `【${span}】` : ''}：${status}`);
            }
        }
        else {
            const relations = p.relations && typeof p.relations === 'object' && !Array.isArray(p.relations) ? p.relations : {};
            for (const [label, value] of Object.entries(relations)) {
                const values = Array.isArray(value) ? value.map((v) => clean(text(v))).filter(Boolean) : [clean(text(value))];
                const cleaned = values.filter(Boolean).join('、');
                if (cleaned !== '')
                    fields.push(`  ${clean(label)}：${cleaned}`);
            }
        }
        if (Array.isArray(p.relationships) && p.relationships.length > 0) {
            const rel = p.relationships.map((r) => clean(text(r))).filter(Boolean);
            if (rel.length > 0)
                fields.push(`  关系：${rel.join('；')}`);
        }
        const listText = (value) => (Array.isArray(value)
            ? value.map((v) => clean(text(v))).filter(Boolean).join('、')
            : clean(text(value)));
        const legacyHobbies = Object.keys(person)
            .filter((k) => k.indexOf('hobby') === 0 && String(Number(k.slice('hobby'.length))) !== 'NaN')
            .sort((a, b) => Number(a.slice('hobby'.length)) - Number(b.slice('hobby'.length)))
            .map((k) => clean(text(person[k])))
            .filter(Boolean);
        const hobbies = [listText(p.hobbies), legacyHobbies.join('、'), clean(text(p.likes))].filter(Boolean).join('、');
        push('爱好', hobbies);
        push('雷区', listText(p.dislikes));
        push('擅长', listText(p.skills));
        push('习惯', text(p.habits));
        push('宠物', listText(p.pets));
        push('其他', text(p.other));
        push('备注', text(person.note));
        const aliases = Array.isArray(person.aliases) ? person.aliases.map(text).filter(Boolean) : [];
        const meta = [];
        if (aliases.length > 0)
            meta.push(`也叫${aliases.join('、')}`);
        if (text(person.qq) !== '')
            meta.push(`QQ ${text(person.qq)}`);
        const who = meta.length > 0 ? `${name}（${meta.join('，')}）` : name;
        // 空壳档案压成一行，省 token
        if (fields.length === 0)
            entries.push(`- ${who}（群成员，档案待补）`);
        else
            entries.push([`- ${who}`, ...fields].join('\n'));
    }
    if (entries.length === 0)
        return '';
    return [
        '【群成员档案】',
        '下面这些人是你早就认识的人。群里消息的发送者名字（真名或昵称）出现在 user: 后面，用这些名字对号。',
        '【硬性】称呼规则：提到任何人——包括第三人称转述、解释自己说过什么——只能用档案里的「称呼」那行；'
            + '没写称呼就用第一行的名字。',
        '不要用 QQ 群昵称、英文 ID 或 nicknameN 里的别名去称呼或提及任何人：哪怕你觉得昵称更自然、更亲切，'
            + '哪怕他本人的群昵称就是那个英文名。',
        '例：群里显示名是「测试昵称」，档案写「称呼：成员甲」→ 一律使用成员甲；'
            + '被问到原因时也不要编造昵称缩写的解释。',
        '每人按字段分条列出，互不混写。回答时只答被问到的字段；但涉及身体状况、雷区、处境时要自然带进关心。',
        '不要罗列整份档案；不要提「档案」「提示」「文件」这类字眼。',
        ...entries,
    ].join('\n');
}

/** 动态上下文：当前说话人、亲密度、关于他的记忆、每日维护提示（每轮可能变化，放在最后） */
const PERSONAL_STATE_PATTERNS = [
    { re: /压力|焦虑|抑郁|崩溃|扛不住|顶不住|好累|累死|心累|内耗|失眠|睡不着/, label: '情绪/压力' },
    { re: /胆固醇|血压|血糖|血脂|尿酸|体检|指标|超标|住院|手术|生病|感冒|发烧|疼|不舒服|过敏|复查/, label: '身体/健康' },
    { re: /瘦了|胖了|减肥|增重|掉秤|长胖|体重/, label: '体重/身体变化' },
    { re: /分手|失恋|吵架|被骂|被裁|失业|挂科|没考好|失败|亏了|赔了/, label: '不顺心的事' },
    { re: /升职|加薪|上岸|考过|录取|中奖|脱单|表白成功|成了|通过了|offer/i, label: '好消息' },
];

/** 这条消息是不是在讲「自己的状态」（健康/情绪/近况） */
function detectPersonalState(text) {
    const t = String(text ?? '');
    if (t.length < 2)
        return undefined;
    for (const item of PERSONAL_STATE_PATTERNS) {
        if (item.re.test(t))
            return item.label;
    }
    return undefined;
}

/**
 * 是不是在「诉苦」：情绪差 / 身体不舒服 / 遇上不顺心的事 / 嫌自己胖。
 * 好消息不算；这类首条不套「必须接话」，交给上面那条「状况」提示，
 * 按关心而不是按打招呼来接。
 */
function detectVenting(text) {
    const t = String(text ?? '');
    if (t.length < 2)
        return false;
    return PERSONAL_STATE_PATTERNS.some((item) => item.label !== '好消息' && item.re.test(t));
}

/** 消息是不是只有 [表情] / [图片] 这类占位符（没有实际文字） */
function isPlaceholderOnly(text) {
    const stripped = String(text ?? '')
        .replace(/\[(?:图片|视频|文件|动画表情|语音|语音消息|闪照|位置|链接|小程序|合并转发)\]/g, '')
        .replace(/\[表情[^\]]*\]/g, '')
        .trim();
    return stripped === '';
}

/** 消息是不是只有表情包/表情占位符（没有实际文字） */
function isStickerOnly(text) {
    return /^(?:\s*\[(?:表情|动画表情|表情包)[^\]]*\]\s*)+$/.test(String(text ?? '').trim());
}

function buildSpeakerContext(gid, record) {
    const list = readPeopleList();
    const speakers = globalThis.__qqbotSpeakers;
    // 优先用本 turn 队首（消息排队时 __qqbotSpeakers 可能已被后一条覆盖）
    const speaker = (typeof roleSkillReplySpeaker === 'function' ? roleSkillReplySpeaker(gid, record) : undefined)
        ?? (typeof roleSkillPendingSpeaker === 'function' ? roleSkillPendingSpeaker(gid) : undefined)
        ?? (speakers instanceof Map ? speakers.get(gid) : undefined);
    if (!speaker || (!speaker.name && !speaker.id))
        return '';
    const matched = findPersonForSpeaker(list, speaker);
    const lines = [];

    // 本 turn 这个人最后说的一条：状态 / 诉苦 / 占位符都从这里判断
    let lastMessageContent = '';
    try {
        const recent = globalThis.__qqbotRecentMessages?.get?.(gid) ?? [];
        const last = speaker.id
            ? [...recent].reverse().find((m) => m && m.id === speaker.id)
            : undefined;
        lastMessageContent = String(last?.content ?? '');
    }
    catch {
        lastMessageContent = '';
    }

    // 这个人刚说的事情里有没有「自己的状态」——有就明确要求回应，别沉默
    let stateLine = '';
    try {
        const kind = detectPersonalState(lastMessageContent);
        if (kind) {
            const snippet = lastMessageContent.slice(0, 40);
            stateLine = `【TA 刚提到自己的状况（${kind}）】「${snippet}」——哪怕这条不是直接问你的，也要用一句话回应（关心/接话/追问一句），不要沉默、不要回 [SILENT]。`;
        }
    }
    catch {
        stateLine = '';
    }

    // 炫耀/卖关子/分享：象信已经判过值得接一句，这里交给人格决定怎么接
    let hookLine = '';
    try {
        const hook = globalThis.__qqbotHooks?.get?.(gid);
        if (hook && Date.now() - Number(hook.at ?? 0) < 5 * 60 * 1000) {
            const verb = hook.type === '卖关子' ? '卖关子' : hook.type === '炫耀' ? '炫耀' : '分享东西';
            hookLine = `【TA 刚才在${verb}】「${String(hook.content).slice(0, 40)}」——按你的人格设定，可以主动接一句（好奇追问 / 捧场 / 拆台，取决于你是什么类型）。`;
        }
    }
    catch {
        hookLine = '';
    }
    if (!matched) {
        if (speaker.name)
            lines.push(`【当前说话的人】${speaker.name}——档案里没有这个人，按陌生人对待。`);
        if (stateLine)
            lines.push(stateLine);
        if (hookLine)
            lines.push(hookLine);
        return lines.join('\n');
    }
    const name = String(matched.name ?? '').trim();
    const call = String(matched.addressing ?? '').trim() || name;
    const alias = speaker.name && speaker.name !== name ? `（${speaker.name}）` : '';
    const gender = String(matched.profile?.gender ?? '').trim();
    const ta = gender === '女' ? '她' : '他';
    const social = globalThis.__qqbotSocial;
    const relationship = social?.describeRelationship ? social.describeRelationship(matched) : '';
    const labels = social?.socialLabels ? social.socialLabels(social.socialOf(matched)) : undefined;
    const firstToday = isFirstMessageToday(gid, speaker.id);
    // 档案里勾了「每日首条必接」：今天第一次露面就必须接一句（不看亲疏）。
    // 但如果这条是在诉苦，就不套问候 / 硬接话，交给下面的「状况」提示按关心处理。
    const dailyFirst = firstToday && matched.dailyFirstReply === true;
    const venting = dailyFirst && detectVenting(lastMessageContent);
    const stickerOnly = isStickerOnly(lastMessageContent);
    const closeEnough = labels ? (labels.relationship.key === 'close' || labels.relationship.key === 'very_close') : affinityInfo(matched).value > 60;
    const greet = closeEnough && firstToday && !venting && !stickerOnly && (labels ? labels.attitude !== 'cold' && labels.attitude !== 'hostile' : true);
    lines.push(`【当前说话的人】${name}${alias}（就是下面档案里的这个人）`);
    lines.push(`- 称呼：${call}`);
    if (relationship)
        lines.push(`- 你和他的关系：${relationship}`);
    if (greet)
        lines.push('- 今天在本群第一次说话：用一句符合你们关系的问好开头（例如「早呀，今天怎么样」这种），再进入正题');
    if (dailyFirst && !venting && !stickerOnly) {
        lines.push(`- 【今日首条】${ta}今天在本群第一次露面，这条必须接一句，不能回 [SILENT]。`);
        if (isPlaceholderOnly(lastMessageContent))
            lines.push('  这条只有图片/视频/文件占位符、没有文字：别猜内容、也别描述，但要接一句（打个招呼、顺着上一句、或逗一句都行），短一点就好。「只有占位符就别回」那条对今天首条不适用。');
        else
            lines.push('  按你们现在的关系接，不用刻意热情；关系不熟就客气一点，但别因为不熟就不接。');
    }
    else if (dailyFirst && !venting && stickerOnly) {
        lines.push('- 【今日首条】这条只有表情包/表情：直接 [SILENT]，不用为了礼貌回一句。');
    }
    lines.push(`- 按${ta}的设定接话，别问已经知道的事；不要提「档案」「提示」「好感度」`);
    if (stateLine)
        lines.push(stateLine);
    if (hookLine)
        lines.push(hookLine);

    // 对方提到的其他人：也捞一下他们的记忆（最多 2 人 × 3 条，控制 token）
    try {
        const recentForOthers = globalThis.__qqbotRecentMessages?.get?.(gid) ?? [];
        const lastMsg = [...recentForOthers].reverse().find((m) => m && m.id === speaker.id);
        const text = String(lastMsg?.content ?? '');
        const others = list
            .filter((p) => p && p !== matched)
            .map((p) => ({ person: p, names: namesOfPerson(p) }))
            .filter(({ names }) => names.some((n) => n.length >= 2 && text.includes(n)))
            .slice(0, 2);
        const injected = new Set();
        const pushPersonMemories = (person) => {
            const whoName = String(person?.name ?? '').trim();
            if (!whoName || injected.has(whoName) || whoName === name)
                return;
            const mem = readPersonMemories(gid, namesOfPerson(person), 3);
            if (mem.length === 0)
                return;
            injected.add(whoName);
            lines.push(`【关于「${whoName}」我记得】`);
            for (const m of mem)
                lines.push(`- ${m.length > 100 ? `${m.slice(0, 100)}…` : m}`);
        };
        for (const { person } of others)
            pushPersonMemories(person);
        // 象信解析出的主语（「我弟」「她」这类代称）也能带出记忆
        const subj = globalThis.__qqbotSubjects?.get?.(gid);
        if (subj && Date.now() - Number(subj.at ?? 0) < 3 * 60 * 1000 && subj.name !== name) {
            const hit = list.find((p) => String(p?.name ?? '').trim() === String(subj.name).trim());
            if (hit)
                pushPersonMemories(hit);
        }
    }
    catch {
        // 别人记忆读失败不影响主流程
    }

    const memories = readPersonMemories(gid, namesOfPerson(matched));
    if (memories.length > 0) {
        lines.push(`【我记得的关于「${name}」的事】`);
        for (const m of memories)
            lines.push(`- ${m.length > 160 ? `${m.slice(0, 160)}…` : m}`);
        lines.push('这些是以前记下的长期记忆，可以直接用；不确定细节时再用 memory_search 查。');
    }

    // 事件追踪：TA 说过的事 / 最近的情绪（追问前先看情绪）
    try {
        const eventLine = globalThis.__qqbotEvents?.promptLine?.(gid, name);
        if (eventLine)
            lines.push(eventLine);
    }
    catch {
        // 事件读取失败不影响主流程
    }

    // 每群每 24 小时提醒一次档案维护
    try {
        const statePath = `${rosterProfileDir()}/qqbot-profile-review.json`;
        let state = {};
        try {
            state = JSON.parse(readFileSync(statePath, 'utf8'));
        }
        catch {
            state = {};
        }
        const last = Number(state[gid] ?? 0);
        if (Date.now() - last > 24 * 3600 * 1000) {
            state[gid] = Date.now();
            writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
            lines.push('【今天的档案维护】');
            lines.push('如果这轮对话或长期记忆里出现了档案没有的稳定信息（职业、爱好、关系、宠物、近况），');
            lines.push('调用 update_person_profile 补进对应的人；只写真实出现过的，别猜。补完自然带过。');
        }
    }
    catch {
        // 维护提示失败不影响对话
    }
    return lines.join('\n');
}
/* <<< dsh-qqbot-patch:people-roster-helper <<< */

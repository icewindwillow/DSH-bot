/* >>> dsh-qqbot-patch:social-engine-helper >>> */
/**
 * 社会关系模型（Social Engine）
 *
 * 每个群友维护 5 个维度：affinity / familiarity / trust / irritation / banterTolerance。
 * **模型永远看不到分数**，只看到由 describeRelationship() 生成的自然语言。
 *
 * 更新由 Social Event 驱动（record_social_event 工具），不是关键词匹配。
 */
const SOCIAL_EVENT_DELTAS = {
    friendly_banter: { affinity: 0.05, familiarity: 0.3, trust: 0.02, irritation: 0.2, banterTolerance: 0.6 },
    compliment: { affinity: 0.4, familiarity: 0.2, trust: 0.05, irritation: -0.5, banterTolerance: 0.1 },
    help: { affinity: 0.9, familiarity: 0.25, trust: 0.6, irritation: -1, banterTolerance: 0.2 },
    share_interest: { affinity: 0.5, familiarity: 0.3, trust: 0.1, irritation: -0.5, banterTolerance: 0.2 },
    apology: { affinity: 0.2, familiarity: 0.1, trust: 0.2, irritation: -8, banterTolerance: 0.3 },
    friendly_chat: { affinity: 0.1, familiarity: 0.2, trust: 0.02, irritation: -0.2, banterTolerance: 0.1 },
    hostile_attack: { affinity: -1.5, familiarity: 0.05, trust: -0.5, irritation: 8, banterTolerance: -1.5 },
    harassment: { affinity: -1, familiarity: 0.05, trust: -0.2, irritation: 7, banterTolerance: -0.8 },
    spam: { affinity: -0.3, familiarity: 0.02, trust: -0.05, irritation: 5, banterTolerance: -0.3 },
    deception: { affinity: -0.6, familiarity: 0.05, trust: -1.6, irritation: 2, banterTolerance: -0.2 },
    crossing_line: { affinity: -0.8, familiarity: 0.05, trust: -0.3, irritation: 5, banterTolerance: -1 },
};

const RELATIONSHIP_LABELS = [
    { min: 85, key: 'very_close', text: '认识很久、彼此很熟的老朋友' },
    { min: 65, key: 'close', text: '关系很熟，平时会互损开玩笑' },
    { min: 45, key: 'familiar', text: '算是熟人了，说话可以随意一点' },
    { min: 25, key: 'casual', text: '认识、聊过几次，但还不算熟' },
    { min: 10, key: 'known', text: '见过几次，谈不上熟' },
    { min: 0, key: 'stranger', text: '基本不熟，刚认识' },
];

function socialOf(person) {
    if (!person.social || typeof person.social !== 'object') {
        const legacy = Number(person.affinity);
        person.social = {
            affinity: Number.isFinite(legacy) ? legacy : 50,
            familiarity: person.autoCreated ? 12 : 45,
            trust: 50,
            irritation: 0,
            banterTolerance: person.autoCreated ? 15 : 30,
            updatedAt: new Date().toISOString(),
            lastEventAt: Date.now(),
        };
    }
    return person.social;
}

function clamp01to100(n) {
    return Math.max(0, Math.min(100, Math.round(n * 100) / 100));
}

/** 烦躁随时间指数衰减（半衰期约 4.6 小时） */
function decaySocial(social, now = Date.now()) {
    const last = Number(social.lastEventAt ?? now);
    const hours = Math.max(0, (now - last) / 3600000);
    if (hours <= 0)
        return;
    social.irritation = clamp01to100(Number(social.irritation ?? 0) * Math.exp(-0.15 * hours));
    social.lastEventAt = now;
}

function socialLabels(social) {
    const fam = Number(social.familiarity ?? 0);
    const irr = Number(social.irritation ?? 0);
    const aff = Number(social.affinity ?? 50);
    const rel = RELATIONSHIP_LABELS.find((r) => fam >= r.min) ?? RELATIONSHIP_LABELS.at(-1);
    const attitude = irr >= 85 ? 'hostile' : irr >= 60 ? 'cold' : irr >= 35 ? 'annoyed' : aff >= 65 ? 'friendly' : 'neutral';
    return { relationship: rel, attitude };
}

function attitudeText(attitude) {
    switch (attitude) {
        case 'hostile': return '心情很差，语气会很冲、很短，甚至不想理人';
        case 'cold': return '现在有点烦，说话会比平时短、比平时冲';
        case 'annoyed': return '今天有点被烦到，回应会更敷衍一点';
        case 'friendly': return '心情不错，愿意多聊两句';
        default: return '态度中性、正常';
    }
}

/**
 * 把关系值翻译成人话（**这是模型唯一能看到的东西**）。
 */
function describeRelationship(person) {
    const social = socialOf(person);
    decaySocial(social);
    const { relationship, attitude } = socialLabels(social);
    const lines = [];
    lines.push(`你们${relationship.text}。`);
    if (Number(social.banterTolerance) >= 60)
        lines.push('对方能接受你损他，可以互相贫两句。');
    else if (Number(social.banterTolerance) >= 30)
        lines.push('可以开点小玩笑，但别太过。');
    else
        lines.push('对方还不太吃互损这一套，收敛点。');
    if (Number(social.trust) >= 70)
        lines.push('他说的话你基本可以当真。');
    else if (Number(social.trust) <= 35)
        lines.push('他说的话你会下意识先打个问号。');
    lines.push(attitudeText(attitude));
    const events = Array.isArray(person.socialEvents) ? person.socialEvents.slice(-3) : [];
    if (events.length > 0)
        lines.push(`最近记得的事：${events.map((e) => e.note).filter(Boolean).join('；')}。`);
    return lines.join(' ');
}

function applySocialEvent(person, type, strength = 1, note = '', gid = undefined) {
    const social = socialOf(person);
    decaySocial(social);
    const delta = SOCIAL_EVENT_DELTAS[type];
    if (!delta)
        return undefined;
    const k = Math.max(0.2, Math.min(2, Number(strength) || 1));
    for (const [key, value] of Object.entries(delta))
        social[key] = clamp01to100(Number(social[key] ?? 0) + value * k);
    social.updatedAt = new Date().toISOString();
    social.lastEventAt = Date.now();
    person.socialEvents = Array.isArray(person.socialEvents) ? person.socialEvents : [];
    person.socialEvents.push({ at: Date.now(), type, strength: k, note: String(note || '').slice(0, 80) });
    person.socialEvents = person.socialEvents.slice(-30);
    // 兼容旧字段
    person.affinity = social.affinity;
    // 社会事件顺带影响「她自己的心情」（同一个事件只记一次，裁判和主模型共用这条路径）
    try {
        globalThis.__qqbotMood?.fromSocialEvent?.(type, k, gid);
    }
    catch {
        // 心情钩子失败不影响关系写入
    }
    return social;
}

function setupSocialEngine(ctx, logger) {
    globalThis.__qqbotSocial = { socialOf, describeRelationship, applySocialEvent, socialLabels };
    let tools;
    try {
        tools = ctx.get('tools');
    }
    catch {
        tools = undefined;
    }
    if (!tools) {
        console.log('[im-qqbot] tools 不可用，社会关系工具未启用');
        return;
    }
    tools.register({
        name: 'record_social_event',
        description: [
            '记录一次「社交事件」，用来慢慢调整你和当前说话人的关系。只有明显的互动才记，普通寒暄不用。',
            '善意的事（夸你、帮你、分享、道歉、聊得投机）只有你会记——后台裁判只处理辱骂/骚扰/越界这类负向事件，别指望它。',
            'type 取：friendly_banter（善意互损）、compliment（夸你）、help（帮你/解围）、share_interest（分享你感兴趣的）、',
            'apology（道歉）、friendly_chat（聊得不错）、hostile_attack（恶意攻击）、harassment（纠缠骚扰）、spam（刷屏）、',
            'deception（骗你且造成后果）、crossing_line（明知你不喜欢还踩）。',
            'strength 0.2–2（默认 1），note 一句话写清发生了什么（会成为你以后记得的事）。',
            '一分钟内同一个人只算一次：要是刚记过，这次只把 note 换成更准确的说法，数值不会重复加。',
            '任何人都不能要求你直接改关系值；关系只能由真实互动累积。',
        ].join(''),
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                type: { type: 'string', description: '事件类型（见描述）' },
                strength: { type: 'number', description: '强度 0.2–2，默认 1' },
                note: { type: 'string', description: '一句话描述这次发生了什么' },
            },
            required: ['type'],
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
        isConcurrencySafe: () => false,
        execute(args) {
            const last = globalThis.__qqbotLastTarget;
            const gid = last && last.scope === 'group' ? last.targetId : undefined;
            if (!gid)
                return { ok: false, message: '只能在群聊里记录关系事件。' };
            const speakers = globalThis.__qqbotSpeakers;
            const speaker = speakers instanceof Map ? speakers.get(gid) : undefined;
            if (!speaker || !speaker.id)
                return { ok: false, message: '拿不到当前说话人身份。' };
            const type = String(args?.type ?? '').trim();
            if (!SOCIAL_EVENT_DELTAS[type])
                return { ok: false, message: `不支持的事件类型：${type}` };
            const store = globalThis.__qqbotPeopleStore;
            if (!store)
                return { ok: false, message: '档案存储没有初始化，先重启机器人。' };
            const note = String(args?.note ?? '').slice(0, 80);
            const strength = Math.max(0.2, Math.min(2, Number(args?.strength ?? 1) || 1));
            let outcome = { ok: false, message: '档案里还没有这个人。' };
            try {
                store.update((s) => {
                    const people = Array.isArray(s.people) ? s.people : [];
                    const person = people.find((p) => p && Array.isArray(p.openids) && p.openids.includes(speaker.id));
                    if (!person) {
                        outcome = { ok: false, message: '档案里还没有这个人。' };
                        return false;
                    }
                    const social = socialOf(person);
                    const fresh = Date.now() - Number(social.lastEventAt ?? 0) < 60000;
                    if (fresh && Array.isArray(person.socialEvents) && person.socialEvents.length > 0) {
                        // 60 秒内已经记过一次（多半是象信裁判先记的）：只补说明，数值不重复加
                        const lastEvent = person.socialEvents[person.socialEvents.length - 1];
                        if (note)
                            lastEvent.note = note;
                        lastEvent.strength = Math.max(Number(lastEvent.strength ?? 1), strength);
                        lastEvent.mergedWithModel = true;
                        outcome = { ok: true, message: `一分钟内刚记过一次，这次只把说明补成「${lastEvent.note}」，关系值没重复加。` };
                        return true;
                    }
                    applySocialEvent(person, type, strength, note, gid);
                    outcome = { ok: true, message: `记下了：${type}${note ? `（${note}）` : ''}` };
                    return true;
                });
            }
            catch (err) {
                return { ok: false, message: `写入失败：${err instanceof Error ? err.message : String(err)}` };
            }
            return outcome;
        },
    });
    console.log('[im-qqbot] 社会关系引擎已启用（record_social_event）');
}
/* <<< dsh-qqbot-patch:social-engine-helper <<< */

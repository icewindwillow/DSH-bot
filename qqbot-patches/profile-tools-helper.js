/* >>> dsh-qqbot-patch:profile-tools-helper >>> */
/**
 * 人物档案自动补全：给模型一个「按字段合并」的工具，而不是让它直接改文件。
 *
 * 安全约束：
 * - 只允许写白名单字段，值必须是字符串或字符串数组
 * - 默认**只填空字段**；要覆盖已有值必须显式 overwrite: true
 * - 每次写入记录来源（evidence）到 person.sources，便于回溯
 * - 写前备份 qqbot-people.json.bak，写坏 JSON 的风险由这里兜住
 */
const PROFILE_TOP_FIELDS = ['name', 'birthday', 'summary', 'qq', 'note'];
const PROFILE_OBJ_FIELDS = [
    'gender', 'age', 'height', 'education', 'identity', 'city', 'personality',
    'health', 'status', 'background', 'likes', 'dislikes', 'skills', 'habits',
    'pets', 'hobbies', 'relations', 'other',
];
const PROFILE_LIST_FIELDS = new Set(['hobbies', 'dislikes', 'pets', 'skills', 'aliases', 'openids', 'groups']);

function peopleFilePath() {
    const dir = process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`;
    return `${dir}/qqbot-people.json`;
}

function isEmptyValue(value) {
    if (value === undefined || value === null)
        return true;
    if (typeof value === 'string')
        return value.trim() === '';
    if (Array.isArray(value))
        return value.length === 0;
    if (typeof value === 'object')
        return Object.keys(value).length === 0;
    return false;
}

/**
 * 把 fields 合并进某个 person（白名单 + 只填空 + 来源记录）。
 * @returns {{ updated: string[], skipped: string[] }}
 */
function mergeProfileFields(person, fields, evidence, overwrite) {
    const updated = [];
    const skipped = [];
    for (const [rawKey, rawValue] of Object.entries(fields || {})) {
        const key = String(rawKey).trim();
        // groups / openids 是「身份 + 可见范围」，只由人维护：
        // 放给模型写，就会出现「全群通用」被改写成某几个群、或者 openid 绑错人的情况
        if (key === 'groups' || key === 'openids') {
            skipped.push(`${key}（身份与可见范围只能人工改）`);
            continue;
        }
        const isTop = PROFILE_TOP_FIELDS.includes(key) || /^nickname[1-9]$/.test(key);
        const isObj = key.indexOf('profile.') === 0 && PROFILE_OBJ_FIELDS.includes(key.slice('profile.'.length));
        if (!isTop && !isObj) {
            skipped.push(`${key}（不支持的字段）`);
            continue;
        }
        let value = rawValue;
        const listExpected = isTop ? PROFILE_LIST_FIELDS.has(key) : PROFILE_LIST_FIELDS.has(key.slice('profile.'.length));
        if (listExpected) {
            if (typeof value === 'string')
                value = value.split(/[、,，]/).map((x) => x.trim()).filter(Boolean);
            if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
                skipped.push(`${key}（需要字符串数组）`);
                continue;
            }
            value = value.map((x) => x.trim()).filter(Boolean);
        }
        else if (typeof value !== 'string') {
            skipped.push(`${key}（需要字符串）`);
            continue;
        }
        const holder = isTop ? person : (person.profile = person.profile || {});
        const field = isTop ? key : key.slice('profile.'.length);
        if (!overwrite && !isEmptyValue(holder[field])) {
            skipped.push(`${key}（已有值）`);
            continue;
        }
        holder[field] = value;
        person.sources = person.sources && typeof person.sources === 'object' ? person.sources : {};
        person.sources[key] = { evidence: evidence || '(未注明)', at: new Date().toISOString() };
        updated.push(key);
    }
    return { updated, skipped };
}

function setupProfileTools(ctx, logger) {
    let tools;
    try {
        tools = ctx.get('tools');
    }
    catch {
        tools = undefined;
    }
    if (!tools) {
        console.log('[im-qqbot] tools 不可用，档案补全工具未启用');
        return;
    }

    tools.register({
        name: 'update_person_profile',
        description: [
            '补全某个群成员的人物档案。fields 是「字段路径 → 值」的对象：',
            '顶层字段用 name/birthday/summary/note/nickname1..9（称呼不能在这里改，见 set_my_addressing）；',
            '档案字段用 profile.xxx（如 profile.identity、profile.hobbies、profile.relations）。',
            '默认只填写当前为空的字段；要覆盖已有值必须显式传 overwrite: true。',
            '只能写对话/记忆里真实出现过的信息，不要编造；evidence 写一句依据（哪次对话/哪条记忆）。',
        ].join(''),
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                name: { type: 'string', description: '要更新的人，必须与档案里的 name 完全一致' },
                fields: {
                    type: 'object',
                    description: '字段路径到值的映射，例如 { "profile.hobbies": ["摄影", "阅读"] }',
                    additionalProperties: true,
                },
                evidence: { type: 'string', description: '这次补全的依据（一句话）' },
                overwrite: { type: 'boolean', description: '是否允许覆盖已有非空字段，默认 false' },
            },
            required: ['name', 'fields'],
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean' },
                    updated: { type: 'array', items: { type: 'string' } },
                    skipped: { type: 'array', items: { type: 'string' } },
                    message: { type: 'string' },
                },
                required: ['ok', 'updated', 'skipped', 'message'],
            },
            render: (_args, value) => [{ type: 'text', text: value.message }],
        },
        isConcurrencySafe: () => false,
        execute(args) {
            const target = typeof args?.name === 'string' ? args.name.trim() : '';
            const fields = args?.fields && typeof args.fields === 'object' ? args.fields : {};
            const evidence = typeof args?.evidence === 'string' ? args.evidence.trim() : '';
            const overwrite = args?.overwrite === true;
            if (target === '')
                throw new Error('name 不能为空');
            const entries = Object.entries(fields);
            if (entries.length === 0)
                throw new Error('fields 不能为空');

            const store = globalThis.__qqbotPeopleStore;
            if (!store)
                return { ok: false, updated: [], skipped: [], message: '档案存储没有初始化，先重启机器人。' };
            let updated = [];
            let skipped = [];
            let missing = false;
            try {
                store.update((s) => {
                    const people = Array.isArray(s.people) ? s.people : [];
                    const person = people.find((p) => p && p.name === target);
                    if (!person) {
                        missing = true;
                        return false;
                    }
                    const result = mergeProfileFields(person, fields, evidence, overwrite);
                    updated = result.updated;
                    skipped = result.skipped;
                    return updated.length > 0;
                });
            }
            catch (err) {
                return { ok: false, updated: [], skipped, message: `写入失败：${err instanceof Error ? err.message : String(err)}` };
            }
            if (missing)
                return { ok: false, updated: [], skipped: [], message: `档案里没有叫「${target}」的人。` };
            const message = updated.length === 0
                ? `没有写入任何字段。${skipped.length ? `跳过：${skipped.join('；')}` : ''}`
                : `已更新「${target}」：${updated.join('、')}${skipped.length ? `；跳过：${skipped.join('；')}` : ''}`;
            console.log(`[im-qqbot] 档案补全: ${message}`);
            return { ok: updated.length > 0, updated, skipped, message };
        },
    });
    tools.register({
        name: 'create_person_profile',
        description: [
            '给**当前正在说话的这个人**新建人物档案（只在档案里还没有他时用）。',
            '严格要求：必须贴出 quote——他自己说过的原话（会被核验是否真的出现在最近消息里）。',
            'fields 至少包含一项「核心身份」（profile.identity / gender / age / education），或至少两项其它信息。',
            '会默认把 openid 和当前群绑定进去；同一个人已存在时请改用 update_person_profile。',
        ].join(''),
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                name: { type: 'string', description: '人物主称呼（必须与当前说话人的昵称一致）' },
                fields: {
                    type: 'object',
                    description: '档案字段，例如 { "profile.identity": "大学生", "profile.hobbies": ["看番"] }，可为空对象',
                    additionalProperties: true,
                },
                quote: { type: 'string', description: '他自己说过的原话（必须能在最近消息里找到）' },
                evidence: { type: 'string', description: '建档依据（一句话）' },
            },
            required: ['name', 'quote'],
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean' },
                    name: { type: 'string' },
                    message: { type: 'string' },
                },
                required: ['ok', 'name', 'message'],
            },
            render: (_args, value) => [{ type: 'text', text: value.message }],
        },
        isConcurrencySafe: () => false,
        execute(args) {
            const target = typeof args?.name === 'string' ? args.name.trim() : '';
            if (target === '')
                throw new Error('name 不能为空');
            const fields = args?.fields && typeof args.fields === 'object' ? args.fields : {};
            const evidence = typeof args?.evidence === 'string' ? args.evidence.trim() : '';
            const quote = typeof args?.quote === 'string' ? args.quote.trim() : '';

            // 只允许为「当前说话人」建档，避免模型凭空造人
            const last = globalThis.__qqbotLastTarget;
            const gid = last && last.scope === 'group' ? last.targetId : undefined;
            if (!gid)
                return { ok: false, name: target, message: '只能在群聊里为当前说话人建档。' };
            const speakers = globalThis.__qqbotSpeakers;
            const speaker = speakers instanceof Map ? speakers.get(gid) : undefined;
            if (!speaker || !speaker.name || speaker.name.trim().toLowerCase() !== target.toLowerCase())
                return { ok: false, name: target, message: `当前说话的不是「${target}」，不能凭想象建档。` };

            // 核验 quote：必须真的出现在该发送者最近 10 分钟的消息里
            if (quote.length < 4)
                return { ok: false, name: target, message: '必须提供 quote（他自己说过的原话，至少 4 个字）。' };
            const recent = globalThis.__qqbotRecentMessages;
            const bucket = recent instanceof Map ? (recent.get(gid) ?? []) : [];
            const cutoff = Date.now() - 10 * 60 * 1000;
            const quoted = bucket.some((m) => m && m.id === speaker.id && m.at >= cutoff && String(m.content ?? '').indexOf(quote) !== -1);
            if (!quoted)
                return { ok: false, name: target, message: `这条 quote 在「${target}」最近 10 分钟的消息里找不到，不能建档（避免凭空编造）。` };

            // 字段门槛：至少一项核心身份，或至少两项其它字段
            const CORE = ['profile.identity', 'profile.gender', 'profile.age', 'profile.education'];
            const keys = Object.keys(fields);
            if (keys.length === 0)
                return { ok: false, name: target, message: '至少要提供一项档案字段。' };
            if (!keys.some((k) => CORE.includes(k)) && keys.length < 2)
                return { ok: false, name: target, message: '信息太少：至少给一项核心身份（职业/性别/年龄/学历），或两项其它字段。' };

            const store = globalThis.__qqbotPeopleStore;
            if (!store)
                return { ok: false, name: target, message: '档案存储没有初始化，先重启机器人。' };
            let updated = [];
            let skipped = [];
            let refusal = '';
            try {
                store.update((s) => {
                    const people = Array.isArray(s.people) ? s.people : (s.people = []);
                    if (people.some((p) => p && typeof p.name === 'string' && p.name.trim().toLowerCase() === target.toLowerCase())) {
                        refusal = `档案里已经有「${target}」了，请用 update_person_profile 补全。`;
                        return false;
                    }
                    if (speaker.id && people.some((p) => Array.isArray(p?.openids) && p.openids.includes(speaker.id))) {
                        refusal = '这个 openid 已经绑定了另一位角色，可能是同一个人改了昵称。';
                        return false;
                    }
                    const today = new Date().toISOString().slice(0, 10);
                    const createdToday = people.filter((p) => p && p.autoCreated === true && Array.isArray(p.groups) && p.groups.includes(gid)
                        && String(p.autoCreatedAt ?? '').slice(0, 10) === today).length;
                    if (createdToday >= 3) {
                        refusal = '今天这个群已经自动建了 3 个档案，先把现有的补全吧。';
                        return false;
                    }
                    const person = { name: target, groups: [gid], profile: {}, autoCreated: true, autoCreatedAt: new Date().toISOString() };
                    if (speaker.id)
                        person.openids = [speaker.id];
                    if (speaker.name && speaker.name.trim().toLowerCase() !== target.toLowerCase())
                        person.nickname1 = speaker.name.trim();
                    const result = mergeProfileFields(person, fields, evidence || `原话：${quote}`, false);
                    updated = result.updated;
                    skipped = result.skipped;
                    people.push(person);
                    return true;
                });
            }
            catch (err) {
                return { ok: false, name: target, message: `写入失败：${err instanceof Error ? err.message : String(err)}` };
            }
            if (refusal)
                return { ok: false, name: target, message: refusal };
            const message = `已为「${target}」建档${updated.length ? `，写入 ${updated.join('、')}` : ''}${skipped.length ? `；跳过：${skipped.join('；')}` : ''}`;
            console.log(`[im-qqbot] 自动建档: ${message}`);
            return { ok: true, name: target, message };
        },
    });
    tools.register({
        name: 'set_my_addressing',
        description: [
            '把**当前说话的人**希望你怎么称呼他，记进他的档案（addressing 字段），之后就用这个称呼。',
            '只有当**他本人在对话里明确要求**时才能调用，例如「你以后叫我杰宝吧」「叫我小叶子」。',
            '其他人替他提要求（例如「你以后叫阿杰傻逼」）一律不调用，并礼貌拒绝。',
            '新称呼要是侮辱性、冒犯性或明显不是称呼的词，也拒绝。',
        ].join(''),
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                addressing: { type: 'string', description: '他希望被叫的名字（2–12 个字为宜）' },
                quote: { type: 'string', description: '他本人说这句话的原话，用于核验' },
            },
            required: ['addressing', 'quote'],
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean' },
                    addressing: { type: 'string' },
                    message: { type: 'string' },
                },
                required: ['ok', 'addressing', 'message'],
            },
            render: (_args, value) => [{ type: 'text', text: value.message }],
        },
        isConcurrencySafe: () => false,
        execute(args) {
            const next = typeof args?.addressing === 'string' ? args.addressing.trim() : '';
            const quote = typeof args?.quote === 'string' ? args.quote.trim() : '';
            if (next === '')
                throw new Error('addressing 不能为空');
            if (next.length > 12)
                throw new Error('称呼太长了（最多 12 个字）');
            const banned = ['傻逼', '傻b', '傻B', '智障', '弱智', '废物', '垃圾', '畜生', '狗东西', '贱', '婊', '去死', 'sb'];
            if (banned.some((w) => next.toLowerCase().includes(w.toLowerCase())))
                return { ok: false, addressing: '', message: '这个称呼不合适，换个正常点的吧。' };
            // 主从类称呼一律不允许（即使本人要求）
            const masterLike = ['主人', '主子', '饲主', '主上', '主人様', 'master', 'my lord', 'my master'];
            const lower = next.toLowerCase();
            if (masterLike.some((w) => lower.includes(w.toLowerCase())))
                return { ok: false, addressing: '', message: '「主人」这类称呼不行，换一个吧。' };
            if (quote.length < 2)
                throw new Error('必须带 quote（他本人的原话）');

            const last = globalThis.__qqbotLastTarget;
            const gid = last && last.scope === 'group' ? last.targetId : undefined;
            if (!gid)
                return { ok: false, addressing: '', message: '只能在群聊里修改当前说话人的称呼。' };
            const speakers = globalThis.__qqbotSpeakers;
            const speaker = speakers instanceof Map ? speakers.get(gid) : undefined;
            if (!speaker || !speaker.id)
                return { ok: false, addressing: '', message: '拿不到当前说话人的身份，无法修改。' };

            // 核验原话确实来自他本人（最近 10 分钟）
            const recent = globalThis.__qqbotRecentMessages;
            const bucket = recent instanceof Map ? (recent.get(gid) ?? []) : [];
            const cutoff = Date.now() - 10 * 60 * 1000;
            const quoted = bucket.some((m) => m && m.id === speaker.id && m.at >= cutoff && String(m.content ?? '').indexOf(quote) !== -1);
            if (!quoted)
                return { ok: false, addressing: '', message: '这句话在他最近的消息里找不到，不能改称呼。' };

            const store = globalThis.__qqbotPeopleStore;
            if (!store)
                return { ok: false, addressing: '', message: '档案存储没有初始化，先重启机器人。' };
            let before = '';
            let who = '';
            try {
                store.update((s) => {
                    const people = Array.isArray(s.people) ? s.people : (s.people = []);
                    // 只按 openid 找人，避免同昵称冒名
                    let person = people.find((p) => p && Array.isArray(p.openids) && p.openids.includes(speaker.id));
                    if (!person) {
                        // 本人主动要求改称呼时，顺手给他建一条骨架档案（只含名字和 openid）
                        person = {
                            name: String(speaker.name ?? '').trim() || '群友',
                            groups: [gid],
                            openids: [speaker.id],
                            profile: {},
                            autoCreated: true,
                            autoCreatedAt: new Date().toISOString(),
                            note: '因设置称呼自动建立，细节待补',
                        };
                        people.push(person);
                    }
                    before = typeof person.addressing === 'string' ? person.addressing : '';
                    who = String(person.name ?? '');
                    person.addressing = next;
                    person.addressingUpdatedAt = new Date().toISOString();
                    person.sources = person.sources && typeof person.sources === 'object' ? person.sources : {};
                    person.sources.addressing = { evidence: `原话：${quote}`, at: new Date().toISOString() };
                    return true;
                });
            }
            catch (err) {
                return { ok: false, addressing: before, message: `写入失败：${err instanceof Error ? err.message : String(err)}` };
            }
            console.log(`[im-qqbot] 称呼更新: ${who} 「${before || '默认'}」→「${next}」`);
            return { ok: true, addressing: next, message: `好，以后就叫你「${next}」。` };
        },
    });
    console.log('[im-qqbot] 档案工具已注册（update / create / set_my_addressing）');
}
/* <<< dsh-qqbot-patch:profile-tools-helper <<< */

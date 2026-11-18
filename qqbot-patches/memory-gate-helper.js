/* >>> dsh-qqbot-patch:memory-gate-helper >>> */
/**
 * 长期记忆门控（象信驱动）
 *
 * 每条群消息 → 象信一次问 8 个属性（含「分享/购物/体验」）→ 按阈值决定
 *      → 直接写 ~/.dsh/memory/ltm.db（scope = qq:group:<gid>）
 * 不再做关键词预筛：象信调用量视为免费，宁可多判一条，也不漏掉「我今天…」这类事实。
 *
 * 与模型侧 memory_write 的关系：模型侧已禁用（ltm-write-guard），写入统一走这里。
 */
const MEMORY_GATE_TYPES = ['身份', '偏好', '关系', '经历', '约定', '雷区', '梗', '近况', '其他'];

function memoryGateDir() {
    const os = process.getBuiltinModule?.('node:os');
    return `${os?.homedir?.() ?? process.env.HOME ?? ''}/.dsh/memory/ltm.db`;
}

function memoryGatePeoplePool(gid) {
    const fs = process.getBuiltinModule?.('node:fs');
    const os = process.getBuiltinModule?.('node:os');
    try {
        const store = JSON.parse(fs.readFileSync(`${os.homedir()}/.dsh/profiles/qqbot/qqbot-people.json`, 'utf8'));
        const people = Array.isArray(store.people) ? store.people : [];
        // 先给本群成员（含全局角色），不够再回落到全体
        const inGroup = people.filter((p) => !gid
            || !Array.isArray(p?.groups) || p.groups.length === 0 || p.groups.includes(gid));
        return inGroup.length > 0 ? inGroup : people;
    }
    catch {
        return [];
    }
}

/** 一个人的全部称呼（档案名、群称呼、昵称、别名），用于把象信的选择还原成档案里的人 */
function memoryGatePersonAliases(person) {
    return [...new Set([person?.name, person?.addressing, person?.nickname1, person?.nickname2,
        person?.nickname3, person?.nickname4, ...(Array.isArray(person?.aliases) ? person.aliases : [])]
        .filter((name) => typeof name === 'string' && name.trim() !== '')
        .map((name) => name.trim()))];
}

/** 选项名 + 描述：把「杰哥/阿杰」这类群称呼写进描述，象信才能对上「Dark jack」 */
function memoryGatePeopleChoices(gid) {
    const choices = [];
    for (const person of memoryGatePeoplePool(gid)) {
        const name = String(person?.name ?? '').trim();
        if (name === '')
            continue;
        const aliases = memoryGatePersonAliases(person).filter((alias) => alias !== name);
        choices.push([name, aliases.length > 0
            ? `说的是「${name}」（群称呼/别名：${aliases.slice(0, 4).join('、')}）`
            : `说的是「${name}」`]);
        if (choices.length >= 20)
            break;
    }
    return choices;
}

/** 把象信选中的档案名换成档案称呼（Dark jack → 杰哥），记忆标题统一 */
function memoryGateLabelFor(choice, gid) {
    for (const person of memoryGatePeoplePool(gid))
        if (memoryGatePersonAliases(person).includes(choice))
            return String(person?.addressing || person?.name || choice).trim();
    return choice;
}

/** 消息里是否点名了别的群成员（用来避免把「别人的事」记到说话人头上） */
function memoryGateMentionsOther(gid, senderId, content) {
    for (const person of memoryGatePeoplePool(gid)) {
        if (Array.isArray(person?.openids) && person.openids.includes(senderId))
            continue;
        if (memoryGatePersonAliases(person).some((alias) => alias.length >= 2 && content.includes(alias)))
            return true;
    }
    return false;
}

/** 按 openid 找档案里的人（用来把群昵称换成档案称呼，记忆才能按人检索） */
function memoryGatePersonOf(openid) {
    const fs = process.getBuiltinModule?.('node:fs');
    const os = process.getBuiltinModule?.('node:os');
    if (!openid || !fs || !os)
        return undefined;
    try {
        const dir = process.env.QQBOT_PROFILE_DIR ?? `${os.homedir()}/.dsh/profiles/qqbot`;
        const store = JSON.parse(fs.readFileSync(`${dir}/qqbot-people.json`, 'utf8'));
        return (store.people ?? []).find((p) => p && Array.isArray(p.openids) && p.openids.includes(openid));
    }
    catch {
        return undefined;
    }
}

async function xiangxinMemoryJudge(state, gid) {
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
        state,
        questions: {
            store: { type: 'noul', instructions: '`消息` 是否包含值得长期记住的关于某人的稳定信息？（寒暄、玩笑、重复内容不算）' },
            share: { type: 'noul', instructions: '`消息` 是否在分享自己买的东西、收藏、吃喝体验、想买的东西，或对某类东西的明确偏好？' },
            event: { type: 'noul', instructions: '`消息` 是否包含一个以后可以复述的具体事件（谁对谁做了什么、发生了什么），即使这句话本身是请求、抱怨或情绪表达？只算具体事件，不算纯情绪、泛泛感慨或日常寒暄。' },
            eventSubject: {
                type: 'choice',
                instructions: '如果 `消息` 描述了一个事件，这件事最应该记在谁的名下？`消息` 里的「我/我姐」等称呼要按 `说话人档案` 还原成具体的人（例如「我姐」就是档案.家人.姐姐）。被谈论、被波及的人也算。',
                criteria: (() => {
                    const c = { 说话人自己: '说话人自己的事', 机器人: '机器人小易的事' };
                    for (const [n, description] of memoryGatePeopleChoices(gid))
                        c[n] = description;
                    c.其他人 = '群里另一个没点名的人';
                    c.无法判断 = '看不出在说谁';
                    return c;
                })(),
            },
            type: {
                type: 'choice',
                instructions: '`消息` 里值得记住的信息属于哪一类？',
                criteria: {
                    身份: '姓名、职业、年龄、学历、所在地',
                    偏好: '喜欢/讨厌的东西、口味、兴趣、收藏、购物偏好',
                    关系: '和别人的关系（家人、朋友、同事）',
                    经历: '发生过的事、经历、背景、买东西/旅行/品尝体验',
                    约定: '约定好的时间、计划、承诺',
                    雷区: '明确不想被提的事、禁忌',
                    梗: '群内梗、外号、黑话',
                    近况: '当前状态（身体、心情、工作）',
                    其他: '以上都不是',
                },
            },
            subject: {
                type: 'choice',
                instructions: '这条信息说的是谁？',
                criteria: (() => {
                    const c = { 说话人自己: '说话人自己的事', 机器人: '机器人小易的事' };
                    for (const [n, description] of memoryGatePeopleChoices(gid))
                        c[n] = description;
                    c.其他人 = '群里另一个没点名的人';
                    c.无法判断 = '看不出在说谁';
                    return c;
                })(),
            },
            durability: {
                type: 'choice',
                instructions: '这条信息能记多久？',
                criteria: { 长期: '基本不会变', 中期: '几周到几个月', 一次性: '只在当次对话有效' },
            },
            importance: { type: 'score', instructions: '对以后聊天有多重要？', criteria: ['可有可无', '有点用', '有用', '很重要'] },
            sensitive: { type: 'noul', instructions: '`消息` 是否包含密码、住址、电话、身份证、银行卡等敏感信息？' },
            conflict: { type: 'noul', instructions: '`消息` 是否和 `已知记忆` 矛盾或重复？' },
        },
    };
    try {
        const res = await fetch('https://api.xiangxinai.cn/v1/systemone', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok)
            return undefined;
        return (await res.json())?.answers;
    }
    catch {
        return undefined;
    }
}

function setupMemoryGate(ctx, config, logger) {
    if ((process.env.QQBOT_MEMORY_GATE ?? 'on') === 'off')
        return;
    const fs = process.getBuiltinModule?.('node:fs');
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    if (!fs || !sqlite)
        return;
    const dbPath = memoryGateDir();
    let active = 0;
    const maxActive = Math.max(1, Number(process.env.QQBOT_MEMORY_GATE_MAX ?? 12));

    const lookupKnown = (gid, speaker) => {
        try {
            const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
            const rows = db.prepare('select text from memories where scope = ? order by updated_at desc limit 5')
                .all(`qq:group:${gid}`);
            db.close();
            return rows.map((r) => String(r.text)).join('；').slice(0, 500);
        }
        catch {
            return '';
        }
    };

    const consider = async (mCtx) => {
        if (active >= maxActive)
            return;
        active++;
        try {
            const msg = mCtx?.message;
            if (!msg || msg.kind !== 'group' || !msg.groupOpenid || !msg.senderId)
                return;
            const gid = msg.groupOpenid;
            const speaker = String(msg.senderName ?? '').trim();
            const knownPerson = memoryGatePersonOf(msg.senderId);
            // 群昵称可能是「Reflection Eternal」，档案里叫「Dark jack / 杰哥」；
            // 记忆按档案称呼写，后面按人检索才找得到。
            const speakerLabel = String(knownPerson?.addressing || knownPerson?.name || speaker).trim();
            // 只判「当前这条」：去掉引用块、历史块和发送者前缀，避免把别人说的话记到他头上
            let content = String(msg.content ?? '');
            content = content.replace(/\[Chat history begins\][\s\S]*?\[Chat history ends\]/g, '');
            content = content.replace(/\[Quoted message begins\][\s\S]*?\[Quoted message ends\]/g, '');
            if (content.includes('[Current message]'))
                content = content.split('[Current message]').pop();
            content = content.replace(/^\s*\[[^\]]*\([0-9A-F]+\)\]\s*/, '').trim().slice(0, 500);
            if (!speaker || content.length < 4)
                return;
            // 纯占位符，没有文字可记（QQ 系统表情的实际格式是【表情: 名字】）
            if (/^(?:\s*(?:【表情[：:][^】]*】|\[(?:图片|视频|文件|表情|动画表情|表情包)[^\]]*\])\s*)+$/.test(content))
                return;
            // 同一个人的最近几条发言：只给象信做主体消歧，避免「杨师傅…」把说话人自己的事判成别人
            const recentOwn = (globalThis.__qqbotRecentMessages?.get?.(gid) ?? [])
                .filter((m) => String(m.id ?? '') === String(msg.senderId ?? ''))
                .map((m) => String(m.content ?? '')
                    .replace(/\[(图片|视频|文件|表情)[^\]]*\]/g, '')
                    .replace(/^\s*\[[^\]]*\([0-9A-F]+\)\]\s*/, '')
                    .trim())
                .filter(Boolean)
                .slice(-4);
            const previousOwn = recentOwn.slice(0, -1).join('\n').slice(0, 300);
            const known = lookupKnown(gid, speaker);
            // 把说话人档案里的家人关系交给象信，才能把「我姐」还原成具体的人，
            // 否则「把我姐发的照片撤回」这类事件主体会判成「无法判断」而丢失。
            const relations = knownPerson?.profile?.relations;
            const speakerProfile = { 称呼: speakerLabel };
            if (relations && typeof relations === 'object' && Object.keys(relations).length > 0)
                speakerProfile.家人 = relations;
            const answers = await xiangxinMemoryJudge({ 说话人: speakerLabel, 说话人档案: speakerProfile, 最近发言: previousOwn || '（无）', 已知记忆: known || '（无）', 消息: content }, gid);
            if (!answers)
                return;
            const store = Number(answers.store?.noul ?? 0);
            const share = Number(answers.share?.noul ?? 0) >= 0.55;
            const sensitive = Number(answers.sensitive?.noul ?? 0);
            const conflict = Number(answers.conflict?.noul ?? 0);
            const importance = Number(answers.importance?.score ?? 0);
            const type0 = String(answers.type?.choice ?? '其他');
            const subject0 = String(answers.subject?.choice ?? '无法判断');
            // 近况（自己/指定的人都算）即使 store 不高也存下来，带日期
            const isStatus = type0 === '近况' && subject0 !== '无法判断';
            // 近况：即使象信认为「不值得长期记」，也按日期存一条（她要记得你昨天心情不好）
            // 分享自己买的东西 / 收藏 / 吃喝体验：象信常判「不值得长期记」，但用户明确想留；
            // 分享信号高时放宽 store/importance，仍然拦敏感、重复。
            const baseStoreOk = isStatus
                ? true
                : share
                    ? store >= 0.1 && importance >= 0.6
                    : store >= 0.5 && importance >= 0.8;
            // 事件兜底：请求/情绪类消息里夹带的具体事件（谁对谁做了什么）常被判成
            // 「其他」且 store 很低，只留下情绪碎片、丢掉前因。主体能落到具体的人时，
            // 按「经历」补记一条。
            const event = Number(answers.event?.noul ?? 0);
            const eventSubject0 = String(answers.eventSubject?.choice ?? '无法判断');
            const eventOk = !baseStoreOk
                && event >= 0.6
                && store >= 0.1
                && importance >= 0.8
                && eventSubject0 !== '无法判断'
                && eventSubject0 !== '其他人';
            const storeOk = baseStoreOk || eventOk;
            if ((process.env.QQBOT_MEMORY_GATE_DEBUG ?? '') === '1')
                console.log(`[im-qqbot] 记忆判定: ${speakerLabel} store=${store.toFixed(2)} share=${share ? 1 : 0} imp=${importance.toFixed(2)} event=${event.toFixed(2)} eventSubject=${eventSubject0} type=${type0} subject=${subject0} dur=${String(answers.durability?.choice ?? '?')} sens=${sensitive.toFixed(2)} conflict=${conflict.toFixed(2)} → ${eventOk ? '写(事件)' : storeOk ? '写' : '跳过'}`);
            if (!storeOk || sensitive > 0.3)
                return;
            if (conflict >= 0.85)
                return;

            const type = eventOk ? '经历' : String(answers.type?.choice ?? '其他');
            if (!MEMORY_GATE_TYPES.includes(type))
                return;
            const durability = eventOk ? '中期' : String(answers.durability?.choice ?? '中期');
            const date = new Date().toISOString().slice(0, 10);
            // 主体消歧：subject 是独立的 8 分类，消息里提到「别人/他/杨师傅」时常判成「其他人」；
            // eventSubject 专门要求把「我」还原成说话人，更可靠。两者都落空时按下文兜底。
            const concrete = (value) => value !== '' && value !== '说话人自己' && value !== '机器人'
                && value !== '其他人' && value !== '无法判断';
            const picked = concrete(subject0)
                ? subject0
                : concrete(eventSubject0)
                    ? eventSubject0
                    : '';
            let who;
            if (concrete(picked)) {
                who = memoryGateLabelFor(picked, gid);
            }
            else {
                // 主体落到「其他人/无法判断」：说话人最近在讲自己的事就归回说话人；
                // 只有消息明确点名了别的群成员才保留「其他人」，避免把别人的事记错人
                const mentionsSelf = /我|咱/.test(`${content}\n${previousOwn}`);
                const otherNamed = memoryGateMentionsOther(gid, msg.senderId, content);
                who = mentionsSelf || !otherNamed ? speakerLabel : '其他人';
            }
            const prefix = durability === '一次性' || type === '近况' ? `${date} ` : '';
            const text = `${prefix}[${type}] ${who}：${content}`.slice(0, 180);
            // 只把「主体」写进 tags：把说话人也写进去会让别人的记忆被误当成他的
            const tags = [type, who, 'memory-gate', durability, ...(share ? ['分享'] : []), `imp:${importance.toFixed(1)}`];
            if (prefix)
                tags.push(date);

            const db = new sqlite.DatabaseSync(dbPath);
            try {
                const now = Date.now();
                db.prepare('insert into memories (text, tags, scope, pinned, created_at, updated_at, last_confirmed_at, revision) values (?, ?, ?, 0, ?, ?, ?, 1)')
                    .run(text, tags.join(' '), `qq:group:${gid}`, now, now, now);
                console.log(`[im-qqbot] 记忆入库(${type}/${durability}): ${text.slice(0, 40)}…`);
            }
            finally {
                db.close();
            }
        }
        catch (err) {
            console.log(`[im-qqbot] 记忆门控失败: ${err instanceof Error ? err.message : String(err)}`);
        }
        finally {
            active--;
        }
    };

    /** 图片归档后补一条「经历」：图片正文在纯占位符里，消息门控拿不到，只能由媒体库带过来 */
    const recordMedia = async (info) => {
        try {
            const gid = String(info?.gid ?? '');
            const senderId = String(info?.senderId ?? '');
            const senderName = String(info?.senderName ?? '').trim();
            const mediaId = Number(info?.mediaId ?? 0);
            if (gid === '' || senderName === '')
                return;
            const caption = String(info?.caption ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
            if (caption.length < 4 || caption === '图片' || caption === '表情包')
                return;
            const knownPerson = memoryGatePersonOf(senderId);
            const label = String(knownPerson?.addressing || knownPerson?.name || senderName).trim();
            const marker = mediaId > 0 ? `media:${mediaId}` : '';
            const db = new sqlite.DatabaseSync(dbPath);
            try {
                if (marker !== '' && db.prepare('select 1 as hit from memories where scope = ? and tags like ? limit 1')
                    .get(`qq:group:${gid}`, `% ${marker} %`))
                    return;
                const at = Number(info?.createdAt ?? 0) || Date.now();
                const date = new Date(at).toISOString().slice(0, 10);
                const text = `[经历] ${label}：发了一张图——${caption}`.slice(0, 180);
                const tags = ['经历', label, 'memory-gate', '媒体', ...(marker !== '' ? [marker] : []),
                    '长期', 'imp:1.8', date].join(' ');
                const now = Date.now();
                db.prepare('insert into memories (text, tags, scope, pinned, created_at, updated_at, last_confirmed_at, revision) values (?, ?, ?, 0, ?, ?, ?, 1)')
                    .run(text, tags, `qq:group:${gid}`, at, now, now);
                console.log(`[im-qqbot] 媒体记忆入库: ${text.slice(0, 40)}…`);
            }
            finally {
                db.close();
            }
        }
        catch (err) {
            console.log(`[im-qqbot] 媒体记忆失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    };

    globalThis.__qqbotMemoryGate = { consider, recordMedia };
    console.log(`[im-qqbot] 记忆门控已启用（象信，库 ${dbPath}）`);
}
/* <<< dsh-qqbot-patch:memory-gate-helper <<< */

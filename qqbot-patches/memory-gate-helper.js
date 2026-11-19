/* >>> dsh-qqbot-patch:memory-gate-helper >>> */
/**
 * 长期记忆门控（象信驱动）
 *
 * 每条群消息 → 象信一次问 8 个属性（含「分享/购物/体验」）→ 按阈值决定
 *      → 直接写 ~/.dsh/memory/ltm.db（scope = qq:group:<gid>）
 * 纯反应和占位符提前跳过，含有实际内容的消息交给象信判断。
 *
 * 与模型侧 memory_write 的关系：模型侧已禁用（ltm-write-guard），写入统一走这里。
 */
const MEMORY_GATE_TYPES = ['身份', '偏好', '关系', '经历', '约定', '雷区', '梗', '近况', '其他'];

function memoryGateDir() {
    const os = process.getBuiltinModule?.('node:os');
    return process.env.QQBOT_MEMORY_DB ?? `${process.env.DSH_HOME ?? `${os?.homedir?.() ?? process.env.HOME ?? ''}/.dsh`}/memory/ltm.db`;
}

function memoryGateProfileDir() {
    const os = process.getBuiltinModule?.('node:os');
    return process.env.QQBOT_PROFILE_DIR ?? `${process.env.DSH_HOME ?? `${os?.homedir?.() ?? process.env.HOME ?? ''}/.dsh`}/profiles/${process.env.QQBOT_PROFILE_NAME ?? 'qqbot'}`;
}

/** 判定审计日志：记录每条消息为什么写/为什么跳过，方便回溯漏记 */


function memoryGatePeopleNames(gid) {
    const fs = process.getBuiltinModule?.('node:fs');
    try {
        const store = readProfileDocument(memoryGateProfileDir(), 'people');
        const people = Array.isArray(store.people) ? store.people : [];
        // 先给本群成员（含全局角色），不够再回落到全体；最多 20 个选项
        const inGroup = people.filter((p) => !gid
            || !Array.isArray(p?.groups) || p.groups.length === 0 || p.groups.includes(gid));
        const pool = inGroup.length > 0 ? inGroup : people;
        return pool.map((p) => p?.name).filter((n) => typeof n === 'string' && n.trim()).slice(0, 20);
    }
    catch {
        return [];
    }
}

/**
 * 本群档案里记过的作品（标题 → 载体）：用来给记忆补 work/medium 标签。
 * 只读、失败静默：记忆门控不能因为档案读不到就停摆。
 */
function memoryGateKnownWorks(gid) {
    const fs = process.getBuiltinModule?.('node:fs');
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    if (!fs || !sqlite)
        return [];
    try {
        const store = readProfileDocument(memoryGateProfileDir(), 'people');
        const people = (Array.isArray(store.people) ? store.people : []).filter((p) => !gid
            || !Array.isArray(p?.groups) || p.groups.length === 0 || p.groups.includes(gid));
        const keys = new Set();
        for (const person of people) {
            const ids = (Array.isArray(person?.openids) ? person.openids : []).map((id) => String(id).trim()).filter(Boolean).sort();
            if (ids.length > 0)
                keys.add(`id:${ids[0]}`);
            // 名字键要把所有叫法都放进去：作品库早期版本按主名存过 `name:`，
            // 后来改过名或只记了昵称的人，光比 person.name 就对不上了。
            const names = [person?.name, person?.addressing];
            for (const field of Object.keys(person ?? {})) {
                if (/^nickname\d+$/.test(field))
                    names.push(person[field]);
            }
            if (Array.isArray(person?.aliases))
                names.push(...person.aliases);
            for (const item of names) {
                const name = String(item ?? '').trim().toLowerCase();
                if (name !== '')
                    keys.add(`name:${name}`);
            }
        }
        if (keys.size === 0)
            return [];
        const db = new sqlite.DatabaseSync(memoryGateDir(), { readOnly: true });
        try {
            let rows;
            try {
                rows = db.prepare('select person_key, title, medium from person_interests').all();
            }
            catch {
                // 档案表还没迁移到带载体列的版本时，先只按作品名打标签
                rows = db.prepare('select person_key, title from person_interests').all();
            }
            const seen = new Set();
            const works = [];
            for (const row of rows) {
                if (!keys.has(String(row.person_key ?? '')))
                    continue;
                const title = String(row.title ?? '').trim();
                const key = title.toLowerCase();
                if (title === '' || seen.has(key))
                    continue;
                seen.add(key);
                works.push({ title, medium: String(row.medium ?? '').trim() });
            }
            return works;
        }
        finally {
            db.close();
        }
    }
    catch {
        return [];
    }
}

/** 消息里提到的本群已知作品（取最长命中，避免短名误撞） */
function memoryGateWorkHit(gid, content) {
    const text = String(content ?? '');
    if (text === '')
        return undefined;
    return memoryGateKnownWorks(gid)
        .filter((work) => work.title.length >= 2 && text.includes(work.title))
        .sort((a, b) => b.title.length - a.title.length)[0];
}

/** 象信的 eventObject 选项 → 具体人名；没有另一方时返回 '' */
function memoryGateObjectName(choice, speakerLabel) {
    const value = String(choice ?? '无').trim();
    if (value === '说话人自己')
        return speakerLabel;
    if (value === '机器人')
        return '小易';
    if (value === '' || value === '无' || value === '其他人' || value === '无法判断')
        return '';
    return value;
}

/** 按 openid 找档案里的人（用来把群昵称换成档案称呼，记忆才能按人检索） */
function memoryGatePersonOf(openid) {
    const fs = process.getBuiltinModule?.('node:fs');
    if (!openid || !fs)
        return undefined;
    try {
        const store = readProfileDocument(memoryGateProfileDir(), 'people');
        return (store.people ?? []).find((p) => p && Array.isArray(p.openids) && p.openids.includes(openid));
    }
    catch {
        return undefined;
    }
}

/**
 * 档案称呼 → openid：给记忆/事件补 subject-id、object-id。
 * 只认档案里的名字/称呼/昵称/别名，认不出就留空，不猜。
 */
function memoryGateOpenidOf(name, gid) {
    const fs = process.getBuiltinModule?.('node:fs');
    const key = String(name ?? '').trim().replace(/\s+/g, '_');
    if (key === '' || !fs)
        return '';
    try {
        const store = readProfileDocument(memoryGateProfileDir(), 'people');
        const people = (store.people ?? []).filter((p) => p
            && (!gid || !Array.isArray(p.groups) || p.groups.length === 0 || p.groups.includes(gid)));
        for (const person of people) {
            const names = [person.name, person.addressing];
            for (const field of Object.keys(person)) {
                if (field.startsWith('nickname'))
                    names.push(person[field]);
            }
            if (Array.isArray(person.aliases))
                names.push(...person.aliases);
            if (!names.some((n) => typeof n === 'string' && n.trim().replace(/\s+/g, '_') === key))
                continue;
            const openid = (Array.isArray(person.openids) ? person.openids : [])
                .map((id) => String(id).trim())
                .find((id) => id !== '');
            if (openid)
                return openid;
        }
        return '';
    }
    catch {
        return '';
    }
}

/** 极短的成就播报：「达成」「通关了」「过了」这类要结合上一条才看得懂，不能按长度直接丢 */
function looksLikeShortAchievement(text) {
    return /^(?:达成|通关|通关了|过了|首杀|白金|全成就|毕业了?|挑战成功)[！!。…~\s]*$/.test(String(text ?? '').trim());
}

/** 从消息上下文里取本地图片路径（与媒体归档共用同一套字段） */
function memoryGateImagePaths(mCtx) {
    const msg = mCtx?.message;
    const paths = [];
    if (typeof msg?.imagePath === 'string' && msg.imagePath.startsWith('/'))
        paths.push(msg.imagePath);
    for (const path of (Array.isArray(msg?.imagePaths) ? msg.imagePaths : [])) {
        if (typeof path === 'string' && path.startsWith('/'))
            paths.push(path);
    }
    for (const match of String(msg?.content ?? '').matchAll(/-\s*Image:\s*(\/[^\s]+)/g))
        paths.push(match[1]);
    for (const attachment of (Array.isArray(msg?.attachments) ? msg.attachments : [])) {
        const local = attachment?.localPath ?? attachment?.path ?? attachment?.filePath;
        if (typeof local === 'string' && local.startsWith('/'))
            paths.push(local);
    }
    for (const file of (Array.isArray(mCtx?.state?.downloadedFiles) ? mCtx.state.downloadedFiles : [])) {
        const local = file?.localPath;
        if (typeof local === 'string' && local.startsWith('/'))
            paths.push(local);
    }
    return [...new Set(paths)];
}

/** 视觉摘要缓存：同一张图重复判到时不再打视觉；1 小时或 200 张后淘汰 */
const MEMORY_GATE_VISION_CACHE = new Map();
const MEMORY_GATE_VISION_TTL_MS = 3600_000;
const MEMORY_GATE_VISION_MAX = 200;

/** 给极短成就播报补一句上文（跳过纯图片/表情占位），让记忆不只剩「达成」两个字 */
function memoryGateShortContext(gid, currentContent) {
    try {
        const bucket = globalThis.__qqbotRecentMessages?.get?.(gid) ?? [];
        const current = String(currentContent ?? '').trim();
        for (let i = bucket.length - 1; i >= 0 && i >= bucket.length - 6; i -= 1) {
            const item = bucket[i];
            const text = String(item?.content ?? '').replace(/\s+/g, ' ').trim();
            if (text === '' || text === current)
                continue;
            if (/^(?:\[图片\]|\[视频\]|\[文件\]|\[表情[^\]]*\]|【表情[：:][^】]*】)$/.test(text))
                continue;
            return `（上文：${String(item?.name ?? '群友').trim() || '群友'}：${text.slice(0, 60)}）`;
        }
        return '';
    }
    catch {
        return '';
    }
}

/** 最近几条群消息（不含当前这条）：只用来理解「他/她/我姐」这类代称，不当作事实 */
function memoryGateRecentDialog(gid) {
    try {
        const bucket = globalThis.__qqbotRecentMessages?.get?.(gid) ?? [];
        return bucket.slice(-4, -1)
            .map((m) => `${String(m?.name ?? '').trim()}：${String(m?.content ?? '').replace(/\s+/g, ' ').slice(0, 80)}`)
            .filter((line) => line.trim() !== '：')
            .join('\n') || '（无）';
    }
    catch {
        return '（无）';
    }
}

function memoryGateMessageText(msg) {
    let content = String(msg.content ?? '');
    content = content.replace(/\[Chat history begins\][\s\S]*?\[Chat history ends\]/g, '');
    content = content.replace(/\[Quoted message begins\][\s\S]*?\[Quoted message ends\]/g, '');
    if (content.includes('[Current message]'))
        content = content.split('[Current message]').pop();
    content = content.replace(/^\s*\[[^\]]*\([0-9A-F]+\)\]\s*/, '').trim().slice(0, 500);
    return content;
}

function memoryGateIsBareReaction(content) {
    const reaction = content.replace(/<faceType=[^>]*>|【表情[：:][^】]*】|[\s，。！!？?、~～…]/g, '');
    return /^(?:[哈呵嘿嘻]{2,}|h{3,})$/i.test(reaction);
}

async function requestMemoryJudgment(state, questions) {
    const fs = process.getBuiltinModule?.('node:fs');
    const os = process.getBuiltinModule?.('node:os');
    let key = process.env.XIANGXIN_API_KEY ?? '';
    if (key === '' && fs && os) {
        try {
            const yaml = fs.readFileSync(`${process.env.DSH_HOME ?? `${os.homedir()}/.dsh`}/.credentials.yaml`, 'utf8');
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
    const body = { model: 'xiangxin-latest', state, questions };
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
function xiangxinMemoryJudge(state, gid, trackingQuestions) {
    const questions = {
            store: { type: 'noul', instructions: '`消息` 是否包含值得长期记住的关于某人的稳定信息？（寒暄、玩笑、重复内容不算）' },
            attitude: { type: 'choice', instructions: '判断说话人本人在当前 `消息` 明确表达的态度。必须有明确对象：消息点名的事物、做法或具体事件，或由事项证据唯一指向的事件。笑声、表情、反讽、转述、无对象的生气、顺口附和都选无。一次评价只能选当次态度，只有明确的一贯或泛化偏好才选稳定偏好。', criteria: {
                稳定喜欢: '明确持久或泛化地喜欢某事物或做法',
                稳定反感: '明确持久或泛化地排斥某事物或做法',
                当次正向: '肯定或喜欢这一次明确的体验或事情',
                当次负向: '明确因这一次的经过、做法或结果而不满、生气',
                无: '缺乏本人态度、明确对象或可靠证据',
            } },
            share: { type: 'noul', instructions: '`消息` 是否在分享自己买的东西、收藏、吃喝体验、想买的东西，或对某类东西的明确偏好？' },
            event: { type: 'noul', instructions: '`消息` 是否包含一个以后可以复述的具体事件（谁对谁做了什么、发生了什么），即使这句话本身是请求、抱怨或情绪表达？只算具体事件，不算纯情绪、泛泛感慨或日常寒暄。' },
            // 成就播报：游戏/现实里的通关、达成、挑战完成。只说「达成」「过了」这类
            // 承接上文的短句也要算，靠 `最近对话` 理解它接的是哪件事；吐槽难度不算。
            achievement: { type: 'noul', instructions: '`消息`（必要时结合 `最近对话`）是否在报告自己达成某个游戏或现实里的成就、通关、完成挑战？只说「达成」「过了」「通关了」这类承接上文的话也算；吐槽难度、说别人通关、纯提问不算。' },
            // 元讨论：群里在聊机器人/模型/记忆/代码本身，不是群友自己的生活。
            // 存成经历/近况会让记忆里全是开发噪音，真正的生活事实反而被挤掉。
            meta: { type: 'noul', instructions: '`消息` 主要是在讨论机器人、模型、记忆、代码、部署、人格设定等系统本身，而不是在说群友自己的生活、经历、安排或感受？' },
            // 经历 vs 攻略：游戏机制、配装、打法、职业常识不是「谁的经历」。
            // 不分开的话，「两个暗夜 T 怎么转火」会被记成说话人的亲身经历。
            experience: {
                type: 'choice',
                instructions: '`消息` 是在说说话人自己的亲身经历/进度，还是在讲游戏机制、打法、配装、职业常识等通用知识？',
                criteria: {
                    亲身经历: '自己做过、遇到、达成、正在经历的事',
                    机制攻略: '游戏机制、打法、配装、职业常识等通用知识，不是在讲自己的经历',
                    无法判断: '看不出',
                },
            },
            // 群体共识/客观定义：说话人在澄清或纠正一个可能被误解的客观事实、
            // 概念定义、称谓口径（「X 不是 Y，是 Z」「这个其实是官方版本」「别再搞错了」）。
            // 这类消息往往 store 低（不是谁的个人信息）、又被判成「机制攻略」，
            // 但恰恰是全群以后都会复用的知识，漏记会导致机器人下次还按旧说法答错。
            consensus: {
                type: 'noul',
                instructions: '`消息` 是否在给出一个供全群复用的客观事实、概念定义或纠正既有误解（例如「X 不是 Y，是 Z」「这其实是官方版本不是私服」「以后别搞错了」）？只算对事物本身的澄清/定义，不算个人经历、情绪、玩笑、玩笑式的重复强调。',
            },
            eventSubject: {
                type: 'choice',
                instructions: '如果 `消息` 描述了一个事件，这件事最应该记在谁的名下？`消息` 里的「我/我姐」等称呼要按 `说话人档案` 还原成具体的人（例如「我姐」就是档案.家人.姐姐）。如果说话人自己是当事人（我…、给我…、我弟/我妈…这类以说话人为参照的家人），记在说话人自己名下；只有旁观转述别人的事才记在别人名下。',
                criteria: (() => {
                    const c = { 说话人自己: '说话人是当事人或经历者（含「我弟/我妈」这类家人）', 机器人: '机器人小易的事' };
                    for (const n of memoryGatePeopleNames(gid))
                        c[n] = `说的是「${n}」`;
                    c.其他人 = '群里另一个没点名的人';
                    c.无法判断 = '看不出在说谁';
                    return c;
                })(),
            },
            eventObject: {
                type: 'choice',
                instructions: '如果 `消息` 里的事件还涉及另一个具体的人（谁给谁、谁和谁），另一方是谁？只算真正参与事件的人；泛指的「大家/别人」不算。「他/她/对方/这个人」等代词务必结合 `最近对话` 里点过名的人还原成具体人名（例如上一句是「风月和我婚前…」，这句「他家里人」就是风月）；`说话人档案` 里的「我弟/我姐」等称呼也按档案还原。只有最近对话和档案都确实无法确定时，才选「无法判断」。',
                criteria: (() => {
                    const c = { 无: '没有另一个具体的人', 说话人自己: '另一方是说话人自己', 机器人: '另一方是机器人小易' };
                    for (const n of memoryGatePeopleNames(gid))
                        c[n] = `另一方是「${n}」`;
                    c.其他人 = '群里另一个没点名的人';
                    c.无法判断 = '看不出另一方是谁';
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
                instructions: '这条信息说的是谁？如果说话人自己是经历者（我…、给我…、我弟/我妈…），选「说话人自己」；只是谈论别人时选那个人。',
                criteria: (() => {
                    const c = { 说话人自己: '说话人是经历者（含「我弟/我妈」这类家人）', 机器人: '机器人小易的事' };
                    for (const n of memoryGatePeopleNames(gid))
                        c[n] = `说的是「${n}」`;
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
            // 作品载体：书 / 电影 / 剧 / 动画 / 漫画不能混。消息里说了才算，名字本身看不出就选「说不清」。
            workMedium: {
                type: 'choice',
                instructions: '`消息` 里提到的作品（书、电影、剧、动画、漫画、游戏、音乐等）是什么载体？只有消息明确说「电影」「小说」「剧」或上下文能直接确定时才选；只知道作品名、看不出载体的选「说不清」。',
                criteria: {
                    无: '没有提到作品',
                    电影: '院线片、网络电影、影片',
                    剧集: '电视剧、网剧、连续剧',
                    动画: '动画电影、番剧、动漫',
                    小说: '书、小说、原著、电子书',
                    漫画: '漫画',
                    游戏: '电子游戏、桌游',
                    音乐: '歌曲、专辑',
                    舞台剧: '话剧、音乐剧、舞台剧',
                    综艺: '综艺节目',
                    纪录片: '纪录片',
                    说不清: '提到了作品，但看不出是什么载体',
                },
            },
            // 状态层：只判「当前状态」的变化，用来跟随「前几天生病、现在好了」。
            // 长期身份/偏好不在这里判（走 type）。
            stateChange: {
                type: 'choice',
                instructions: '`消息` 是否在说某人「当前状态」的变化（身体、情绪、工作学习、睡眠、所在地、关系、短期计划）？`最近对话` 只用来理解「他/她/我姐」指谁，判断仍以 `消息` 为准。',
                criteria: {
                    无: '没有提到当前状态',
                    开始: '新出现了一个状态，或比之前更严重',
                    持续: '状态还在继续、再次确认',
                    结束: '状态已经结束、好了、不再如此',
                },
            },
            stateSlot: {
                type: 'choice',
                instructions: '如果 `消息` 提到了当前状态，属于哪一类？',
                criteria: {
                    健康: '生病、受伤、体检、身体不舒服',
                    情绪: '心情、压力、焦虑、开心或难过',
                    工作学习: '加班、考试、项目、找工作',
                    睡眠: '失眠、熬夜、补觉',
                    所在地: '出差、回老家、搬家、旅行中',
                    关系: '和某人的关系变化（在一起/分手/和好/闹掰）',
                    短期计划: '这几天要做的事、行程',
                    其他: '以上都不是',
                },
            },
            stateSubject: {
                type: 'choice',
                instructions: '`消息` 里的当前状态是谁的？「我/我姐」等称呼要按 `说话人档案` 还原成具体的人；`最近对话` 可用来理解代称。',
                criteria: (() => {
                    const c = { 说话人自己: '说话人自己的状态', 机器人: '机器人小易的状态' };
                    for (const n of memoryGatePeopleNames(gid))
                        c[n] = `说的是「${n}」的状态`;
                    c.其他人 = '群里另一个没点名的人';
                    c.无法判断 = '看不出是谁的状态';
                    return c;
                })(),
            },
            stateCertainty: {
                type: 'score',
                instructions: '`消息` 说的这个状态变化有多确定？（开玩笑/夸张的要低分）',
                criteria: ['像玩笑或夸张', '不太确定', '大概是', '明确在说'],
            },
            ...trackingQuestions,
    };
    return requestMemoryJudgment(state, questions);
}

function setupMemoryGate(ctx, config, logger) {
    if ((process.env.QQBOT_MEMORY_GATE ?? 'on') === 'off')
        return;
    const fs = process.getBuiltinModule?.('node:fs');
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    if (!fs || !sqlite)
        return;
    const dbPath = memoryGateDir();
    // 判定审计：跳过原因、分数、请求失败都留痕。否则「这条为什么没记住」
    // 只能靠会话重放猜（2026-11-15 杰哥成就漏记就吃了这个亏）。
    const audit = (entry) => {
        try { appendQqbotRecord(memoryGateProfileDir(), 'memory-gate', { t: new Date().toISOString(), ...entry }); }
        catch { /* 审计失败不影响门控 */ }
    };
    let active = 0;
    const maxActive = Math.max(1, Number(process.env.QQBOT_MEMORY_GATE_MAX ?? 12));
    // 视觉摘要：只给「纯图 / 图 + 很短文字」用，并发最多 2，失败静默回落成纯占位符
    let visionActive = 0;
    const describeImageOnce = async (imagePath) => {
        const cached = MEMORY_GATE_VISION_CACHE.get(imagePath);
        if (cached && Date.now() - cached.at < MEMORY_GATE_VISION_TTL_MS)
            return cached.what;
        const describe = globalThis.__qqbotVision?.describe;
        if (typeof describe !== 'function' || visionActive >= 2)
            return '';
        visionActive++;
        try {
            const result = await describe(imagePath);
            const what = String(result?.what ?? '').trim().slice(0, 80);
            if (what !== '') {
                MEMORY_GATE_VISION_CACHE.set(imagePath, { what, at: Date.now() });
                while (MEMORY_GATE_VISION_CACHE.size > MEMORY_GATE_VISION_MAX)
                    MEMORY_GATE_VISION_CACHE.delete(MEMORY_GATE_VISION_CACHE.keys().next().value);
            }
            return what;
        }
        catch {
            return '';
        }
        finally {
            visionActive--;
        }
    };

    const lookupKnown = (gid, speakerTag) => {
        try {
            const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
            try {
                // 先找「跟这个说话人有关」的条目（他说的 / 说他的），再回落到本群最近记忆
                if (speakerTag) {
                    const rows = db.prepare(`select text from memories where scope = ? and instr(' ' || tags || ' ', ' archived ') = 0 and (instr(' ' || tags || ' ', ' subject:' || ? || ' ') > 0 or instr(' ' || tags || ' ', ' speaker:' || ? || ' ') > 0) order by updated_at desc limit 5`)
                        .all(`qq:group:${gid}`, speakerTag, speakerTag);
                    if (rows.length > 0)
                        return rows.map((r) => String(r.text)).join('；').slice(0, 500);
                }
                const rows = db.prepare("select text from memories where scope = ? and instr(' ' || tags || ' ', ' archived ') = 0 order by updated_at desc limit 5")
                    .all(`qq:group:${gid}`);
                return rows.map((r) => String(r.text)).join('；').slice(0, 500);
            }
            finally {
                db.close();
            }
        }
        catch {
            return '';
        }
    };

    /** 标签里不能有空格：人名空格换成下划线，供 subject:/speaker: 检索 */
    const tagName = (value) => String(value ?? '').trim().replace(/\s+/g, '_');

    /** 一次性记忆的生命周期：超过 14 天清掉（连同向量；FTS 由 vector-helper 对账清孤儿）。 */
    const pruneOnce = () => {
        const d = new Date();
        const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        if (globalThis.__qqbotMemoryPruneDay === today)
            return;
        globalThis.__qqbotMemoryPruneDay = today;
        const cutoff = Date.now() - 14 * 86400000;
        try {
            const db = new sqlite.DatabaseSync(dbPath, { timeout: 5000 });
            try {
                const ids = db.prepare("select id from memories where created_at < ? and instr(' ' || tags || ' ', ' 一次性 ') > 0")
                    .all(cutoff)
                    .map((row) => Number(row.id));
                if (ids.length === 0)
                    return;
                let dropVector;
                try {
                    dropVector = db.prepare('delete from memory_vectors where memory_id = ?');
                }
                catch {
                    dropVector = undefined;
                }
                const dropMemory = db.prepare('delete from memories where id = ?');
                db.exec('begin');
                try {
                    for (const id of ids) {
                        dropVector?.run(id);
                        dropMemory.run(id);
                    }
                    db.exec('commit');
                }
                catch (err) {
                    try { db.exec('rollback'); } catch { /* 忽略 */ }
                    throw err;
                }
                console.log(`[im-qqbot] 记忆清理: -${ids.length} 条过期一次性记忆`);
            }
            finally {
                db.close();
            }
        }
        catch (err) {
            console.log(`[im-qqbot] 记忆清理失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    };

    const consider = async (mCtx) => {
        pruneOnce();
        if (active >= maxActive) {
            const msg = mCtx?.message;
            if (msg?.kind === 'group' && msg.groupOpenid && msg.senderId)
                audit({ gid: msg.groupOpenid, speakerId: msg.senderId,
                    messageUid: String(msg.messageId ?? msg.msgId ?? ''), reason: 'at_capacity' });
            return;
        }
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
            // 状态事件按消息去重：同一条消息重复判到（重试/补判）不会重复累加
            const messageUid = String(msg.messageId ?? msg.msgId ?? '').trim();
            // 只判「当前这条」：去掉引用块、历史块和发送者前缀，避免把别人说的话记到他头上
            let content = memoryGateMessageText(msg);
            const recentDialog = memoryGateRecentDialog(gid);
            // 「达成」「过了」这类极短播报本身没有信息量，但它是上一件事的收尾：
            // 按长度直接丢会让整件事在压缩后蒸发，所以放进去让象信结合上文判断。
            const shortAchievement = looksLikeShortAchievement(content);
            if (!speaker) {
                audit({ gid, reason: 'no_speaker', msg: content.slice(0, 80) });
                return;
            }
            if (memoryGateIsBareReaction(content)) {
                audit({ gid, speakerId: msg.senderId, messageUid, reason: 'bare_reaction', decision: 'skip' });
                return;
            }
            const tracking = globalThis.__qqbotEvents?.prepare?.(msg, content);
            const short = content.length < 4 && !shortAchievement;
            if (short && !tracking?.attitudeOptions?.size) {
                audit({ gid, speaker: speakerLabel, speakerId: msg.senderId, reason: 'too_short', msg: content.slice(0, 80) });
                return;
            }
            // 图片没有文字说明时，先看一眼图再判：截图/照片本身可能就是一条经历
            // （「达成」的成就截图就是这么漏的）。表情包不送视觉。
            const imagePaths = memoryGateImagePaths(mCtx);
            const visibleText = content
                .replace(/-\s*Image:\s*\/[^\s]+/g, '')
                .replace(/【表情[：:][^】]*】|\[(?:图片|视频|文件|表情|动画表情|表情包)[^\]]*\]/g, '')
                .trim();
            const imageOnly = imagePaths.length > 0
                && visibleText.length <= 12
                && /\[图片[^\]]*\]|-\s*Image:\s*\//.test(content);
            let visionNote = '';
            if (imageOnly) {
                visionNote = await describeImageOnce(imagePaths[0]);
                if (visionNote !== '')
                    content = `${content} （图片内容：${visionNote}）`.slice(0, 500);
            }
            // 纯占位符，没有文字可记（QQ 系统表情的实际格式是【表情: 名字】）
            if (/^(?:\s*(?:【表情[：:][^】]*】|\[(?:图片|视频|文件|表情|动画表情|表情包)[^\]]*\])\s*)+$/.test(content)) {
                audit({ gid, speaker: speakerLabel, speakerId: msg.senderId, reason: imageOnly ? 'vision_failed' : 'placeholder', msg: content.slice(0, 80) });
                return;
            }
            const known = lookupKnown(gid, tagName(speakerLabel));
            // 把说话人档案里的家人关系交给象信，才能把「我姐」还原成具体的人，
            // 否则「把我姐发的照片撤回」这类事件主体会判成「无法判断」而丢失。
            const relations = knownPerson?.profile?.relations;
            const speakerProfile = { 称呼: speakerLabel };
            if (relations && typeof relations === 'object' && Object.keys(relations).length > 0)
                speakerProfile.家人 = relations;
            const answers = await xiangxinMemoryJudge({
                说话人: speakerLabel,
                说话人档案: speakerProfile,
                已知记忆: known || '（无）',
                最近对话: recentDialog,
                消息: content,
                ...tracking?.state,
            }, gid, tracking?.questions);
            if (!answers) {
                audit({ gid, speaker: speakerLabel, speakerId: msg.senderId, messageUid, reason: 'judge_failed',
                    tracking: tracking ? { decision: 'judge_failed' } : undefined });
                return;
            }
            const trackingResult = tracking
                ? await globalThis.__qqbotEvents?.observe?.(tracking, answers, recentDialog)
                : undefined;
            const outcome = trackingResult?.closedEventId && trackingResult.outcomeKind
                ? { id: trackingResult.closedEventId, title: trackingResult.title, kind: trackingResult.outcomeKind,
                    other: trackingResult.other, otherId: trackingResult.otherId } : undefined;
            const attitude = answers.attitude?.choice;
            const explicitAttitude = Number(answers.attitude?.confidence ?? 0) >= 0.65
                && ['稳定喜欢', '稳定反感', '当次正向', '当次负向'].includes(attitude)
                && Number(answers.sensitive?.noul ?? 0) <= 0.3 && Number(answers.meta?.noul ?? 0) < 0.6
                && answers.experience?.choice !== '机制攻略';
            const attitudeEvent = explicitAttitude && Number(answers.attitude_event?.confidence ?? 0) >= 0.65
                ? tracking?.attitudeOptions?.get(answers.attitude_event?.choice) : undefined;
            if (short && !outcome && !attitudeEvent) {
                audit({ gid, speaker: speakerLabel, speakerId: msg.senderId, messageUid,
                    reason: 'too_short', tracking: trackingResult });
                return;
            }
            const store = Number(answers.store?.noul ?? 0);
            const share = Number(answers.share?.noul ?? 0) >= 0.55;
            const sensitive = Number(answers.sensitive?.noul ?? 0);
            const conflict = Number(answers.conflict?.noul ?? 0);
            const importance = Number(answers.importance?.score ?? 0);
            const type0 = String(answers.type?.choice ?? '其他');
            const rawSubject0 = String(answers.subject?.choice ?? '无法判断');
            // 主体纠偏：「小易今天怎么抽风了」这类话，象信容易把主体判成「机器人」，
            // 记忆就挂到小易名下，按说话人检索永远找不回来。说话人不是小易自己时，
            // 主体回落到说话人本人，另打 about:小易 保留「这条在说小易」这层含义。
            const aboutBot = rawSubject0 === '机器人';
            const subject0 = aboutBot ? '说话人自己' : rawSubject0;
            // 开发讨论不算这个人的生活：只在经历/近况上拦，约定/偏好/雷区仍然照存。
            const metaScore = Number(answers.meta?.noul ?? 0);
            const metaStrong = metaScore >= 0.6;
            // 类型层面只拦经历/近况；事件、成就、状态不看类型，meta 高就一律不写——
            // 否则「聊记忆系统」被判成「其他」时会从事件兜底绕回去。
            const metaNoise = metaStrong && (type0 === '经历' || type0 === '近况');
            // 机制/攻略不是谁的经历：强制按「其他」存，主体记成「其他人」，
            // 不进事件流、不算成就，也不当成说话人的近况。
            const experience0 = String(answers.experience?.choice ?? '无法判断');
            const knowledgeOnly = experience0 === '机制攻略';
            // 近况（自己/指定的人都算）即使 store 不高也存下来，带日期
            const attitudeOk = explicitAttitude && (!short || Boolean(attitudeEvent));
            const stableAttitude = attitudeOk && (attitude === '稳定喜欢' || attitude === '稳定反感');
            const isStatus = !knowledgeOnly && !attitudeOk && type0 === '近况' && subject0 !== '无法判断';
            // 近况：即使象信认为「不值得长期记」，也按日期存一条（她要记得你昨天心情不好）
            // 分享自己买的东西 / 收藏 / 吃喝体验：象信常判「不值得长期记」，但用户明确想留；
            // 分享信号高时放宽 store/importance，仍然拦敏感、重复。
            const baseStoreOk = !metaNoise && (isStatus
                ? true
                : share
                    ? store >= 0.1 && importance >= 0.6
                    : store >= 0.5 && importance >= 0.8);
            // 事件兜底：请求/情绪类消息里夹带的具体事件（谁对谁做了什么）常被判成
            // 「其他」且 store 很低，只留下情绪碎片、丢掉前因。主体能落到具体的人时，
            // 按「经历」补记一条。
            const event = Number(answers.event?.noul ?? 0);
            const rawEventSubject0 = String(answers.eventSubject?.choice ?? '无法判断');
            const eventSubjectBot = rawEventSubject0 === '机器人';
            const eventSubject0 = eventSubjectBot ? '说话人自己' : rawEventSubject0;
            // 成就播报：确认是「自己通关/达成」后，不看 store 分数直接按「经历」落库，
            // 并进事件流；否则「截图 + 达成」这种消息永远进不了长期记忆。
            const achievementScore = Number(answers.achievement?.noul ?? 0);
            const achievement = achievementScore >= 0.6;
            let achievementSubject = subject0;
            if (achievement && achievementSubject === '无法判断' && shortAchievement)
                achievementSubject = '说话人自己';
            const achievementOk = !metaStrong
                && !knowledgeOnly
                && achievement
                && achievementSubject !== '无法判断'
                && achievementSubject !== '其他人';
            const eventOk = !metaStrong
                && !knowledgeOnly
                && !baseStoreOk
                && event >= 0.6
                && store >= 0.1
                && importance >= 0.8
                && eventSubject0 !== '无法判断'
                && eventSubject0 !== '其他人';
            // 群体共识/客观定义通道：象信判出「这条在给全群一个可复用的定义或纠错」时，
            // 放宽 store 门槛（实测「魔兽无限不是私服」store 仅 0.36/0.45，被当噪音丢了）。
            // 但不全放开：importance 仍要求够高，避免把「这个不是这样」的随口纠正全写进来。
            // 这是 V 字纠错类消息，主语不是某个人，按「其他」落库并打「共识」标签。
            const consensusScore = Number(answers.consensus?.noul ?? 0);
            const consensusOk = !metaStrong
                && consensusScore >= 0.6
                && store >= 0.1
                && importance >= 1.0;
            const storeOk = Boolean(outcome || attitudeOk || baseStoreOk || eventOk || achievementOk || consensusOk);
            if ((process.env.QQBOT_MEMORY_GATE_DEBUG ?? '') === '1')
                console.log(`[im-qqbot] 记忆判定: ${speakerLabel} store=${store.toFixed(2)} share=${share ? 1 : 0} imp=${importance.toFixed(2)} event=${event.toFixed(2)} eventSubject=${eventSubject0} ach=${achievementScore.toFixed(2)} consensus=${consensusScore.toFixed(2)} meta=${metaScore.toFixed(2)} exp=${experience0} type=${type0} subject=${subject0}${aboutBot ? '(about:小易)' : ''} dur=${String(answers.durability?.choice ?? '?')} sens=${sensitive.toFixed(2)} conflict=${conflict.toFixed(2)} → ${achievementOk ? '写(成就)' : eventOk ? '写(事件)' : consensusOk ? '写(共识)' : storeOk ? (knowledgeOnly ? '写(知识)' : '写') : '跳过'}`);
            if (sensitive > 0.3) {
                audit({ gid, speaker: speakerLabel, speakerId: msg.senderId, reason: 'sensitive', msg: '[敏感]', len: content.length, messageUid, tracking: trackingResult });
                return;
            }
            // 状态事件独立于「值不值得长期记」：哪怕这条只值一个碎片，
            // 「我发烧了 / 我好了」也要进状态层，否则跟随不了病情变化。
            const stateChange = String(answers.stateChange?.choice ?? '无');
            const stateSlot = String(answers.stateSlot?.choice ?? '其他');
            const stateSubject0 = String(answers.stateSubject?.choice ?? '无法判断');
            const stateCertainty = Number(answers.stateCertainty?.score ?? 0);
            const stateOp = stateChange === '开始' ? 'start' : stateChange === '持续' ? 'continue' : stateChange === '结束' ? 'end' : '';
            let stateSubject = stateSubject0;
            if (stateSubject === '无法判断' || stateSubject === '其他人')
                stateSubject = subject0;
            const stateOk = !metaStrong
                && !knowledgeOnly
                && (!attitudeOk || stateSlot !== '情绪')
                && stateOp !== ''
                && stateSlot !== '其他'
                && stateSubject !== '无法判断'
                && stateSubject !== '其他人'
                && stateCertainty >= 1;
            if (stateOk && (process.env.QQBOT_MEMORY_GATE_DEBUG ?? '') === '1')
                console.log(`[im-qqbot] 状态判定: ${stateSubject} ${stateSlot} ${stateChange} cert=${stateCertainty.toFixed(2)}`);
            // 事件的「另一方」：只在这条消息真的会写事件时才算（状态事件不需要对象）。
            const eventKind = outcome || (attitudeOk && !stableAttitude) ? 'episode' : metaStrong || knowledgeOnly || stableAttitude
                ? ''
                : achievementOk || eventOk ? 'episode' : type0 === '约定' ? 'commitment' : type0 === '关系' ? 'relation' : '';
            const eventOp = eventKind === 'episode' ? 'occur' : eventKind === 'commitment' ? 'declare' : eventKind === 'relation' ? 'change' : '';
            const eventSubject = outcome || attitudeOk ? '说话人自己' : achievementOk ? achievementSubject : eventOk ? eventSubject0 : subject0;
            const eventSubjectName = eventSubject === '说话人自己'
                ? speakerLabel
                : eventSubject === '机器人' ? '小易' : eventSubject;
            const eventWillWrite = (!stateOk || outcome)
                && eventKind !== ''
                && eventSubject !== '无法判断'
                && eventSubject !== '其他人'
                && eventSubjectName.trim() !== '';
            const eventObjectName = eventWillWrite
                ? outcome?.other || memoryGateObjectName(answers.eventObject?.choice, speakerLabel)
                : '';
            const eventObjectId = outcome?.otherId || memoryGateOpenidOf(eventObjectName, gid);
            const scores = {
                store: Number(store.toFixed(2)),
                share: share ? 1 : 0,
                imp: Number(importance.toFixed(2)),
                event: Number(event.toFixed(2)),
                ach: Number(achievementScore.toFixed(2)),
                consensus: Number(consensusScore.toFixed(2)),
                meta: Number(metaScore.toFixed(2)),
                type: type0,
                subject: subject0,
                dur: String(answers.durability?.choice ?? '?'),
                sens: Number(sensitive.toFixed(2)),
                conflict: Number(conflict.toFixed(2)),
                exp: experience0,
                ...(attitudeOk ? { attitude } : {}),
            };
            const decision = [storeOk ? 'memory' : '', stateOk ? 'state' : '', eventWillWrite ? 'event' : '']
                .filter(Boolean)
                .join('+') || 'skip';
            audit({
                gid,
                speaker: speakerLabel,
                speakerId: msg.senderId,
                msg: content.slice(0, 80),
                len: content.length,
                scores,
                decision,
                messageUid,
                tracking: trackingResult,
                reason: decision === 'skip' ? (metaNoise ? 'meta_noise' : 'below_threshold') : '',
                ...(visionNote !== '' ? { vision: visionNote } : {}),
            });
            let memoryId;
            const trackedEventId = outcome?.id || attitudeEvent?.id;
            const resultSource = outcome ? `${outcome.id}:${messageUid || 'unidentified'}` : '';
            const archiveTag = outcome ? `event-result-source:${resultSource}` : attitudeOk && messageUid ? `attitude-message:${messageUid}` : '';
            const context = outcome ? `「${outcome.title}」结果：${outcome.kind}。原话：`
                : attitudeEvent ? `关于「${attitudeEvent.title}」：` : '';
            const archiveValue = `${context}${content}`;
            if (storeOk) {
                // conflict 高不再丢弃：更正比旧说法更重要。写入时打上「更正」标签，
                // 让新条目和旧条目同时存在，由注入时的排序/模型自己取新。
                const correction = conflict >= 0.85;
                const type = outcome ? '经历' : attitudeOk ? (stableAttitude ? '偏好' : '经历')
                    : achievementOk || eventOk ? '经历' : (knowledgeOnly || consensusOk) ? '其他' : type0;
                if (MEMORY_GATE_TYPES.includes(type)) {
                    const subject = outcome || attitudeOk ? '说话人自己' : knowledgeOnly || consensusOk
                        ? '其他人'
                        : achievementOk ? achievementSubject : eventOk ? eventSubject0 : subject0;
                    const durability = stableAttitude && !outcome ? '长期' : outcome || attitudeOk || achievementOk || eventOk
                        ? '中期'
                        : consensusOk ? '长期' : String(answers.durability?.choice ?? '中期');
                    // 本地日期（北京时间 UTC+8）：toISOString() 取的是 UTC，00:00–08:00 的
                    // 消息会写错成前一天（实测 269/2171 条中招），模型以后引用时就记混时间。
                    const _now = new Date();
                    const date = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`;
                    const who = subject === '说话人自己' || subject === '无法判断' ? speakerLabel : subject;
                    // 所有类型正文都带日期锚点：这样「上午说的 / 前两天讲的」以后引用时一眼可辨，
                    // 不再只有近况/一次性才有日期。date tag 仍只给近况/一次性，避免污染别的按标签查询。
                    const prefix = `${date} `;
                    const dateTag = durability === '一次性' || type === '近况';
                    // 「达成」这种两个字的消息，光存下来没有回想价值；补一句上文再入档。
                    const contextNote = achievementOk && shortAchievement ? memoryGateShortContext(gid, content) : '';
                    // 指代消歧：正文里出现「他/她/对方」且象信判出了事件另一方时，附上真实人名，
                    // 否则这条记忆被单独召回时，「他因为单身出去玩一个人住」根本认不出「他」是谁。
                    const hasPronoun = /他|她|对方|那人/.test(content);
                    const objectNote = hasPronoun && eventObjectName !== ''
                        && eventObjectName !== who && eventObjectName !== '无法判断'
                        ? `（他/她指 ${eventObjectName}）` : '';
                    const text = `${prefix}[${type}] ${who}：${archiveValue}${contextNote}${objectNote}`.slice(0, 180);
                    // 主体和说话人分开记：subject: 是「关于谁」，speaker: 是「谁说的」；
                    // 保留 who 纯标签，兼容 people-roster / 人物卡等按名字匹配的旧逻辑。
                    const tagImportance = achievementOk ? Math.max(importance, 1.2) : importance;
                    const tags = [type, who, 'memory-gate', durability, ...(share ? ['分享'] : []), `imp:${tagImportance.toFixed(1)}`];
                    if (attitudeOk) tags.push('态度', attitude);
                    if (outcome) tags.push('事项结果', `event-result:${outcome.id}`);
                    if (trackedEventId) tags.push(`tracked-event:${trackedEventId}`);
                    if (archiveTag) tags.push(archiveTag);
                    if (achievementOk)
                        tags.push('成就');
                    if (knowledgeOnly)
                        tags.push('知识');
                    // 共识标签：注入时优先带出，避免被大量近况挤出 prompt
                    if (consensusOk)
                        tags.push('共识');
                    // 作品标签：work: 记作品名，medium: 记载体（电影/小说/剧集…）。
                    // 消息自己说了载体就按消息，没说才回落到本群档案里记过的载体；都没有就不打。
                    const workHit = memoryGateWorkHit(gid, content);
                    const explicitMedium = String(answers.workMedium?.choice ?? '无');
                    const workMedium = explicitMedium === '无' || explicitMedium === '说不清'
                        ? String(workHit?.medium ?? '')
                        : explicitMedium;
                    if (workHit)
                        tags.push(`work:${tagName(workHit.title)}`);
                    if (workMedium !== '')
                        tags.push(`medium:${tagName(workMedium)}`);
                    if (dateTag)
                        tags.push(date);
                    // openid 写进标签：subject-id 是「关于谁」，speaker-id 是「谁说的」。
                    // 名字可能重名或改名，openid 才能把一条记忆稳定对到具体的人。
                    const subjectId = who === speakerLabel ? msg.senderId : memoryGateOpenidOf(who, gid);
                    tags.push(`subject:${tagName(who)}`, `speaker:${tagName(speakerLabel)}`, `speaker-id:${msg.senderId}`);
                    if (subjectId !== '')
                        tags.push(`subject-id:${subjectId}`);
                    // 原话主体是小易时，补一条 about: 标签：既能按人检索，又不会丢掉「在说小易」。
                    if (aboutBot || eventSubjectBot)
                        tags.push('about:小易');
                    if (eventObjectName !== '' && tagName(eventObjectName) !== tagName(eventSubjectName)) {
                        tags.push(`object:${tagName(eventObjectName)}`);
                        if (eventObjectId !== '')
                            tags.push(`object-id:${eventObjectId}`);
                    }
                    if (correction)
                        tags.push('更正', `conflict:${conflict.toFixed(1)}`);
                    const db = new sqlite.DatabaseSync(dbPath);
                    try {
                        const now = Date.now();
                        const scope = `qq:group:${gid}`;
                        const tagPattern = ` ${archiveTag} `;
                        const info = db.prepare(`insert into memories (text, tags, scope, pinned, created_at, updated_at, last_confirmed_at, revision)
                            select ?, ?, ?, 0, ?, ?, ?, 1 where ? = '' or not exists
                            (select 1 from memories where scope = ? and instr(' ' || tags || ' ', ?) > 0)`)
                            .run(text, tags.join(' '), scope, now, now, now, archiveTag, scope, tagPattern);
                        memoryId = info.changes ? Number(info.lastInsertRowid) : db.prepare(
                            "select id from memories where scope = ? and instr(' ' || tags || ' ', ?) > 0 limit 1"
                        ).get(scope, tagPattern)?.id;
                        if (info.changes) console.log(`[im-qqbot] 记忆入库(${type}/${durability}): ${text.slice(0, 40)}…`);
                    }
                    finally {
                        db.close();
                    }
                }
            }
            if (stateOk) {
                const stateSubjectName = stateSubject === '说话人自己'
                    ? speakerLabel
                    : stateSubject === '机器人' ? '小易' : stateSubject;
                const applied = globalThis.__qqbotPersonState?.apply?.({
                    gid,
                    subjectName: stateSubjectName,
                    subjectId: stateSubject === '说话人自己' ? msg.senderId : memoryGateOpenidOf(stateSubjectName, gid),
                    slot: stateSlot,
                    op: stateOp,
                    value: content.slice(0, 120),
                    raw: content,
                    at: Date.now(),
                    eventUid: messageUid !== '' ? `message:${gid}:${messageUid}` : '',
                    speakerName: speakerLabel,
                    speakerId: msg.senderId,
                    source: 'memory-gate',
                    confidence: Math.max(0, Math.min(1, stateCertainty / 3)),
                    memoryId,
                });
                if (applied && (process.env.QQBOT_MEMORY_GATE_DEBUG ?? '') === '1')
                    console.log(`[im-qqbot] 状态入库: ${stateSubject} ${stateSlot} ${stateOp}`);
            }
            if (eventWillWrite) {
                const eventUid = outcome ? `tracked-result:${gid}:${resultSource}`
                    : messageUid ? `message:${gid}:${messageUid}:${eventKind}` : '';
                const confidence = outcome ? Number(answers.result_kind?.confidence ?? 0.55)
                    : attitudeOk ? Number(answers.attitude?.confidence) : Math.max(0, Math.min(1, importance / 1.5));
                const appended = globalThis.__qqbotPersonState?.append?.({
                    gid,
                    subjectName: eventSubjectName,
                    subjectId: eventSubject === '说话人自己' ? msg.senderId : memoryGateOpenidOf(eventSubjectName, gid),
                    kind: eventKind,
                    op: eventOp,
                    value: archiveValue.slice(0, 160),
                    raw: content,
                    at: Date.now(),
                    eventUid,
                    speakerName: speakerLabel,
                    speakerId: msg.senderId,
                    objectName: eventObjectName,
                    objectId: eventObjectId,
                    source: 'memory-gate',
                    confidence,
                    memoryId,
                });
                if (appended && (process.env.QQBOT_MEMORY_GATE_DEBUG ?? '') === '1')
                    console.log(`[im-qqbot] 事件入库: ${eventSubjectName}${eventObjectName ? ` → ${eventObjectName}` : ''} ${eventKind}/${eventOp}`);
            }
        }
        catch (err) {
            console.log(`[im-qqbot] 记忆门控失败: ${err instanceof Error ? err.message : String(err)}`);
        }
        finally {
            active--;
        }
    };

    globalThis.__qqbotMemoryGate = { consider };
    console.log(`[im-qqbot] 记忆门控已启用（象信，库 ${dbPath}）`);
}
/* <<< dsh-qqbot-patch:memory-gate-helper <<< */

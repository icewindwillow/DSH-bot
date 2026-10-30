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

function memoryGatePeopleNames(gid) {
    const fs = process.getBuiltinModule?.('node:fs');
    const os = process.getBuiltinModule?.('node:os');
    try {
        const store = JSON.parse(fs.readFileSync(`${os.homedir()}/.dsh/profiles/qqbot/qqbot-people.json`, 'utf8'));
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
            // 群昵称可能是「测试昵称」，档案里使用另一个称呼；
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
            if (/^\[(图片|视频|文件|表情)[^\]]*\]$/.test(content))   // 纯占位符，没有文字可记
                return;
            const known = lookupKnown(gid, speaker);
            const answers = await xiangxinMemoryJudge({ 说话人: speakerLabel, 已知记忆: known || '（无）', 消息: content }, gid);
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
            const storeOk = isStatus
                ? true
                : share
                    ? store >= 0.1 && importance >= 0.6
                    : store >= 0.5 && importance >= 0.8;
            if ((process.env.QQBOT_MEMORY_GATE_DEBUG ?? '') === '1')
                console.log(`[im-qqbot] 记忆判定: ${speakerLabel} store=${store.toFixed(2)} share=${share ? 1 : 0} imp=${importance.toFixed(2)} type=${type0} subject=${subject0} dur=${String(answers.durability?.choice ?? '?')} sens=${sensitive.toFixed(2)} conflict=${conflict.toFixed(2)} → ${storeOk ? '写' : '跳过'}`);
            if (!storeOk || sensitive > 0.3)
                return;
            if (conflict >= 0.85)
                return;

            const type = String(answers.type?.choice ?? '其他');
            if (!MEMORY_GATE_TYPES.includes(type))
                return;
            const subject = String(answers.subject?.choice ?? '无法判断');
            const durability = String(answers.durability?.choice ?? '中期');
            const date = new Date().toISOString().slice(0, 10);
            const who = subject === '说话人自己' || subject === '无法判断' ? speakerLabel : subject;
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

    globalThis.__qqbotMemoryGate = { consider };
    console.log(`[im-qqbot] 记忆门控已启用（象信，库 ${dbPath}）`);
}
/* <<< dsh-qqbot-patch:memory-gate-helper <<< */

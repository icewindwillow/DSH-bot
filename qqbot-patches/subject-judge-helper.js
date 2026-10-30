/* >>> dsh-qqbot-patch:subject-judge-helper >>> */
/**
 * 「这句话在说谁」解析：人类很少直呼其名（我弟 / 她 / 叶老师），
 * 用象信结合「说话人已知记忆」判断主语，缓存结果供提示词注入别人的记忆。
 */
const SUBJECT_HINT = /他|她|弟|妹|哥|姐|爸|妈|对象|朋友|同事|老板|老师|同学|室友|家人|那家伙|某人/;

async function xiangxinResolveSubject(state) {
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
            mentions: { type: 'noul', instructions: '`消息` 是否在说群里的另一个人（可能用称呼、亲属词、代称，而不是名字）？' },
            who: { type: 'choice', instructions: '`消息` 主要在说谁？没提到具体的人就选「都没提到」。', criteria: state.criteria },
        },
    };
    try {
        const res = await fetch('https://api.xiangxinai.cn/v1/systemone', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok)
            return undefined;
        const ans = (await res.json())?.answers;
        return { mentions: Number(ans?.mentions?.noul ?? 0), who: String(ans?.who?.choice ?? ''), confidence: Number(ans?.who?.confidence ?? 0) };
    }
    catch {
        return undefined;
    }
}

function setupSubjectJudge(ctx, logger) {
    if ((process.env.QQBOT_SUBJECT_JUDGE ?? 'on') === 'off')
        return;
    const fs = process.getBuiltinModule?.('node:fs');
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    if (!fs || !sqlite)
        return;
    const dir = process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`;
    const subjects = new Map();
    globalThis.__qqbotSubjects = subjects;
    const lastAt = new Map();

    const membersOf = (gid) => {
        try {
            const store = JSON.parse(fs.readFileSync(`${dir}/qqbot-people.json`, 'utf8'));
            return (store.people ?? []).filter((p) => p && (p.groups ?? []).includes(gid)).map((p) => String(p.name ?? '').trim()).filter(Boolean);
        }
        catch {
            return [];
        }
    };

    const memoriesOf = (gid, names) => {
        try {
            const db = new sqlite.DatabaseSync(`${process.env.HOME ?? ''}/.dsh/memory/ltm.db`, { readOnly: true });
            const rows = db.prepare("select text from memories where scope = ? and ((' '||tags||' ') like ? or text like ?) order by updated_at desc limit 3")
                .all(`qq:group:${gid}`, `% ${names[0]} %`, `%] ${names[0]}：%`);
            db.close();
            return rows.map((r) => String(r.text)).join('；').slice(0, 300);
        }
        catch {
            return '';
        }
    };

    const consider = async (mCtx) => {
        try {
            const msg = mCtx?.message;
            if (!msg || msg.kind !== 'group' || !msg.groupOpenid || !msg.senderId)
                return;
            const content = String(msg.content ?? '').trim();
            if (content.length < 3 || content.length > 200)
                return;
            if (!SUBJECT_HINT.test(content))
                return;
            const gid = msg.groupOpenid;
            const members = membersOf(gid).filter((n) => n !== msg.senderName);
            if (members.length === 0)
                return;
            // 提到名字的走名字匹配，不必再问
            if (members.some((n) => n.length >= 2 && content.includes(n)))
                return;
            if (Date.now() - (lastAt.get(gid) ?? 0) < 5000)
                return;
            lastAt.set(gid, Date.now());

            const criteria = { 说话人自己: '说说话人自己的事', 机器人: '说机器人小易', 都没提到: '没提到具体的人' };
            for (const n of members.slice(0, 15))
                criteria[n] = `说的是「${n}」`;
            const known = memoriesOf(gid, [msg.senderName ?? '']);
            const ans = await xiangxinResolveSubject({ 说话人: msg.senderName ?? '', 已知关系: known || '（无）', 消息: content, criteria });
            if (!ans || ans.who === '说话人自己' || ans.who === '机器人' || ans.who === '都没提到')
                return;
            // who 已经排除「说自己/说机器人/都没提到」，看置信度即可
            if (ans.confidence < 0.6)
                return;
            subjects.set(gid, { name: ans.who, at: Date.now(), senderId: msg.senderId });
            console.log(`[im-qqbot] 主语解析: 这句在说「${ans.who}」 (${ans.confidence.toFixed(2)})`);
        }
        catch {
            // 解析失败不影响对话
        }
    };
    globalThis.__qqbotSubjectJudge = { consider };
    console.log('[im-qqbot] 主语解析已启用（象信，支持代称/亲属词）');
}
/* <<< dsh-qqbot-patch:subject-judge-helper <<< */

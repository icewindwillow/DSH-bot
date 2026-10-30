/* >>> dsh-qqbot-patch:memory-summary-helper >>> */
/**
 * 每日近况汇总：把同一个人 7 天内的多条「[近况]」记忆合并成一条总结。
 * 象信参与判断：要不要合并、主要围绕什么、严重程度；文本由代码拼装（象信不生成）。
 * 每天 04:00 跑一次（进程时区）。
 */
async function xiangxinSummaryJudge(state) {
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
            merge: { type: 'noul', instructions: '`近况条目` 是否适合合并成一条阶段性总结（而不是各自保留）？' },
            theme: {
                type: 'choice',
                instructions: '这些近况主要围绕什么？',
                criteria: { 情绪压力: '心情、压力、焦虑', 身体健康: '生病、体检、指标、睡眠', 工作学习: '工作、加班、考试、项目', 人际关系: '朋友、家人、感情', 生活琐事: '吃、玩、日常小事', 其他: '以上都不是' },
            },
            severity: { type: 'score', instructions: '这些近况整体的严重/需要关心的程度', criteria: ['还好', '有点在意', '值得关心', '需要重点关心'] },
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

function setupMemorySummary(ctx, logger) {
    if ((process.env.QQBOT_MEMORY_SUMMARY ?? 'on') === 'off')
        return;
    const fs = process.getBuiltinModule?.('node:fs');
    const os = process.getBuiltinModule?.('node:os');
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    if (!fs || !sqlite)
        return;
    const dbPath = `${os.homedir()}/.dsh/memory/ltm.db`;
    const profileDir = process.env.QQBOT_PROFILE_DIR ?? `${os.homedir()}/.dsh/profiles/qqbot`;
    let lastRunDay = '';
    let groupNames = new Map();
    try {
        const meta = JSON.parse(fs.readFileSync(`${profileDir}/qqbot-groups-meta.json`, 'utf8'));
        groupNames = new Map((Array.isArray(meta?.groups) ? meta.groups : []).map((g) => [String(g.id), String(g.name ?? g.id)]));
    }
    catch {
        groupNames = new Map();
    }
    const localDay = (date = new Date()) => {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    };

    /** 用 opencode-go 把当天新记忆写成 2~4 句日报（模型只做改写，不做判断） */
    const generateDigest = async (rows, groupName, date) => {
        let llm;
        try {
            llm = ctx.get('llm');
        }
        catch {
            llm = undefined;
        }
        if (!llm || typeof llm.stream !== 'function')
            return '';
        const source = rows.slice(0, 40).map((row, index) => {
            const text = String(row.text ?? '')
                .replace(/^\d{4}-\d{2}-\d{2} /, '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 160);
            return `${index + 1}. ${text}`;
        }).join('\n');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        let output = '';
        try {
            for await (const chunk of llm.stream({
                provider: process.env.QQBOT_DIGEST_PROVIDER ?? 'opencode-go',
                model: process.env.QQBOT_DIGEST_MODEL ?? 'deepseek-v4.1-flash',
                system: [
                    '你是群聊记忆整理器。根据给出的记忆写一段 2~4 句的中文日报。',
                    '只写记忆里明确出现的事实，不要编造、不要推测、不要给建议；写清「谁 + 做了什么/什么状态」；',
                    '不要列表、不要标题、不要超过 160 字。',
                ].join('\n'),
                messages: [{
                    role: 'user',
                    content: [{ type: 'text', text: `群：${groupName}\n日期：${date}\n记忆：\n${source}` }],
                }],
                maxTokens: 400,
                reasoningEffort: 'low',
                signal: controller.signal,
            })) {
                if (!chunk)
                    continue;
                if (chunk.type === 'text-delta')
                    output += chunk.text ?? '';
                else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
                    output = '';
                    break;
                }
            }
        }
        catch {
            output = '';
        }
        finally {
            clearTimeout(timer);
        }
        return output.replace(/\s+/g, ' ').trim().slice(0, 400);
    };

    /** 每个群每天最多一条 [日报]；只有最近 24h 新记忆 >= 3 条才生成 */
    const writeDailyDigest = async (db, date) => {
        const since = Date.now() - 24 * 3600 * 1000;
        const scopes = db.prepare("select distinct scope from memories where scope like 'qq:group:%' and created_at >= ?").all(since);
        let written = 0;
        for (const row of scopes) {
            const scope = String(row.scope ?? '');
            if (!scope)
                continue;
            const exists = db.prepare("select id from memories where scope = ? and tags like '%日报%' and text like ?")
                .get(scope, `[日报] ${date}%`);
            if (exists)
                continue;
            const memories = db.prepare("select text from memories where scope = ? and created_at >= ? and tags not like '%日报%' order by created_at desc limit 40")
                .all(scope, since);
            if (memories.length < 3)
                continue;
            const gid = scope.slice('qq:group:'.length);
            const name = groupNames.get(gid) ?? gid.slice(0, 6);
            const digest = await generateDigest(memories, name, date);
            if (!digest) {
                console.log(`[im-qqbot] 日报生成失败: ${name}`);
                continue;
            }
            const text = `[日报] ${date} ${name}：${digest}`.slice(0, 600);
            const ts = Date.now();
            db.prepare('insert into memories (text, tags, scope, pinned, created_at, updated_at, last_confirmed_at, revision) values (?, ?, ?, 0, ?, ?, ?, 1)')
                .run(text, `日报 ${date} 汇总 ${name}`, scope, ts, ts, ts);
            written++;
            console.log(`[im-qqbot] 日报入库: ${name} ${digest.slice(0, 40)}…`);
        }
        return written;
    };

    const runOnce = async (force = false) => {
        const now = new Date();
        const today = localDay(now);
        if (!force && (now.getHours() < 4 || lastRunDay === today))
            return;
        lastRunDay = today;
        let db;
        try {
            db = new sqlite.DatabaseSync(dbPath);
        }
        catch {
            return;
        }
        try {
            const since = Date.now() - 7 * 86400000;
            const rows = db.prepare("select id, text, scope, created_at from memories where tags like '%近况%' and created_at >= ? order by created_at asc").all(since);
            const groups = new Map();
            for (const r of rows) {
                const m = String(r.text).match(/^(\d{4}-\d{2}-\d{2})? ?\[近况\] ([^：]+)：/);
                if (!m)
                    continue;
                const key = `${r.scope}|${m[2]}`;
                (groups.get(key) ?? groups.set(key, []).get(key)).push(r);
            }
            for (const [key, items] of groups) {
                if (items.length < 3)
                    continue;
                const [scope, who] = key.split('|');
                const sample = items.slice(-5).map((r) => String(r.text).replace(/^\d{4}-\d{2}-\d{2} /, '').slice(0, 60));
                const ans = await xiangxinSummaryJudge({ 人物: who, 条数: items.length, 近况条目: sample });
                if (!ans || Number(ans.merge?.noul ?? 0) < 0.5)
                    continue;
                const theme = String(ans.theme?.choice ?? '其他');
                const sev = Number(ans.severity?.score ?? 0);
                const start = new Date(Number(items[0].created_at)).toISOString().slice(5, 10);
                const end = new Date(Number(items[items.length - 1].created_at)).toISOString().slice(5, 10);
                const latest = String(items[items.length - 1].text).replace(/^\d{4}-\d{2}-\d{2} /, '').slice(0, 60);
                const text = `[近况汇总] ${who}（${start}~${end}，${items.length}条）：主要在${theme}；关心程度 ${sev.toFixed(1)}/3；最近一条：${latest}`.slice(0, 200);
                const insert = db.prepare('insert into memories (text, tags, scope, pinned, created_at, updated_at, last_confirmed_at, revision) values (?, ?, ?, 0, ?, ?, ?, 1)');
                const del = db.prepare('delete from memories where id = ?');
                for (const it of items)
                    del.run(it.id);
                const ts = Date.now();
                insert.run(text, `近况汇总 ${who} 汇总 ${today}`, scope, ts, ts, ts);
                console.log(`[im-qqbot] 近况汇总: ${who} ${items.length} 条 → 1 条`);
            }
            const digests = await writeDailyDigest(db, today);
            if (digests > 0)
                console.log(`[im-qqbot] 今日日报: ${digests} 个群`);
        }
        catch (err) {
            console.log(`[im-qqbot] 近况汇总失败: ${err instanceof Error ? err.message : String(err)}`);
        }
        finally {
            db.close();
        }
    };

    setInterval(() => { void runOnce(); }, 30 * 60 * 1000);
    globalThis.__qqbotMemorySummary = { runOnce };
    console.log('[im-qqbot] 近况汇总/每日日报已启用（每天 04:00，象信判断合并 + 模型写日报）');
}
/* <<< dsh-qqbot-patch:memory-summary-helper <<< */

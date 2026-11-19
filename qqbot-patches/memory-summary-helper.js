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

/**
 * 事件沉淀：把还没接上长期记忆的事件写成 memories 条目，并回填 memory_id。
 * 只处理已经落定的事件（默认 6 小时前），避免和同一条消息刚写入的记忆抢跑。
 * 同一主体、同一文本 7 天内已有记忆时只回填引用，不重复写。
 */
function memoryConsolidateEvents(db, options = {}) {
    const now = Number(options.now ?? Date.now());
    const cutoff = now - Math.max(0, Number(options.minAgeMs ?? 6 * 3600 * 1000));
    const limit = Math.max(1, Math.min(500, Number(options.limit ?? 200)));
    const labels = { episode: '经历', commitment: '约定', relation: '关系' };
    // 事件表由状态层创建；没有它时不影响日报等既有流程
    if (!db.prepare("select name from sqlite_master where type = 'table' and name = 'mem_events'").get())
        return { written: 0, linked: 0 };
    const rows = db.prepare(`select id, scope, subject_key, subject_name, kind, value, event_at
        from mem_events
        where memory_id is null and kind in ('episode', 'commitment', 'relation')
            and value != '' and event_at <= ?
        order by event_at asc, id asc limit ?`).all(cutoff, limit);
    const findDup = db.prepare(`select id from memories
        where scope = ? and text = ? and created_at >= ?
            and instr(' ' || tags || ' ', ' archived ') = 0
        order by id desc limit 1`);
    const insert = db.prepare(`insert into memories
        (text, tags, scope, pinned, created_at, updated_at, last_confirmed_at, revision)
        values (?, ?, ?, 0, ?, ?, ?, 1)`);
    const link = db.prepare('update mem_events set memory_id = ? where id = ? and memory_id is null');
    let written = 0;
    let linked = 0;
    db.exec('begin immediate');
    try {
        for (const row of rows) {
            const value = String(row.value ?? '').replace(/\s+/g, ' ').trim();
            const subject = String(row.subject_name ?? '').trim();
            if (value.length < 2 || subject === '')
                continue;
            const label = labels[String(row.kind)] ?? '事件';
            const text = `[${label}] ${subject}：${value}`.slice(0, 300);
            const at = Number(row.event_at);
            const dup = findDup.get(String(row.scope), text, at - 7 * 86400000);
            if (dup) {
                link.run(Number(dup.id), Number(row.id));
                linked++;
                continue;
            }
            const info = insert.run(text,
                `事件沉淀 ${label} subject:${row.subject_key} kind:${row.kind} event:${row.id}`,
                String(row.scope), at, at, at);
            link.run(Number(info.lastInsertRowid), Number(row.id));
            written++;
        }
        db.exec('commit');
    }
    catch (err) {
        try { db.exec('rollback'); } catch { /* 忽略 */ }
        throw err;
    }
    return { written, linked };
}

// No snapshots of source text: a deleted, reclassified or edited row must not be replayed as old evidence.
function memorySummaryFingerprint(text) {
    return process.getBuiltinModule('node:crypto').createHash('sha256').update(text).digest('hex');
}

function memorySummaryWrite(db, { text, tags, scope, sources, at, digestDate, archive = false }) {
    db.exec('begin immediate');
    try {
        db.exec(`create table if not exists qqbot_summary_sources (
            summary_id integer not null, source_id integer not null,
            summary_fingerprint text not null, source_fingerprint text not null,
            primary key (summary_id, source_id)
        )`);
        const current = db.prepare("select text, revision from memories where id = ? and scope = ? and instr(lower(tags), 'pm:') = 0");
        const snapshot = sources.map((row) => current.get(row.id, scope));
        if ((digestDate && db.prepare("select 1 from memories where scope = ? and text like ?").get(scope, `[日报] ${digestDate}%`))
            || sources.some((row, index) => !snapshot[index] || snapshot[index].revision !== row.revision
                || snapshot[index].text !== row.text)) {
            db.exec('rollback');
            return false;
        }
        const summary = db.prepare(`insert into memories
            (text, tags, scope, pinned, created_at, updated_at, last_confirmed_at, revision)
            values (?, ?, ?, 0, ?, ?, ?, 1)`).run(text, tags, scope, at, at, at);
        const link = db.prepare('insert into qqbot_summary_sources (summary_id, source_id, summary_fingerprint, source_fingerprint) values (?, ?, ?, ?)');
        const fingerprint = memorySummaryFingerprint(text);
        for (const [index, row] of sources.entries())
            link.run(summary.lastInsertRowid, row.id, fingerprint, memorySummaryFingerprint(snapshot[index].text));
        if (archive) {
            const mark = db.prepare("update memories set tags = tags || ' archived', revision = revision + 1 where id = ? and scope = ?");
            for (const row of sources)
                mark.run(row.id, scope);
        }
        db.exec('commit');
        return true;
    }
    catch (error) {
        try { db.exec('rollback'); } catch { /* transaction already closed */ }
        throw error;
    }
}

function memorySummaryEvidence(db, scope, { id, keyword } = {}) {
    const results = [];
    const empty = (status) => ({ status, missing: 0, results });
    if (typeof scope !== 'string' || !/^qq:(?:group|c2c):[^:]+$/.test(scope))
        return empty('unavailable');
    if (!Number.isSafeInteger(id) || id < 1)
        return empty('not-found');
    const summary = db.prepare(`select text, created_at from memories where id = ? and scope = ?
        and (text like '[日报] %' or text like '[近况汇总] %') and instr(lower(tags), 'pm:') = 0`).get(id, scope);
    if (!summary)
        return empty('not-found');
    const tableExists = (name) => !!db.prepare("select 1 from sqlite_schema where type = 'table' and name = ?").get(name);
    // A manually edited summary no longer represents the inputs we recorded at generation time.
    if (!tableExists('qqbot_summary_sources'))
        return empty('summary-only');
    const sources = db.prepare(`select m.id, m.text, m.created_at, m.updated_at, s.source_fingerprint from qqbot_summary_sources s
        left join memories m on m.id = s.source_id and m.scope = ? and instr(lower(m.tags), 'pm:') = 0
            and instr(' ' || m.tags || ' ', ' orphan-review ') = 0
        where s.summary_id = ? and s.summary_fingerprint = ? order by m.created_at desc, m.id desc`)
        .all(scope, id, memorySummaryFingerprint(summary.text));
    const live = sources.filter((row) => row.id !== null && memorySummaryFingerprint(row.text) === row.source_fingerprint);
    if (!live.length)
        return { ...empty('summary-only'), missing: sources.length };

    const term = typeof keyword === 'string' ? keyword.trim().slice(0, 48) : '';
    const later = term.length < 2 ? [] : db.prepare(`select m.id, m.text, m.created_at, m.updated_at from memories m
        where m.scope = ? and m.created_at >= ? and m.id != ? and instr(lower(m.tags), 'pm:') = 0
          and m.text not like '[日报] %' and m.text not like '[近况汇总] %'
          and instr(' ' || m.tags || ' ', ' archived ') = 0
          and instr(lower(m.text), lower(?)) > 0
          and not exists (select 1 from qqbot_summary_sources s where s.summary_id = ? and s.source_id = m.id)
        order by m.created_at desc, m.id desc limit 3`).all(scope, summary.created_at, id, term, id);
    const matching = term.length < 2 ? [] : live.filter((row) => row.text.toLowerCase().includes(term.toLowerCase()));
    const selected = [...new Set([...matching, ...live])].slice(0, 6);
    const event = tableExists('mem_events') ? db.prepare(`select raw, speaker_name, event_at from mem_events
        where memory_id = ? and scope = ? and source = 'memory-gate' and raw != '' and speaker_name != ''
          and event_at <= ? and ingested_at >= ?
        order by event_at desc, id desc limit 1`) : null;
    const append = (row, relation) => {
        const snippet = event?.get(row.id, scope, relation === 'summary-input' ? summary.created_at : Date.now(), row.updated_at);
        const text = snippet?.raw ?? row.text;
        results.push({ id: row.id, relation, kind: snippet ? 'chat-excerpt' : 'memory-entry',
            at: snippet?.event_at ?? row.created_at, speaker: snippet?.speaker_name.slice(0, 60) ?? '',
            text: text.length > 220 ? `${text.slice(0, 220)}…` : text });
    };
    for (const row of selected) append(row, 'summary-input');
    for (const row of later) append(row, 'later-keyword-match');
    results.sort((a, b) => a.at - b.at || a.id - b.id);
    return { status: live.length > selected.length || live.length !== sources.length ? 'partial' : 'found',
        missing: sources.length - live.length, results };
}

function setupMemorySummaryEvidence(ctx, sqlite, dbPath) {
    let tools;
    try { tools = ctx.get('tools'); } catch { return; }
    tools?.register({
        name: 'memory_summary_evidence',
        description: '仅在有人追问旧事的原话、说话人、时间或前后有冲突时，用 memory_search 返回的日报或近况汇总数字 ID 核查来源。可传一个活动名等短关键词检查后续同会话记录。后续匹配不是自动判定的更正。chat-excerpt 是留存聊天片段，memory-entry 只是记忆条目，不可冒充原话；来源不可用就说只能确认摘要，不要补造。',
        parameters: {
            type: 'object', additionalProperties: false, required: ['id'],
            properties: { id: { type: 'integer' }, keyword: { type: 'string' } },
        },
        output: {
            schema: { type: 'object', additionalProperties: false, required: ['status', 'missing', 'results'],
                properties: { status: { type: 'string' }, missing: { type: 'integer' }, results: { type: 'array',
                    items: { type: 'object', additionalProperties: false, required: ['id', 'relation', 'kind', 'at', 'speaker', 'text'],
                        properties: { id: { type: 'integer' }, relation: { type: 'string' }, kind: { type: 'string' },
                            at: { type: 'number' }, speaker: { type: 'string' }, text: { type: 'string' } } } } } },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        isConcurrencySafe: true,
        async execute(args, exec) {
            const sessionId = exec?.agent?.session?.header?.id ?? exec?.agent?.header?.id;
            const scopes = globalThis.__qqbotMemoryScopeBySession;
            const scope = typeof sessionId === 'string' && scopes && Object.hasOwn(scopes, sessionId) ? scopes[sessionId] : undefined;
            if (!scope)
                return { status: 'unavailable', missing: 0, results: [] };
            let db;
            try {
                db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
                db.exec('begin');
                return memorySummaryEvidence(db, scope, args);
            }
            catch {
                return { status: 'unavailable', missing: 0, results: [] };
            }
            finally { db?.close(); }
        },
    });
}

function setupMemorySummary(ctx, logger) {
    const fs = process.getBuiltinModule?.('node:fs');
    const os = process.getBuiltinModule?.('node:os');
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    if (!fs || !sqlite)
        return;
    const dbPath = process.env.QQBOT_MEMORY_DB ?? `${process.env.DSH_HOME ?? `${os.homedir()}/.dsh`}/memory/ltm.db`;
    setupMemorySummaryEvidence(ctx, sqlite, dbPath);
    if ((process.env.QQBOT_MEMORY_SUMMARY ?? 'on') === 'off')
        return;
    const profileDir = process.env.QQBOT_PROFILE_DIR ?? `${process.env.DSH_HOME ?? `${os.homedir()}/.dsh`}/profiles/${process.env.QQBOT_PROFILE_NAME ?? 'qqbot'}`;
    let lastRunDay = '';
    const loadGroupNames = () => {
        try {
            const groups = readQqbotGroupDirectory(profileDir);
            return new Map(groups.map((g) => [String(g.id), String(g.name ?? g.id)]));
        } catch { return new Map(); }
    };
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
        const groupNames = loadGroupNames();
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
            const memories = db.prepare(`select id, text, revision from memories where scope = ? and created_at >= ?
                and text not like '[日报] %' and text not like '[近况汇总] %'
                and instr(lower(tags), 'pm:') = 0 and instr(' ' || tags || ' ', ' archived ') = 0
                order by created_at desc, id desc limit 40`)
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
            if (!memorySummaryWrite(db, { text, tags: `日报 ${date} 汇总 ${name}`, scope, sources: memories, at: ts, digestDate: date }))
                continue;
            written++;
            console.log(`[im-qqbot] 日报入库: ${name} ${digest.slice(0, 40)}…`);
        }
        return written;
    };



    /**
     * 每日记忆质量复核：把「还是不大行」「我不满意」这类孤儿句交给高推理模型。
     * 原文永远保留；无法从上下文还原成具体事件的条目软归档，不再参与召回。
     */
    const runQualityScan = async (force = false) => {
        const sqliteDb = dbPath;
        let db;
        try { db = new sqlite.DatabaseSync(sqliteDb); } catch { return { reviewed: 0, orphaned: 0, rebuilt: 0 }; }
        const result = { reviewed: 0, orphaned: 0, rebuilt: 0 };
        try {
            db.exec(`create table if not exists memory_quality_reviews (
                memory_id integer primary key,
                decision text not null,
                reason text not null default '',
                replacement text not null default '',
                reviewed_at integer not null
            )`);
            const llm = (() => { try { return ctx.get('llm'); } catch { return undefined; } })();
            if (!llm || typeof llm.stream !== 'function') return result;
            const now = Date.now();
            const reviewed = new Set(db.prepare('select memory_id from memory_quality_reviews').all().map((row) => Number(row.memory_id)));
            const all = db.prepare(`select id, scope, text, tags, created_at from memories
                where instr(' ' || tags || ' ', ' archived ') = 0
                  and tags like '%近况%' and tags not like '%日报%' and tags not like '%近况汇总%'
                order by created_at asc`).all();
            const vague = /(还是不大行|不大满意|不满意|不太行|我不行了|不知道|没事|还行|好累|好烦|难受|忘了|算了|不想了|先这样|终于看完了|刚醒|醒了|没了|估计没了|但是很难|心情不好|天气好好|天气超好|物是人非)/;
            const candidates = all.filter((row) => !reviewed.has(Number(row.id)) && (String(row.text).length <= 120 || vague.test(String(row.text)))).slice(0, force ? 80 : 40);
            if (!candidates.length) return result;
            const review = db.prepare('insert or replace into memory_quality_reviews (memory_id, decision, reason, replacement, reviewed_at) values (?, ?, ?, ?, ?)');
            const archive = db.prepare("update memories set tags = trim(tags || ' archived orphan-review'), updated_at = ?, revision = revision + 1 where id = ? and instr(' ' || tags || ' ', ' archived ') = 0");
            const insert = db.prepare('insert into memories (text, tags, scope, pinned, created_at, updated_at, last_confirmed_at, revision) values (?, ?, ?, 0, ?, ?, ?, 1)');
            for (let offset = 0; offset < candidates.length; offset += 8) {
                const batch = candidates.slice(offset, offset + 8);
                const payload = batch.map((row) => {
                    const subject = String(row.tags).match(/(?:^| )subject:([^ ]+)/)?.[1] ?? '';
                    const context = db.prepare(`select id, text, created_at from memories
                        where scope = ? and instr(' ' || tags || ' ', ' archived ') = 0
                          and abs(created_at - ?) <= ? order by created_at asc limit 18`).all(row.scope, row.created_at, 3 * 86400000)
                        .map((item) => `${item.id}: ${String(item.text).replace(/\s+/g, ' ').slice(0, 220)}`).join('\n');
                    return { id: Number(row.id), text: String(row.text), subject, context };
                });
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 30000);
                let output = '';
                try {
                    for await (const chunk of llm.stream({
                        provider: process.env.QQBOT_MEMORY_REVIEW_PROVIDER ?? process.env.QQBOT_DIGEST_PROVIDER ?? 'opencode-go',
                        model: process.env.QQBOT_MEMORY_REVIEW_MODEL ?? process.env.QQBOT_DIGEST_MODEL ?? 'deepseek-v4.1-flash',
                        reasoningEffort: 'high', maxTokens: 1800, signal: controller.signal,
                        system: ['你是长期记忆质量审校员。判断短句是否有明确事件目标。',
                            '必须结合同群三天内上下文；「还是不大行」「我不满意」若能明确对应某个作品、任务、游戏或事件，就改写为一条具体事实。',
                            '无法确认目标就判 orphan；不要凭常识补全，不要把情绪本身当成具体事件。',
                            '只输出 JSON 数组，每项是 {id,decision,reason,replacement}；decision 只能是 keep、orphan、rewrite。',
                            'rewrite 的 replacement 必须是中文、第三人称、带明确目标的完整记忆句，不超过 180 字。'].join('\n'),
                        messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(payload) }] }],
                    })) {
                        if (chunk?.type === 'text-delta') output += chunk.text ?? '';
                        if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') output = '';
                    }
                } catch { output = ''; } finally { clearTimeout(timer); }
                let decisions;
                try { decisions = JSON.parse(output.match(/\[[\s\S]*\]/)?.[0] ?? '[]'); } catch { decisions = []; }
                if (!Array.isArray(decisions)) decisions = [];
                db.exec('begin immediate');
                try {
                    for (const row of batch) {
                        const decision = decisions.find((item) => Number(item?.id) === Number(row.id));
                        // 模型漏答时保留原文和复核资格，不能视作已确认应归档。
                        if (!['keep', 'orphan', 'rewrite'].includes(decision?.decision)) continue;
                        const kind = decision.decision;
                        const reason = String(decision.reason ?? '').slice(0, 300);
                        const replacement = String(decision?.replacement ?? '').trim().slice(0, 400);
                        review.run(Number(row.id), kind, reason, replacement, now);
                        result.reviewed++;
                        if (kind === 'orphan') { archive.run(now, Number(row.id)); result.orphaned++; }
                        if (kind === 'rewrite' && replacement.length >= 8) {
                            archive.run(now, Number(row.id));
                            const subject = String(row.text).match(/\[近况\]\s*([^：:]+)[：:]/)?.[1] ?? '相关人物';
                            const text = `[经历] ${subject}：${replacement}`.slice(0, 500);
                            const exists = db.prepare('select 1 from memories where scope = ? and text = ? and instr(\' \' || tags || \' \', \' archived \') = 0 limit 1').get(row.scope, text);
                            if (!exists) insert.run(text, `近况 context-reconstructed source:${row.id}`, row.scope, now, now, now);
                            result.rebuilt++;
                        }
                    }
                    db.exec('commit');
                } catch (error) { try { db.exec('rollback'); } catch {} throw error; }
            }
            if (result.reviewed) console.log(`[im-qqbot] 记忆质量扫描：复核 ${result.reviewed} 条，孤儿 ${result.orphaned} 条，重建 ${result.rebuilt} 条`);
            return result;
        } finally { db.close(); }
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
            // 近况汇总：被「状态 + 叙事」取代，默认关闭（QQBOT_STATUS_SUMMARY=on 可临时开回）。
            // 保留历史数据和代码，不再默认生成新的汇总卡、也不再归档原始近况。
            if (String(process.env.QQBOT_STATUS_SUMMARY ?? 'off').trim().toLowerCase() === 'on') {
                const since = Date.now() - 7 * 86400000;
                // archived = 已汇总过的原始条目：不再参与下一轮汇总，但保留正文当证据
                const rows = db.prepare("select id, text, scope, created_at, revision from memories where tags like '%近况%' and instr(' ' || tags || ' ', ' archived ') = 0 and instr(lower(tags), 'pm:') = 0 and created_at >= ? order by created_at asc, id asc").all(since);
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
                    if (!memorySummaryWrite(db, { text, tags: `近况汇总 ${who} 汇总 ${today}`, scope,
                        sources: items, at: Date.now(), archive: true }))
                        continue;
                    console.log(`[im-qqbot] 近况汇总: ${who} ${items.length} 条 → 1 条（原始条目已归档）`);
                }
            }
            if ((process.env.QQBOT_EVENT_CONSOLIDATE ?? 'on') !== 'off') {
                const consolidated = memoryConsolidateEvents(db);
                if (consolidated.written > 0 || consolidated.linked > 0)
                    console.log(`[im-qqbot] 事件沉淀: 新记忆 ${consolidated.written} 条，复用已有 ${consolidated.linked} 条`);
            }
            await runQualityScan(false);
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
    globalThis.__qqbotMemorySummary = { runOnce, runQualityScan };
    console.log(`[im-qqbot] 每日任务已启用（近况汇总 ${String(process.env.QQBOT_STATUS_SUMMARY ?? 'off') === 'on' ? '开' : '关'}，事件沉淀 + 日报开，每天 04:00）`);
}
/* <<< dsh-qqbot-patch:memory-summary-helper <<< */

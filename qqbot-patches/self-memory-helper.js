/* >>> dsh-qqbot-patch:self-memory-helper >>> */
/**
 * 小易自己的私人记忆：她亲身经历过、或从自己履历里知道的事。
 *
 * 和「行为准则 / 人设规则」分开：规则是每轮都要守的，私人记忆只是她心里知道的事，
 * 平时不提，话题真碰到时才自然带一句。存在 ltm.db 的 self_memories 表，不动其他表。
 *
 * - 召回：每条群消息后台先问一次象信「这句和她自己的哪段经历有关」，
 *         命中的缓存 10 分钟，轮到她说话时由 self-memory-prompt 注入。
 *         没命中不清缓存，方便「你后来没事吧」这种看不出主语的追问。
 * - 注入：只有命中才注入，不设常驻规则，避免她被提示「我有记忆」之后到处乱说。
 * - 写入：由维护脚本 / 种子数据直接落库，不开放给群友写。
 */
const SELF_MEMORY_DB_FILE = () => process.env.QQBOT_MEMORY_DB ?? `${process.env.HOME ?? ''}/.dsh/memory/ltm.db`;
const SELF_MEMORY_SEARCH_POOL = 240;
const SELF_MEMORY_CHOICES_PER_CALL = 200;
// 预取缓存 10 分钟自然过期，和梗库一致
const SELF_MEMORY_RECALL_TTL_MS = 10 * 60 * 1000;
// 比梗库更保守：宁可少带一条，也不要她逢人就说自己的事
const SELF_MEMORY_RECALL_HIT_P = 0.4;
const SELF_MEMORY_RECALL_MIN_CHARS = 4;
// 组装 prompt 时等预取的上限，只影响「刚触发、还没回」的情况
const SELF_MEMORY_RECALL_AWAIT_MS = 250;

let selfMemoryTableReady = false;

function selfMemoryTable(db) {
    db.exec(`create table if not exists self_memories (
        id integer primary key autoincrement,
        topic text not null,
        summary text not null,
        detail text not null default '',
        tags text not null default '',
        created_at integer not null,
        updated_at integer not null,
        last_used_at integer not null default 0,
        use_count integer not null default 0
    )`);
    db.exec('create unique index if not exists self_memories_topic on self_memories(topic)');
}

/** 建表每个进程只做一次，避免每轮都拿写锁 */
function selfMemoryEnsure(db) {
    if (selfMemoryTableReady)
        return;
    selfMemoryTable(db);
    selfMemoryTableReady = true;
}

function selfMemoryOpen(readOnly = false) {
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    if (!sqlite)
        return undefined;
    return readOnly
        ? new sqlite.DatabaseSync(SELF_MEMORY_DB_FILE(), { readOnly: true })
        : new sqlite.DatabaseSync(SELF_MEMORY_DB_FILE());
}

function selfMemoryList() {
    const db = selfMemoryOpen();
    if (!db)
        return [];
    try {
        selfMemoryEnsure(db);
        return db.prepare('select * from self_memories order by updated_at desc limit ?')
            .all(SELF_MEMORY_SEARCH_POOL);
    }
    catch {
        return [];
    }
    finally {
        db.close();
    }
}

function selfMemoryXiangxinKey() {
    let key = String(process.env.XIANGXIN_API_KEY ?? '').trim();
    if (key !== '')
        return key;
    try {
        const fs = process.getBuiltinModule?.('node:fs');
        const os = process.getBuiltinModule?.('node:os');
        const yaml = fs.readFileSync(`${os.homedir()}/.dsh/.credentials.yaml`, 'utf8');
        const match = yaml.match(/XIANGXIN_API_KEY:\s*(\S+)/);
        return match ? match[1].trim() : '';
    }
    catch {
        return '';
    }
}

function selfMemoryRecentChat(gid) {
    const bucket = globalThis.__qqbotRecentMessages?.get?.(gid) ?? [];
    return bucket.slice(-6).map((item) => {
        const content = String(item?.content ?? '')
            .replace(/\[(图片|视频|文件|表情|动画表情|表情包)[^\]]*\]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        return content === '' ? '' : `${item?.name ?? ''}：${content.slice(0, 120)}`;
    }).filter(Boolean).join('\n').slice(0, 700);
}

function selfMemoryExactHit(rows, query) {
    const wanted = String(query ?? '').trim().toLowerCase();
    if (wanted === '')
        return undefined;
    return rows.find((row) => String(row.topic ?? '').trim().toLowerCase() === wanted);
}

/** 象信按意思挑：把记忆拆成 ≤200 个选项，多个分片并行，再合并概率 */
async function selfMemoryJudge(rows, query, gid, timeoutMs = 8000) {
    const key = selfMemoryXiangxinKey();
    if (key === '' || rows.length === 0)
        return undefined;
    const chunks = [];
    for (let i = 0; i < rows.length; i += SELF_MEMORY_CHOICES_PER_CALL)
        chunks.push(rows.slice(i, i + SELF_MEMORY_CHOICES_PER_CALL));
    const recent = selfMemoryRecentChat(gid);
    const scored = await Promise.all(chunks.map(async (chunk) => {
        const criteria = {};
        for (const row of chunk)
            criteria[row.topic] = row.summary;
        criteria['都不是'] = '这段聊天和她的任何一段亲身经历、见闻都没有关系';
        const body = {
            model: 'xiangxin-latest',
            state: { 查询: query, 最近群聊: recent || '（无）' },
            questions: {
                命中: {
                    type: 'choice',
                    instructions: '`查询`（必要时结合 `最近群聊`）碰到了小易自己的哪一段亲身经历或见闻？只有话题确实相关、她可以顺势提起时才选；普通闲聊、只在聊别人的事时选「都不是」。',
                    criteria,
                },
            },
        };
        try {
            const res = await fetch('https://api.xiangxinai.cn/v1/systemone', {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!res.ok)
                return [];
            const probabilities = (await res.json())?.answers?.命中?.probabilities ?? {};
            return chunk.map((row) => ({ row, p: Number(probabilities[row.topic] ?? 0) })).filter((item) => item.p > 0);
        }
        catch {
            return [];
        }
    }));
    return scored.flat().sort((a, b) => b.p - a.p);
}

function selfMemoryTouch(ids) {
    if (ids.length === 0)
        return;
    const db = selfMemoryOpen();
    if (!db)
        return;
    try {
        const now = Date.now();
        const update = db.prepare('update self_memories set last_used_at = ?, use_count = use_count + 1 where id = ?');
        for (const id of ids)
            update.run(now, id);
    }
    catch {
        // 统计失败不影响检索
    }
    finally {
        db.close();
    }
}

// ---- 后台预取：每条群消息先问一次「这句碰到她哪段经历」，命中的缓存给下一轮用 ----

/** gid → { at, query, hits: [{ topic, summary, detail, tags }] } */
const selfMemoryRecallCache = new Map();
/** gid → 最新一条待判文本（后来的覆盖先来的，避免一次发言刷出一串请求） */
const selfMemoryRecallQueue = new Map();
/** gid → 正在跑的任务 */
const selfMemoryRecallRunning = new Map();

function selfMemoryRecallHits(rows) {
    return rows.slice(0, 2).map((row) => ({
        topic: String(row.topic ?? ''),
        summary: String(row.summary ?? ''),
        detail: String(row.detail ?? ''),
        tags: String(row.tags ?? ''),
    }));
}

async function selfMemoryRecallOne(gid, text) {
    const clean = text
        .replace(/\[(图片|视频|文件|表情|动画表情|表情包)[^\]]*\]/g, '')
        .replace(/【表情[：:][^】]*】/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    // 寒暄、单字、纯占位符没必要问
    if (clean.length < SELF_MEMORY_RECALL_MIN_CHARS)
        return;
    const rows = selfMemoryList();
    if (rows.length === 0)
        return;
    const exact = selfMemoryExactHit(rows, clean);
    if (exact) {
        selfMemoryRecallCache.set(gid, { at: Date.now(), query: clean, hits: selfMemoryRecallHits([exact]) });
        return;
    }
    // 预取只是提前攒上下文，超时就放弃，别把同群的后续消息堵在后面
    const judged = await selfMemoryJudge(rows, clean, gid, 3000);
    // 象信不可用（undefined）时保留上一次命中，别把上下文清空
    if (!judged)
        return;
    const hits = judged.filter((item) => item.p >= SELF_MEMORY_RECALL_HIT_P).map((item) => item.row);
    if (hits.length === 0)
        return;
    selfMemoryRecallCache.set(gid, { at: Date.now(), query: clean, hits: selfMemoryRecallHits(hits) });
}

/**
 * 入站消息预取（异步、不阻塞消息处理）。
 * 同一个群同时只跑一个任务，后来的消息排队（只留最新一条）。
 */
function selfMemoryPrefetch(gid, content) {
    const text = String(content ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!gid || text === '')
        return Promise.resolve();
    const running = selfMemoryRecallRunning.get(gid);
    if (running) {
        selfMemoryRecallQueue.set(gid, text);
        return running;
    }
    selfMemoryRecallQueue.set(gid, text);
    const task = (async () => {
        try {
            while (selfMemoryRecallQueue.has(gid)) {
                const next = selfMemoryRecallQueue.get(gid);
                selfMemoryRecallQueue.delete(gid);
                try {
                    await selfMemoryRecallOne(gid, next);
                }
                catch {
                    // 预取失败不影响对话
                }
            }
        }
        finally {
            selfMemoryRecallRunning.delete(gid);
            // 收尾瞬间刚好又插进一条：接着跑，别把它落在队列里
            if (selfMemoryRecallQueue.has(gid))
                void selfMemoryPrefetch(gid, selfMemoryRecallQueue.get(gid) ?? '');
        }
    })();
    selfMemoryRecallRunning.set(gid, task);
    return task;
}

/** 同步读缓存，拼成一段可注入的 prompt 文本（没命中返回空串） */
function selfMemoryRecallSnapshot(gid) {
    const entry = selfMemoryRecallCache.get(gid);
    if (!entry)
        return '';
    if (Date.now() - entry.at > SELF_MEMORY_RECALL_TTL_MS) {
        selfMemoryRecallCache.delete(gid);
        return '';
    }
    if (!entry.hits || entry.hits.length === 0)
        return '';
    const lines = entry.hits.map((hit) => {
        const detail = hit.detail.replace(/\s+/g, ' ').trim();
        return `- ${hit.topic}：${hit.summary}${detail ? `（${detail.slice(0, 200)}）` : ''}`;
    });
    return `【你自己的记忆·和这段聊天有关】下面是你自己的亲身经历或见闻，不是群友说的事，也不是群里的八卦：\n${lines.join('\n')}\n（这些只是你心里知道的事：别主动提、别到处说，也别当谈资复述。只有话题真的碰到时才像突然想起来一样自然带一句，不要背设定。）`;
}

/**
 * 组装 prompt 时调用：有命中立刻返回；
 * 刚好有一条预取在路上时最多等一会儿（首条消息就提问的场景），超时就先不带。
 */
async function selfMemoryRecallLine(gid, waitMs = SELF_MEMORY_RECALL_AWAIT_MS) {
    const hit = selfMemoryRecallSnapshot(gid);
    if (hit !== '')
        return hit;
    const running = selfMemoryRecallRunning.get(gid);
    if (!running)
        return '';
    await Promise.race([
        running,
        new Promise((resolve) => {
            const timer = setTimeout(resolve, waitMs);
            if (typeof timer.unref === 'function')
                timer.unref();
        }),
    ]);
    return selfMemoryRecallSnapshot(gid);
}

/** 写入 / 更新一条私人记忆（维护脚本与测试用；不开放成群聊工具） */
function selfMemorySave(args) {
    const topic = String(args?.topic ?? '').trim().slice(0, 40);
    const summary = String(args?.summary ?? '').trim().slice(0, 160);
    if (topic.length < 2)
        return { ok: false, message: 'topic 太短，至少 2 个字。' };
    if (summary === '')
        return { ok: false, message: '缺一句话概括（summary）。' };
    const detail = String(args?.detail ?? '').trim().slice(0, 1200);
    const tags = String(args?.tags ?? '').split(/\s+/).filter(Boolean).join(' ');
    const db = selfMemoryOpen();
    if (!db)
        return { ok: false, message: '记忆库暂时不可用（sqlite 没加载）。' };
    try {
        selfMemoryEnsure(db);
        const now = Date.now();
        const existing = db.prepare('select id from self_memories where lower(topic) = lower(?) limit 1').get(topic);
        if (existing) {
            db.prepare('update self_memories set summary = ?, detail = ?, tags = ?, updated_at = ? where id = ?')
                .run(summary, detail, tags, now, existing.id);
            return { ok: true, message: `已更新「${topic}」`, topic };
        }
        db.prepare('insert into self_memories (topic, summary, detail, tags, created_at, updated_at, last_used_at, use_count) values (?, ?, ?, ?, ?, ?, 0, 0)')
            .run(topic, summary, detail, tags, now, now);
        return { ok: true, message: `已记住「${topic}」`, topic };
    }
    catch (err) {
        return { ok: false, message: `记忆写入失败：${err instanceof Error ? err.message : String(err)}` };
    }
    finally {
        db.close();
    }
}

function selfMemoryStats() {
    const db = selfMemoryOpen(true);
    if (!db)
        return { ok: false, total: 0 };
    try {
        const row = db.prepare('select count(*) as n from self_memories').get();
        return { ok: true, total: Number(row?.n ?? 0) };
    }
    catch {
        return { ok: false, total: 0 };
    }
    finally {
        db.close();
    }
}

globalThis.__qqbotSelfMemory = {
    list: selfMemoryList,
    prefetch: selfMemoryPrefetch,
    recallLine: selfMemoryRecallLine,
    save: selfMemorySave,
    stats: selfMemoryStats,
};
/* <<< dsh-qqbot-patch:self-memory-helper <<< */

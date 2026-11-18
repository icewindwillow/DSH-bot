/* >>> dsh-qqbot-patch:meme-helper >>> */
/**
 * 群梗 / 黑话记忆库
 *
 * 和 memories 分开存：梗库要的是「词条 + 一句话解释 + 出处 + 别名」，
 * 而不是某个人某天说的一句话。存进 ltm.db 的 memes 表，不改原表。
 *
 * - 保存：meme_save（模型联网确认含义后写入，或群里有人解释时直接写入）
 * - 召回：meme_search 用象信做「这句话在说哪个梗」的语义判断，不用正则硬匹配
 * - 注入：每轮只放一条常驻规则；另有一条后台预取——
 *         每条群消息都异步问一次象信「这句话在说库里的哪个梗」，
 *         命中的那一条缓存起来，轮到她说话时直接带上解释，
 *         所以「小张是谁」这种只出现别名的追问也能接住，而不用等模型自己想起来查。
 *
 * scope：global（公共的游戏/影视梗，所有群可见）/ qq:group:<gid>（群内黑话，只在本群可见）
 */
const MEME_DB_FILE = () => process.env.QQBOT_MEMORY_DB ?? `${process.env.HOME ?? ''}/.dsh/memory/ltm.db`;
const MEME_SEARCH_POOL = 480;
const MEME_CHOICES_PER_CALL = 200;
// 预取缓存：只保留「这段聊天里刚提到过」的命中，10 分钟后自然过期。
// 没命中时不清空——「我怎么没看到这个人」这类追问本身看不出在说谁，
// 清掉反而正好丢掉上一条攒下的命中。
const MEME_RECALL_TTL_MS = 10 * 60 * 1000;
// 自动注入比手动检索更严：宁可少带一条，也不要每句话都硬塞一个不相干的梗。
const MEME_RECALL_HIT_P = 0.35;
const MEME_RECALL_MIN_CHARS = 4;
// 组装 prompt 时等预取的上限：只影响「这条消息刚触发预取、还没回」的情况，
// 250ms 基本感觉不到；再长就会拖慢每条普通回复。
const MEME_RECALL_AWAIT_MS = 250;

let memeTableReady = false;

function memeTable(db) {
    db.exec(`create table if not exists memes (
        id integer primary key autoincrement,
        term text not null,
        aliases text not null default '',
        summary text not null,
        detail text not null default '',
        tags text not null default '',
        scope text not null default 'global',
        source text not null default '',
        pinned integer not null default 0,
        created_at integer not null,
        updated_at integer not null,
        last_used_at integer not null default 0,
        use_count integer not null default 0
    )`);
    db.exec('create unique index if not exists memes_term_scope on memes(term, scope)');
}

/** 建表每个进程只做一次，避免每轮都拿写锁 */
function memeEnsure(db) {
    if (memeTableReady)
        return;
    memeTable(db);
    memeTableReady = true;
}

function memeOpen(readOnly = false) {
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    if (!sqlite)
        return undefined;
    return readOnly
        ? new sqlite.DatabaseSync(MEME_DB_FILE(), { readOnly: true })
        : new sqlite.DatabaseSync(MEME_DB_FILE());
}

function memeSplitAliases(value) {
    const raw = Array.isArray(value) ? value : String(value ?? '').split(/[\s,，、/|]+/);
    return [...new Set(raw.map((item) => String(item ?? '').trim()).filter((item) => item !== ''))];
}

function memeScopeOf(gid) {
    return gid ? `qq:group:${gid}` : 'global';
}

function memeList(gid, limit = MEME_SEARCH_POOL) {
    const db = memeOpen();
    if (!db)
        return [];
    try {
        memeEnsure(db);
        const scope = memeScopeOf(gid);
        return db.prepare('select * from memes where scope = ? or scope = ? order by pinned desc, updated_at desc limit ?')
            .all('global', scope, Math.max(1, limit));
    }
    catch {
        return [];
    }
    finally {
        db.close();
    }
}

/** 同一个词条在 global / 本群都有时，本群的优先（更具体） */
function memeDedupe(rows) {
    const seen = new Map();
    for (const row of rows) {
        const key = String(row.term ?? '').trim().toLowerCase();
        if (key === '')
            continue;
        const prev = seen.get(key);
        if (!prev || String(row.scope).startsWith('qq:group:'))
            seen.set(key, row);
    }
    return [...seen.values()];
}

/** 常驻硬规则：不注入任何词条，只在需要时让模型自己调 meme_search */
const MEME_RULE = [
    '【梗库】遇到游戏/影视/群内黑话里的人名、外号、缩写或设定，只要本次上下文里没被解释过，先调 meme_search 查梗库；即使你觉得你知道，也先确认，别猜。',
    '库里没有、又确实影响接话时，才用 web_search 查一次；确认含义后用 meme_save 记下来（一句话解释 + 出处 + 别名），以后就不用再搜。',
    '有人已经把梗解释清楚时，直接 meme_save。别记普通词、一次性玩笑和隐私信息。',
].join('');

function memePromptLine() {
    return MEME_RULE;
}

function memeXiangxinKey() {
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

function memeRecentChat(gid) {
    const bucket = globalThis.__qqbotRecentMessages?.get?.(gid) ?? [];
    return bucket.slice(-6).map((item) => {
        const content = String(item?.content ?? '')
            .replace(/\[(图片|视频|文件|表情|动画表情|表情包)[^\]]*\]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        return content === '' ? '' : `${item?.name ?? ''}：${content.slice(0, 120)}`;
    }).filter(Boolean).join('\n').slice(0, 700);
}

function memeExactHit(rows, query) {
    const wanted = String(query ?? '').trim().toLowerCase();
    if (wanted === '')
        return undefined;
    for (const row of rows) {
        const names = [row.term, ...memeSplitAliases(row.aliases)]
            .map((name) => String(name ?? '').trim().toLowerCase())
            .filter(Boolean);
        if (names.includes(wanted))
            return row;
    }
    return undefined;
}

/** 象信按意思挑：把词库拆成 ≤200 个选项，多个分片并行，再合并概率 */
async function memeJudge(rows, query, gid, timeoutMs = 8000) {
    const key = memeXiangxinKey();
    if (key === '' || rows.length === 0)
        return undefined;
    const chunks = [];
    for (let i = 0; i < rows.length; i += MEME_CHOICES_PER_CALL)
        chunks.push(rows.slice(i, i + MEME_CHOICES_PER_CALL));
    const recent = memeRecentChat(gid);
    const scored = await Promise.all(chunks.map(async (chunk) => {
        const criteria = {};
        for (const row of chunk)
            criteria[row.term] = `${row.summary}${row.aliases ? `（也叫：${row.aliases}）` : ''}`;
        criteria['都不是'] = '列表里没有对应的梗、黑话、外号或人物';
        const body = {
            model: 'xiangxin-latest',
            state: { 查询: query, 最近群聊: recent || '（无）' },
            questions: {
                命中: {
                    type: 'choice',
                    instructions: '`查询`（必要时结合 `最近群聊`）在说下面哪个梗、黑话、外号或游戏/影视人物？按意思判断，不要只看字面；只是普通词语或没有对应项时选「都不是」。',
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
            return chunk.map((row) => ({ row, p: Number(probabilities[row.term] ?? 0) })).filter((item) => item.p > 0);
        }
        catch {
            return [];
        }
    }));
    return scored.flat().sort((a, b) => b.p - a.p);
}

function memeTouch(ids) {
    if (ids.length === 0)
        return;
    const db = memeOpen();
    if (!db)
        return;
    try {
        const now = Date.now();
        const update = db.prepare('update memes set last_used_at = ?, use_count = use_count + 1 where id = ?');
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

async function memeSearch(query, { gid, limit = 3 } = {}) {
    const text = String(query ?? '').trim();
    if (text === '')
        return [];
    const rows = memeDedupe(memeList(gid));
    if (rows.length === 0)
        return [];
    const exact = memeExactHit(rows, text);
    if (exact) {
        memeTouch([exact.id]);
        return [{ ...exact, score: 1 }];
    }
    const judged = await memeJudge(rows, text, gid);
    if (judged && judged.length > 0) {
        const hits = judged.filter((item) => item.p >= 0.12).slice(0, Math.max(1, Math.min(5, limit)));
        memeTouch(hits.map((item) => item.row.id));
        return hits.map((item) => ({ ...item.row, score: item.p }));
    }
    // 象信不可用时的降级：只认「词条/别名直接出现在原话里」，不做正则猜测
    const hits = rows.filter((row) => [row.term, ...memeSplitAliases(row.aliases)]
        .some((name) => name.length >= 2 && text.includes(name)))
        .slice(0, Math.max(1, Math.min(5, limit)));
    memeTouch(hits.map((row) => row.id));
    return hits.map((row) => ({ ...row, score: 0 }));
}

// ---- 后台预取：每条群消息先问一次「这句在说哪个梗」，命中的缓存给下一轮用 ----

/** gid → { at, query, hits: [{ term, summary, detail, aliases }] } */
const memeRecallCache = new Map();
/** gid → 最新一条待判文本（后来的覆盖先来的，避免一次发言刷出一串请求） */
const memeRecallQueue = new Map();
/** gid → 正在跑的任务 */
const memeRecallRunning = new Map();

function memeRecallHits(rows) {
    return rows.slice(0, 2).map((row) => ({
        term: String(row.term ?? ''),
        summary: String(row.summary ?? ''),
        detail: String(row.detail ?? ''),
        aliases: String(row.aliases ?? ''),
    }));
}

async function memeRecallOne(gid, text) {
    const clean = text
        .replace(/\[(图片|视频|文件|表情|动画表情|表情包)[^\]]*\]/g, '')
        .replace(/【表情[：:][^】]*】/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    // 寒暄、单字、纯占位符没必要问
    if (clean.length < MEME_RECALL_MIN_CHARS)
        return;
    const rows = memeDedupe(memeList(gid));
    if (rows.length === 0)
        return;
    const exact = memeExactHit(rows, clean);
    if (exact) {
        memeRecallCache.set(gid, { at: Date.now(), query: clean, hits: memeRecallHits([exact]) });
        return;
    }
    // 预取只是提前攒上下文，超时就放弃，别把同群的后续消息堵在后面
    const judged = await memeJudge(rows, clean, gid, 3000);
    // 象信不可用（undefined）时保留上一次命中，别把上下文清空
    if (!judged)
        return;
    const hits = judged.filter((item) => item.p >= MEME_RECALL_HIT_P).map((item) => item.row);
    if (hits.length === 0)
        return;
    memeRecallCache.set(gid, { at: Date.now(), query: clean, hits: memeRecallHits(hits) });
}

/**
 * 入站消息预取（异步、不阻塞消息处理）。
 * 同一个群同时只跑一个任务，后来的消息排队（只留最新一条）。
 * 返回任务 Promise，方便测试等待。
 */
function memePrefetch(gid, content) {
    const text = String(content ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!gid || text === '')
        return Promise.resolve();
    const running = memeRecallRunning.get(gid);
    if (running) {
        memeRecallQueue.set(gid, text);
        return running;
    }
    memeRecallQueue.set(gid, text);
    const task = (async () => {
        try {
            while (memeRecallQueue.has(gid)) {
                const next = memeRecallQueue.get(gid);
                memeRecallQueue.delete(gid);
                try {
                    await memeRecallOne(gid, next);
                }
                catch {
                    // 预取失败不影响对话
                }
            }
        }
        finally {
            memeRecallRunning.delete(gid);
            // 收尾瞬间刚好又插进一条：接着跑，别把它落在队列里
            if (memeRecallQueue.has(gid))
                void memePrefetch(gid, memeRecallQueue.get(gid) ?? '');
        }
    })();
    memeRecallRunning.set(gid, task);
    return task;
}

/** 同步读缓存，拼成一段可注入的 prompt 文本（没命中返回空串） */
function memeRecallSnapshot(gid) {
    const entry = memeRecallCache.get(gid);
    if (!entry)
        return '';
    if (Date.now() - entry.at > MEME_RECALL_TTL_MS) {
        memeRecallCache.delete(gid);
        return '';
    }
    if (!entry.hits || entry.hits.length === 0)
        return '';
    const lines = entry.hits.map((hit) => {
        const alias = hit.aliases ? `（也叫：${hit.aliases}）` : '';
        const detail = hit.detail.replace(/\s+/g, ' ').trim();
        return `- ${hit.term}${alias}：${hit.summary}${detail ? `；${detail.slice(0, 180)}` : ''}`;
    });
    return `【梗库·这段聊天里提到过】\n${lines.join('\n')}\n（需要接话时直接用这些解释，不用再查；对方已经解释过就别重复。）`;
}

/**
 * 组装 prompt 时调用：有命中立刻返回；
 * 刚好有一条预取在路上时最多等一会儿（首条消息就提问的场景），超时就先不带。
 */
async function memeRecallLine(gid, waitMs = MEME_RECALL_AWAIT_MS) {
    const hit = memeRecallSnapshot(gid);
    if (hit !== '')
        return hit;
    const running = memeRecallRunning.get(gid);
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
    return memeRecallSnapshot(gid);
}

function memeSave(args, gid) {
    const term = String(args?.term ?? '').trim().slice(0, 40);
    const summary = String(args?.summary ?? '').trim().slice(0, 120);
    if (term.length < 2)
        return { ok: false, message: '词条名太短，至少 2 个字。' };
    if (summary === '')
        return { ok: false, message: '缺一句话解释（summary）。' };
    const wantedScope = String(args?.scope ?? '').toLowerCase();
    const scope = wantedScope === 'global' ? 'global' : memeScopeOf(gid);
    if (wantedScope !== 'global' && scope === 'global')
        return { ok: false, message: '不知道当前在哪个群，这条先没记。' };
    const aliases = memeSplitAliases(args?.aliases).join(' ');
    const detail = String(args?.detail ?? '').trim().slice(0, 800);
    const tags = memeSplitAliases(args?.tags).join(' ');
    const source = String(args?.source ?? '').trim().slice(0, 300);
    const db = memeOpen();
    if (!db)
        return { ok: false, message: '梗库暂时不可用（sqlite 没加载）。' };
    try {
        memeEnsure(db);
        const now = Date.now();
        const existing = db.prepare('select * from memes where lower(term) = lower(?) and scope = ? limit 1').get(term, scope);
        if (existing) {
            const mergedAliases = memeSplitAliases(`${existing.aliases ?? ''} ${aliases}`).join(' ');
            db.prepare('update memes set aliases = ?, summary = ?, detail = ?, tags = ?, source = ?, updated_at = ? where id = ?')
                .run(mergedAliases, summary, detail || String(existing.detail ?? ''), tags || String(existing.tags ?? ''), source || String(existing.source ?? ''), now, existing.id);
            return { ok: true, message: `已更新「${term}」：${summary}`, term, scope };
        }
        db.prepare('insert into memes (term, aliases, summary, detail, tags, scope, source, pinned, created_at, updated_at, last_used_at, use_count) values (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, 0)')
            .run(term, aliases, summary, detail, tags, scope, source, now, now);
        return { ok: true, message: `已记住「${term}」：${summary}`, term, scope };
    }
    catch (err) {
        return { ok: false, message: `梗库写入失败：${err instanceof Error ? err.message : String(err)}` };
    }
    finally {
        db.close();
    }
}

function memeStats(gid) {
    const db = memeOpen();
    if (!db)
        return { ok: false };
    try {
        memeEnsure(db);
        const scope = memeScopeOf(gid);
        const total = db.prepare('select count(*) c from memes').get().c;
        const local = db.prepare('select count(*) c from memes where scope = ? or scope = ?').get('global', scope).c;
        return { ok: true, total, local, scope };
    }
    catch {
        return { ok: false };
    }
    finally {
        db.close();
    }
}

globalThis.__qqbotMeme = {
    promptLine: memePromptLine,
    recallLine: memeRecallLine,
    prefetch: memePrefetch,
    search: memeSearch,
    save: memeSave,
    list: memeList,
    stats: memeStats,
};
/* <<< dsh-qqbot-patch:meme-helper <<< */

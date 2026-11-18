/* >>> dsh-qqbot-patch:note-helper >>> */
/**
 * 长条目记忆：方案 / 清单 / 长文
 *
 * memories 一条只有 180 字（记忆门控 text.slice(0, 180)），
 * 「一套天赋加点」「一份配置清单」这种塞不进去；单独存 notes 表：
 *   title（标题）+ summary（给语义召回用）+ body（全文，最多 2 万字）
 *
 * - 写：note_save（别人让你记一下就记，不按字数卡；长方案也可以整份存）
 * - 读：note_search，用象信按意思选标题，命中后返回全文
 * - 改：note_update，先按意思选中条目，再用象信定位到具体某一行；分不清就反问，不硬改
 * 与梗库同一套：不加正则，scope = global / qq:group:<gid>
 * 公共库（global）只有主人 / 管理员能写，见 permissions-helper.js 的 note.writeGlobal。
 */
const NOTE_DB_FILE = () => process.env.QQBOT_MEMORY_DB ?? `${process.env.HOME ?? ''}/.dsh/memory/ltm.db`;
const NOTE_SEARCH_POOL = 480;
const NOTE_CHOICES_PER_CALL = 200;
const NOTE_MAX_BODY = 20000;
// 改条目时的置信度门槛：最高分够高、且和第二名拉开差距，才直接改；否则反问
const NOTE_UPDATE_MIN_P = 0.3;
const NOTE_UPDATE_SECOND_P = 0.2;
const NOTE_UPDATE_MARGIN = 0.12;
const NOTE_BLOCK_PREVIEW = 72;

let noteTableReady = false;

function noteTable(db) {
    db.exec(`create table if not exists notes (
        id integer primary key autoincrement,
        title text not null,
        summary text not null default '',
        body text not null,
        tags text not null default '',
        scope text not null default 'global',
        source text not null default '',
        created_at integer not null,
        updated_at integer not null,
        last_used_at integer not null default 0,
        use_count integer not null default 0
    )`);
    db.exec('create unique index if not exists notes_title_scope on notes(title, scope)');
}

function noteEnsure(db) {
    if (noteTableReady)
        return;
    noteTable(db);
    noteTableReady = true;
}

function noteOpen(readOnly = false) {
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    if (!sqlite)
        return undefined;
    return readOnly
        ? new sqlite.DatabaseSync(NOTE_DB_FILE(), { readOnly: true })
        : new sqlite.DatabaseSync(NOTE_DB_FILE());
}

function noteScopeOf(gid) {
    return gid ? `qq:group:${gid}` : 'global';
}

function noteSplit(value) {
    const raw = Array.isArray(value) ? value : String(value ?? '').split(/[\s,，、/|]+/);
    return [...new Set(raw.map((item) => String(item ?? '').trim()).filter((item) => item !== ''))];
}

function noteList(gid, limit = NOTE_SEARCH_POOL) {
    const db = noteOpen();
    if (!db)
        return [];
    try {
        noteEnsure(db);
        return db.prepare('select * from notes where scope = ? or scope = ? order by updated_at desc limit ?')
            .all('global', noteScopeOf(gid), Math.max(1, limit));
    }
    catch {
        return [];
    }
    finally {
        db.close();
    }
}

/** 本群词条优先于同名公共词条 */
function noteDedupe(rows) {
    const seen = new Map();
    for (const row of rows) {
        const key = String(row.title ?? '').trim().toLowerCase();
        if (key === '')
            continue;
        const prev = seen.get(key);
        if (!prev || String(row.scope).startsWith('qq:group:'))
            seen.set(key, row);
    }
    return [...seen.values()];
}

function noteXiangxinKey() {
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

function noteRecentChat(gid) {
    const bucket = globalThis.__qqbotRecentMessages?.get?.(gid) ?? [];
    return bucket.slice(-6).map((item) => {
        const content = String(item?.content ?? '')
            .replace(/\[(图片|视频|文件|表情|动画表情|表情包)[^\]]*\]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        return content === '' ? '' : `${item?.name ?? ''}：${content.slice(0, 120)}`;
    }).filter(Boolean).join('\n').slice(0, 700);
}

function noteExactHit(rows, query) {
    const wanted = String(query ?? '').trim().toLowerCase();
    if (wanted === '')
        return undefined;
    return rows.find((row) => String(row.title ?? '').trim().toLowerCase() === wanted);
}

/** 象信按意思挑标题；分片并行（每片 ≤200 个选项） */
async function noteJudge(rows, query, gid) {
    const key = noteXiangxinKey();
    if (key === '' || rows.length === 0)
        return undefined;
    const chunks = [];
    for (let i = 0; i < rows.length; i += NOTE_CHOICES_PER_CALL)
        chunks.push(rows.slice(i, i + NOTE_CHOICES_PER_CALL));
    const recent = noteRecentChat(gid);
    const scored = await Promise.all(chunks.map(async (chunk) => {
        const criteria = {};
        for (const row of chunk)
            criteria[row.title] = row.summary;
        criteria['都不是'] = '列表里没有对应的方案、清单或长文';
        const body = {
            model: 'xiangxin-latest',
            state: { 查询: query, 最近群聊: recent || '（无）' },
            questions: {
                命中: {
                    type: 'choice',
                    instructions: '`查询`（必要时结合 `最近群聊`）在问下面哪一份方案、清单或长文？按意思判断，不要只看字面；没有对应项时选「都不是」。',
                    criteria,
                },
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
                return [];
            const probabilities = (await res.json())?.answers?.命中?.probabilities ?? {};
            return chunk.map((row) => ({ row, p: Number(probabilities[row.title] ?? 0) })).filter((item) => item.p > 0);
        }
        catch {
            return [];
        }
    }));
    return scored.flat().sort((a, b) => b.p - a.p);
}

function noteTouch(ids) {
    if (ids.length === 0)
        return;
    const db = noteOpen();
    if (!db)
        return;
    try {
        const now = Date.now();
        const update = db.prepare('update notes set last_used_at = ?, use_count = use_count + 1 where id = ?');
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

async function noteSearch(query, { gid, limit = 2 } = {}) {
    const text = String(query ?? '').trim();
    if (text === '')
        return [];
    const rows = noteDedupe(noteList(gid));
    if (rows.length === 0)
        return [];
    const max = Math.max(1, Math.min(3, limit));
    const exact = noteExactHit(rows, text);
    if (exact) {
        noteTouch([exact.id]);
        return [{ ...exact, score: 1 }];
    }
    const judged = await noteJudge(rows, text, gid);
    if (judged && judged.length > 0) {
        const hits = judged.filter((item) => item.p >= 0.12).slice(0, max);
        noteTouch(hits.map((item) => item.row.id));
        return hits.map((item) => ({ ...item.row, score: item.p }));
    }
    // 象信不可用：只认标题/摘要/标签里的原话
    const hits = rows.filter((row) => `${row.title} ${row.summary} ${row.tags}`.toLowerCase().includes(text.toLowerCase())).slice(0, max);
    noteTouch(hits.map((row) => row.id));
    return hits.map((row) => ({ ...row, score: 0 }));
}

function noteSave(args, gid, sender) {
    const title = String(args?.title ?? '').trim();
    const body = String(args?.body ?? '').trim();
    if (title === '')
        return { ok: false, message: 'title 不能为空，写清这是什么。' };
    if (body === '')
        return { ok: false, message: 'body 不能为空。' };
    const wantedScope = String(args?.scope ?? '').toLowerCase();
    // 公共库跨群可见，只有主人 / 管理员能写；普通成员记在本群
    if (wantedScope === 'global' && sender && globalThis.__qqbotPerm?.can?.(sender, 'note.writeGlobal') !== true)
        return { ok: false, message: '公共库只有主人或管理员能写；要记的话我改存本群。' };
    const db = noteOpen();
    if (!db)
        return { ok: false, message: '数据库不可用，这条先没存。' };
    try {
        noteEnsure(db);
        const scope = wantedScope === 'global' ? 'global' : noteScopeOf(gid);
        if (wantedScope !== 'global' && scope === 'global')
            return { ok: false, message: '当前不在群里；群内长文请指定 scope=global 或先在群里再说。' };
        const summary = String(args?.summary ?? '').trim() || body.replace(/\s+/g, ' ').slice(0, 120);
        const tags = noteSplit(args?.tags).join(' ');
        const source = String(args?.source ?? '').trim();
        const now = Date.now();
        const existing = db.prepare('select id from notes where lower(title) = lower(?) and scope = ?').get(title, scope);
        if (existing) {
            db.prepare('update notes set summary = ?, body = ?, tags = ?, source = ?, updated_at = ? where id = ?')
                .run(summary, body.slice(0, NOTE_MAX_BODY), tags, source, now, existing.id);
            return { ok: true, message: `已更新长条目「${title}」（${body.length} 字）。`, title, scope };
        }
        db.prepare('insert into notes (title, summary, body, tags, scope, source, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(title, summary, body.slice(0, NOTE_MAX_BODY), tags, scope, source, now, now);
        return { ok: true, message: `已存入长条目「${title}」（${body.length} 字）。`, title, scope };
    }
    catch (error) {
        return { ok: false, message: `写入失败：${String(error?.message ?? error)}` };
    }
    finally {
        db.close();
    }
}

/** 正文按行拆成可改的块：每个非空行一项，行号从 1 开始（含空行） */
function noteLineBlocks(body) {
    const lines = String(body ?? '').split('\n');
    const blocks = [];
    let pos = 0;
    for (let i = 0; i < lines.length; i += 1) {
        const text = lines[i];
        if (text.trim() !== '')
            blocks.push({ index: i + 1, start: pos, end: pos + text.length, text });
        pos += text.length + 1;
    }
    return blocks;
}

function noteBlockLabel(block) {
    const preview = block.text.replace(/\s+/g, ' ').trim().slice(0, NOTE_BLOCK_PREVIEW);
    return `${block.index}. ${preview}`;
}

/** 象信按意思挑「这一份里的哪一行」；分片并行 */
async function noteJudgeBlocks(blocks, query, title) {
    const key = noteXiangxinKey();
    if (key === '' || blocks.length === 0)
        return undefined;
    const chunks = [];
    for (let i = 0; i < blocks.length; i += NOTE_CHOICES_PER_CALL)
        chunks.push(blocks.slice(i, i + NOTE_CHOICES_PER_CALL));
    const scored = await Promise.all(chunks.map(async (chunk) => {
        const criteria = {};
        for (const block of chunk)
            criteria[noteBlockLabel(block)] = block.text.replace(/\s+/g, ' ').trim().slice(0, 160);
        criteria['都不是'] = '这份长条目里没有对应的一项';
        const body = {
            model: 'xiangxin-latest',
            state: { 查询: query, 长条目: title },
            questions: {
                命中: {
                    type: 'choice',
                    instructions: '`查询` 要改的是下面哪一行/哪一段？按意思判断；如果有多行都像，选最直接对应的一项；都不对应选「都不是」。',
                    criteria,
                },
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
                return { items: [], noneP: 0 };
            const probabilities = (await res.json())?.answers?.命中?.probabilities ?? {};
            return {
                items: chunk
                    .map((block) => ({ block, p: Number(probabilities[noteBlockLabel(block)] ?? 0) }))
                    .filter((item) => item.p > 0),
                noneP: Number(probabilities['都不是'] ?? 0),
            };
        }
        catch {
            return { items: [], noneP: 0 };
        }
    }));
    return {
        items: scored.flatMap((chunk) => chunk.items).sort((a, b) => b.p - a.p),
        noneP: Math.max(...scored.map((chunk) => chunk.noneP), 0),
    };
}

/** 最高分够高且和第二名拉开差距才返回 top；否则标记 ambiguous */
function notePickScored(items) {
    if (!items || items.length === 0)
        return { top: undefined, ambiguous: false };
    const sorted = [...items].sort((a, b) => b.p - a.p);
    const top = sorted[0];
    if (top.p < NOTE_UPDATE_MIN_P)
        return { top: undefined, ambiguous: false };
    const second = sorted[1];
    if (second && second.p >= NOTE_UPDATE_SECOND_P && top.p - second.p < NOTE_UPDATE_MARGIN)
        return { top: undefined, ambiguous: true, candidates: sorted.slice(0, 3) };
    return { top, ambiguous: false };
}

function noteAskNotes(rows, query) {
    const question = `库里有几份都像你说的「${query}」，你指的是哪一份？`;
    return {
        ok: false,
        needConfirm: true,
        message: question,
        question,
        candidates: rows.map((row) => ({
            kind: 'note',
            noteId: Number(row.id),
            title: String(row.title ?? ''),
            preview: String(row.summary ?? '').slice(0, 100),
            score: Number(row.score ?? 0),
        })),
    };
}

function noteAskBlocks(note, items, query, question) {
    const text = question ?? `「${note.title}」里有几处像「${query}」，你指的是哪一条？`;
    return {
        ok: false,
        needConfirm: true,
        message: text,
        question: text,
        title: String(note.title ?? ''),
        noteId: Number(note.id),
        candidates: items.map((item) => ({
            kind: 'block',
            noteId: Number(note.id),
            block: item.block.index,
            preview: item.block.text.replace(/\s+/g, ' ').trim().slice(0, 100),
            score: Number(item.p ?? 0),
        })),
    };
}

function noteWriteBody(id, body) {
    const db = noteOpen();
    if (!db)
        return false;
    try {
        noteEnsure(db);
        db.prepare('update notes set body = ?, updated_at = ? where id = ?').run(String(body).slice(0, NOTE_MAX_BODY), Date.now(), id);
        return true;
    }
    catch {
        return false;
    }
    finally {
        db.close();
    }
}

/** 整行替换看起来会把原信息冲掉时，先让调用方确认 */
function noteReplaceLooksLossy(oldText, newText) {
    const oldTrim = String(oldText ?? '').trim();
    const newTrim = String(newText ?? '').trim();
    if (oldTrim === '' || newTrim === '' || oldTrim.length < 8)
        return false;
    const oldPipes = (oldTrim.match(/\|/g) ?? []).length;
    const newPipes = (newTrim.match(/\|/g) ?? []).length;
    if (oldPipes >= 2 && newPipes < 2)
        return true;
    const label = oldTrim.match(/^([^：:|]{1,16})[：:]/);
    if (label && !newTrim.includes(label[1]))
        return true;
    return oldTrim.length >= 30 && newTrim.length < oldTrim.length / 2;
}

/**
 * 改长条目里的某一项。
 * mode=replace：change 必须是替换后的完整那一行/那一段；
 * mode=append：change 追加到末尾；
 * mode=delete：删掉匹配到的那一行。
 * 条目或行分不清时返回 needConfirm + candidates，由调用方去问用户，
 * 用户确认后带 noteId / block 再调一次即可精确落刀。
 */
async function noteUpdate(args, gid) {
    const query = String(args?.query ?? '').trim();
    const change = String(args?.change ?? '');
    const modeRaw = String(args?.mode ?? 'replace').trim().toLowerCase();
    const mode = ['replace', 'append', 'delete'].includes(modeRaw) ? modeRaw : 'replace';
    const noteId = Number(args?.noteId);
    if (mode === 'replace' && change.trim() === '')
        return { ok: false, needConfirm: false, message: 'change 不能为空；改某一项时请写替换后的完整内容。' };
    if (mode === 'append' && change.trim() === '')
        return { ok: false, needConfirm: false, message: '要追加的内容不能为空。' };
    if (mode === 'delete' && change.trim() !== '')
        return { ok: false, needConfirm: false, message: '删除时不要带 change。' };
    if (query === '' && !(Number.isFinite(noteId) && noteId > 0))
        return { ok: false, needConfirm: false, message: '告诉我你要改哪一份、哪一项。' };

    const rows = noteDedupe(noteList(gid));
    if (rows.length === 0)
        return { ok: false, needConfirm: false, message: '还没有存过长条目。' };

    let note;
    if (Number.isFinite(noteId) && noteId > 0) {
        note = rows.find((row) => Number(row.id) === noteId);
        if (!note)
            return { ok: false, needConfirm: false, message: `找不到 id=${noteId} 的长条目（可能不在本群可见范围）。` };
    }
    else {
        const wanted = String(args?.title ?? '').trim();
        if (wanted !== '') {
            const exact = rows.find((row) => String(row.title ?? '').trim().toLowerCase() === wanted.toLowerCase());
            if (exact)
                note = exact;
            else {
                const near = rows.filter((row) => String(row.title ?? '').toLowerCase().includes(wanted.toLowerCase()));
                if (near.length === 1)
                    note = near[0];
                else if (near.length > 1)
                    return noteAskNotes(near.slice(0, 3).map((row) => ({ ...row, score: 0.9 })), wanted);
            }
        }
        if (!note) {
            const judged = await noteJudge(rows, query || wanted, gid);
            if (judged && judged.length > 0) {
                const picked = notePickScored(judged);
                if (picked.ambiguous)
                    return noteAskNotes(picked.candidates.map((item) => ({ ...item.row, score: item.p })), query || wanted);
                if (!picked.top) {
                    const weak = judged.filter((item) => item.p >= 0.05).slice(0, 3);
                    if (weak.length > 0)
                        return noteAskNotes(weak.map((item) => ({ ...item.row, score: item.p })), query || wanted);
                    return { ok: false, needConfirm: false, message: `没找到「${query || wanted}」对应的长条目。` };
                }
                note = picked.top.row;
            }
            else {
                // 象信不可用：只认标题/摘要/标签里的原话
                const needle = (query || wanted).toLowerCase();
                const literal = rows.filter((row) => `${row.title} ${row.summary} ${row.tags}`.toLowerCase().includes(needle));
                if (literal.length === 1)
                    note = literal[0];
                else if (literal.length > 1)
                    return noteAskNotes(literal.slice(0, 3).map((row) => ({ ...row, score: 1 })), query || wanted);
                else
                    return { ok: false, needConfirm: false, message: `没找到「${query || wanted}」对应的长条目。` };
            }
        }
    }

    const body = String(note.body ?? '');
    if (mode === 'append') {
        const addition = change.trim();
        const next = `${body.replace(/\s+$/, '')}\n\n${addition}`;
        if (next.length > NOTE_MAX_BODY)
            return { ok: false, needConfirm: false, message: '追加后超过 2 万字，先拆成两条再存。' };
        if (!noteWriteBody(note.id, next))
            return { ok: false, needConfirm: false, message: '写入失败，没改动。' };
        return {
            ok: true,
            needConfirm: false,
            message: `已在「${note.title}」末尾追加 ${addition.length} 字。`,
            title: String(note.title ?? ''),
            noteId: Number(note.id),
            updated: addition,
        };
    }

    const blocks = noteLineBlocks(body);
    if (blocks.length === 0)
        return { ok: false, needConfirm: false, message: '这份长条目正文是空的，没有可改的项。' };

    let target;
    const wantedBlock = Number(args?.block);
    if (Number.isFinite(wantedBlock) && wantedBlock > 0) {
        target = blocks.find((block) => block.index === wantedBlock);
        if (!target)
            return { ok: false, needConfirm: false, message: `「${note.title}」没有第 ${wantedBlock} 行（正文共 ${blocks.length} 个非空行）。` };
    }
    else {
        const judged = await noteJudgeBlocks(blocks, query || change, note.title);
        if (judged) {
            const picked = notePickScored(judged.items);
            // 「都不是」比最高分还高 → 视为没对上，继续走原话兜底
            if (picked.top && judged.noneP < picked.top.p)
                target = picked.top.block;
            else if (picked.ambiguous)
                return noteAskBlocks(note, picked.candidates, query || change);
        }
        if (!target) {
            const needle = (query || change).toLowerCase();
            const literal = blocks.filter((block) => block.text.toLowerCase().includes(needle));
            if (literal.length === 1)
                target = literal[0];
            else if (literal.length > 1)
                return noteAskBlocks(note, literal.slice(0, 3).map((block) => ({ block, p: 1 })), query || change);
            else
                return noteAskBlocks(note, (judged?.items ?? []).slice(0, 3), query || change, `「${note.title}」里没找到明确对应「${query || change}」的那一项，你指的是哪一条？`);
        }
    }

    // 行里带表格竖线或「标签：」的，只给一小段新内容就替换会冲掉其他信息，先确认
    if (mode === 'replace' && args?.confirm !== true && noteReplaceLooksLossy(target.text, change)) {
        const question = `这一行原来是「${target.text.trim()}」，你给的新内容只有「${change.trim()}」，会整行覆盖。确认整行替换就带 confirm=true 再调一次；只想改其中一处的话，请把整行补全。`;
        return {
            ok: false,
            needConfirm: true,
            message: question,
            question,
            title: String(note.title ?? ''),
            noteId: Number(note.id),
            old: target.text,
            updated: change,
        };
    }

    let next;
    if (mode === 'delete') {
        let start = target.start;
        let end = target.end;
        if (body[end] === '\n')
            end += 1;
        else if (start > 0 && body[start - 1] === '\n')
            start -= 1;
        next = body.slice(0, start) + body.slice(end);
    }
    else {
        next = body.slice(0, target.start) + change + body.slice(target.end);
    }
    if (next.length > NOTE_MAX_BODY)
        return { ok: false, needConfirm: false, message: '改完超过 2 万字，先拆成两条再存。' };
    if (!noteWriteBody(note.id, next))
        return { ok: false, needConfirm: false, message: '写入失败，没改动。' };
    return {
        ok: true,
        needConfirm: false,
        message: mode === 'delete'
            ? `已从「${note.title}」删掉第 ${target.index} 行。`
            : `已更新「${note.title}」第 ${target.index} 行。`,
        title: String(note.title ?? ''),
        noteId: Number(note.id),
        old: target.text,
        updated: mode === 'delete' ? '（已删除）' : change,
    };
}

function noteStats(gid) {
    const db = noteOpen(true);
    if (!db)
        return { total: 0 };
    try {
        const row = db.prepare('select count(*) as n from notes where scope = ? or scope = ?').get('global', noteScopeOf(gid));
        return { total: Number(row?.n ?? 0) };
    }
    catch {
        return { total: 0 };
    }
    finally {
        db.close();
    }
}

globalThis.__qqbotNote = {
    search: noteSearch,
    save: noteSave,
    update: noteUpdate,
    list: noteList,
    stats: noteStats,
};
/* <<< dsh-qqbot-patch:note-helper <<< */

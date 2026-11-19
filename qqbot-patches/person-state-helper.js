/* >>> dsh-qqbot-patch:person-state-helper >>> */
/**
 * 人物事件层
 *
 *   mem_events     只追加的事件流：谁、在什么时候、发生了什么 / 状态变成什么
 *   person_states  从状态事件归约出的当前状态（投影，随时可删了重建）
 *
 * kind 分工：
 *   state      状态变化（开始/持续/结束），会投影到 person_states
 *   episode    具体经历（谁做了什么、发生了什么）
 *   commitment 约定（说好的时间/计划/承诺）
 *   relation   关系变化（在一起/分手/和好/闹掰）
 * 非 state 事件只进事件流，不投影——它们的用途是给叙事层（最近发生的事）提供素材。
 *
 * 设计约束：状态不是独立事实，而是事件的推导结果。
 *   - 原始证据仍留在 memories（这里只存事件和引用，不复制长期记忆）
 *   - rebuild(scope) 可以从 mem_events 完整重放，结果与在线写入一致
 *
 * 用途：解决「前几天生病、这几天好了」这类跟随问题——注入时先给当前状态，
 * 已结束的状态明确标记为「只能回溯」，不再让模型从碎片里猜。
 */
const PERSON_STATE_SLOTS = ['健康', '情绪', '工作学习', '睡眠', '所在地', '关系', '短期计划'];
const PERSON_STATE_OPS = ['start', 'continue', 'end'];
const PERSON_EVENT_KINDS = ['episode', 'commitment', 'relation'];
const PERSON_EVENT_OPS = ['occur', 'declare', 'change'];
const PERSON_NARRATIVE_LABELS = { episode: '', commitment: '约定', relation: '关系' };

function personStateDbPath() {
    const os = process.getBuiltinModule?.('node:os');
    return process.env.QQBOT_MEMORY_DB ?? `${process.env.DSH_HOME ?? `${os?.homedir?.() ?? process.env.HOME ?? ''}/.dsh`}/memory/ltm.db`;
}

function personStateScope(gid) {
    const raw = String(gid ?? '').trim();
    return raw.startsWith('qq:') ? raw : `qq:group:${raw}`;
}

/** 主体键：标签/索引里不能有空格，人名里的空格统一换成下划线 */
function personStateKey(name) {
    return String(name ?? '').trim().replace(/\s+/g, '_');
}

/** 一组称呼 → 去重后的主体键 */
function personStateKeys(names) {
    return [...new Set((Array.isArray(names) ? names : [names])
        .map((name) => personStateKey(name))
        .filter(Boolean))];
}

function personStatePeople() {
    const fs = process.getBuiltinModule?.('node:fs');
    const os = process.getBuiltinModule?.('node:os');
    if (!fs || !os)
        return [];
    try {
        const dir = process.env.QQBOT_PROFILE_DIR ?? `${process.env.DSH_HOME ?? `${os.homedir()}/.dsh`}/profiles/${process.env.QQBOT_PROFILE_NAME ?? 'qqbot'}`;
        const store = readProfileDocument(dir, 'people');
        return Array.isArray(store?.people) ? store.people : [];
    }
    catch {
        return [];
    }
}

function personStateNames(person) {
    const out = [person?.name, person?.addressing];
    for (const key of Object.keys(person ?? {})) {
        if (key.startsWith('nickname'))
            out.push(person[key]);
    }
    if (Array.isArray(person?.aliases))
        out.push(...person.aliases);
    return out.filter((n) => typeof n === 'string' && n.trim() !== '').map((n) => n.trim());
}

/** 别名表的作用域：'*' = 所有群通用（档案没写 groups 时） */
const PERSON_ALIAS_SCOPE_ALL = '*';
let personAliasCache = { path: '', at: 0, byScope: new Map() };

function personAliasCacheReset() {
    personAliasCache = { path: '', at: 0, byScope: new Map() };
}

function personAliasEnsure(db) {
    db.exec(`
        create table if not exists person_aliases (
            id integer primary key autoincrement,
            scope text not null,
            alias_key text not null,
            alias_name text not null,
            subject_key text not null,
            subject_name text not null,
            source text not null default '',
            created_at integer not null,
            updated_at integer not null
        );
        create unique index if not exists ux_person_aliases on person_aliases(scope, alias_key);
    `);
}

/**
 * 把档案里的名字 / 称呼 / 昵称 / 别名灌进别名表。
 * scope 用 personStateScope(gid)；档案没写 groups 的人落在 '*'（所有群通用）。
 * source='people' 的行每次整批重建，手工补的其它来源不受影响。
 */
function personAliasPopulate(db, peopleData) {
    const people = Array.isArray(peopleData) ? peopleData : personStatePeople();
    const now = Date.now();
    const insert = db.prepare(`insert into person_aliases
        (scope, alias_key, alias_name, subject_key, subject_name, source, created_at, updated_at)
        values (?, ?, ?, ?, ?, 'people', ?, ?)
        on conflict(scope, alias_key) do update set
            alias_name = excluded.alias_name,
            subject_key = excluded.subject_key,
            subject_name = excluded.subject_name,
            source = excluded.source,
            updated_at = excluded.updated_at`);
    let count = 0;
    db.exec('begin immediate');
    try {
        db.prepare("delete from person_aliases where source = 'people'").run();
        const seen = new Set();
        for (const person of people) {
            const canonical = String(person?.name ?? '').trim();
            if (canonical === '')
                continue;
            const scopes = Array.isArray(person?.groups) && person.groups.length > 0
                ? [...new Set(person.groups.map((g) => personStateScope(g)).filter((scope) => scope !== 'qq:group:'))]
                : [PERSON_ALIAS_SCOPE_ALL];
            for (const scope of scopes) {
                for (const alias of personStateNames(person)) {
                    const aliasKey = personStateKey(alias);
                    if (aliasKey === '')
                        continue;
                    const dedupe = `${scope}|${aliasKey}`;
                    if (seen.has(dedupe))
                        continue;
                    seen.add(dedupe);
                    insert.run(scope, aliasKey, alias, personStateKey(canonical), canonical, now, now);
                    count++;
                }
            }
        }
        db.exec('commit');
    }
    catch (err) {
        try { db.exec('rollback'); } catch { /* 忽略 */ }
        throw err;
    }
    personAliasCacheReset();
    return count;
}

/** 别名查表：先查本群，再回落到 '*'。缓存 30 秒，脚本改表后调用 reset。 */
function personAliasLookup(name, gid) {
    const key = personStateKey(name);
    if (key === '')
        return undefined;
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    if (!sqlite)
        return undefined;
    const path = personStateDbPath();
    if (personAliasCache.path !== path || Date.now() - personAliasCache.at > 30000) {
        const byScope = new Map();
        try {
            const db = new sqlite.DatabaseSync(path, { readOnly: true });
            try {
                for (const row of db.prepare('select scope, alias_key, subject_key, subject_name from person_aliases').all()) {
                    const scope = String(row.scope);
                    if (!byScope.has(scope))
                        byScope.set(scope, new Map());
                    byScope.get(scope).set(String(row.alias_key), {
                        key: String(row.subject_key),
                        name: String(row.subject_name),
                    });
                }
            }
            finally {
                db.close();
            }
        }
        catch {
            // 表还没建（首次启动）或库不存在：回落到档案文件
            byScope.clear();
        }
        personAliasCache = { path, at: Date.now(), byScope };
    }
    const scopes = gid ? [personStateScope(gid), PERSON_ALIAS_SCOPE_ALL] : [PERSON_ALIAS_SCOPE_ALL];
    for (const scope of scopes) {
        const hit = personAliasCache.byScope.get(scope)?.get(key);
        if (hit)
            return hit;
    }
    return undefined;
}

/**
 * 把「杰哥 / 我姐」这类称呼还原成档案里的名字。
 * 先查别名表（按群隔离），再回落到档案文件；都找不到就原样使用——不猜、不硬编码人名。
 */
function personStateCanonical(name, gid) {
    const raw = String(name ?? '').trim();
    if (raw === '')
        return { key: '', name: '' };
    const key = personStateKey(raw);
    const alias = personAliasLookup(key, gid);
    if (alias)
        return alias;
    const people = personStatePeople().filter((p) => !gid
        || !Array.isArray(p?.groups) || p.groups.length === 0 || p.groups.includes(gid));
    for (const person of people) {
        const canonical = String(person?.name ?? '').trim();
        if (canonical === '')
            continue;
        if (personStateNames(person).some((n) => personStateKey(n) === key))
            return { key: personStateKey(canonical), name: canonical };
    }
    return { key, name: raw };
}

/**
 * 档案称呼 → openid。事件里同时存名字和 openid：
 * 名字方便人读，openid 保证改昵称、重名时还能对回同一个人。
 */
function personStateOpenid(name, gid) {
    const canonical = personStateCanonical(name, gid);
    if (canonical.key === '')
        return '';
    const people = personStatePeople().filter((p) => !gid
        || !Array.isArray(p?.groups) || p.groups.length === 0 || p.groups.includes(gid));
    for (const person of people) {
        const matched = personStateKey(person?.name) === canonical.key
            || personStateNames(person).some((n) => personStateKey(n) === canonical.key);
        if (!matched)
            continue;
        const openid = (Array.isArray(person?.openids) ? person.openids : [])
            .map((id) => String(id).trim())
            .find((id) => id !== '');
        if (openid)
            return openid;
    }
    return '';
}

function personStateEnsure(db) {
    db.exec(`
        create table if not exists mem_events (
            id integer primary key autoincrement,
            event_uid text not null,
            scope text not null,
            subject_key text not null,
            subject_name text not null,
            kind text not null default 'state',
            slot text not null,
            op text not null,
            value text not null default '',
            raw text not null default '',
            speaker_key text not null default '',
            speaker_name text not null default '',
            event_at integer not null,
            ingested_at integer not null,
            source text not null default '',
            confidence real not null default 0,
            memory_id integer,
            object_key text not null default '',
            object_name text not null default '',
            subject_id text not null default '',
            speaker_id text not null default '',
            object_id text not null default ''
        );
        create unique index if not exists ux_mem_events_uid on mem_events(event_uid);
        create index if not exists ix_mem_events_subject on mem_events(scope, subject_key, slot, event_at);

        create table if not exists person_states (
            id integer primary key autoincrement,
            scope text not null,
            subject_key text not null,
            subject_name text not null,
            slot text not null,
            status text not null,
            value text not null default '',
            valid_from integer not null,
            valid_to integer,
            last_confirmed_at integer not null,
            confidence real not null default 0,
            evidence_event_ids text not null default '[]',
            first_event_id integer not null,
            last_event_id integer not null,
            revision integer not null default 1,
            updated_at integer not null
        );
        create index if not exists ix_person_states_lookup on person_states(scope, subject_key, status);
        create unique index if not exists ux_person_states_current
            on person_states(scope, subject_key, slot) where status = 'open';
    `);
    personAliasEnsure(db);
    // 事件对象（关系里的另一方、约定的对方）：旧库用 ALTER 补齐，不改已有行。
    const columns = new Set(db.prepare('pragma table_info(mem_events)').all().map((row) => String(row.name)));
    if (!columns.has('object_key'))
        db.exec("alter table mem_events add column object_key text not null default ''");
    if (!columns.has('object_name'))
        db.exec("alter table mem_events add column object_name text not null default ''");
    // openid：名字会改、会重名，事件要能稳定对回具体的人。
    if (!columns.has('subject_id'))
        db.exec("alter table mem_events add column subject_id text not null default ''");
    if (!columns.has('speaker_id'))
        db.exec("alter table mem_events add column speaker_id text not null default ''");
    if (!columns.has('object_id'))
        db.exec("alter table mem_events add column object_id text not null default ''");
}

function personStateEvidence(raw, eventId) {
    let list = [];
    try {
        list = JSON.parse(String(raw ?? '[]'));
    }
    catch {
        list = [];
    }
    if (!Array.isArray(list))
        list = [];
    list.push(eventId);
    return JSON.stringify(list.slice(-20));
}

/** 事件 → 状态投影。在线写入和重建共用这一段，保证两边结果一致。 */
function personStateReduce(db, event) {
    const current = db.prepare("select * from person_states where scope = ? and subject_key = ? and slot = ? and status = 'open'")
        .get(event.scope, event.subject_key, event.slot);
    const eventId = Number(event.id);
    const at = Number(event.event_at);
    const confidence = Number(event.confidence ?? 0);
    if (event.op === 'end') {
        if (!current)
            return;
        db.prepare(`update person_states
            set status = 'resolved', valid_to = ?, last_confirmed_at = ?, last_event_id = ?,
                revision = revision + 1, updated_at = ?, evidence_event_ids = ?
            where id = ?`)
            .run(at, at, eventId, at, personStateEvidence(current.evidence_event_ids, eventId), current.id);
        return;
    }
    if (event.op === 'continue' && current) {
        db.prepare(`update person_states
            set last_confirmed_at = ?, last_event_id = ?, revision = revision + 1,
                updated_at = ?, confidence = ?, evidence_event_ids = ?
            where id = ?`)
            .run(at, eventId, at, Math.max(Number(current.confidence ?? 0), confidence),
                personStateEvidence(current.evidence_event_ids, eventId), current.id);
        return;
    }
    // start：先把同槽位的旧状态关掉，再开一条新的；
    // continue 遇到没有 open 的情况（例如重启后首次见到「还在吃药」）也按开始处理。
    if (current) {
        db.prepare(`update person_states
            set status = 'resolved', valid_to = ?, last_event_id = ?, revision = revision + 1,
                updated_at = ?, evidence_event_ids = ?
            where id = ?`)
            .run(at, eventId, at, personStateEvidence(current.evidence_event_ids, eventId), current.id);
    }
    db.prepare(`insert into person_states
        (scope, subject_key, subject_name, slot, status, value, valid_from, valid_to,
         last_confirmed_at, confidence, evidence_event_ids, first_event_id, last_event_id, revision, updated_at)
        values (?, ?, ?, ?, 'open', ?, ?, null, ?, ?, ?, ?, ?, 1, ?)`)
        .run(event.scope, event.subject_key, event.subject_name, event.slot,
            String(event.value ?? '').slice(0, 160), at, at, confidence,
            JSON.stringify([eventId]), eventId, eventId, at);
}

/**
 * 追加一条状态事件并更新投影。
 * 同一条消息重复判到（event_uid 相同）会被忽略，不会重复累加 revision。
 */
function personStateApply(input) {
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    if (!sqlite)
        return false;
    const gid = String(input?.gid ?? '').trim();
    const subject = personStateCanonical(input?.subjectName, gid);
    const slot = String(input?.slot ?? '');
    const op = String(input?.op ?? '');
    if (gid === '' || subject.key === '' || !PERSON_STATE_SLOTS.includes(slot) || !PERSON_STATE_OPS.includes(op))
        return false;
    const scope = personStateScope(gid);
    const at = Number(input?.at ?? Date.now());
    const raw = String(input?.raw ?? input?.value ?? '').replace(/\s+/g, ' ').trim();
    const subjectId = String(input?.subjectId ?? '').trim() || personStateOpenid(subject.name, gid);
    const speakerId = String(input?.speakerId ?? '').trim() || personStateOpenid(input?.speakerName, gid);
    const uid = String(input?.eventUid ?? '').trim()
        || `${scope}|${subject.key}|${slot}|${op}|${at}|${raw.slice(0, 120)}`;
    let db;
    try {
        db = new sqlite.DatabaseSync(personStateDbPath(), { timeout: 5000 });
        personStateEnsure(db);
        db.exec('begin immediate');
        try {
            const info = db.prepare(`insert or ignore into mem_events
                (event_uid, scope, subject_key, subject_name, kind, slot, op, value, raw,
                 speaker_key, speaker_name, event_at, ingested_at, source, confidence, memory_id,
                 subject_id, speaker_id)
                values (?, ?, ?, ?, 'state', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(uid, scope, subject.key, subject.name, slot, op,
                    String(input?.value ?? raw).replace(/\s+/g, ' ').trim().slice(0, 160), raw.slice(0, 300),
                    personStateKey(input?.speakerName), String(input?.speakerName ?? '').trim(),
                    at, Date.now(), String(input?.source ?? ''), Number(input?.confidence ?? 0),
                    input?.memoryId === undefined ? null : Number(input.memoryId),
                    subjectId, speakerId);
            if (Number(info.changes) === 0) {
                db.exec('commit');
                return false;
            }
            const event = db.prepare('select * from mem_events where id = ?').get(Number(info.lastInsertRowid));
            if (event)
                personStateReduce(db, event);
            db.exec('commit');
            return true;
        }
        catch (err) {
            try { db.exec('rollback'); } catch { /* 忽略 */ }
            throw err;
        }
    }
    catch (err) {
        console.log(`[im-qqbot] 状态事件写入失败: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
    finally {
        try { db?.close(); } catch { /* 忽略 */ }
    }
}

/**
 * 追加一条非状态事件（经历/约定/关系变化）。
 * 只进事件流，不投影——person_states 只由 state 事件推导。
 */
function personEventAppend(input) {
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    if (!sqlite)
        return false;
    const gid = String(input?.gid ?? '').trim();
    const subject = personStateCanonical(input?.subjectName, gid);
    const kind = String(input?.kind ?? '');
    const op = String(input?.op ?? '');
    if (gid === '' || subject.key === '' || !PERSON_EVENT_KINDS.includes(kind) || !PERSON_EVENT_OPS.includes(op))
        return false;
    const scope = personStateScope(gid);
    const at = Number(input?.at ?? Date.now());
    const raw = String(input?.raw ?? input?.value ?? '').replace(/\s+/g, ' ').trim();
    const uid = String(input?.eventUid ?? '').trim()
        || `${scope}|${subject.key}|${kind}|${op}|${at}|${raw.slice(0, 120)}`;
    const object = personStateCanonical(input?.objectName, gid);
    const subjectId = String(input?.subjectId ?? '').trim() || personStateOpenid(subject.name, gid);
    const speakerId = String(input?.speakerId ?? '').trim() || personStateOpenid(input?.speakerName, gid);
    const objectId = String(input?.objectId ?? '').trim() || personStateOpenid(object.name, gid);
    let db;
    try {
        db = new sqlite.DatabaseSync(personStateDbPath(), { timeout: 5000 });
        personStateEnsure(db);
        const info = db.prepare(`insert or ignore into mem_events
            (event_uid, scope, subject_key, subject_name, kind, slot, op, value, raw,
             speaker_key, speaker_name, event_at, ingested_at, source, confidence, memory_id,
             object_key, object_name, subject_id, speaker_id, object_id)
            values (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(uid, scope, subject.key, subject.name, kind, op,
                String(input?.value ?? raw).replace(/\s+/g, ' ').trim().slice(0, 160), raw.slice(0, 300),
                personStateKey(input?.speakerName), String(input?.speakerName ?? '').trim(),
                at, Date.now(), String(input?.source ?? ''), Number(input?.confidence ?? 0),
                input?.memoryId === undefined ? null : Number(input.memoryId),
                object.key, object.name, subjectId, speakerId, objectId);
        return Number(info.changes) > 0;
    }
    catch (err) {
        console.log(`[im-qqbot] 事件写入失败: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
    finally {
        try { db?.close(); } catch { /* 忽略 */ }
    }
}

/** 从事件流重建某个群的全部状态（或全部群） */
function personStateRebuild(gid) {
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    if (!sqlite)
        return 0;
    let db;
    try {
        db = new sqlite.DatabaseSync(personStateDbPath(), { timeout: 5000 });
        personStateEnsure(db);
        db.exec('begin immediate');
        try {
            const events = gid
                ? db.prepare("select * from mem_events where scope = ? and kind = 'state' order by event_at asc, id asc").all(personStateScope(gid))
                : db.prepare("select * from mem_events where kind = 'state' order by event_at asc, id asc").all();
            if (gid)
                db.prepare('delete from person_states where scope = ?').run(personStateScope(gid));
            else
                db.exec('delete from person_states');
            for (const event of events)
                personStateReduce(db, event);
            db.exec('commit');
            return events.length;
        }
        catch (err) {
            try { db.exec('rollback'); } catch { /* 忽略 */ }
            throw err;
        }
    }
    catch (err) {
        console.log(`[im-qqbot] 状态重建失败: ${err instanceof Error ? err.message : String(err)}`);
        return 0;
    }
    finally {
        try { db?.close(); } catch { /* 忽略 */ }
    }
}

function personStateDay(ts) {
    const date = new Date(Number(ts));
    if (!Number.isFinite(date.getTime()))
        return '';
    return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * 注入用：当前 open 状态 + 最近结束的状态。
 * names 是这个人可能的称呼（档案名/称呼/昵称），查询时会统一成 subject_key。
 *
 * staleDays：超过这么多天没有「持续」确认的 open 状态不再当成当前状态注入。
 * 状态行本身不改（stale 是读取时的推导，不是新状态），事件重放结果仍然一致。
 */
function personStateBlock(gid, names, options = {}) {
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    if (!sqlite)
        return '';
    const keys = personStateKeys(names);
    if (keys.length === 0)
        return '';
    const limit = Math.max(1, Number(options.limit ?? 5));
    const resolvedDays = Math.max(0, Number(options.resolvedDays ?? 7));
    const staleDays = Math.max(1, Number(options.staleDays ?? process.env.QQBOT_PERSON_STATE_STALE_DAYS ?? 7));
    const includeResolved = options.resolved !== false;
    const now = Date.now();
    const placeholders = keys.map(() => '?').join(', ');
    let db;
    try {
        db = new sqlite.DatabaseSync(personStateDbPath(), { readOnly: true });
        const open = db.prepare(`select slot, value, valid_from, last_confirmed_at from person_states
            where scope = ? and status = 'open' and subject_key in (${placeholders}) and last_confirmed_at >= ?
            order by last_confirmed_at desc limit ?`).all(personStateScope(gid), ...keys, now - staleDays * 86400000, limit);
        const resolved = includeResolved && resolvedDays > 0
            ? db.prepare(`select slot, value, valid_from, valid_to from person_states
                where scope = ? and status = 'resolved' and subject_key in (${placeholders}) and valid_to >= ?
                order by valid_to desc limit ?`).all(personStateScope(gid), ...keys, now - resolvedDays * 86400000, Math.max(1, Number(options.resolvedLimit ?? 2)))
            : [];
        if (open.length === 0 && resolved.length === 0)
            return '';
        const lines = [];
        if (open.length > 0) {
            lines.push('【TA 现在的状态（这是当前结论，优先于旧记忆里的说法）】');
            for (const row of open) {
                const since = personStateDay(row.valid_from);
                const ageDays = Math.max(0, Math.floor((now - Number(row.last_confirmed_at)) / 86400000));
                const tail = ageDays >= 2
                    ? `，最后确认 ${ageDays} 天前`
                    : (personStateDay(row.last_confirmed_at) !== since ? '，最近又确认过' : '');
                lines.push(`- ${row.slot}：「${String(row.value ?? '').slice(0, 80)}」（${since} 起${tail}）`);
            }
        }
        if (resolved.length > 0) {
            lines.push('【TA 已经结束的状态（只在回溯时提，不要当成现在）】');
            for (const row of resolved) {
                lines.push(`- ${row.slot}：「${String(row.value ?? '').slice(0, 80)}」（${personStateDay(row.valid_from)}~${personStateDay(row.valid_to)}，已结束）`);
            }
        }
        lines.push('状态以这里为准；TA 刚刚说的话如果和这里冲突，按新说的来，别把已结束的状态当成现在。');
        return lines.join('\n');
    }
    catch {
        return '';
    }
    finally {
        try { db?.close(); } catch { /* 忽略 */ }
    }
}

/**
 * 只读时间线：某人最近的事件（默认 7 天内，时间正序）。
 * 目前只给后续叙事层取用，不注入 prompt。
 */
function personTimeline(gid, names, options = {}) {
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    if (!sqlite)
        return [];
    const keys = personStateKeys(names);
    if (keys.length === 0)
        return [];
    const days = Math.max(1, Number(options.days ?? 7));
    const limit = Math.max(1, Number(options.limit ?? 5));
    const kinds = (Array.isArray(options.kinds) ? options.kinds : [])
        .map((kind) => String(kind))
        .filter((kind) => kind === 'state' || PERSON_EVENT_KINDS.includes(kind));
    const placeholders = keys.map(() => '?').join(', ');
    const params = [personStateScope(gid), ...keys, ...keys, Date.now() - days * 86400000];
    let sql = `select kind, op, subject_name, object_name, speaker_name, value, event_at, memory_id from mem_events
        where scope = ? and (subject_key in (${placeholders}) or object_key in (${placeholders})) and event_at >= ?`;
    if (kinds.length > 0) {
        sql += ` and kind in (${kinds.map(() => '?').join(', ')})`;
        params.push(...kinds);
    }
    sql += ' order by event_at desc, id desc limit ?';
    params.push(limit);
    let db;
    try {
        db = new sqlite.DatabaseSync(personStateDbPath(), { readOnly: true });
        return db.prepare(sql).all(...params)
            .map((row) => ({
                kind: String(row.kind),
                op: String(row.op),
                subjectName: String(row.subject_name),
                objectName: String(row.object_name ?? ''),
                speakerName: String(row.speaker_name ?? ''),
                value: String(row.value ?? ''),
                at: Number(row.event_at),
                day: personStateDay(row.event_at),
                memoryId: row.memory_id === null ? undefined : Number(row.memory_id),
            }))
            .reverse();
    }
    catch {
        return [];
    }
    finally {
        try { db?.close(); } catch { /* 忽略 */ }
    }
}

/**
 * 叙事块：把最近的事件按天串成「最近发生的事」。
 * 只读事件流、不改状态；同一件事重复出现只留最近一条。
 * 默认排除 state 事件——当前/已结束状态由 personStateBlock 单独注入，不重复。
 */
function personNarrative(gid, names, options = {}) {
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    if (!sqlite)
        return '';
    const keys = personStateKeys(names);
    if (keys.length === 0)
        return '';
    const days = Math.max(1, Math.min(60, Number(options.days ?? 7)));
    const maxItems = Math.max(1, Math.min(20, Number(options.limit ?? 8)));
    const maxChars = Math.max(80, Math.min(1200, Number(options.maxChars ?? 480)));
    const kinds = (Array.isArray(options.kinds) ? options.kinds : [])
        .map((kind) => String(kind))
        .filter((kind) => PERSON_EVENT_KINDS.includes(kind));
    const useKinds = kinds.length > 0 ? kinds : PERSON_EVENT_KINDS;
    const selfKeys = new Set(keys);
    const placeholders = keys.map(() => '?').join(', ');
    const params = [
        personStateScope(gid), ...keys, ...keys, Date.now() - days * 86400000,
        ...useKinds,
    ];
    let db;
    try {
        db = new sqlite.DatabaseSync(personStateDbPath(), { readOnly: true });
        const rows = db.prepare(`select kind, subject_name, speaker_name, value, event_at from mem_events
            where scope = ? and (subject_key in (${placeholders}) or object_key in (${placeholders})) and event_at >= ?
                and kind in (${useKinds.map(() => '?').join(', ')})
            order by event_at desc, id desc limit 40`).all(...params);
        const seen = new Set();
        const chosen = [];
        for (const row of rows) {
            const value = String(row.value ?? '').replace(/\s+/g, ' ').trim();
            if (value.length < 2)
                continue;
            const speaker = String(row.speaker_name ?? '').trim();
            const subjectName = String(row.subject_name ?? '');
            const dedupe = `${row.kind}|${speaker}|${value}`;
            if (seen.has(dedupe))
                continue;
            seen.add(dedupe);
            // 事件记在 A 名下、查的是在场的另一方 B（如「我弟给我寄了…」记在 B 的对象侧）：
            // 必须标出这是 A 的事，否则会被读成 B 的自述（「阿余有个弟弟」）。
            const subjectIsSelf = selfKeys.has(personStateKey(subjectName));
            const owner = !subjectIsSelf && subjectName !== ''
                ? (speaker !== '' && speaker !== subjectName ? `${subjectName} 的事，${speaker} 说` : `${subjectName} 的事`)
                : '';
            chosen.push({
                kind: String(row.kind),
                value,
                at: Number(row.event_at),
                // 事件记在 A 名下、话是 B 说的（如「我弟…」）：保留说话人，避免读成 A 的自述。
                // 说话人就是查询对象时不加，避免「澜熙 说」出现在澜熙自己的叙事里。
                owner,
            });
            if (chosen.length >= maxItems)
                break;
        }
        if (chosen.length === 0)
            return '';
        chosen.reverse();
        const lines = [`【TA 最近发生的事（本群，最近 ${days} 天）】`];
        let currentDay = '';
        let spent = 0;
        for (const event of chosen) {
            const snippet = event.value.length > 48 ? `${event.value.slice(0, 48)}…` : event.value;
            const label = PERSON_NARRATIVE_LABELS[event.kind] ?? '';
            const quote = event.owner === '' ? snippet : `${snippet}（${event.owner}）`;
            const item = label === '' ? quote : `${label}：${quote}`;
            if (spent + item.length > maxChars)
                break;
            spent += item.length;
            const day = personStateDay(event.at);
            if (day !== currentDay) {
                lines.push(`- ${day}：${item}`);
                currentDay = day;
            }
            else {
                lines[lines.length - 1] += `；${item}`;
            }
        }
        if (lines.length === 1)
            return '';
        lines.push('按时间顺序；这些是发生过的事，别当成刚刚发生。');
        return lines.join('\n');
    }
    catch {
        return '';
    }
    finally {
        try { db?.close(); } catch { /* 忽略 */ }
    }
}

/**
 * 只读工具：person_status
 * 不传 name 时默认当前群 + 当前说话人；返回状态块、叙事和最近时间线。
 * 只读，不写库；QQBOT_PERSON_TOOLS=off 可关。
 */
function setupPersonStatusTool(ctx, manager) {
    if (String(process.env.QQBOT_PERSON_TOOLS ?? 'on').trim().toLowerCase() === 'off')
        return;
    let tools;
    try {
        tools = ctx.get('tools');
    }
    catch {
        tools = undefined;
    }
    if (!tools || typeof tools.register !== 'function') {
        console.log('[im-qqbot] tools 不可用，person_status 未注册');
        return;
    }
    const namesForKey = (key) => {
        const person = personStatePeople().find((p) => personStateKey(p?.name) === key);
        return person ? personStateNames(person) : [];
    };
    tools.register({
        name: 'person_status',
        description: [
            '查某人现在是什么状态、最近发生过什么。适合回答「他病好了吗」「她最近怎么样」「我们之前约了什么」。',
            '不传 name 就查当前说话的人；返回当前状态、已结束状态（只能回溯）、最近事件时间线。',
            '状态行是当前结论，优先于旧记忆；已结束的状态不要当成现在。',
        ].join(''),
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                name: { type: 'string', description: '要查的人（档案名或群里的称呼）；不填就是当前说话人' },
                days: { type: 'number', description: '往前看几天，默认 7，最多 60' },
            },
            required: [],
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    name: { type: 'string' },
                    status: { type: 'string' },
                    narrative: { type: 'string' },
                    events: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                day: { type: 'string' },
                                kind: { type: 'string' },
                                value: { type: 'string' },
                            },
                            required: ['day', 'kind', 'value'],
                        },
                    },
                },
                required: ['name', 'status', 'narrative', 'events'],
            },
            render: (_args, value) => {
                const lines = [];
                if (value.status)
                    lines.push(value.status);
                if (value.narrative)
                    lines.push(value.narrative);
                if (value.events.length > 0)
                    lines.push(`【最近事件】\n${value.events.map((item) => `- ${item.day} ${item.kind}：${item.value}`).join('\n')}`);
                if (lines.length === 0)
                    return [{ type: 'text', text: `${value.name || '这个人'}现在没有记录到状态或近期事件。` }];
                return [{ type: 'text', text: lines.join('\n') }];
            },
        },
        isConcurrencySafe: true,
        execute(args, exec) {
            const record = exec?.agent && manager?.findByAgent(exec.agent);
            const gid = record?.scope === 'group' ? String(record.peerId ?? '') : '';
            const reply = record?.replyTarget;
            const recent = gid && reply?.targetId === gid && reply.msgId
                ? globalThis.__qqbotRecentMessages?.get?.(gid) : undefined;
            const speaker = recent?.findLast(item => item.msgId === String(reply.msgId));
            const input = String(args?.name ?? '').trim() || String(speaker?.name ?? '').trim();
            if (gid === '' || input === '')
                return { name: input, status: '', narrative: '', events: [] };
            const canonical = personStateCanonical(input, gid);
            const keys = [...new Set([canonical.name, ...namesForKey(canonical.key), input].filter(Boolean))];
            const days = Math.max(1, Math.min(60, Number(args?.days ?? 7)));
            const status = globalThis.__qqbotPersonState?.block?.(gid, keys) ?? '';
            const narrative = globalThis.__qqbotPersonState?.narrative?.(gid, keys, { days }) ?? '';
            const events = (globalThis.__qqbotPersonState?.timeline?.(gid, keys, { days, limit: 6 }) ?? [])
                .map((row) => ({
                    day: String(row.day ?? ''),
                    kind: row.kind === 'state' ? row.slot || 'state' : String(row.kind ?? ''),
                    value: String(row.value ?? '').slice(0, 120),
                }));
            return { name: canonical.name, status, narrative, events };
        },
    });
    console.log('[im-qqbot] person_status 工具已注册');
}

function setupPersonState(ctx, config, logger, manager) {
    const mode = String(process.env.QQBOT_PERSON_STATE ?? 'on').trim().toLowerCase();
    if (mode === 'off')
        return;
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    if (!sqlite)
        return;
    try {
        const db = new sqlite.DatabaseSync(personStateDbPath(), { timeout: 5000 });
        try {
            personStateEnsure(db);
            const aliases = personAliasPopulate(db);
            console.log(`[im-qqbot] 别名表: ${aliases} 条`);
        }
        finally {
            db.close();
        }
    }
    catch (err) {
        console.log(`[im-qqbot] 状态层初始化失败: ${err instanceof Error ? err.message : String(err)}`);
        return;
    }
    const shadow = mode === 'shadow';
    const narrativeOff = String(process.env.QQBOT_PERSON_NARRATIVE ?? 'on').trim().toLowerCase() === 'off';
    globalThis.__qqbotPersonState = {
        apply: personStateApply,
        append: personEventAppend,
        rebuild: personStateRebuild,
        block: shadow ? () => '' : personStateBlock,
        narrative: shadow || narrativeOff ? () => '' : personNarrative,
        timeline: personTimeline,
        canonical: personStateCanonical,
        aliases: personAliasPopulate,
        aliasReset: personAliasCacheReset,
        mode,
    };
    if (!shadow)
        setupPersonStatusTool(ctx, manager);
    console.log(`[im-qqbot] 人物状态层已启用（${shadow ? '影子写入，暂不注入' : '写入 + 注入'}）`);
}
/* <<< dsh-qqbot-patch:person-state-helper <<< */

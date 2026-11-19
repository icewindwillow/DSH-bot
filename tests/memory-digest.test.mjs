#!/usr/bin/env node
/**
 * 每日日报（memory-summary-helper 的 [日报] 分支）离线测试。
 *
 * 不调用真实模型：ctx.get('llm') 返回一个只吐固定文本的假 stream。
 * 用法：node tests/memory-digest.test.mjs
 */
import { readQqbotGroupDirectory } from '../qqbot-patches/profile-document-reader.js';
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { createMemoryFixture } from './fixtures/ltm-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const home = mkdtempSync(join(tmpdir(), 'qqbot-digest-'));
mkdirSync(join(home, '.dsh', 'memory'), { recursive: true });
mkdirSync(join(home, '.dsh', 'profiles', 'qqbot'), { recursive: true });
createMemoryFixture(join(home, '.dsh', 'memory', 'ltm.db'));
writeFileSyncSafe(join(home, '.dsh', 'profiles', 'qqbot', 'qqbot-groups-meta.json'), JSON.stringify({
    groups: [{ id: 'GID_TEST', name: '测试群' }],
}, null, 2));
process.env.HOME = home;
process.env.DSH_HOME = join(home, '.dsh');
process.env.QQBOT_PROFILE_DIR = join(home, '.dsh', 'profiles', 'qqbot');

function writeFileSyncSafe(path, text) {
    // node:fs 的 writeFileSync 在这里按需引入，避免顶部再拆一次导入
    const fs = process.getBuiltinModule('node:fs');
    fs.writeFileSync(path, text, 'utf8');
}

const db = new DatabaseSync(join(home, '.dsh', 'memory', 'ltm.db'));
db.exec('delete from memories');
const insert = db.prepare('insert into memories (text, tags, scope, pinned, created_at, updated_at, last_confirmed_at, revision) values (?, ?, ?, 0, ?, ?, ?, 1)');
const now = Date.now();
insert.run('叶兰舟：我最近都好累', '近况 叶兰舟', 'qq:group:GID_TEST', now, now, now);
insert.run('[身份] 玛卡巴卡：清华研究生', '身份 玛卡巴卡', 'qq:group:GID_TEST', now, now, now);
insert.run('[偏好] 七颜：喜欢猫', '偏好 七颜', 'qq:group:GID_TEST', now, now, now);
db.close();

let calls = 0;
const llm = {
    stream(options) {
        if (options.reasoningEffort === 'high') return (async function* () { yield { type: 'text-delta', text: '[]' }; })();
        calls++;
        if (options.provider !== 'opencode-go' || options.model !== 'deepseek-v4.1-flash')
            throw new Error(`意外路由: ${options.provider}/${options.model}`);
        return (async function* () {
            yield { type: 'text-delta', text: '叶兰舟最近很累，玛卡巴卡是清华研究生，七颜喜欢猫。' };
            yield { type: 'finish', reason: { kind: 'completed' } };
        })();
    },
};
const tools = new Map();
const ctx = { get: (name) => name === 'llm' ? llm : name === 'tools' ? { register: (tool) => tools.set(tool.name, tool) } : undefined };
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const src = readFileSync(join(ROOT, 'qqbot-patches', 'memory-summary-helper.js'), 'utf8')
    .replace(/^\/\* >>>.*$/m, '')
    .replace(/^\/\* <<<.*$/m, '');
const factory = new Function('readQqbotGroupDirectory', 'readFileSync', 'writeFileSync', 'console', `
    ${src}
    return { setupMemorySummary, memorySummaryWrite, memoryConsolidateEvents };
`);
const consolidateApi = factory(readQqbotGroupDirectory, readFileSync, writeFileSyncSafe, { log: () => {} });
consolidateApi.setupMemorySummary(ctx, logger);

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
    try {
        await fn();
        pass++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        fail++;
        console.error(`  ✗ ${name}\n    ${err.message}`);
    }
};
const rowsOf = () => {
    const conn = new DatabaseSync(join(home, '.dsh', 'memory', 'ltm.db'), { readOnly: true });
    try {
        return conn.prepare("select id, text, tags, scope from memories where tags like '%日报%'").all();
    }
    finally {
        conn.close();
    }
};

console.log('每日日报测试');

await check('最近 24h 有 3 条记忆 → 生成一条 [日报]', async () => {
    await globalThis.__qqbotMemorySummary.runOnce(true);
    const rows = rowsOf();
    if (rows.length !== 1)
        throw new Error(`日报条数 ${rows.length}`);
    if (!String(rows[0].text).startsWith('[日报] '))
        throw new Error(`文本不对：${rows[0].text}`);
    if (!String(rows[0].text).includes('叶兰舟') || !String(rows[0].text).includes('玛卡巴卡'))
        throw new Error('日报没覆盖记忆');
    if (calls !== 1)
        throw new Error(`模型调用次数 ${calls}`);
    globalThis.__qqbotMemoryScopeBySession = { digest: 'qq:group:GID_TEST' };
    try {
        const evidence = await tools.get('memory_summary_evidence').execute({ id: rows[0].id }, { agent: { header: { id: 'digest' } } });
        assert.equal(evidence.status, 'found');
        assert.equal(evidence.results.length, 3);
        assert(evidence.results.every((row) => row.kind === 'memory-entry' && row.relation === 'summary-input'));
    } finally { delete globalThis.__qqbotMemoryScopeBySession; }
});

await check('同一天再跑不重复写', async () => {
    await globalThis.__qqbotMemorySummary.runOnce(true);
    if (rowsOf().length !== 1)
        throw new Error('重复生成了日报');
});

await check('换会话后回查日报：有旧说法、较晚更正和说话人；不搜索别的群或私聊', async () => {
    const scope = 'qq:group:TRIP';
    const path = join(home, '.dsh', 'memory', 'ltm.db');
    const db = new DatabaseSync(path);
    try {
        const add = db.prepare(`insert into memories (text, tags, scope, pinned, created_at, updated_at, last_confirmed_at, revision)
            values (?, ?, ?, 0, ?, ?, ?, 1)`);
        const addAt = (text, at, owner = scope, tags = '') => Number(add.run(text, tags, owner, at, at, at).lastInsertRowid);
        const earlier = addAt('甲说露营定在周六', now - 3000);
        const source = db.prepare('select id, revision, text from memories where id = ?').get(earlier);
        assert.equal(consolidateApi.memorySummaryWrite(db, { text: '[日报] 露营定在周六', tags: '日报', scope, sources: [source], at: now - 2000 }), true);
        const summary = db.prepare("select id from memories where text = '[日报] 露营定在周六'").get().id;
        const later = addAt('乙把露营改到周日', now - 1000);
        addAt('甲把露营改到周一', now - 500, 'qq:group:OTHER');
        addAt('私聊露营改到周二', now - 500, 'qq:c2c:someone');
        addAt('私藏露营改到周三', now - 500, scope, 'pm:42');
        const event = db.prepare(`insert into mem_events (event_uid, scope, subject_key, subject_name, slot, op, raw,
            speaker_name, event_at, ingested_at, source, memory_id) values (?, ?, 'trip', '露营', '', 'declare', ?, ?, ?, ?, 'memory-gate', ?)`);
        event.run('first', scope, '我看露营就定周六吧', '甲', now - 3000, now - 3000, earlier);
        event.run('correction', scope, '露营改周日，周六下雨', '乙', now - 1000, now - 1000, later);
        event.run('wrong-scope', 'qq:c2c:someone', '不能漏出来', '丙', now, now, later);

        globalThis.__qqbotMemoryScopeBySession = { 'new-session': scope, 'other-session': 'qq:group:OTHER' };
        globalThis.__qqbotCurrentGid = 'TRIP'; // 即使遗留全局指到了这个群，未登记会话也不能读
        const tool = tools.get('memory_summary_evidence');
        const exec = (session) => ({ agent: { session: { header: { id: session } } } });
        const ask = (session, id = summary) => tool.execute({ id, keyword: '露营', scope }, exec(session));
        const result = await ask('new-session');
        assert.equal(result.status, 'found');
        assert.deepEqual(result.results.map(({ speaker, text, kind, relation }) => ({ speaker, text, kind, relation })), [
            { speaker: '甲', text: '我看露营就定周六吧', kind: 'chat-excerpt', relation: 'summary-input' },
            { speaker: '乙', text: '露营改周日，周六下雨', kind: 'chat-excerpt', relation: 'later-keyword-match' },
        ]);
        assert.equal((await ask('other-session')).status, 'not-found');
        assert.equal((await ask('unregistered')).status, 'unavailable');
        const legacy = addAt('[日报] 旧日报', now - 1500);
        assert.equal((await ask('new-session', legacy)).status, 'summary-only');

        db.prepare("update memories set tags = '近况 archived', revision = revision + 1 where id = ?").run(earlier);
        assert.equal((await ask('new-session')).status, 'found');
        db.prepare("update memories set text = '已修订，不能当作当时输入', revision = revision + 1 where id = ?").run(earlier);
        assert.deepEqual(await ask('new-session'), { status: 'summary-only', missing: 1, results: [] });

        db.prepare('delete from memories where id = ?').run(earlier);
        // 旧事件的 raw 仍在，但不能拿它复活删除的来源。
        assert.deepEqual(await ask('new-session'), { status: 'summary-only', missing: 1, results: [] });
        assert.equal(consolidateApi.memorySummaryWrite(db, { text: '[日报] 异步生成后发现来源已删除', tags: '日报',
            scope, sources: [source], at: now }), false);
        assert.equal(db.prepare("select count(*) as n from memories where text like '%来源已删除'").get().n, 0);
        db.prepare('delete from memories where scope in (?, ?, ?)').run(scope, 'qq:group:OTHER', 'qq:c2c:someone');
        db.prepare("delete from mem_events where event_uid in ('first', 'correction', 'wrong-scope')").run();
    } finally {
        delete globalThis.__qqbotMemoryScopeBySession;
        delete globalThis.__qqbotCurrentGid;
        db.close();
    }
});

await check('近况汇总：显式开启后原始条目软归档，不删除；再跑不重复汇总', async () => {
    process.env.QQBOT_STATUS_SUMMARY = 'on';
    process.env.XIANGXIN_API_KEY = 'test-key';
    // 象信只决定「要不要合并 / 主题 / 程度」，文本由代码拼装
    globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ answers: { merge: { noul: 0.9 }, theme: { choice: '身体健康' }, severity: { score: 1.5 } } }),
    });
    const conn = new DatabaseSync(join(home, '.dsh', 'memory', 'ltm.db'));
    const now = Date.now();
    for (const text of ['我发烧了', '还在吃药', '退烧了但没精神'])
        conn.prepare('insert into memories (text, tags, scope, pinned, created_at, updated_at, last_confirmed_at, revision) values (?, ?, ?, 0, ?, ?, ?, 1)')
            .run(`2026-11-14 [近况] 白泽：${text}`, '近况 白泽 memory-gate 2026-11-14', 'qq:group:GID_TEST', now, now, now);
    conn.close();
    await globalThis.__qqbotMemorySummary.runOnce(true);
    const read = () => {
        const db = new DatabaseSync(join(home, '.dsh', 'memory', 'ltm.db'), { readOnly: true });
        try {
            return db.prepare("select id, text, tags from memories where tags like '%近况%'").all();
        }
        finally {
            db.close();
        }
    };
    const rows = read();
    const originals = rows.filter((row) => String(row.text).startsWith('2026-11-14 [近况] 白泽：'));
    if (originals.length !== 3)
        throw new Error(`原始条目丢了：${originals.length}`);
    if (originals.some((row) => !String(row.tags).includes('archived')))
        throw new Error('原始条目没归档');
    const summary = rows.find((row) => String(row.text).startsWith('[近况汇总] 白泽'));
    if (!summary)
        throw new Error('没生成汇总');
    globalThis.__qqbotMemoryScopeBySession = { digest: 'qq:group:GID_TEST' };
    try {
        const evidence = await tools.get('memory_summary_evidence').execute({ id: summary.id }, { agent: { header: { id: 'digest' } } });
        assert.equal(evidence.status, 'found');
        assert.deepEqual(evidence.results.map((row) => row.id), originals.map((row) => row.id).sort((a, b) => a - b));
    } finally { delete globalThis.__qqbotMemoryScopeBySession; }
    const summaryCount = rows.filter((row) => String(row.text).startsWith('[近况汇总] 白泽')).length;
    await globalThis.__qqbotMemorySummary.runOnce(true);
    if (read().filter((row) => String(row.text).startsWith('[近况汇总] 白泽')).length !== summaryCount)
        throw new Error('归档后又被重复汇总');
});

await check('近况汇总默认关闭：原始近况不再被归档', async () => {
    process.env.QQBOT_STATUS_SUMMARY = 'off';
    const conn = new DatabaseSync(join(home, '.dsh', 'memory', 'ltm.db'));
    const now = Date.now();
    for (const text of ['在准备考试', '有点焦虑', '还在复习'])
        conn.prepare('insert into memories (text, tags, scope, pinned, created_at, updated_at, last_confirmed_at, revision) values (?, ?, ?, 0, ?, ?, ?, 1)')
            .run(`2026-11-15 [近况] 甲：${text}`, '近况 甲 memory-gate 2026-11-15', 'qq:group:GID_TEST', now, now, now);
    conn.close();
    await globalThis.__qqbotMemorySummary.runOnce(true);
    const db = new DatabaseSync(join(home, '.dsh', 'memory', 'ltm.db'), { readOnly: true });
    try {
        const originals = db.prepare("select tags from memories where text like '2026-11-15 [近况] 甲：%'").all();
        if (originals.length !== 3)
            throw new Error(`原始条目数量 ${originals.length}`);
        if (originals.some((row) => String(row.tags).includes('archived')))
            throw new Error('默认关闭时仍然归档了近况');
        if (db.prepare("select id from memories where text like '[近况汇总] 甲%'").all().length !== 0)
            throw new Error('默认关闭时仍然生成了汇总');
    }
    finally {
        db.close();
    }
});

await check('事件沉淀：未接记忆的事件写成长期记忆并回填 memory_id', async () => {
    const dbPath = join(home, '.dsh', 'memory', 'ltm.db');
    const conn = new DatabaseSync(dbPath);
    const ts = Date.now();
    const HOUR = 3600 * 1000;
    const insertEvent = conn.prepare(`insert into mem_events
        (event_uid, scope, subject_key, subject_name, kind, slot, op, value, raw, event_at, ingested_at, source)
        values (?, 'qq:group:GID_TEST', ?, ?, ?, '', ?, ?, ?, ?, ?, 'test')`);
    insertEvent.run('ev-a', '白泽', '白泽', 'episode', 'occur', '参加了婚礼', '参加了婚礼', ts - 10 * HOUR, ts);
    insertEvent.run('ev-b', '白泽', '白泽', 'commitment', 'declare', '周六看电影', '周六看电影', ts - 9 * HOUR, ts);
    insertEvent.run('ev-c', '白泽', '白泽', 'relation', 'change', '和室友和好', '和室友和好', ts - 8 * HOUR, ts);
    insertEvent.run('ev-dup', '白泽', '白泽', 'episode', 'occur', '参加了婚礼', '参加了婚礼', ts - 7 * HOUR, ts);
    insertEvent.run('ev-new', '白泽', '白泽', 'episode', 'occur', '刚刚发生的事', '刚刚发生的事', ts - 1 * HOUR, ts);
    conn.close();

    await globalThis.__qqbotMemorySummary.runOnce(true);

    const read = () => {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
            return {
                memories: db.prepare("select id, text, tags from memories where tags like '%事件沉淀%'").all(),
                events: db.prepare("select id, event_uid, memory_id from mem_events where event_uid like 'ev-%' order by id").all(),
            };
        }
        finally {
            db.close();
        }
    };
    const before = read();
    if (before.memories.length !== 3)
        throw new Error(`沉淀记忆条数 ${before.memories.length}`);
    const texts = before.memories.map((row) => String(row.text));
    for (const expected of ['[经历] 白泽：参加了婚礼', '[约定] 白泽：周六看电影', '[关系] 白泽：和室友和好']) {
        if (!texts.includes(expected))
            throw new Error(`缺少记忆：${expected}`);
    }
    if (before.memories.some((row) =>
        !String(row.tags).includes('subject:白泽') || !String(row.tags).includes(`event:`)))
        throw new Error('记忆标签缺少主体或事件引用');
    const eventOf = (uid) => before.events.find((row) => row.event_uid === uid);
    for (const uid of ['ev-a', 'ev-b', 'ev-c', 'ev-dup']) {
        if (eventOf(uid) == null || eventOf(uid).memory_id === null)
            throw new Error(`${uid} 没回填 memory_id`);
    }
    if (eventOf('ev-new').memory_id !== null)
        throw new Error('太新的事件不该马上沉淀');
    if (Number(eventOf('ev-dup').memory_id) !== Number(eventOf('ev-a').memory_id))
        throw new Error('重复事件没复用已有记忆');

    await globalThis.__qqbotMemorySummary.runOnce(true);
    const after = read();
    if (after.memories.length !== before.memories.length)
        throw new Error('重复沉淀了记忆');
});

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

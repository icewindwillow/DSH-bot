#!/usr/bin/env node
/**
 * 记忆门控离线测试：不调象信、不碰真实库。
 *
 * 验证：
 *   - 没有关键词预筛：普通「我今天买了…」也会送判
 *   - 引用块/历史块不会被当成说话人自己的话
 *   - 纯 [图片] 占位符不送判
 *   - 象信说「不值得」就不写
 *   - 状态事件：值得记 → 开始/结束；主体不明 → 不写；同一条消息不重复写
 *
 * 用法：node tests/memory-gate.test.mjs
 */
import './fixtures/profile-documents-globals.mjs';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createMemoryFixture } from './fixtures/ltm-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const home = mkdtempSync(join(tmpdir(), 'qqbot-memgate-'));
mkdirSync(join(home, '.dsh', 'memory'), { recursive: true });
mkdirSync(join(home, '.dsh', 'profiles', 'qqbot'), { recursive: true });
createMemoryFixture(join(home, '.dsh', 'memory', 'ltm.db'));
writeFileSync(join(home, '.dsh', 'profiles', 'qqbot', 'qqbot-people.json'), JSON.stringify({ people: [{ name: '测试用户', openids: ['SID'], groups: ['GID_TEST'] }] }));
process.env.HOME = home;
process.env.DSH_HOME = join(home, '.dsh');
process.env.QQBOT_PROFILE_DIR = join(home, '.dsh', 'profiles', 'qqbot');
process.env.XIANGXIN_API_KEY = 'test-key';

const dbPath = join(home, '.dsh', 'memory', 'ltm.db');
const loadPatch = (name) => readFileSync(join(ROOT, 'qqbot-patches', name), 'utf8')
    .replace(/^\/\* >>>.*$/m, '')
    .replace(/^\/\* <<<.*$/m, '');

// 状态层先初始化（建表），再清空测试库
const stateApi = new Function(`
    ${loadPatch('person-state-helper.js')}
    return { setupPersonState, setupPersonStatusTool };
`)();
const quietLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
stateApi.setupPersonState({}, {}, quietLogger);

const db = new DatabaseSync(dbPath);
db.exec('delete from memories');
db.exec('delete from mem_events');
db.exec('delete from person_states');
db.close();

let fetchCalls = 0;
let answers = {
    store: { noul: 0.9 },
    type: { choice: '偏好' },
    subject: { choice: '说话人自己' },
    durability: { choice: '长期' },
    importance: { score: 1.5 },
    sensitive: { noul: 0.01 },
    conflict: { noul: 0.02 },
};
globalThis.fetch = async () => {
    fetchCalls++;
    return { ok: true, json: async () => ({ answers }) };
};

const src = readFileSync(join(ROOT, 'qqbot-patches', 'memory-gate-helper.js'), 'utf8')
    .replace(/^\/\* >>>.*$/m, '')
    .replace(/^\/\* <<<.*$/m, '');
const factory = new Function('readFileSync', 'writeFileSync', 'console', `
    ${src}
    ${loadPatch('event-helper.js')}
    return { setupMemoryGate, setupEvents };
`);
const runtime = factory(readFileSync, writeFileSync, { log: () => {} });
runtime.setupMemoryGate({}, {}, quietLogger);

// 审计日志先放一条 60 天前的旧记录：首次判定时应按 30 天保留期清掉
writeFileSync(join(home, '.dsh', 'profiles', 'qqbot', 'qqbot-memory-gate.jsonl'),
    `${JSON.stringify({ t: new Date(Date.now() - 60 * 86400000).toISOString(), reason: 'too_old_marker' })}\n`);

const rowsOf = () => {
    const conn = new DatabaseSync(dbPath, { readOnly: true });
    try {
        return conn.prepare('select text, tags, scope from memories').all();
    }
    finally {
        conn.close();
    }
};
const send = (content, senderId = 'SID', messageId = '', extra = {}) => globalThis.__qqbotMemoryGate.consider({
    message: { kind: 'group', groupOpenid: 'GID_TEST', senderId, senderName: '测试用户', content, messageId, ...extra },
});

// 视觉摘要桩：测试里不真的看图
let visionCalls = 0;
let visionResult = { what: '一张游戏成就达成截图，写着「白手起家」', joke: 0.1 };
globalThis.__qqbotVision = {
    describe: async () => {
        visionCalls += 1;
        return visionResult;
    },
};
const stateRows = (sql, ...params) => {
    const conn = new DatabaseSync(dbPath, { readOnly: true });
    try {
        return conn.prepare(sql).all(...params);
    }
    finally {
        conn.close();
    }
};

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

console.log('记忆门控测试');

await check('没有预筛：「我今天买了辆车」也会送象信并入库', async () => {
    const before = rowsOf().length;
    await send('我今天买了辆车，黑色的', 'SID1');
    const rows = rowsOf();
    if (rows.length !== before + 1)
        throw new Error(`入库条数 ${rows.length - before}`);
    if (!String(rows.at(-1).text).includes('我今天买了辆车'))
        throw new Error('正文不对');
    if (!String(rows.at(-1).tags).includes('imp:1.5'))
        throw new Error('没记 importance');
});

await check('引用块不会被当成说话人自己的话', async () => {
    await send('[Quoted message begins] 别人说：我养了一只猫 [Quoted message ends] [Current message] 我今天去杭州出差', 'SID2');
    const last = rowsOf().at(-1);
    if (String(last.text).includes('我养了一只猫'))
        throw new Error('把引用记进来了');
    if (!String(last.text).includes('我今天去杭州出差'))
        throw new Error('当前消息丢了');
});

await check('纯 [图片] 不送判', async () => {
    const calls = fetchCalls;
    await send('[图片]', 'SID3');
    if (fetchCalls !== calls)
        throw new Error('给占位符发了象信');
});

await check('象信说「不值得」就不写', async () => {
    answers = {
        store: { noul: 0.1 },
        type: { choice: '其他' },
        subject: { choice: '无法判断' },
        durability: { choice: '一次性' },
        importance: { score: 0.2 },
        sensitive: { noul: 0.01 },
        conflict: { noul: 0.02 },
    };
    const before = rowsOf().length;
    await send('哈哈哈哈', 'SID4');
    if (rowsOf().length !== before)
        throw new Error('不该入库');
});

await check('分享购物/体验：store 低但 share 高 → 入库并带分享标签', async () => {
    answers = {
        store: { noul: 0.16 },
        share: { noul: 0.95 },
        type: { choice: '偏好' },
        subject: { choice: '说话人自己' },
        durability: { choice: '一次性' },
        importance: { score: 1.2 },
        sensitive: { noul: 0.01 },
        conflict: { noul: 0.02 },
    };
    const before = rowsOf().length;
    await send('我这次想买山崎12，主要想尝尝水楢桶', 'SID5');
    const rows = rowsOf();
    if (rows.length !== before + 1)
        throw new Error('分享没有入库');
    if (!String(rows.at(-1).tags).includes('分享'))
        throw new Error('没带分享标签');
});

const stateAnswers = (over = {}) => ({
    store: { noul: 0.05 },
    type: { choice: '其他' },
    subject: { choice: '无法判断' },
    durability: { choice: '一次性' },
    importance: { score: 0.1 },
    sensitive: { noul: 0.01 },
    conflict: { noul: 0.02 },
    stateChange: { choice: '开始' },
    stateSlot: { choice: '健康' },
    stateSubject: { choice: '说话人自己' },
    stateCertainty: { score: 2 },
    ...over,
});

await check('状态：长期记忆不值得写，但「开始生病」进状态层', async () => {
    answers = stateAnswers();
    const before = rowsOf().length;
    await send('我今天发烧了，三十八度', 'SID6', 'm6');
    if (rowsOf().length !== before)
        throw new Error('不该写长期记忆');
    const rows = stateRows("select * from person_states where scope = 'qq:group:GID_TEST' and status = 'open'");
    if (rows.length !== 1)
        throw new Error(`状态行数 ${rows.length}`);
    if (!String(rows[0].value).includes('发烧'))
        throw new Error(`状态值不对：${rows[0].value}`);
    if (rows[0].subject_name !== '测试用户')
        throw new Error(`主体不对：${rows[0].subject_name}`);
    const [event] = stateRows("select subject_id, speaker_id from mem_events where kind = 'state' and event_uid like '%m6%'");
    if (!event || event.subject_id !== 'SID6' || event.speaker_id !== 'SID6')
        throw new Error(`状态事件 openid 不对：${JSON.stringify(event)}`);
});

await check('状态：好了 → 关闭当前状态', async () => {
    answers = stateAnswers({ stateChange: { choice: '结束' } });
    await send('我退烧了，好了', 'SID6', 'm7');
    const open = stateRows("select * from person_states where scope = 'qq:group:GID_TEST' and status = 'open'");
    if (open.length !== 0)
        throw new Error('状态还没关闭');
    const resolved = stateRows("select * from person_states where scope = 'qq:group:GID_TEST' and status = 'resolved'");
    if (resolved.length !== 1 || !Number(resolved[0].valid_to))
        throw new Error('没有留下已结束状态');
});

await check('状态：主体不明 / 像玩笑 → 不写事件', async () => {
    answers = stateAnswers({ stateSubject: { choice: '其他人' } });
    const before = stateRows('select id from mem_events').length;
    await send('哈哈他肯定又熬夜了', 'SID7', 'm8');
    if (stateRows('select id from mem_events').length !== before)
        throw new Error('主体不明也写了事件');
    answers = stateAnswers({ stateCertainty: { score: 0.5 } });
    await send('我死了', 'SID7', 'm9');
    if (stateRows('select id from mem_events').length !== before)
        throw new Error('玩笑/低置信也写了事件');
});

await check('状态：同一条消息重复判到不重复写', async () => {
    answers = stateAnswers();
    await send('我头疼得厉害', 'SID8', 'm10');
    const first = stateRows('select id from mem_events').length;
    await send('我头疼得厉害', 'SID8', 'm10');
    if (stateRows('select id from mem_events').length !== first)
        throw new Error('重复写了事件');
    const open = stateRows("select * from person_states where scope = 'qq:group:GID_TEST' and status = 'open'");
    if (open.length !== 1)
        throw new Error(`open 状态数 ${open.length}`);
});

const eventAnswers = (over = {}) => ({
    store: { noul: 0.1 },
    type: { choice: '其他' },
    subject: { choice: '说话人自己' },
    durability: { choice: '一次性' },
    importance: { score: 0.9 },
    sensitive: { noul: 0.01 },
    conflict: { noul: 0.02 },
    event: { noul: 0.9 },
    eventSubject: { choice: '说话人自己' },
    stateChange: { choice: '无' },
    stateSlot: { choice: '其他' },
    stateSubject: { choice: '无法判断' },
    stateCertainty: { score: 0 },
    ...over,
});

await check('事件：具体经历写 episode 事件，并关联长期记忆', async () => {
    answers = eventAnswers();
    await send('我今天去参加了公司的年会', 'SID9', 'm11');
    const rows = stateRows("select * from mem_events where kind = 'episode' and scope = 'qq:group:GID_TEST'");
    if (rows.length !== 1)
        throw new Error(`episode 事件数 ${rows.length}`);
    if (rows[0].op !== 'occur' || rows[0].subject_name !== '测试用户')
        throw new Error(`事件字段不对：${rows[0].op}/${rows[0].subject_name}`);
    if (rows[0].subject_id !== 'SID9' || rows[0].speaker_id !== 'SID9')
        throw new Error(`事件 openid 不对：${rows[0].subject_id}/${rows[0].speaker_id}`);
    const [memory] = stateRows('select id from memories order by id desc limit 1');
    if (Number(rows[0].memory_id) !== Number(memory.id))
        throw new Error('没关联 memoryId');
});

await check('事件：约定写 commitment 事件', async () => {
    answers = eventAnswers({
        event: { noul: 0 },
        type: { choice: '约定' },
        store: { noul: 0.8 },
        importance: { score: 1.2 },
        durability: { choice: '中期' },
    });
    await send('周六一起去看电影吧', 'SID10', 'm12');
    const rows = stateRows("select * from mem_events where kind = 'commitment' and scope = 'qq:group:GID_TEST'");
    if (rows.length !== 1 || rows[0].op !== 'declare')
        throw new Error(`commitment 事件不对：${JSON.stringify(rows)}`);
});

await check('事件：关系变化写 relation 事件', async () => {
    answers = eventAnswers({
        event: { noul: 0 },
        type: { choice: '关系' },
        store: { noul: 0.8 },
        importance: { score: 1.2 },
        durability: { choice: '长期' },
    });
    await send('我姐结婚了，我上周去参加婚礼', 'SID11', 'm13');
    const rows = stateRows("select * from mem_events where kind = 'relation' and scope = 'qq:group:GID_TEST'");
    if (rows.length !== 1 || rows[0].op !== 'change')
        throw new Error(`relation 事件不对：${JSON.stringify(rows)}`);
});

await check('事件：第一人称经历记在说话人名下，另一人作为 object', async () => {
    // 「我弟给我寄了柚子」：弟弟是说话人的弟弟，事件记在说话人名下，不算被寄的人有弟弟
    answers = eventAnswers({ type: { choice: '经历' }, eventObject: { choice: '阿余' } });
    await send('你们怎么知道我弟给我寄了柚子', 'SID14', 'm16');
    const [row] = stateRows("select * from mem_events where event_uid like '%m16%' and kind = 'episode'");
    if (!row)
        throw new Error('episode 没写');
    if (row.subject_name !== '测试用户')
        throw new Error(`主体不对：${row.subject_name}`);
    if (row.speaker_name !== '测试用户')
        throw new Error(`说话人不对：${row.speaker_name}`);
    if (row.object_name !== '阿余')
        throw new Error(`对象不对：${row.object_name}`);
    const [memory] = stateRows('select text, tags from memories order by id desc limit 1');
    // 正文统一带日期锚点（YYYY-MM-DD 前缀），类型/主体紧随其后
    if (!/^\d{4}-\d{2}-\d{2} \[经历\] 测试用户：/.test(String(memory.text)))
        throw new Error(`正文主体不对：${memory.text}`);
    if (!String(memory.tags).includes('object:阿余'))
        throw new Error(`缺少 object 标签：${memory.tags}`);
});

await check('事件：主体不明不写通用事件', async () => {
    answers = eventAnswers({ eventSubject: { choice: '无法判断' }, event: { noul: 0 } });
    const before = stateRows('select id from mem_events').length;
    await send('有人在群里说了件事', 'SID12', 'm14');
    if (stateRows('select id from mem_events').length !== before)
        throw new Error('主体不明也写了事件');
});

await check('事件：状态消息不重复写通用事件', async () => {
    answers = stateAnswers();
    const before = stateRows("select id from mem_events where kind != 'state'").length;
    await send('我胃疼得厉害', 'SID13', 'm15');
    const after = stateRows("select id from mem_events where kind != 'state'").length;
    if (after !== before)
        throw new Error('状态消息又写了一条通用事件');
    if (stateRows("select * from mem_events where kind = 'state' and event_uid like '%m15%'").length !== 1)
        throw new Error('状态事件没写');
});

// 作品标签：先在档案里记一条「黑牢城 = 电影」，再验证消息没写载体时也能补上
const peoplePath = join(home, '.dsh', 'profiles', 'qqbot', 'qqbot-people.json');
{
    const store = JSON.parse(readFileSync(peoplePath, 'utf8'));
    store.people = Array.isArray(store.people) ? store.people : [];
    if (!store.people.some((person) => person.name === '测试用户')) {
        store.people.push({ name: '测试用户', openids: ['SID'], groups: ['GID_TEST'], profile: {} });
        writeFileSync(peoplePath, `${JSON.stringify(store, null, 2)}\n`);
    }
    const conn = new DatabaseSync(dbPath);
    try {
        const columns = conn.prepare('pragma table_info(person_interests)').all();
        if (!columns.some((column) => String(column.name) === 'medium'))
            conn.exec("alter table person_interests add column medium text not null default ''");
        const exists = conn.prepare("select id from person_interests where person_key = 'id:SID' and title = '黑牢城' and medium = '电影'").get();
        if (!exists) {
            const at = Date.now();
            conn.prepare(`insert into person_interests (person_key, person_name, kind, title, title_key, medium, progress, status, created_at, updated_at)
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run('id:SID', '测试用户', 'movies', '黑牢城', '黑牢城', '电影', '昨天看的', '看完', at, at);
        }
    }
    finally {
        conn.close();
    }
}

const basicAnswers = (over = {}) => ({
    store: { noul: 0.9 },
    type: { choice: '经历' },
    subject: { choice: '说话人自己' },
    durability: { choice: '长期' },
    importance: { score: 1.5 },
    sensitive: { noul: 0.01 },
    conflict: { noul: 0.02 },
    experience: { choice: '亲身经历' },
    ...over,
});

await check('作品：消息没写载体时，用档案里的载体补标签', async () => {
    answers = basicAnswers({ workMedium: { choice: '说不清' } });
    await send('黑牢城还没看完呢', 'SID', 'm17');
    const last = rowsOf().at(-1);
    if (!String(last.tags).includes('work:黑牢城'))
        throw new Error(`缺少 work 标签：${last.tags}`);
    if (!String(last.tags).includes('medium:电影'))
        throw new Error(`缺少 medium 标签：${last.tags}`);
});

await check('作品：消息明说小说时以消息为准', async () => {
    answers = basicAnswers({ workMedium: { choice: '小说' } });
    await send('黑牢城的小说还差最后一点', 'SID', 'm18');
    const last = rowsOf().at(-1);
    if (!String(last.tags).includes('medium:小说'))
        throw new Error(`载体不对：${last.tags}`);
    if (String(last.tags).includes('medium:电影'))
        throw new Error(`档案载体覆盖了消息：${last.tags}`);
});

await check('成就：只说「达成」也按经历落库并进事件流', async () => {
    answers = {
        store: { noul: 0.05 },
        type: { choice: '其他' },
        subject: { choice: '无法判断' },
        durability: { choice: '一次性' },
        importance: { score: 0.2 },
        sensitive: { noul: 0.01 },
        conflict: { noul: 0.02 },
        event: { noul: 0 },
        eventSubject: { choice: '无法判断' },
        achievement: { noul: 0.9 },
        stateChange: { choice: '无' },
        stateSlot: { choice: '其他' },
        stateSubject: { choice: '无法判断' },
        stateCertainty: { score: 0 },
    };
    const before = rowsOf().length;
    await send('达成', 'SID15', 'm19');
    const rows = rowsOf();
    if (rows.length !== before + 1)
        throw new Error('成就短句没入库');
    if (!/^\d{4}-\d{2}-\d{2} \[经历\] 测试用户：达成/.test(String(rows.at(-1).text)))
        throw new Error(`正文不对：${rows.at(-1).text}`);
    if (!String(rows.at(-1).tags).includes('成就'))
        throw new Error(`缺少成就标签：${rows.at(-1).tags}`);
    if (!String(rows.at(-1).tags).includes('imp:1.2'))
        throw new Error(`成就没抬高重要性：${rows.at(-1).tags}`);
    const events = stateRows("select * from mem_events where kind = 'episode' and event_uid like '%m19%'");
    if (events.length !== 1)
        throw new Error(`episode 事件数 ${events.length}`);
});

await check('成就：承接短句但象信否认 → 不写', async () => {
    answers = {
        store: { noul: 0.05 },
        type: { choice: '其他' },
        subject: { choice: '无法判断' },
        durability: { choice: '一次性' },
        importance: { score: 0.2 },
        sensitive: { noul: 0.01 },
        conflict: { noul: 0.02 },
        event: { noul: 0 },
        eventSubject: { choice: '无法判断' },
        achievement: { noul: 0.1 },
        stateChange: { choice: '无' },
        stateSlot: { choice: '其他' },
        stateSubject: { choice: '无法判断' },
        stateCertainty: { score: 0 },
    };
    const before = rowsOf().length;
    const eventsBefore = stateRows('select id from mem_events').length;
    await send('过了', 'SID16', 'm20');
    if (rowsOf().length !== before || stateRows('select id from mem_events').length !== eventsBefore)
        throw new Error('否认证候还是写了');
});

await check('元讨论：聊机器人/记忆/代码本身不按经历落库', async () => {
    answers = basicAnswers({
        meta: { noul: 0.9 },
        event: { noul: 0.9 },
        eventSubject: { choice: '说话人自己' },
        achievement: { noul: 0.9 },
    });
    const before = rowsOf().length;
    const eventsBefore = stateRows('select id from mem_events').length;
    await send('记忆门控那段代码我又改了一版，重启之后再看日志', 'SID', 'm21');
    if (rowsOf().length !== before || stateRows('select id from mem_events').length !== eventsBefore)
        throw new Error('元讨论还是入库了');
});

await check('元讨论：type 判成「其他」也不能从事件兜底绕过去', async () => {
    // 线上样本：聊记忆系统时 meta=0.95，但 type 判成其他；旧逻辑只看 type 会漏拦
    answers = basicAnswers({
        meta: { noul: 0.95 },
        type: { choice: '其他' },
        subject: { choice: '云影' },
        store: { noul: 0.21 },
        event: { noul: 0.95 },
        eventSubject: { choice: '云影' },
        achievement: { noul: 0 },
        importance: { score: 1.63 },
    });
    const before = rowsOf().length;
    const eventsBefore = stateRows('select id from mem_events').length;
    await send('大模型把云影说话扔给杰哥就离谱了', 'SID', 'm29');
    if (rowsOf().length !== before || stateRows('select id from mem_events').length !== eventsBefore)
        throw new Error('元讨论从事件兜底写进去了');
});

await check('主体纠偏：说「小易」的话记在说话人名下，并标 about:小易', async () => {
    answers = basicAnswers({ subject: { choice: '机器人' } });
    await send('小易今天怎么老抽风', 'SID', 'm22');
    const last = rowsOf().at(-1);
    if (!/^\d{4}-\d{2}-\d{2} \[经历\] 测试用户：/.test(String(last.text)))
        throw new Error(`主体没纠正：${last.text}`);
    if (!String(last.tags).includes('subject:测试用户'))
        throw new Error(`缺少 subject 标签：${last.tags}`);
    if (String(last.tags).includes('subject:机器人'))
        throw new Error(`还挂在机器人名下：${last.tags}`);
    if (!String(last.tags).includes('about:小易'))
        throw new Error(`缺少 about 标签：${last.tags}`);
});

await check('主体纠偏：事件主体是机器人时同样回落到说话人', async () => {
    answers = eventAnswers({ eventSubject: { choice: '机器人' } });
    await send('小易昨天帮我打过了那个副本', 'SID17', 'm23');
    const [row] = stateRows("select * from mem_events where event_uid like '%m23%' and kind = 'episode'");
    if (!row)
        throw new Error('episode 没写');
    if (row.subject_name !== '测试用户')
        throw new Error(`事件主体没纠正：${row.subject_name}`);
    const [memory] = stateRows('select tags from memories order by id desc limit 1');
    if (!String(memory.tags).includes('about:小易'))
        throw new Error(`缺少 about 标签：${memory.tags}`);
});

await check('机制：攻略类不按经历落库，也不进事件流', async () => {
    answers = basicAnswers({
        type: { choice: '经历' },
        subject: { choice: '说话人自己' },
        store: { noul: 0.9 },
        importance: { score: 1.5 },
        achievement: { noul: 0.9 },
        event: { noul: 0.9 },
        eventSubject: { choice: '说话人自己' },
        experience: { choice: '机制攻略' },
    });
    const before = rowsOf().length;
    const eventsBefore = stateRows('select count(*) as n from mem_events')[0].n;
    await send('尤其是两个暗夜t做转火，2t嘲讽同时开暴击，1t影遁降仇恨', 'SID', 'm27');
    const rows = rowsOf();
    if (rows.length !== before + 1)
        throw new Error(`入库条数 ${rows.length - before}`);
    const last = rows.at(-1);
    if (!/^\d{4}-\d{2}-\d{2} \[其他\] 其他人：/.test(String(last.text)))
        throw new Error(`类型/主体不对：${last.text}`);
    if (!String(last.tags).includes('知识'))
        throw new Error(`缺知识标签：${last.tags}`);
    if (!String(last.tags).includes('subject:其他人'))
        throw new Error(`缺 subject:其他人：${last.tags}`);
    if (!String(last.tags).includes('speaker-id:SID'))
        throw new Error(`知识条目丢了说话人 openid：${last.tags}`);
    if (!String(last.tags).includes('speaker:测试用户'))
        throw new Error(`知识条目丢了说话人标签：${last.tags}`);
    const eventsAfter = stateRows('select count(*) as n from mem_events')[0].n;
    if (eventsAfter !== eventsBefore)
        throw new Error('机制攻略写进了事件流');
});

await check('共识：store 低 + 机制攻略封死兜底，但象信判为客观定义 → 仍入库', async () => {
    // 复现线上：store=0.45<0.5、exp=机制攻略 使 event/achievement 兜底失效，
    // 只有新的 consensus 通道能救回来。
    answers = basicAnswers({
        type: { choice: '其他' },
        subject: { choice: '说话人自己' },
        store: { noul: 0.45 },
        importance: { score: 1.8 },
        experience: { choice: '机制攻略' },
        consensus: { noul: 0.9 },
        event: { noul: 0.41 },
        achievement: { noul: 0.01 },
    });
    const before = rowsOf().length;
    await send('小葛，小易，你们都记住了，魔兽无限是最新的官方版本，不是私服', 'SID', 'm30');
    const rows = rowsOf();
    if (rows.length !== before + 1)
        throw new Error(`入库条数 ${rows.length - before}`);
    const last = rows.at(-1);
    if (!/^\d{4}-\d{2}-\d{2} \[其他\] 其他人：/.test(String(last.text)))
        throw new Error(`类型/主体不对：${last.text}`);
    if (!String(last.tags).includes('共识'))
        throw new Error(`缺共识标签：${last.tags}`);
    if (!String(last.tags).includes('长期'))
        throw new Error(`共识应按长期存：${last.tags}`);
});

await check('共识：importance 不够时仍跳过（防随口纠正全写）', async () => {
    answers = basicAnswers({
        store: { noul: 0.4 },
        importance: { score: 0.5 },
        consensus: { noul: 0.9 },
    });
    const before = rowsOf().length;
    await send('这个不是这样，是另一个', 'SID', 'm31');
    if (rowsOf().length !== before)
        throw new Error('importance 低也写了');
});

await check('共识：象信说不是客观定义时按原逻辑跳过', async () => {
    answers = basicAnswers({
        store: { noul: 0.36 },
        importance: { score: 1.39 },
        consensus: { noul: 0.2 },
    });
    const before = rowsOf().length;
    await send('我再说一遍，我真的很困', 'SID', 'm32');
    if (rowsOf().length !== before)
        throw new Error('不该入库');
});

await check('共识：开发讨论（meta 高）不写', async () => {
    answers = basicAnswers({
        store: { noul: 0.4 },
        importance: { score: 1.6 },
        consensus: { noul: 0.9 },
        meta: { noul: 0.8 },
    });
    const before = rowsOf().length;
    await send('记忆系统里这个字段的定义是这样的', 'SID', 'm33');
    if (rowsOf().length !== before)
        throw new Error('meta 高也写了');
});

await check('共识：敏感内容仍然拦', async () => {
    answers = basicAnswers({
        store: { noul: 0.4 },
        importance: { score: 1.6 },
        consensus: { noul: 0.9 },
        sensitive: { noul: 0.9 },
    });
    const before = rowsOf().length;
    await send('官方定义的密码是 123456，不是 654321', 'SID', 'm34');
    if (rowsOf().length !== before)
        throw new Error('敏感也写了');
});

await check('openid：记在别人名下的记忆同时带 subject-id 和 speaker-id', async () => {
    // 档案是测试副本，这里补一个本群的人，验证名字能还原成 openid
    const peoplePath = join(home, '.dsh', 'profiles', 'qqbot', 'qqbot-people.json');
    const store = JSON.parse(readFileSync(peoplePath, 'utf8'));
    store.people = Array.isArray(store.people) ? store.people : [];
    store.people.push({ name: '测试阿余', addressing: '阿余', openids: ['OID_AYU'], groups: ['GID_TEST'] });
    writeFileSync(peoplePath, JSON.stringify(store));
    answers = basicAnswers({
        type: { choice: '经历' },
        subject: { choice: '测试阿余' },
        store: { noul: 0.9 },
        importance: { score: 1.3 },
        event: { noul: 0 },
    });
    await send('阿余今天一个人去打了全场篮球', 'SID12', 'm28');
    const last = rowsOf().at(-1);
    if (!String(last.text).includes('测试阿余：'))
        throw new Error(`主体没写成档案名：${last.text}`);
    if (!String(last.tags).includes('subject-id:OID_AYU'))
        throw new Error(`缺 subject-id：${last.tags}`);
    if (!String(last.tags).includes('speaker-id:SID12'))
        throw new Error(`缺 speaker-id：${last.tags}`);
});

await check('图片：纯图先做视觉摘要，再按成就落库', async () => {
    answers = basicAnswers({
        store: { noul: 0.01 },
        importance: { score: 0.7 },
        achievement: { noul: 0.9 },
        type: { choice: '经历' },
        subject: { choice: '说话人自己' },
    });
    const before = rowsOf().length;
    const callsBefore = visionCalls;
    await send('[图片]', 'SID', 'm24', { imagePath: '/tmp/qqbot-test-achievement.png' });
    if (visionCalls !== callsBefore + 1)
        throw new Error('没调用视觉');
    const rows = rowsOf();
    if (rows.length !== before + 1)
        throw new Error(`入库条数 ${rows.length - before}`);
    const last = rows.at(-1);
    if (!String(last.text).includes('图片内容：一张游戏成就达成截图'))
        throw new Error(`摘要没进正文：${last.text}`);
    if (!String(last.tags).includes('成就'))
        throw new Error(`缺成就标签：${last.tags}`);
});

await check('图片：同一路径重复判到不重复调用视觉', async () => {
    const callsBefore = visionCalls;
    await send('[图片]', 'SID', 'm25', { imagePath: '/tmp/qqbot-test-achievement.png' });
    if (visionCalls !== callsBefore)
        throw new Error('重复调了视觉');
});

await check('图片：视觉失败时退回占位符跳过并留痕', async () => {
    visionResult = null;
    const before = rowsOf().length;
    await send('[图片]', 'SID', 'm26', { imagePath: '/tmp/qqbot-test-null.png' });
    if (rowsOf().length !== before)
        throw new Error('视觉失败还入库了');
    const lines = readQqbotRecords(process.env.QQBOT_PROFILE_DIR, 'memory-gate');
    if (!lines.some((line) => line.reason === 'vision_failed'))
        throw new Error('没有 vision_failed 记录');
    visionResult = { what: '一张游戏成就达成截图，写着「白手起家」', joke: 0.1 };
});

await check('审计日志：跳过与入库都留痕，超过 30 天的旧记录被清掉', async () => {
    const lines = readQqbotRecords(process.env.QQBOT_PROFILE_DIR, 'memory-gate');
    const reasons = new Set(lines.map((line) => line.reason));
    if (reasons.has('too_old_marker'))
        throw new Error('60 天前的记录没被清掉');
    if (!reasons.has('too_short'))
        throw new Error('没有 too_short 记录');
    if (!reasons.has('placeholder'))
        throw new Error('没有 placeholder 记录');
    if (!lines.some((line) => String(line.decision).includes('memory')))
        throw new Error('没有成功入库的审计记录');
    if (!lines.some((line) => line.speakerId === 'SID9'))
        throw new Error('审计没记说话人 openid');
});

await check('跟进事件：同一请求读取上下文，短句可按事件 ID 结算', async () => {
    const profile = process.env.QQBOT_PROFILE_DIR;
    withQqbotProfileDocuments(profile, db => db.update('people', state => {
        state.people.push({ name: '乙同学', openids: ['SID_B'], groups: ['GID_TEST'] });
        return state;
    }));
    runtime.setupEvents({ get: name => name === 'llm' ? {
        async *stream() {
            yield { type: 'text-delta', text: '{"title":"帮乙同学拿胃药","object":"胃药","due":""}' };
        },
    } : undefined }, {}, {}, quietLogger);
    const events = globalThis.__qqbotEvents;
    const requestBodies = [];
    const planAnswers = {
        plan: { noul: 0.96 },
        followup_priority: { score: 2.6 },
        followup_timing: { choice: '近期' },
        followup_person: { choice: '乙同学', confidence: 0.98 },
    };
    (globalThis.__qqbotRecentMessages ??= new Map()).set('GID_TEST', [
        { name: '乙同学', id: 'SID_B', content: '我忘了带胃药', msgId: 'earlier' },
        { name: '测试用户', id: 'SID', content: '我去帮乙同学拿胃药', msgId: 'followup-plan' },
    ]);
    globalThis.fetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        requestBodies.push(body);
        let reply = {};
        if (body.state.消息 === '我去帮乙同学拿胃药') reply = planAnswers;
        if (['到了', '已经找到药盒了，还没拿给他', '已经拿到前台了'].includes(body.state.消息)) {
            reply = {
                result_plan: { choice: Object.keys(body.state.待跟进事项)[0], confidence: 0.97 },
                result_kind: { choice: body.state.消息 === '到了' ? '完成' : '进展', confidence: 0.96 },
            };
        }
        if (body.state.消息 === '我还帮乙同学取包裹') reply = { ...planAnswers, sensitive: { noul: 0.9 } };
        if (body.state.消息 === '我对耽搁这么久很生气') {
            reply = {
                attitude: { choice: '当次负向', confidence: 0.91 },
                attitude_event: { choice: Object.keys(body.state.已结算事项 ?? {})[0], confidence: 0.94 },
                type: { choice: '偏好' },
            };
        }
        if (body.state.消息 === '我一直喜欢看推理小说')
            reply = { attitude: { choice: '稳定喜欢', confidence: 0.95 }, type: { choice: '其他' } };
        return { ok: true, json: async () => ({ answers: reply }) };
    };
    const memoryCount = rowsOf().length;
    await Promise.all([
        send('[Quoted message begins]我想去跑步[Quoted message ends]我去帮乙同学拿胃药', 'SID', 'followup-plan'),
        send('我还帮乙同学取包裹', 'SID', 'followup-sensitive'),
    ]);
    if (requestBodies.length !== 2 || !requestBodies[0].questions.store || !requestBodies[0].questions.plan
        || !requestBodies[0].state.最近对话.includes('我忘了带胃药')
        || requestBodies[0].state.消息 !== '我去帮乙同学拿胃药') throw new Error('没有共享请求、清洗或上下文');
    const [plan] = events.read().events;
    if (events.read().events.length !== 1 || plan.personId !== 'SID_B' || plan.sourcePersonId !== 'SID'
        || plan.object !== '胃药' || plan.sourceMessageId !== 'followup-plan' || rowsOf().length !== memoryCount) throw new Error('跟进对象、证据或入库过滤异常');
    await send('已经找到药盒了，还没拿给他', 'SID', 'followup-progress');
    const progress = events.read().events.find(item => item.id === plan.id);
    if (progress.status !== 'open' || progress.progressMessageId !== 'followup-progress'
        || !events.promptLine('GID_TEST', { name: '乙同学', id: 'SID_B' }, { messageId: 'new-message', preview: true }).includes('已经找到药盒了'))
        throw new Error('进展未保留到跟进提示');
    await send('已经拿到前台了', 'SID', 'followup-progress2');
    await send('到了', 'SID_B', 'followup-result', { senderName: '乙同学' });
    const result = events.read().events.find(item => item.id === plan.id);
    if (result.status !== 'done' || result.resultMessageId !== 'followup-result'
        || result.resultEvidence !== '到了' || result.resultPersonId !== 'SID_B') throw new Error('短结果未结算到原事件');
    if (result.history.map(entry => entry.messageId).join(',') !== 'followup-progress,followup-progress2,followup-result'
        || result.progressEvidence !== '已经拿到前台了') throw new Error('历史进展丢失或最新进展不正确');
    await send('到了', 'SID_B', 'followup-result', { senderName: '乙同学' });
    const outcomes = rowsOf().filter(row => row.tags.includes(`event-result:${plan.id}`));
    if (outcomes.length !== 1 || !outcomes[0].text.includes('帮乙同学拿胃药」结果：完成')
        || !outcomes[0].tags.includes('subject-id:SID_B') || !outcomes[0].tags.includes('object-id:SID')) {
        throw new Error('结算没有按事项和人物归档，或重复写入');
    }
    const linked = stateRows('select subject_id, object_id, memory_id from mem_events where event_uid = ?', `tracked-result:GID_TEST:${plan.id}:followup-result`);
    if (linked.length !== 1 || !linked[0].memory_id || linked[0].subject_id !== 'SID_B' || linked[0].object_id !== 'SID') {
        throw new Error('人物经历缺少关联结果或参与者');
    }
    await send('我对耽搁这么久很生气', 'SID_B', 'followup-attitude', { senderName: '乙同学' });
    await send('我一直喜欢看推理小说', 'SID', 'stable-attitude');
    const beforeLaughter = requestBodies.length;
    await send('哈哈哈哈哈哈', 'SID', 'laughter');
    if (requestBodies.length !== beforeLaughter) throw new Error('纯笑声仍被送往记忆裁判');
    const rows = rowsOf();
    if (!rows.some(row => row.text.includes('关于「帮乙同学拿胃药」') && row.tags.includes('当次负向')
        && row.tags.includes('tracked-event:' + plan.id) && !row.tags.includes('偏好'))
        || !rows.some(row => row.text.includes('喜欢看推理小说') && row.tags.startsWith('偏好 ') && row.tags.includes('长期'))
        || rows.some(row => row.text.includes('哈哈哈哈哈哈'))) throw new Error('当次态度、稳定偏好或纯笑声归档错误');
    const audit = readQqbotRecords(profile, 'memory-gate');
    if (!audit.some(line => line.messageUid === 'followup-plan' && line.tracking?.decision === 'tracked')
        || !audit.some(line => line.messageUid === 'followup-sensitive' && line.tracking?.decision === 'sensitive')
        || !audit.some(line => line.messageUid === 'followup-result' && line.tracking?.closedEventId === plan.id)) {
        throw new Error('审计缺少计划、过滤或结算记录');
    }
});

await check('人物状态工具由发起查询的 agent 绑定群组，不读取进程最近活跃的群', () => {
    let tool;
    const managed = {};
    const group = { scope: 'group', peerId: 'GID_TEST', replyTarget: { targetId: 'GID_TEST', msgId: 'fixture-status-message' } };
    stateApi.setupPersonStatusTool({ get: () => ({ register(value) { tool = value; } }) }, {
        findByAgent: (agent) => agent === managed ? group : undefined,
    });
    globalThis.__qqbotLastGid = 'fixture-unrelated-group';
    const recent = globalThis.__qqbotRecentMessages ??= new Map();
    recent.set(group.peerId, [{ msgId: group.replyTarget.msgId, name: '测试用户' }]);
    const original = globalThis.__qqbotPersonState.block;
    globalThis.__qqbotPersonState.block = (gid) => gid;
    try {
        if (tool.execute({}, { agent: managed }).status !== group.peerId) throw new Error('未使用查询会话的群');
        if (tool.execute({ name: '测试用户' }, { agent: {} }).status !== '') throw new Error('未管理的会话读到了群资料');
        group.scope = 'c2c';
        if (tool.execute({ name: '测试用户' }, { agent: managed }).status !== '') throw new Error('私聊读到了群资料');
    } finally {
        globalThis.__qqbotPersonState.block = original;
    }
});

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

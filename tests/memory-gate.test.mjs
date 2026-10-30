#!/usr/bin/env node
/**
 * 记忆门控离线测试：不调象信、不碰真实库。
 *
 * 验证：
 *   - 没有关键词预筛：普通「我今天买了…」也会送判
 *   - 引用块/历史块不会被当成说话人自己的话
 *   - 纯 [图片] 占位符不送判
 *   - 象信说「不值得」就不写
 *
 * 用法：node tests/memory-gate.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createMemoryStore } from './fixtures/memory-store.mjs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const home = mkdtempSync(join(tmpdir(), 'qqbot-memgate-'));
process.env.HOME = home; // Isolate all homedir-based helper reads before setup.
mkdirSync(join(home, '.dsh', 'memory'), { recursive: true });
mkdirSync(join(home, '.dsh', 'profiles', 'qqbot'), { recursive: true });
writeFileSync(join(home, '.dsh', 'profiles', 'qqbot', 'qqbot-people.json'), JSON.stringify({
    people: [{ name: '测试档案成员', addressing: '测试档案称呼', openids: ['SID1'], groups: ['GID_TEST'], profile: {} }],
}));
process.env.QQBOT_PROFILE_DIR = join(home, '.dsh', 'profiles', 'qqbot');
process.env.XIANGXIN_API_KEY = 'test-key';

const dbPath = join(home, '.dsh', 'memory', 'ltm.db');
const db = createMemoryStore(dbPath);
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
    return { setupMemoryGate };
`);
factory(readFileSync, process.getBuiltinModule('node:fs').writeFileSync, { log: () => {} })
    .setupMemoryGate({}, {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });

const rowsOf = () => {
    const conn = new DatabaseSync(dbPath, { readOnly: true });
    try {
        return conn.prepare('select text, tags, scope from memories').all();
    }
    finally {
        conn.close();
    }
};
const send = (content, senderId = 'SID') => globalThis.__qqbotMemoryGate.consider({
    message: { kind: 'group', groupOpenid: 'GID_TEST', senderId, senderName: '测试用户', content },
});

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
    if (!String(rows.at(-1).text).includes('测试档案称呼'))
        throw new Error('没有按虚构档案称呼写入');
});

await check('引用块不会被当成说话人自己的话', async () => {
    await send('[Quoted message begins] 别人说：我养了一只猫 [Quoted message ends] [Current message] 我今天去测试城参加展会', 'SID2');
    const last = rowsOf().at(-1);
    if (String(last.text).includes('我养了一只猫'))
        throw new Error('把引用记进来了');
    if (!String(last.text).includes('我今天去测试城参加展会'))
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
    await send('我这次想买测试积木，主要想拼一座虚构城堡', 'SID5');
    const rows = rowsOf();
    if (rows.length !== before + 1)
        throw new Error('分享没有入库');
    if (!String(rows.at(-1).tags).includes('分享'))
        throw new Error('没带分享标签');
});

// home is the mkdtemp-created isolated fixture root, never the real HOME.
rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

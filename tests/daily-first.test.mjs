#!/usr/bin/env node
/**
 * 「每日首条必接」（dailyFirstReply）离线测试。
 *
 * 不启动 QQ：把补丁片段抽出来，配上临时 profile 目录直接跑。
 *   - 群门控 / 象信门控共用的 dailyFirstPending()：只读、不提前消耗「今天已出现」
 *   - 提示词：今天首条注入「必须接话」，纯表情包不接、纯图片仍接，诉苦改走关心
 *
 * 用法：node tests/daily-first.test.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const PROFILE = mkdtempSync(join(tmpdir(), 'qqbot-daily-first-'));
const OLD_HOME = process.env.HOME;
process.env.QQBOT_PROFILE_DIR = PROFILE;
process.env.HOME = PROFILE;   // 隔离 ltm.db，避免读到真实记忆

const GID = 'G1';
const PEOPLE_PATH = join(PROFILE, 'qqbot-people.json');
const GREETINGS_PATH = join(PROFILE, 'qqbot-greetings.json');

const PEOPLE = {
    people: [
        { name: '测试成员己', openids: ['USER_FIXTURE_F'], groups: [GID], dailyFirstReply: true, social: { affinity: 20 }, profile: {} },
        { name: '测试成员庚', openids: ['USER_FIXTURE_G'], groups: [GID], dailyFirstReply: true, social: { affinity: 90 }, profile: {} },
        { name: '路人', openids: ['ID_LUREN'], groups: [GID], profile: {} },
    ],
};
writeFileSync(PEOPLE_PATH, JSON.stringify(PEOPLE, null, 2));

// ── 群门控里那三个共用判断（只读） ──
const gateSrc = readFileSync(join(ROOT, 'qqbot-patches', 'group-mention.js'), 'utf8')
    .split('// >>> daily-first-helpers')[1]
    .split('// <<< daily-first-helpers')[0];
const gateFactory = new Function('readFileSync', `
    const gateProfileDir = process.env.QQBOT_PROFILE_DIR;
    ${gateSrc}
    return { dailyFirstDateKey, dailyFirstFindPerson, dailyFirstPending };
`);
const gate = gateFactory(readFileSync);

// ── 提示词 helper ──
const helperSrc = readFileSync(join(ROOT, 'qqbot-patches', 'people-roster-helper.js'), 'utf8')
    .replace(/^\/\* >>>.*$/m, '')
    .replace(/^\/\* <<<.*$/m, '');
const helperFactory = new Function('readFileSync', 'writeFileSync', `
    ${helperSrc}
    return { buildSpeakerContext, isFirstMessageToday, detectVenting, isPlaceholderOnly, localDateKey };
`);
const api = helperFactory(readFileSync, writeFileSync);

function resetGreetings(state = {}) {
    writeFileSync(GREETINGS_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function speak(person, content) {
    globalThis.__qqbotSpeakers = new Map([[GID, { id: person.openids[0], name: person.name }]]);
    globalThis.__qqbotRecentMessages = new Map([[GID, [{
        id: person.openids[0], name: person.name, msgId: 'm1', content, at: Date.now(),
    }]]]);
    globalThis.__qqbotPendingInbound = new Map();
    globalThis.__qqbotHooks = new Map();
    globalThis.__qqbotSubjects = new Map();
    globalThis.__qqbotSocial = undefined;
}

const memberF = PEOPLE.people[0];
const memberG = PEOPLE.people[1];
const outsider = PEOPLE.people[2];

let pass = 0;
let fail = 0;
function check(name, fn) {
    try {
        fn();
        pass++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        fail++;
        console.error(`  ✗ ${name}\n    ${err.message}`);
    }
}
function ok(value, label) {
    if (!value) throw new Error(`${label}: 期望为真`);
}
function notOk(value, label) {
    if (value) throw new Error(`${label}: 期望为假`);
}
function eq(actual, expected, label) {
    if (actual !== expected) throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

const build = () => api.buildSpeakerContext(GID, { scope: 'group', peerId: GID });

console.log('每日首条必接测试');

check('本地日期按 00:00 换天（不是 UTC 8 点）', () => {
    eq(api.localDateKey(new Date(2026, 9, 27, 0, 5)), '2026-10-27', '凌晨 00:05');
    eq(api.localDateKey(new Date(2026, 9, 27, 23, 59)), '2026-10-27', '晚上 23:59');
    eq(api.localDateKey(new Date(2026, 9, 28, 0, 5)), '2026-10-28', '次日凌晨');
});

check('门控只读：首次判定为 true，且不写 greetings', () => {
    resetGreetings();
    const sender = { id: memberF.openids[0], name: memberF.name };
    eq(gate.dailyFirstPending(GID, sender), true, '首次');
    eq(gate.dailyFirstPending(GID, sender), true, '再读仍为 true（没有被门控消耗）');
    eq(JSON.parse(readFileSync(GREETINGS_PATH, 'utf8'))[`${GID}:${memberF.openids[0]}`], undefined, '未落盘');
});

check('门控：今天已出现 / 没勾 / 不认识 → false', () => {
    resetGreetings({ [`${GID}:${memberF.openids[0]}`]: gate.dailyFirstDateKey() });
    eq(gate.dailyFirstPending(GID, { id: memberF.openids[0], name: memberF.name }), false, '今天已出现');
    resetGreetings();
    eq(gate.dailyFirstPending(GID, { id: outsider.openids[0], name: outsider.name }), false, '没勾');
    eq(gate.dailyFirstPending(GID, { id: 'ID_UNKNOWN', name: '陌生人' }), false, '不认识');
});

check('勾了的人今天首条普通文字 → 注入「今日首条必须接话」', () => {
    resetGreetings();
    speak(memberF, '我来了');
    const text = build();
    ok(text.includes('【今日首条】'), '带今日首条');
    ok(text.includes('必须接一句'), '要求接话');
    ok(text.includes('不能回 [SILENT]'), '不许沉默');
});

check('同一天第二条 → 不再要求', () => {
    speak(memberF, '今天吃什么');
    notOk(build().includes('【今日首条】'), '不再带今日首条');
});

check('首条只有 [表情] → 不再硬接，直接 [SILENT]', () => {
    resetGreetings();
    speak(memberF, '[表情]');
    const text = build();
    notOk(text.includes('必须接一句'), '不要求接话');
    ok(text.includes('直接 [SILENT]'), '明确沉默');
    notOk(text.includes('今天在本群第一次说话'), '不套问候');
});

check('首条只有 [图片] → 仍按今日首条接一句', () => {
    resetGreetings();
    speak(memberF, '[图片]');
    const text = build();
    ok(text.includes('【今日首条】'), '带今日首条');
    ok(text.includes('必须接一句'), '要求接话');
    ok(text.includes('图片/视频/文件占位符'), '图片占位符仍接');
});

check('首条在诉苦 → 不套问候/硬接话，改走关心', () => {
    resetGreetings();
    speak(memberF, '今天好累啊');
    const text = build();
    notOk(text.includes('【今日首条】'), '不套今日首条');
    ok(text.includes('TA 刚提到自己的状况'), '注入状况提示');
    ok(text.includes('不要沉默'), '仍要求回应');
});

check('关系很熟的人首条诉苦 → 也不套「早呀」式问候', () => {
    resetGreetings();
    speak(memberG, '好累啊');
    const text = build();
    notOk(text.includes('今天在本群第一次说话'), '不问候');
    notOk(text.includes('【今日首条】'), '不硬接话');
    ok(text.includes('TA 刚提到自己的状况'), '按关心');
});

check('没勾的人首条 → 不注入', () => {
    resetGreetings();
    speak(outsider, '路过');
    notOk(build().includes('【今日首条】'), '没勾不注入');
});

check('到了第二天（本地日期变了）→ 重新算首条', () => {
    resetGreetings({ [`${GID}:${memberF.openids[0]}`]: '2000-01-01' });
    speak(memberF, '早呀');
    ok(build().includes('【今日首条】'), '新的一天重新注入');
});

check('占位符判定：只有 [图片]/[表情xx] 才算，带文字不算', () => {
    ok(api.isPlaceholderOnly('[图片]'), '纯 [图片]');
    ok(api.isPlaceholderOnly(' [表情123] '), '纯 [表情123]');
    ok(api.isPlaceholderOnly(''), '空内容');
    notOk(api.isPlaceholderOnly('看图 [图片]'), '带文字');
});

check('诉苦判定：好消息不算诉苦', () => {
    ok(api.detectVenting('今天好累'), '累');
    ok(api.detectVenting('我又胖了'), '胖');
    notOk(api.detectVenting('我升职了'), '好消息');
});

console.log(`\n${pass} 通过, ${fail} 失败`);

process.env.HOME = OLD_HOME;
rmSync(PROFILE, { recursive: true, force: true });
process.exit(fail ? 1 : 0);

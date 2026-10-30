#!/usr/bin/env node
/**
 * 群唤醒指数（wakeIndex）离线测试。
 *
 * 不启动 QQ：把群门控里「读配置 + 判断要不要接」的片段抽出来，配上临时 profile 目录直接跑。
 *   - 100 = 老行为：没被点名（图片 / 炫耀 / 对话窗口 / 打招呼）也每条都接
 *   - 25  = 只有约 25% 的这类消息会被放进来
 *   - 0   = 只听 @（门控外）和叫名字
 *   - @ / 名字 / 每日首条必接 不受指数影响
 *
 * 用法：node tests/wake-index.test.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const PROFILE = mkdtempSync(join(tmpdir(), 'qqbot-wake-index-'));
const OLD_HOME = process.env.HOME;
process.env.QQBOT_PROFILE_DIR = PROFILE;
process.env.HOME = PROFILE;

const GROUPS_PATH = join(PROFILE, 'qqbot-groups.json');
const PEOPLE_PATH = join(PROFILE, 'qqbot-people.json');

const LOW = 'GROUP_LOW';       // 指数 25
const MUTE = 'GROUP_MUTE';     // 指数 0
const NORMAL = 'GROUP_NORMAL'; // 没单独配 = 默认 100
const OUTSIDE = 'GROUP_OUTSIDE'; // 不在 noMention 里（必须真 @）

function writeGroups(extra = {}) {
    writeFileSync(GROUPS_PATH, `${JSON.stringify({
        noMention: [LOW, MUTE, NORMAL],
        wakeWords: ['小易'],
        wakeCooldownMs: 0,
        conversationWindowMs: 180000,
        wakeIndex: { [LOW]: 25, [MUTE]: 0 },
        ...extra,
    }, null, 2)}\n`);
}

writeGroups();
writeFileSync(PEOPLE_PATH, JSON.stringify({
    people: [
        { name: '测试成员己', openids: ['USER_FIXTURE_F'], groups: [MUTE], dailyFirstReply: true, profile: {} },
    ],
}, null, 2));

// ── 抽片段：配置读取 + 唤醒指数 + 每日首条 + 判断函数 ──
const source = readFileSync(join(ROOT, 'qqbot-patches', 'group-mention.js'), 'utf8');
const slice = (start, end) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    if (from === -1 || to === -1) throw new Error(`找不到补丁片段：${start} … ${end}`);
    return source.slice(from + start.length, to);
};
const core = slice('// >>> group-gate-core', '// <<< group-gate-core');
const daily = slice('// >>> daily-first-helpers', '// <<< daily-first-helpers');
const decide = slice('// >>> wake-decide', '// <<< wake-decide');

const factory = new Function('readFileSync', 'appendFileSync', `
    const gateProfileDir = process.env.QQBOT_PROFILE_DIR;
    ${core}
    ${daily}
    ${decide}
    return { loadGroupGateConfig, wakeIndexOf, decideGroupImplicit, lastWakeAt, lastActivityAt };
`);
const gate = factory(readFileSync, () => {});

const realRandom = Math.random;
const withRandom = (value, fn) => {
    Math.random = () => value;
    try { return fn(); } finally { Math.random = realRandom; }
};

function reset() {
    gate.lastWakeAt.clear();
    gate.lastActivityAt.clear();
    delete globalThis.__qqbotLastBotReply;
    delete globalThis.__qqbotGreetGate;
    delete globalThis.__qqbotSpeakers;
    delete globalThis.__qqbotRecentMessages;
}

let pass = 0;
let fail = 0;
function check(name, fn) {
    reset();
    try {
        fn();
        pass += 1;
        console.log(`  ✓ ${name}`);
    }
    catch (err) {
        fail += 1;
        console.log(`  ✗ ${name}\n    ${err?.message ?? err}`);
    }
}
function eq(actual, expected, label) {
    if (actual !== expected)
        throw new Error(`${label ?? ''} 期望 ${expected}，实际 ${actual}`);
}

console.log('唤醒指数');

check('默认 100：图片 / 炫耀 / 对话窗口都放行', () => {
    eq(gate.decideGroupImplicit(NORMAL, '[图片]'), true, '图片');
    reset();
    eq(gate.decideGroupImplicit(NORMAL, '我抽到限定角色了'), true, '炫耀');
    reset();
    gate.lastActivityAt.set(NORMAL, Date.now());
    eq(gate.decideGroupImplicit(NORMAL, '今天好热'), true, '对话窗口');
});

check('指数 25：同样一条图片，掷中才放行', () => {
    eq(withRandom(0.10, () => gate.decideGroupImplicit(LOW, '[图片]')), true, 'roll=10 应放行');
    reset();
    eq(withRandom(0.90, () => gate.decideGroupImplicit(LOW, '[图片]')), false, 'roll=90 应拦下');
});

check('指数 25：叫名字不受影响', () => {
    eq(withRandom(0.99, () => gate.decideGroupImplicit(LOW, '小易在吗')), true);
    eq(withRandom(0.99, () => gate.decideGroupImplicit(LOW, '在吗小易喵')), true);
});

check('指数 0：只认名字，图片 / 窗口 / 打招呼都不主动接', () => {
    eq(gate.decideGroupImplicit(MUTE, '[图片]'), false, '图片');
    gate.lastActivityAt.set(MUTE, Date.now());
    eq(gate.decideGroupImplicit(MUTE, '今天好热'), false, '对话窗口');
    eq(gate.decideGroupImplicit(MUTE, '晚安'), false, '打招呼');
    eq(gate.decideGroupImplicit(MUTE, '小易'), true, '名字');
});

check('指数 0：叫名字也受冷却限制', () => {
    writeGroups({ wakeCooldownMs: 5000 });
    gate.lastWakeAt.set(MUTE, Date.now());
    eq(gate.decideGroupImplicit(MUTE, '小易'), false);
    gate.lastWakeAt.set(MUTE, Date.now() - 6000);
    eq(gate.decideGroupImplicit(MUTE, '小易'), true);
    writeGroups();
});

check('打招呼没被掷中时不消耗 30 分钟节流', () => {
    eq(withRandom(0.90, () => gate.decideGroupImplicit(LOW, '早安')), false, '第一次被拦');
    eq(withRandom(0.10, () => gate.decideGroupImplicit(LOW, '早安')), true, '第二次掷中还能接');
});

check('每日首条必接不受唤醒指数影响', () => {
    globalThis.__qqbotSpeakers = new Map([[MUTE, { id: 'USER_FIXTURE_F', name: '测试成员己' }]]);
    eq(gate.decideGroupImplicit(MUTE, '[图片]'), true);
});

check('不在 noMention 的群仍然必须真 @', () => {
    eq(gate.decideGroupImplicit(OUTSIDE, '小易在吗'), false);
    eq(gate.decideGroupImplicit(OUTSIDE, '[图片]'), false);
});

check('指数读取：缺省 100，越界会夹到 0–100', () => {
    writeGroups({ wakeIndex: { [LOW]: 150, [MUTE]: -20 } });
    const cfg = gate.loadGroupGateConfig();
    eq(gate.wakeIndexOf(cfg, LOW), 100);
    eq(gate.wakeIndexOf(cfg, MUTE), 0);
    eq(gate.wakeIndexOf(cfg, NORMAL), 100);
    writeGroups();
});

rmSync(PROFILE, { recursive: true, force: true });
process.env.HOME = OLD_HOME;

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

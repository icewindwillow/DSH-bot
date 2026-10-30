#!/usr/bin/env node
/**
 * 心情状态机（mood）离线测试。
 *
 * 覆盖：标签映射、指数回归、脉冲夹紧、提示词文案、行为系数范围、落盘与锁。
 * 用法：node tests/mood.test.mjs
 */
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PROFILE = mkdtempSync(join(tmpdir(), 'qqbot-mood-'));
process.env.QQBOT_PROFILE_DIR = PROFILE;
process.env.QQBOT_MOOD = 'on';

const strip = (p) => readFileSync(p, 'utf8')
    .replace(/^\/\* >>>.*$/m, '')
    .replace(/^\/\* <<<.*$/m, '');

const timers = [];
const sandbox = {
    process,
    console: { log: () => {}, error: console.error },
    setTimeout,
    clearTimeout,
    setInterval: (fn, ms) => {
        const t = { fn, ms, unref() { return t; } };
        timers.push(t);
        return t;
    },
    clearInterval: () => {},
};
const factory = new Function(...Object.keys(sandbox), `
    ${strip(join(ROOT, 'qqbot-patches', 'mood-helper.js'))}
    return { setupMood };
`);
const { setupMood } = factory(...Object.values(sandbox));

let passed = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
    if (cond) {
        passed += 1;
        console.log(`  ✓ ${name}`);
    }
    else {
        failures.push(name);
        console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    }
};

const boot = () => {
    delete globalThis.__qqbotMood;
    globalThis.__qqbotCurrentGid = 'G1';
    setupMood({ get: () => undefined }, { use: () => {} }, {}, { info: () => {} });
    return globalThis.__qqbotMood;
};

console.log('mood: 标签映射');
{
    const mood = boot();
    const { labelOf } = mood._test;
    const cases = [
        [80, 80, '兴奋'], [80, 50, '开心'], [80, 30, '满足'],
        [50, 80, '精神'], [50, 50, '平静'], [50, 30, '困倦'],
        [30, 80, '烦躁'], [30, 50, '低落'], [30, 30, '蔫蔫'],
    ];
    for (const [v, e, want] of cases)
        ok(`labelOf(${v},${e}) = ${want}`, labelOf(v, e) === want, `得到 ${labelOf(v, e)}`);
}

console.log('mood: 指数回归');
{
    const mood = boot();
    const { settle, baseValence } = mood._test;
    const now = Date.now();
    const node = { valence: 0, energy: 0, updatedAt: now - 3 * 3600e3 };
    settle(node, 3, now);
    // 半衰期 3h：valence 应回到基线的约一半（深夜基线会略低）
    const expected = baseValence(now) / 2;
    ok('valence 半衰期 ≈ 3h', Math.abs(node.valence - expected) < 2, `得到 ${node.valence.toFixed(1)}，期望 ${expected.toFixed(1)}`);
    ok('energy 向作息基线回归', node.energy > 0 && node.energy < 60, `得到 ${node.energy.toFixed(1)}`);
    ok('updatedAt 被刷新', Math.abs(node.updatedAt - now) < 5);
}

console.log('mood: 脉冲与夹紧');
{
    const mood = boot();
    const vBase = mood._test.baseValence(Date.now());
    const eBase = mood._test.baseEnergy(Date.now());
    mood.pulse('G1', 100, 100, '一次巨大的好事');
    const snap = mood.snapshot('G1');
    ok('单次脉冲 valence 夹在 +6', snap.valence <= vBase + 6.1, `得到 ${snap.valence.toFixed(1)}，基线 ${vBase.toFixed(1)}`);
    ok('单次脉冲 energy 夹在 +8', snap.energy <= eBase + 8.1, `得到 ${snap.energy.toFixed(1)}，基线 ${eBase.toFixed(1)}`);
    mood.pulse('G1', -100, -100, '一次巨大的坏事');
    const snap2 = mood.snapshot('G1');
    ok('负向脉冲不越界', snap2.valence >= 0 && snap2.energy >= 0);
    ok('事件被记录', snap2.events.length >= 2);
    ok('事件保留上限 40', (() => {
        for (let i = 0; i < 60; i += 1)
            mood.pulse('G1', 0.1, 0, `事件${i}`);
        return mood.snapshot('G1').events.length <= 40;
    })());
}

console.log('mood: 提示词文案');
{
    const mood = boot();
    mood.pulse('G1', 4, 6, '有人夸了她的穿搭');
    const line = mood.promptLine('G1');
    ok('包含状态段', line.includes('【你此刻的状态】'), line);
    ok('不含数字', !/[0-9]/.test(line), line);
    ok('禁止说出口', line.includes('不要说出口'), line);
    ok('没消息的群不注入', mood.promptLine('G404') === '');
}

console.log('mood: 行为系数范围');
{
    const mood = boot();
    mood.pulse('G1', -5, -8, '被凶了');
    const low = { wake: mood.wakeFactor('G1'), gate: mood.gateBias('G1'), sticker: mood.stickerFactor('G1') };
    mood.pulse('G1', 6, 8, '被夸了');
    mood.pulse('G1', 6, 8, '又被夸了');
    const high = { wake: mood.wakeFactor('G1'), gate: mood.gateBias('G1'), sticker: mood.stickerFactor('G1') };
    ok('wake 在 0.6–1.15', low.wake >= 0.6 && high.wake <= 1.15, JSON.stringify({ low: low.wake, high: high.wake }));
    ok('gate 在 0.8–1.15', low.gate >= 0.8 && high.gate <= 1.15, JSON.stringify({ low: low.gate, high: high.gate }));
    ok('sticker 在 0.65–1.2', low.sticker >= 0.65 && high.sticker <= 1.2, JSON.stringify({ low: low.sticker, high: high.sticker }));
    ok('心情好时更愿意接话', high.wake > low.wake && high.gate > low.gate);
}

console.log('mood: 落盘与锁');
{
    const mood = boot();
    mood.pulse('G1', 2, 2, '测试落盘');
    const file = join(PROFILE, 'qqbot-mood.json');
    ok('状态文件存在', existsSync(file));
    const state = JSON.parse(readFileSync(file, 'utf8'));
    ok('按群存储', Boolean(state.groups?.G1));
    ok('全局底色存在', typeof state.global?.valence === 'number');
    ok('没有残留锁文件', !existsSync(`${file}.lock`));
}

console.log('mood: dry 模式');
{
    delete globalThis.__qqbotMood;
    process.env.QQBOT_MOOD = 'dry';
    globalThis.__qqbotCurrentGid = 'G2';
    setupMood({ get: () => undefined }, { use: () => {} }, {}, { info: () => {} });
    const mood = globalThis.__qqbotMood;
    mood.pulse('G2', 3, 3, 'dry 也要记录');
    ok('dry 模式不注入提示词', mood.promptLine('G2') === '');
    ok('dry 模式仍记录状态', Boolean(mood.snapshot('G2')));
    process.env.QQBOT_MOOD = 'on';
}

rmSync(PROFILE, { recursive: true, force: true });
console.log(`\n${passed} 通过，${failures.length} 失败`);
if (failures.length > 0) {
    console.error(`失败项：${failures.join(' / ')}`);
    process.exit(1);
}

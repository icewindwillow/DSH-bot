#!/usr/bin/env node
/**
 * 群友互动边：规则提取、60 秒冷却、摩擦衰减、提示词摘要、落盘。
 * 用法：node tests/group-relations.test.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, openSync, closeSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PROFILE = mkdtempSync(join(tmpdir(), 'qqbot-relations-'));
process.env.QQBOT_PROFILE_DIR = PROFILE;
const PEOPLE = join(PROFILE, 'qqbot-people.json');
writeFileSync(PEOPLE, JSON.stringify({
    people: [
        { name: '张甲', openids: ['U1'], groups: ['G1'], profile: {} },
        { name: '李乙', openids: ['U2'], groups: ['G1'], profile: {} },
        { name: '王丙', openids: ['U3'], groups: ['G1'], profile: {} },
        { name: '赵丁', openids: ['U4'], groups: ['G1'], profile: {} },
    ],
}, null, 2));

const OLD = Date.now() - 2 * 3600 * 1000;
const RELATIONS = join(PROFILE, 'qqbot-relations.json');
writeFileSync(RELATIONS, JSON.stringify({
    version: 1,
    edges: {
        G1: {
            '张甲|李乙': { close: 30, conflict: 40, count: 5, lastAt: OLD, conflictAt: OLD, note: '上次互怼过' },
            '张甲|王丙': { close: 60, conflict: 0, count: 20, lastAt: OLD, conflictAt: OLD, note: '' },
        },
    },
}, null, 2));

const strip = (p) => readFileSync(p, 'utf8')
    .replace(/^\/\* >>>.*$/m, '')
    .replace(/^\/\* <<<.*$/m, '');
let flush = () => {};
const logs = [];
const factory = new Function('readFileSync', 'writeFileSync', 'openSync', 'closeSync', 'statSync', 'renameSync', 'unlinkSync', 'setInterval', 'process', 'console', `
    ${strip(join(ROOT, 'qqbot-patches', 'group-relations-helper.js'))}
    setupGroupRelations({}, {}, {}, {});
    return globalThis.__qqbotRelations;
`);
// 拦截定时器：不真的等待 60 秒，直接把 persist 回调拿出来手动触发
const makeInterval = (fn) => { flush = fn; return { unref() {} }; };
const relations = factory(readFileSync, writeFileSync, openSync, closeSync, statSync, renameSync, unlinkSync, makeInterval,
    { env: process.env, pid: process.pid }, { log: (s) => logs.push(String(s)) });

const key = (a, b) => relations._test.pairKey(a, b);
const edge = (a, b) => JSON.parse(readFileSync(RELATIONS, 'utf8')).edges.G1[key(a, b)];

let pass = 0;
let fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (err) { fail++; console.error(`  ✗ ${name}\n    ${err.message}`); }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const speaker = { id: 'U1', name: '张甲' };
const person = { name: '张甲' };
const msg = (content, mentions) => ({ kind: 'group', groupOpenid: 'G1', senderId: 'U1', senderName: '张甲', content, mentions });

check('@ 某人记一次互动（次数与亲疏都涨）', () => {
    relations.track(msg('<@U2> 李乙，今天怎么不理人', [{ member_openid: 'U2' }]));
    flush();
    const e = edge('张甲', '李乙');
    if (e.count !== 6) throw new Error(`@ 一次应 5→6，实际 ${e.count}`);
    if (!(e.close > 30)) throw new Error(`亲疏应上升，实际 ${e.close}`);
    if (e.note.indexOf('李乙') < 0) throw new Error(`备注没记原话：${e.note}`);
    if (e.note.includes('<@')) throw new Error(`备注不该留 @ 原始 token：${e.note}`);
});

check('同一对 60 秒内不重复累加', () => {
    relations.track(msg('李乙，你说话啊', [{ member_openid: 'U2' }]));
    flush();
    if (edge('张甲', '李乙').count !== 6) throw new Error('冷却期内又累加了');
});

check('正文点名也算一次互动', () => {
    relations.track(msg('王丙 你那个图还有吗'));
    flush();
    if (edge('张甲', '王丙').count !== 21) throw new Error(`点名应 20→21，实际 ${edge('张甲', '王丙').count}`);
});

check('有摩擦时提示词要提醒分寸', () => {
    relations.track(msg('李乙，我们聊聊', [{ member_openid: 'U2' }]));
    const line = relations.promptLines('G1', speaker, person);
    if (!line.includes('摩擦')) throw new Error(`应给摩擦提示，实际：${line || '(空)'}`);
    if (!line.includes('李乙')) throw new Error(`应点名李乙，实际：${line}`);
});

check('常搭话给偏熟判断', () => {
    relations.track(msg('王丙 晚上开黑吗'));
    const line = relations.promptLines('G1', speaker, person);
    if (!line.includes('常搭话')) throw new Error(`应给偏熟提示，实际：${line || '(空)'}`);
});

check('没点到任何人时不注入', () => {
    relations.track(msg('今天好热啊'));
    const line = relations.promptLines('G1', speaker, person);
    if (line !== '') throw new Error(`不该注入，实际：${line}`);
});

check('复用 middleware 的 @ 解析：按 openid 归到档案名字', () => {
    relations.track(msg('赵丁 在吗', []), { self: false, others: [{ id: 'U4', name: '赵四' }, { id: 'SELF', name: '' }], tokens: [] });
    flush();
    if (edge('张甲', '赵丁').count !== 1) throw new Error(`应记 1 次，实际 ${edge('张甲', '赵丁').count}`);
    if (edge('张甲', '赵四')) throw new Error('不该按 mention 昵称另建一条边');
});

check('他只是被 @ 但没聊过的人，按不熟提示', () => {
    relations.track(msg('赵丁 在吗', [{ member_openid: 'U4' }]));
    const line = relations.promptLines('G1', speaker, person);
    if (!line.includes('偶尔搭话')) throw new Error(`应按不熟提示，实际：${line || '(空)'}`);
});

check('摩擦按 48 小时半衰期衰减', () => {
    const e = { conflict: 40, conflictAt: Date.now() - 48 * 3600 * 1000 };
    relations._test.decayEdge(e);
    if (!near(e.conflict, 20, 0.5)) throw new Error(`48 小时后应约 20，实际 ${e.conflict}`);
});

check('落盘文件结构正确', () => {
    flush();
    const saved = JSON.parse(readFileSync(RELATIONS, 'utf8'));
    if (!saved.edges.G1[key('张甲', '李乙')]) throw new Error('没写入 G1 的边');
    if (!saved.updatedAt) throw new Error('缺 updatedAt');
    if (logs.length === 0) throw new Error('没打印启用日志');
});

console.log(`\n${pass} 通过, ${fail} 失败`);
rmSync(PROFILE, { recursive: true, force: true });
process.exit(fail ? 1 : 0);

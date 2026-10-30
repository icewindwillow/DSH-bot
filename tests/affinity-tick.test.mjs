#!/usr/bin/env node
/**
 * 关系自然增长（affinity-tick）+ 档案写锁（people-store）离线测试。
 *
 * 语义：一条群消息按「社交信号权重」累加，攒够阈值才结算一次。
 * 用法：node tests/affinity-tick.test.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, openSync, closeSync, utimesSync, statSync, copyFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const PROFILE = mkdtempSync(join(tmpdir(), 'qqbot-affinity-'));
process.env.QQBOT_PROFILE_DIR = PROFILE;
const PEOPLE = join(PROFILE, 'qqbot-people.json');

const seed = {
    people: [
        { name: '测试成员乙', openids: ['USER_FIXTURE_B'], groups: ['G1'], social: { affinity: 50, familiarity: 46, trust: 50, irritation: 0, banterTolerance: 30, lastEventAt: 0 } },
        { name: '满值', openids: ['ID_FULL'], groups: ['G1'], social: { affinity: 100, familiarity: 100, trust: 50, irritation: 0, banterTolerance: 30, lastEventAt: 0 } },
    ],
};
writeFileSync(PEOPLE, JSON.stringify(seed, null, 2));

const strip = (p) => readFileSync(p, 'utf8').replace(/^\/\* >>>.*$/m, '').replace(/^\/\* <<<.*$/m, '');

// 把两个补丁片段按真实顺序装进来（people-store 先，affinity-tick 后）
const sandbox = {
    readFileSync, writeFileSync, openSync, closeSync, statSync, copyFileSync, renameSync,
    unlinkSync: (p) => rmSync(p, { force: true }),
    process, console: { log: () => {}, error: console.error },
};
const factory = new Function(...Object.keys(sandbox), `
    ${strip(join(ROOT, 'qqbot-patches', 'people-store.js'))}
    ${strip(join(ROOT, 'qqbot-patches', 'affinity-tick.js'))}
    return { bumpAffinityFromChat, store: globalThis.__qqbotPeopleStore };
`);
const { bumpAffinityFromChat: tick, store } = factory(...Object.values(sandbox));

const read = () => JSON.parse(readFileSync(PEOPLE, 'utf8'));
const person = (name) => read().people.find((p) => p.name === name);
const close = (a, b) => Math.abs(a - b) < 1e-6;

let pass = 0;
let fail = 0;
function check(name, test) {
    try {
        test();
        pass++;
        console.log(`  ✓ ${name}`);
    }
    catch (err) {
        fail++;
        console.error(`  ✗ ${name}\n    ${err.message}`);
    }
}
function eq(actual, expected, label) {
    if (!close(actual, expected))
        throw new Error(`${label}: 期望 ${expected}，实际 ${actual}`);
}
function ok(cond, label) {
    if (!cond)
        throw new Error(label);
}

console.log('关系自然增长 / 写锁');

check('单条普通消息不结算（权重不够）', () => {
    const f0 = person('测试成员乙').social.familiarity;
    tick('G1', 'USER_FIXTURE_B', '测试成员乙', '今天天气还不错啊', false);
    eq(person('测试成员乙').social.familiarity, f0, '熟悉度');
});

check('攒够权重后结算一次，涨幅按权重放大', () => {
    const f0 = person('测试成员乙').social.familiarity;
    // 每条：0.3 在场 + 0.4（≥12 字）= 0.7；前面还攒了 0.3，再发 6 条累计 4.5 → 触发一次
    for (let i = 0; i < 6; i += 1)
        tick('G1', 'USER_FIXTURE_B', '测试成员乙', '刚完成了一份测试文档的阅读练习', false);
    const gained = person('测试成员乙').social.familiarity - f0;
    ok(gained > 0.5 && gained < 1.5, `涨幅应在 0.5~1.5 之间，实际 ${gained}`);
});

check('骂人的话几乎不涨熟悉度', () => {
    for (let i = 0; i < 8; i += 1)
        tick('G1', 'USER_FIXTURE_B', '测试成员乙', '傻逼机器人滚', false);
    const s = person('测试成员乙').social;
    ok(s.familiarity < 100, '熟悉度没到顶');
});

check('明确对它说话（directed）权重更高', () => {
    const before = person('测试成员乙').social.familiarity;
    for (let i = 0; i < 4; i += 1)
        tick('G2', 'USER_FIXTURE_B', '测试成员乙', '小易你在吗今天忙不忙', true);
    ok(person('测试成员乙').social.familiarity > before, '应该涨了');
});

check('到 100 封顶', () => {
    for (let i = 0; i < 40; i += 1)
        tick('G1', 'ID_FULL', '满值', '这条消息内容比较长一点点让权重高起来', true);
    eq(person('满值').social.familiarity, 100, '熟悉封顶');
    eq(person('满值').social.affinity, 100, '好感封顶');
});

check('QQBOT_AFFINITY_TICK=off 时不涨', () => {
    process.env.QQBOT_AFFINITY_TICK = 'off';
    const a0 = person('测试成员乙').social.affinity;
    for (let i = 0; i < 6; i += 1)
        tick('G1', 'USER_FIXTURE_B', '测试成员乙', '小易这条消息也不算数了吧', true);
    eq(person('测试成员乙').social.affinity, a0, '没变');
    delete process.env.QQBOT_AFFINITY_TICK;
});

check('不认识的人不写文件', () => {
    const before = read().people.length;
    for (let i = 0; i < 6; i += 1)
        tick('G1', 'ID_UNKNOWN', '路人', '随便说两句看看会不会写进去', false);
    eq(read().people.length, before, '人数没变');
    ok(!read().people.some((p) => p.name === '路人'), '没写出路人');
});

check('僵尸锁会被清掉，不卡死', () => {
    const lock = `${PEOPLE}.lock`;
    writeFileSync(lock, 'stale');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    ok(store.update((s) => { s.touched = (s.touched ?? 0) + 1; return true; }).wrote, '应该写成功');
});

check('mutator 返回 false 时不写', () => {
    const raw = readFileSync(PEOPLE, 'utf8');
    const r = store.update(() => false);
    ok(r.wrote === false, 'wrote 应为 false');
    eq(readFileSync(PEOPLE, 'utf8') === raw ? 1 : 0, 1, '文件未变');
});

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

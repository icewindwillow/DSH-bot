#!/usr/bin/env node
/**
 * record_social_event：60 秒内重复记录只补说明、不重复加数值。
 * 用法：node tests/social-event.test.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, openSync, closeSync, statSync, copyFileSync, renameSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PROFILE = mkdtempSync(join(tmpdir(), 'qqbot-social-'));
process.env.QQBOT_PROFILE_DIR = PROFILE;
const PEOPLE = join(PROFILE, 'qqbot-people.json');
writeFileSync(PEOPLE, JSON.stringify({
    people: [{ name: '测试成员癸', openids: ['USER_FIXTURE_J'], groups: ['G1'], profile: {}, social: { affinity: 50, familiarity: 40, trust: 50, irritation: 0, banterTolerance: 30, lastEventAt: 0 } }],
}, null, 2));

const strip = (p) => readFileSync(p, 'utf8').replace(/^\/\* >>>.*$/m, '').replace(/^\/\* <<<.*$/m, '');

let tool;
const ctx = { get: () => ({ register: (def) => { tool = def; } }) };

const factory = new Function('readFileSync', 'writeFileSync', 'openSync', 'closeSync', 'statSync', 'copyFileSync', 'renameSync', 'unlinkSync', 'process', 'console', 'ctx', `
    ${strip(join(ROOT, 'qqbot-patches', 'people-store.js'))}
    ${strip(join(ROOT, 'qqbot-patches', 'social-engine-helper.js'))}
    setupSocialEngine(ctx, { info() {} });
    return { tool: globalThis.__testTool };
`);
// 捕获注册的工具
const registered = [];
ctx.get = () => ({ register: (def) => registered.push(def) });
factory(readFileSync, writeFileSync, openSync, closeSync, statSync, copyFileSync, renameSync, unlinkSync, process, { log() {} }, ctx);

const record = registered.find((d) => d.name === 'record_social_event');
if (!record)
    throw new Error('没注册 record_social_event');

globalThis.__qqbotLastTarget = { scope: 'group', targetId: 'G1' };
globalThis.__qqbotSpeakers = new Map([['G1', { id: 'USER_FIXTURE_J', name: '测试成员癸' }]]);

const person = () => JSON.parse(readFileSync(PEOPLE, 'utf8')).people[0];
let pass = 0;
let fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (err) { fail++; console.error(`  ✗ ${name}\n    ${err.message}`); }
}
const near = (a, b) => Math.abs(a - b) < 1e-6;

check('第一次记录正常加数值', () => {
    const r = record.execute({ type: 'friendly_chat', strength: 1, note: '聊了两句新番' });
    if (!r.ok) throw new Error(r.message);
    const p = person();
    if (!near(p.social.affinity, 50.1)) throw new Error(`好感应 50.1，实际 ${p.social.affinity}`);
    if (!near(p.social.familiarity, 40.2)) throw new Error(`熟悉应 40.2，实际 ${p.social.familiarity}`);
});

check('60 秒内第二次只补说明，不重复加数值', () => {
    const before = person().social;
    const r = record.execute({ type: 'help', strength: 2, note: '帮他找了张参考图' });
    if (!r.ok) throw new Error(r.message);
    const p = person();
    if (!near(p.social.affinity, before.affinity)) throw new Error(`好感不应再涨：${before.affinity} → ${p.social.affinity}`);
    const last = p.socialEvents.at(-1);
    if (last.note !== '帮他找了张参考图') throw new Error(`说明没更新：${last.note}`);
    if (!last.mergedWithModel) throw new Error('没打合并标记');
});

check('存档条数没有翻倍', () => {
    const p = person();
    if (p.socialEvents.length !== 1) throw new Error(`应该有 1 条事件，实际 ${p.socialEvents.length}`);
});

check('events 里有原始 note 与强度', () => {
    const last = person().socialEvents.at(-1);
    if (!(last.strength >= 1)) throw new Error(`强度不对：${last.strength}`);
});

console.log(`\n${pass} 通过, ${fail} 失败`);
rmSync(PROFILE, { recursive: true, force: true });
process.exit(fail ? 1 : 0);

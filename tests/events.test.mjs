#!/usr/bin/env node
/**
 * 事件追踪（events）离线测试。
 *
 * 覆盖：计划去重、追问时机（短期 12h/长期 3d + 24h 间隔）、情绪优先于计划、
 *       askedCount 递增、情绪事件过期。
 * 用法：node tests/events.test.mjs
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PROFILE = mkdtempSync(join(tmpdir(), 'qqbot-events-'));
process.env.QQBOT_PROFILE_DIR = PROFILE;
process.env.HOME = PROFILE;
process.env.XIANGXIN_API_KEY = 'fixture-key';
process.env.QQBOT_EVENTS_TRACK = 'on';

const strip = (p) => readFileSync(p, 'utf8')
    .replace(/^\/\* >>>.*$/m, '')
    .replace(/^\/\* <<<.*$/m, '');

const sandbox = {
    process,
    console: { log: () => {}, error: console.error },
    setTimeout,
    clearTimeout,
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    fetch: async () => { throw new Error('no network in test'); },
};
const factory = new Function(...Object.keys(sandbox), `
    ${strip(join(ROOT, 'qqbot-patches', 'event-helper.js'))}
    return { setupEvents };
`);
const { setupEvents } = factory(...Object.values(sandbox));
setupEvents({ get: () => undefined }, { use: () => {} }, {}, { info: () => {} });
const events = globalThis.__qqbotEvents;

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

const GID = 'G1';
const PERSON = '测试成员丙';

console.log('events: 计划去重');
{
    events.addPlan({ person: PERSON, gid: GID, title: '完成测试拼图', kind: 'short', evidence: '下周六完成测试拼图' });
    events.addPlan({ person: PERSON, gid: GID, title: '完成测试拼图', kind: 'short', evidence: '重复提到' });
    const list = events.read().events.filter((e) => e.type === 'plan');
    ok('同一件事只留一条', list.length === 1, `得到 ${list.length}`);
    ok('重复提到会刷新时间', list[0].lastMentionedAt >= list[0].createdAt);
}

console.log('events: 追问时机');
{
    // 刚建的计划不该被追问
    ok('刚说过不追问', events.promptLine(GID, PERSON) === '', events.promptLine(GID, PERSON));
    // 把计划调到 2 天前
    const state = JSON.parse(readFileSync(join(PROFILE, 'qqbot-events.json'), 'utf8'));
    state.events.find((e) => e.type === 'plan').createdAt = Date.now() - 2 * 86400000;
    writeFileSync(join(PROFILE, 'qqbot-events.json'), JSON.stringify(state, null, 2));
    const line = events.promptLine(GID, PERSON);
    ok('2 天后会追问', line.includes('【TA 说过的事】') && line.includes('完成测试拼图'), line);
    const after = JSON.parse(readFileSync(join(PROFILE, 'qqbot-events.json'), 'utf8')).events.find((e) => e.type === 'plan');
    ok('记录已问次数', after.askedCount === 1, `得到 ${after.askedCount}`);
    ok('24 小时内不重复问', events.promptLine(GID, PERSON).includes('完成测试拼图') === false);
}

console.log('events: 情绪优先');
{
    events.addEmotion({ person: PERSON, gid: GID, emotion: '难过', summary: '今天真的好难过' });
    const line = events.promptLine(GID, PERSON);
    ok('情绪事件优先关心', line.includes('【TA 现在的情绪】难过'), line);
    ok('情绪中不追问计划', !line.includes('完成测试拼图'), line);
}

console.log('events: 自动结算');
{
    events.addPlan({ person: PERSON, gid: GID, title: '完成长期测试作品', kind: 'long', evidence: '要完成长期测试作品' });
    const closed = events.applyResult(PERSON, '完成长期测试作品', '完成');
    const target = events.read().events.find((e) => e.title === '完成长期测试作品');
    ok('完成会关掉事件', closed === true && target.status === 'done', JSON.stringify({ closed, status: target?.status }));
    ok('已关闭的不重复结算', events.applyResult(PERSON, '完成长期测试作品', '放弃') === false);
    ok('没提到不结算', events.applyResult(PERSON, '没提到', '完成') === false);
}

console.log('events: 过期清理');
{
    const state = JSON.parse(readFileSync(join(PROFILE, 'qqbot-events.json'), 'utf8'));
    for (const e of state.events)
        e.createdAt = Date.now() - 5 * 86400000;
    writeFileSync(join(PROFILE, 'qqbot-events.json'), JSON.stringify(state, null, 2));
    events.maintain();
    const open = events.read().events.filter((e) => e.status === 'open');
    ok('过期的都关掉', open.length === 0, `还剩 ${open.length}`);
}

rmSync(PROFILE, { recursive: true, force: true });
console.log(`\n${passed} 通过，${failures.length} 失败`);
if (failures.length > 0) {
    console.error(`失败项：${failures.join(' / ')}`);
    process.exit(1);
}

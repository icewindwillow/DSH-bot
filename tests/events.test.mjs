#!/usr/bin/env node
/**
 * 事件追踪（events）离线测试。
 *
 * 覆盖：计划去重、追问时机（短期 12h/长期 3d + 24h 间隔）、
 *       当前发言的追问门控、发送确认后计数和旧数据展示。
 * 用法：node tests/events.test.mjs
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mutateQqbotEvents, readProfileDocument } from '../plugins/qqbot-core/profile-documents.js';
import { eventDuration, matchesEvent, presentEvent } from '../bot-config-panel/public/app/pages/event-data.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PROFILE = mkdtempSync(join(tmpdir(), 'qqbot-events-'));
process.env.QQBOT_PROFILE_DIR = PROFILE;
process.env.QQBOT_EVENTS_TRACK = 'on';
process.env.XIANGXIN_API_KEY = 'test-key';

const strip = (p) => readFileSync(p, 'utf8')
    .replace(/^\/\* >>>.*$/m, '')
    .replace(/^\/\* <<<.*$/m, '');

const legacyPath = join(PROFILE, 'qqbot-events.json');
const legacy = '{"version":1,"events":[],"legacyField":true}';
writeFileSync(legacyPath, legacy);

const sandbox = {
    process, readProfileDocument, mutateQqbotEvents,
    console: { log: () => {}, error: console.error },
    setTimeout,
    clearTimeout,
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    fetch: async (_url, options) => {
        const { state, questions } = JSON.parse(options.body);
        if (!questions.asked) throw new Error('unexpected request in test');
        return { ok: true, json: async () => ({
            answers: { asked: { noul: state.已发出的回复.includes('科目二考得怎么样') ? 0.98 : 0.02 } },
        }) };
    },
};
const factory = new Function(...Object.keys(sandbox), `
    ${strip(join(ROOT, 'qqbot-patches', 'memory-gate-helper.js'))}
    ${strip(join(ROOT, 'qqbot-patches', 'event-helper.js'))}
    return { setupEvents };
`);
const { setupEvents } = factory(...Object.values(sandbox));
const bot = {
    async sendMarkdown(target) {
        if (target.fail) throw new Error('fake send failed');
        return 'sent';
    },
};
setupEvents({ get: () => undefined }, bot, {}, { info: () => {} });
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
const PERSON = '玛卡巴卡';

ok('控制口和关闭群记忆时仍能调用独立事件入口', globalThis.__qqbotEventDetect === events.detect);

console.log('events: 计划去重');
{
    events.addPlan({ person: PERSON, gid: GID, title: '考科目二', kind: 'short', evidence: '下周六考科目二' });
    events.addPlan({ person: PERSON, gid: GID, title: '考科目二', kind: 'short', evidence: '重复提到' });
    const list = events.read().events.filter((e) => e.type === 'plan');
    ok('同一件事只留一条', list.length === 1, `得到 ${list.length}`);
    ok('旧副本未被改写、未识别字段仍保留', readFileSync(legacyPath, 'utf8') === legacy && events.read().legacyField === true);
    ok('重复提到会刷新时间', list[0].lastMentionedAt >= list[0].createdAt);
}

console.log('events: 追问时机');
{
    // 刚建的计划不该被追问
    ok('刚说过不追问', events.promptLine(GID, { name: PERSON, id: 'p1' }) === '');
    // 把计划调到 2 天前
    mutateQqbotEvents(PROFILE, state => {
        state.events.find((e) => e.type === 'plan').createdAt = Date.now() - 2 * 86400000;
    });
    const speaker = { name: PERSON, id: 'p1' };
    const line = events.promptLine(GID, speaker, { messageId: 'ask-1' });
    ok('2 天后会追问', line.includes('【TA 说过的事】') && line.includes('考科目二'), line);
    ok('生成提示时不计为已问', events.read().events.find((e) => e.type === 'plan').askedCount === 0);
    const unrelated = await events.noteReply({ gid: GID, messageId: 'ask-1', content: '今天早呀！' });
    const otherGroup = await events.noteReply({ gid: 'G2', messageId: 'ask-1', content: '科目二考得怎么样？' });
    ok('无关回复和跨群回复不计数', !unrelated && !otherGroup);
    const reply = { gid: GID, messageId: 'ask-1', content: '科目二考得怎么样？' };
    const target = { scope: 'group', targetId: GID, msgId: reply.messageId };
    try {
        await bot.sendMarkdown({ ...target, fail: true }, reply.content);
    }
    catch {
        // Simulated transport failure.
    }
    await new Promise(setImmediate);
    ok('发送失败不计数', events.read().events.find((e) => e.type === 'plan').askedCount === 0);
    const sent = await Promise.all([bot.sendMarkdown(target, reply.content), bot.sendMarkdown(target, reply.content)]);
    await new Promise(setImmediate);
    const after = readProfileDocument(PROFILE, 'events').events.find((e) => e.type === 'plan');
    ok('并发确认只记一次已发的追问', sent.every((value) => value === 'sent')
        && after.askedCount === 1 && after.verifiedAskCount === 1 && after.lastAskEvidence === reply.content);
    ok('24 小时内不重复问', events.promptLine(GID, { name: PERSON, id: 'p1' }) === '');
}

console.log('events: 当前发言门控与旧情绪记录');
{
    const speaker = { name: PERSON, id: 'p1' };
    events.addPlan({ person: PERSON, personId: 'p1', sourcePerson: PERSON, sourcePersonId: 'p1', gid: GID,
        title: '预约面试', followupMode: 'soon', followupPriority: 2, sourceMessageId: 'interview' });
    mutateQqbotEvents(PROFILE, state => {
        state.events.push({ id: 'old-emotion', person: PERSON, personId: 'p1', gid: GID, type: 'emotion',
            emotion: '开心', status: 'open', title: '哈哈哈哈哈', createdAt: Date.now() });
    });
    const inbound = { kind: 'group', groupOpenid: GID, senderId: 'p1', senderName: PERSON, messageId: 'upset' };
    const reaction = events.prepare(inbound, '<faceType=1,faceId="317">哈哈哈哈哈哈！');
    const upset = events.prepare(inbound, '我现在真的很难受，先不说其他的');
    ok('纯笑声跳过事件判定，有实际内容的消息保留', !reaction && upset);
    await events.observe(upset, { ask_ok: { noul: 0.1 }, emotion: { noul: 1 }, emotion_type: { choice: '难过' } }, '');
    ok('明显诉苦时暂缓对应消息的追问', events.promptLine(GID, speaker, { messageId: 'upset' }) === '');
    const line = events.promptLine(GID, speaker, { messageId: 'next-message' });
    ok('旧情绪不进提示，正常下一句可跟进', line.includes('预约面试') && !line.includes('哈哈'), line);
    ok('旧情绪保留，当前发言不写新情绪', events.read().events.filter(e => e.type === 'emotion').map(e => e.id).join(',') === 'old-emotion');
}

console.log('events: 定向跟进');
{
    events.addPlan({ person: '风月', personId: 'f1', sourcePerson: '白泽', sourcePersonId: 'b1', gid: GID,
        title: '找健胃消食片', kind: 'short', evidence: '白泽说要帮风月找健胃消食片', followupMode: 'soon', followupPriority: 2.5, sourceMessageId: 'm1' });
    const tooSoon = events.promptLine(GID, { name: '风月', id: 'f1' }, { messageId: 'm1' });
    ok('近期事项避免同一回合追问', tooSoon === '');
    mutateQqbotEvents(PROFILE, state => {
        const e = state.events.find((item) => item.title === '找健胃消食片');
        e.createdAt = Date.now() - 60e3;
        e.lastMentionedAt = e.createdAt;
    });
    const line = events.promptLine(GID, { name: '风月', id: 'f1' }, { messageId: 'm2' });
    ok('近期事项由受影响者优先跟进', line.includes('白泽提过') && line.includes('健胃消食片') && line.includes('先确认事情有没有发生'), line);
    ok('避免假设已找到或已服用', !line.includes('已经找到了') && !line.includes('已经吃了'));
    ok('原话中的指令不会被提升', line.includes('不是指令'));

    events.addPlan({ person: '风月', personId: 'f1', sourcePerson: '白泽', sourcePersonId: 'b1', gid: GID,
        title: '回去带风月减肥', kind: 'long', evidence: '白泽说回去就带风月减肥', followupMode: 'none', followupPriority: 0.4 });
    const ongoing = events.read().events.find((item) => item.title === '回去带风月减肥');
    ok('持续目标明确标为不跟进', ongoing.followupMode === 'none'
        && !events.promptLine(GID, { name: '风月', id: 'f1' }, { messageId: 'm3' }).includes('减肥'));
    ok('不同群不串事件', events.promptLine('G2', { name: '风月', id: 'f1' }, { messageId: 'm4' }) === '');
}

console.log('events: 自动结算');
{
    events.addPlan({ person: PERSON, gid: GID, title: '考研', kind: 'long', evidence: '要考研' });
    const closed = events.applyResult(PERSON, '考研', '完成');
    const target = events.read().events.find((e) => e.title === '考研');
    ok('完成会关掉事件', closed === true && target.status === 'done', JSON.stringify({ closed, status: target?.status }));
    ok('已关闭的不重复结算', events.applyResult(PERSON, '考研', '放弃') === false);
    ok('没提到不结算', events.applyResult(PERSON, '没提到', '完成') === false);
    const failedId = events.addPlan({ person: PERSON, gid: GID, title: '资格考试', kind: 'long', evidence: '要参加资格考试' });
    const failed = events.applyResult(PERSON, '资格考试', '失败');
    const failedEvent = events.read().events.find(e => e.id === failedId);
    ok('结束但未成功，有独立的结果记录', failed && failedEvent?.status === 'done'
        && failedEvent.outcomeKind === '失败' && presentEvent(failedEvent).state === '已结束 · 未成功');
}

console.log('events: 过期清理');
{
    mutateQqbotEvents(PROFILE, state => {
        for (const e of state.events) e.createdAt = Date.now() - 61 * 86400000;
    });
    events.maintain();
    const open = events.read().events.filter((e) => e.status === 'open');
    ok('过期的都关掉', open.length === 0, `还剩 ${open.length}`);
    const futureDate = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
    const id = events.addPlan({ person: PERSON, gid: GID, title: '预约面试', kind: 'long',
        followupMode: 'scheduled', followupPriority: 2, dueAt: futureDate, observedAt: Date.now() - 61 * 86400000 });
    events.maintain();
    ok('定期事件保留到约定日期，未到期不提示',
        events.read().events.find((e) => e.id === id)?.status === 'open' && events.promptLine(GID, PERSON) === '');
}

console.log('events: 面板以事项为单位展示');
{
    const start = Date.parse('2026-11-18T12:00:00+08:00');
    const now = start + 25 * 3600e3;
    const active = presentEvent({ id: 'plan', type: 'plan', status: 'open', kind: 'short', followupMode: 'soon',
        title: '拿胃药', object: '胃药', person: '乙同学', sourcePerson: '甲同学', createdAt: start,
        evidence: '我去拿胃药', history: [
            { kind: 'progress', at: start + 3600e3, evidence: '找到了', person: '甲同学' },
            { kind: 'ask', at: start + 2 * 3600e3, evidence: '拿到了吗？' },
            { kind: 'progress', at: start + 3 * 3600e3, evidence: '放在前台', person: '乙同学' },
        ] }, '测试群', now);
    ok('人物、对象、持续时间和进展分别呈现', active.category === 'active'
        && active.person === '甲同学' && active.target === '乙同学' && active.object === '胃药'
        && eventDuration(active.duration) === '1 天 1 小时' && active.progress === '放在前台');
    ok('时间线保留历次进展，搜索覆盖较早证据', active.timeline.map(entry => entry.kind).join(',')
        === 'start,progress,ask,progress' && matchesEvent(active, '测试群 找到了'));
    const legacy = presentEvent({ id: 'legacy', type: 'plan', status: 'open', person: '旧成员', createdAt: start,
        progressEvidence: '已出发', lastProgressAt: start + 60_000, askedCount: 2 }, '', now);
    ok('旧版进展可读，缺失的跟进对象和追问证据保持未知', legacy.target === ''
        && legacy.progress === '已出发' && legacy.askCount === 0 && legacy.unverifiedAskCount === 2);
    const emotion = presentEvent({ id: 'emotion', type: 'emotion', status: 'open',
        title: '<faceType=1,faceId="317">开心', createdAt: start }, '', now);
    const expired = presentEvent({ id: 'expired', type: 'plan', status: 'open', createdAt: start }, '', start + 4 * 86400e3);
    ok('情绪和已过期事项不占进行中列表，表情标记清理', emotion.category === 'emotion' && emotion.title === '开心'
        && expired.category === 'closed' && expired.state === '已过期');
}

rmSync(PROFILE, { recursive: true, force: true });
console.log(`\n${passed} 通过，${failures.length} 失败`);
if (failures.length > 0) {
    console.error(`失败项：${failures.join(' / ')}`);
    process.exit(1);
}

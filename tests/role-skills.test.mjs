#!/usr/bin/env node
/**
 * 角色技能（特定角色爱好）离线测试。
 *
 * 不启动 QQ：读取仓库里的补丁片段，配上 people/roster 的最小桩，
 * 直接验证「谁会触发 / 谁不会 / 开关口令 / 工具开关 / frontmatter 剥离」。
 *
 * 用法：node tests/role-skills.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const PROFILE = mkdtempSync(join(tmpdir(), 'qqbot-role-skill-'));
process.env.QQBOT_PROFILE_DIR = PROFILE;
mkdirSync(join(PROFILE, 'skills', 'qiangzheyu'), { recursive: true });

writeFileSync(join(PROFILE, 'skills', 'qiangzheyu', 'SKILL.md'), [
    '---',
    'name: qiangzheyu',
    'description: test',
    '---',
    '',
    '# 强者语（测试正文）',
    '把「就」说成「便」。',
].join('\n'));

writeFileSync(join(PROFILE, 'qqbot-people.json'), JSON.stringify({
    people: [
        { name: '测试成员甲', openids: ['USER_FIXTURE_A'], groups: ['GROUP_FIXTURE_A'], profile: {} },
        { name: '测试成员乙', openids: ['USER_FIXTURE_B'], groups: ['GROUP_FIXTURE_A'], profile: {} },
    ],
}, null, 2));

writeFileSync(join(PROFILE, 'qqbot-role-skills.json'), JSON.stringify({
    skills: [{
        id: 'qiangzheyu',
        name: '强者语',
        category: '特定角色爱好',
        file: 'skills/qiangzheyu/SKILL.md',
        enabled: true,
        audiences: [{ person: '测试成员甲', openids: ['USER_FIXTURE_A'], groups: ['GROUP_FIXTURE_A'], default: true }],
    }],
}, null, 2));

const helper = readFileSync(join(ROOT, 'qqbot-patches', 'role-skills-helper.js'), 'utf8')
    .replace(/^\/\* >>>.*$/m, '')
    .replace(/^\/\* <<<.*$/m, '');

const stubs = `
function readPeopleList() {
    try {
        const parsed = JSON.parse(readFileSync(process.env.QQBOT_PROFILE_DIR + '/qqbot-people.json', 'utf8'));
        return Array.isArray(parsed?.people) ? parsed.people : [];
    } catch { return []; }
}
function namesOfPerson(person) {
    const out = [person.name, person.addressing];
    for (const key of Object.keys(person)) {
        if (key.indexOf('nickname') === 0) out.push(person[key]);
    }
    if (Array.isArray(person.aliases)) out.push(...person.aliases);
    return out.filter((n) => typeof n === 'string' && n.trim() !== '').map((n) => n.trim());
}
function findPersonForSpeaker(list, speaker) {
    if (!speaker) return undefined;
    const lower = String(speaker.name ?? '').toLowerCase();
    return list.find((person) => {
        if (!person || typeof person !== 'object') return false;
        if (Array.isArray(person.openids) && person.openids.includes(speaker.id)) return true;
        return namesOfPerson(person).some((n) => n.toLowerCase() === lower);
    });
}
`;

const factory = new Function('readFileSync', 'writeFileSync', 'appendFileSync', `
${stubs}
${helper}
return { buildRoleSkillSection, switchRoleSkill, readRoleSkillState, readRoleSkillRegistry, markRoleSkillTurnStart, finishRoleSkillTurn };
`);

const api = factory(readFileSync, writeFileSync, (path, text) => writeFileSync(path, text, { flag: 'a' }));

const GID = 'GROUP_FIXTURE_A';
const OTHER_GID = 'GROUP_FIXTURE_B';
const memberA = { id: 'USER_FIXTURE_A', name: '测试成员甲' };
const memberB = { id: 'USER_FIXTURE_B', name: '测试成员乙' };

function setSpeaker(speaker, text, gid = GID) {
    globalThis.__qqbotPendingInbound = new Map();
    globalThis.__qqbotSpeakers = new Map([[gid, { ...speaker }]]);
    globalThis.__qqbotRecentMessages = new Map([[gid, [{ ...speaker, content: text, at: Date.now() }]]]);
    globalThis.__qqbotLastGid = gid;
}

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
function eq(actual, expected, label) {
    if (actual !== expected)
        throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function ok(value, label) {
    if (!value)
        throw new Error(`${label}: 期望为真`);
}

console.log('角色技能测试');

check('成员甲在测试群甲说话 → 注入强者语（frontmatter 已剥离）', () => {
    setSpeaker(memberA, '你会不会强者语');
    const section = api.buildRoleSkillSection(GID);
    ok(section.includes('【角色爱好·强者语（只对测试成员甲）】'), '带标题');
    ok(section.includes('把「就」说成「便」'), '带正文');
    ok(!section.includes('name: qiangzheyu'), '不带 frontmatter');
});

check('replyTarget 指向成员甲的消息 → 注入（优先级最高）', () => {
    setSpeaker(memberB, '随便');
    globalThis.__qqbotPendingInbound = new Map([[GID, [
        { id: memberB.id, name: memberB.name, content: '别人先说的', at: Date.now() - 1000 },
        { id: memberA.id, name: memberA.name, content: '成员甲最后说的', at: Date.now() },
    ]]]);
    globalThis.__qqbotRecentMessages = new Map([[GID, [
        { id: memberA.id, name: memberA.name, msgId: 'm-1', content: '成员甲最后说的', at: Date.now() },
    ]]]);
    const section = api.buildRoleSkillSection(GID, { replyTarget: { targetId: GID, msgId: 'm-1' } });
    ok(section.includes('强者语'), '按 replyTarget 注入');
    globalThis.__qqbotPendingInbound = new Map();
});

check('排队消息：全局说话人是别人，但本 turn 队首是成员甲 → 注入', () => {
    setSpeaker(memberB, '后一句');
    globalThis.__qqbotPendingInbound = new Map([[GID, [
        { id: memberA.id, name: memberA.name, content: '第一句', at: Date.now() - 2000 },
        { id: memberB.id, name: memberB.name, content: '后一句', at: Date.now() - 1000 },
    ]]]);
    const section = api.buildRoleSkillSection(GID);
    ok(section.includes('强者语'), '按队首注入');
    globalThis.__qqbotPendingInbound = new Map();
});

check('turn/start 快照队列，turn 中到达的消息留给下一轮', () => {
    setSpeaker(memberA, '本 turn');
    globalThis.__qqbotPendingInbound = new Map([[GID, [
        { id: memberA.id, name: memberA.name, content: '本 turn 第一条', at: Date.now() - 1000 },
    ]]]);
    api.markRoleSkillTurnStart(GID, Date.now());
    eq(globalThis.__qqbotPendingInbound.get(GID), undefined, 'pending 已清空');
    ok(api.buildRoleSkillSection(GID).includes('强者语'), '快照仍参与判断');

    // turn 进行中新到的消息
    globalThis.__qqbotPendingInbound.set(GID, [
        { id: memberB.id, name: memberB.name, content: '生成期间新到', at: Date.now() },
    ]);
    api.finishRoleSkillTurn(GID);
    eq(globalThis.__qqbotPendingInbound.get(GID).length, 1, '新消息保留');
    globalThis.__qqbotPendingInbound = new Map();
    globalThis.__qqbotRoleTurnInbound = new Map();
});

check('别人在测试群甲说话 → 不注入', () => {
    setSpeaker(memberB, '你好');
    eq(api.buildRoleSkillSection(GID), '', 'section');
});

check('成员甲在别的群说话 → 不注入', () => {
    setSpeaker(memberA, '你好', OTHER_GID);
    eq(api.buildRoleSkillSection(OTHER_GID), '', 'section');
});

check('「你正常跟我说话」→ 自动关闭', () => {
    setSpeaker(memberA, '你正常跟我说话');
    eq(api.buildRoleSkillSection(GID), '', '本轮不再注入');
    const state = api.readRoleSkillState();
    const entry = Object.values(state)[0];
    eq(entry.enabled, false, '状态');
    eq(entry.by, 'auto', '来源');
});

check('关闭后普通消息仍保持关闭', () => {
    setSpeaker(memberA, '今天吃什么');
    eq(api.buildRoleSkillSection(GID), '', 'section');
});

check('「来点强者语」→ 自动打开', () => {
    setSpeaker(memberA, '来点强者语');
    ok(api.buildRoleSkillSection(GID).includes('强者语'), 'section');
    eq(Object.values(api.readRoleSkillState())[0].enabled, true, '状态');
});

check('工具开关：按名字关闭 / 按 id 打开', () => {
    setSpeaker(memberA, '随便聊聊');
    let r = api.switchRoleSkill({ skill: '强者语', enabled: false });
    eq(r.ok, true, '关闭 ok');
    eq(api.buildRoleSkillSection(GID), '', '关闭后 section');
    r = api.switchRoleSkill({ skill: 'qiangzheyu', enabled: true });
    eq(r.ok, true, '打开 ok');
    ok(api.buildRoleSkillSection(GID).includes('强者语'), '打开后 section');
});

check('工具拒绝：别人替成员甲改开关', () => {
    setSpeaker(memberB, '把成员甲的强者语关了');
    const r = api.switchRoleSkill({ skill: '强者语', enabled: false, person: '测试成员甲' });
    eq(r.ok, false, 'ok');
    ok(r.message.includes('本人'), 'message');
});

check('工具拒绝：技能没对这个人开放', () => {
    setSpeaker(memberB, '你也给我来点强者语');
    const r = api.switchRoleSkill({ skill: '强者语', enabled: true });
    eq(r.ok, false, 'ok');
    ok(r.message.includes('没有对「测试成员乙」开放'), 'message');
});

check('「别玩强者语了」→ 自动关闭（重点：不能反过来开）', () => {
    setSpeaker(memberA, '别玩强者语了');
    eq(api.buildRoleSkillSection(GID), '', 'section');
    eq(Object.values(api.readRoleSkillState())[0].enabled, false, '状态');
    setSpeaker(memberA, '来点强者语');
    ok(api.buildRoleSkillSection(GID).includes('强者语'), '重新打开');
});

check('「你正常点」→ 自动关闭', () => {
    setSpeaker(memberA, '你正常点');
    eq(api.buildRoleSkillSection(GID), '', 'section');
    eq(Object.values(api.readRoleSkillState())[0].enabled, false, '状态');
    setSpeaker(memberA, '来点强者语');
    ok(api.buildRoleSkillSection(GID).includes('强者语'), '重新打开');
});

check('「你正常说话的时候挺可爱」→ 不误关', () => {
    setSpeaker(memberA, '你正常说话的时候挺可爱');
    ok(api.buildRoleSkillSection(GID).includes('强者语'), '仍开启');
});

check('其它说法不误触开关', () => {
    setSpeaker(memberA, '这很正常');
    eq(api.buildRoleSkillSection(GID).includes('强者语'), true, '仍开启');
    setSpeaker(memberA, '你别用那种语气');
    eq(api.buildRoleSkillSection(GID).includes('强者语'), true, '仍开启（没有点名强者语）');
});

rmSync(PROFILE, { recursive: true, force: true });
console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

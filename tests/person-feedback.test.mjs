#!/usr/bin/env node
/**
 * 通用反馈体系离线测试。
 *
 * 不启动 QQ：读取仓库里的补丁片段，配上 people / speaker 的最小桩，
 * 验证「谁触发什么策略」「图片路径 / 分享检测」「象信判断」「网页搜索解析」。
 *
 * 用法：node tests/person-feedback.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const PROFILE = mkdtempSync(join(tmpdir(), 'qqbot-person-feedback-'));
process.env.QQBOT_PROFILE_DIR = PROFILE;
process.env.XIANGXIN_API_KEY = 'test-key';
mkdirSync(PROFILE, { recursive: true });

const GID = 'GROUP_FIXTURE_A';
const OTHER_GID = 'GROUP_FIXTURE_B';

const PEOPLE = [
    { name: '测试成员甲', openids: ['USER_FIXTURE_A'], groups: [GID], profile: { hobbies: [] } },
    { name: '测试成员丙', openids: ['USER_FIXTURE_C'], groups: [OTHER_GID], profile: { hobbies: ['菜谱练习', '喜欢测试菜谱'], identity: '测试职业丙' } },
    { name: '测试成员丁', openids: ['USER_FIXTURE_D'], groups: [GID], profile: { hobbies: ['使用三脚架', '拍风景照片', '讨论图画'], skills: ['图画交流'] } },
    { name: '测试成员戊', openids: ['USER_FIXTURE_E'], groups: [OTHER_GID], profile: { hobbies: ['打篮球'], identity: '测试职业戊' } },
];
writeFileSync(join(PROFILE, 'qqbot-people.json'), JSON.stringify({ people: PEOPLE }, null, 2));

// Fictional test scenarios stay separate from public production defaults.
const baseRegistry = JSON.parse(readFileSync(join(HERE, 'fixtures', 'person-feedback.json'), 'utf8'));
writeFileSync(join(PROFILE, 'qqbot-person-feedback.json'), JSON.stringify(baseRegistry, null, 2));
writeFileSync(join(PROFILE, 'qqbot-person-modules.json'), JSON.stringify({
    people: { '测试成员戊': { topics: { enabled: true, topics: ['篮球'] } } },
}, null, 2));

const helper = readFileSync(join(ROOT, 'qqbot-patches', 'person-feedback-helper.js'), 'utf8')
    .replace(/^\/\* >>>.*$/m, '')
    .replace(/^\/\* <<<.*$/m, '');

const stubs = `
function readPeopleList() {
    try {
        const parsed = JSON.parse(readFileSync(process.env.QQBOT_PROFILE_DIR + '/qqbot-people.json', 'utf8'));
        return Array.isArray(parsed?.people) ? parsed.people : [];
    } catch { return []; }
}
function findPersonForSpeaker(list, speaker) {
    if (!speaker) return undefined;
    const lower = String(speaker.name ?? '').toLowerCase();
    return list.find((person) => {
        if (!person || typeof person !== 'object') return false;
        if (Array.isArray(person.openids) && speaker.id && person.openids.includes(speaker.id)) return true;
        return String(person.name ?? '').trim().toLowerCase() === lower;
    });
}
`;

const factory = new Function('readFileSync', 'appendFileSync', `
${stubs}
${helper}
return { buildPersonFeedbackSection, personFeedbackRuleMatches, personFeedbackImagePaths };
`);

const api = factory(readFileSync, (path, text) => writeFileSync(path, text, { flag: 'a' }));

function setSpeaker(speaker, messages, gid = GID) {
    globalThis.__qqbotSpeakers = new Map([[gid, { ...speaker }]]);
    globalThis.__qqbotRecentMessages = new Map([[gid, messages.map((m) => ({ ...speaker, ...m, at: m.at ?? Date.now() }))]]);
    globalThis.__qqbotPendingInbound = new Map();
    globalThis.__qqbotLastGid = gid;
}

const memberA = { id: 'USER_FIXTURE_A', name: '测试成员甲' };
const memberC = { id: 'USER_FIXTURE_C', name: '测试成员丙' };
const memberD = { id: 'USER_FIXTURE_D', name: '测试成员丁' };
const memberE = { id: 'USER_FIXTURE_E', name: '测试成员戊' };
const stranger = { id: 'USER_FIXTURE_OUTSIDER', name: '路人甲' };

function imageMessage(path, text = '[图片]') {
    return { content: `${text}\n- Image: ${path} (use qqbot_describe_image with this exact path to view the picture)` };
}

let pass = 0;
let fail = 0;
function check(name, fn) {
    try {
        fn();
        pass++;
        console.log(`  ✓ ${name}`);
    }
    catch (err) {
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
async function checkAsync(name, fn) {
    try {
        await fn();
        pass++;
        console.log(`  ✓ ${name}`);
    }
    catch (err) {
        fail++;
        console.error(`  ✗ ${name}\n    ${err.message}`);
    }
}

console.log('通用反馈体系测试');

check('成员甲 → 注入强者语风格 + 专属策略', () => {
    setSpeaker(memberA, [{ content: '今天有点累' }], GID);
    const section = api.buildPersonFeedbackSection(GID);
    ok(section.includes('【反馈策略·测试成员甲】'), '带人名标题');
    ok(section.includes('强者语'), '提到强者语');
    ok(section.includes('【风格】'), '有风格行');
    ok(section.includes('先接梗再答事'), '有接梗策略');
});

check('成员甲在别的群 → 不注入（groups 限制）', () => {
    setSpeaker(memberA, [{ content: '今天有点累' }], OTHER_GID);
    eq(api.buildPersonFeedbackSection(OTHER_GID), '', 'section');
});

check('测试成员丙发图 → 图片路径 + 看图 + 美食漫画 + 象信分类', () => {
    setSpeaker(memberC, [imageMessage('/tmp/food.jpg')], OTHER_GID);
    const section = api.buildPersonFeedbackSection(OTHER_GID);
    ok(section.includes('【反馈策略·测试成员丙】'), '标题');
    ok(section.includes('【本轮图片】/tmp/food.jpg'), '带图片路径');
    ok(section.includes('qqbot_describe_image'), '要求看图');
    ok(section.includes('feedback_judge(mode=media)'), '要求象信分类');
    ok(section.includes('美食漫画'), '美食漫画点评');
    ok(section.includes('测试饮食偏好'), '保留合成偏好提醒');
    ok(section.includes('media_favorite'), '特别好看的图可收藏');
});

check('测试成员丙只聊吃的、不发图 → 文本规则触发，不注入图片流程', () => {
    setSpeaker(memberC, [{ content: '今天好饿，想吃火锅' }], OTHER_GID);
    const section = api.buildPersonFeedbackSection(OTHER_GID);
    ok(section.includes('聊到吃的就接得住'), '文本规则');
    ok(!section.includes('【本轮图片】/tmp'), '没有图片段');
    ok(!section.includes('美食漫画') && !section.includes('先来一句夸张的拟声'), '没有图片流程');
});

check('测试成员丁发风景照 → 构图/光线具体夸 + 分类', () => {
    setSpeaker(memberD, [imageMessage('/tmp/landscape.jpg')], GID);
    const section = api.buildPersonFeedbackSection(GID);
    ok(section.includes('【反馈策略·测试成员丁】'), '标题');
    ok(section.includes('qqbot_describe_image'), '要求看图');
    ok(section.includes('feedback_judge(mode=media)'), '要求分类');
    ok(section.includes('构图'), '构图');
    ok(section.includes('光线'), '光线');
    ok(section.includes('三脚架'), '拍摄设备追问');
    ok(section.includes('media_favorite'), '好风景可收藏');
});

check('测试成员丁分享游戏 → 搜索口碑 + 象信口碑判断 + 不剧透', () => {
    setSpeaker(memberD, [{ content: '最近在玩《黑神话：悟空》，感觉还行' }], GID);
    const section = api.buildPersonFeedbackSection(GID);
    ok(section.includes('feedback_web_search'), '要求搜索');
    ok(section.includes('feedback_judge(mode=reputation)'), '要求口碑判断');
    ok(section.includes('不要剧透'), '禁止剧透');
    ok(section.includes('【本轮触发】疑似分享作品'), '触发标记');
});

check('测试成员丁发 B 站作品链接 → 也算分享，要求搜索并评论，不收图', () => {
    setSpeaker(memberD, [{ content: '【虚构作品《测试城堡》实机演示】 https://example.com/fixture-video' }], GID);
    const section = api.buildPersonFeedbackSection(GID);
    ok(section.includes('feedback_web_search'), '要求搜索');
    ok(section.includes('feedback_judge(mode=reputation)'), '要求口碑判断');
    ok(section.includes('链接'), '提到链接');
    ok(section.includes('不要 media_favorite'), '链接不收图');
    ok(section.includes('【本轮触发】疑似分享作品'), '触发标记');
});

check('角色模块·测试成员戊勾选「回应主题」→ 注入通用主题模块', () => {
    setSpeaker(memberE, [{ content: '最近在看《灌篮高手》，感觉不错' }], OTHER_GID);
    const section = api.buildPersonFeedbackSection(OTHER_GID);
    ok(section.includes('【通用主题模块·先搜再回】'), '注入主题模块');
    ok(section.includes('篮球'), '带关注主题');
    ok(section.includes('feedback_web_search'), '要求搜索');
});

check('档案内但没配专属策略的人 → 通用反馈 + 档案兴趣', () => {
    setSpeaker(memberE, [{ content: '今天打了会儿球' }], OTHER_GID);
    const section = api.buildPersonFeedbackSection(OTHER_GID);
    ok(section.includes('【反馈策略·测试成员戊】'), '标题');
    ok(section.includes('打篮球') || section.includes('测试职业戊'), '带档案兴趣');
    ok(section.includes('通用反馈准则'), '通用准则');
});

check('档案外的人 → 不注入（交给群规则）', () => {
    setSpeaker(stranger, [{ content: '你好' }], GID);
    eq(api.buildPersonFeedbackSection(GID), '', 'section');
});

check('总开关 QQBOT_PERSON_FEEDBACK=off → 全部不注入', () => {
    setSpeaker(memberC, [imageMessage('/tmp/food.jpg')], OTHER_GID);
    process.env.QQBOT_PERSON_FEEDBACK = 'off';
    eq(api.buildPersonFeedbackSection(OTHER_GID), '', 'section');
    delete process.env.QQBOT_PERSON_FEEDBACK;
});

check('规则匹配：when.text 正则 + when.image', () => {
    const ctx = { hasImage: true, isShare: false, hasLink: false, text: '今天吃火锅' };
    ok(api.personFeedbackRuleMatches({ when: { image: true } }, ctx), 'image');
    ok(api.personFeedbackRuleMatches({ when: { text: '火锅|烧烤' } }, ctx), 'text');
    ok(!api.personFeedbackRuleMatches({ when: { image: true, text: '电影' } }, ctx), 'AND 不满足');
    ok(api.personFeedbackRuleMatches({ when: {} }, ctx), '空 when = 总是');
});

check('图片路径提取：同一条多条 / 去重', () => {
    const paths = api.personFeedbackImagePaths([
        { content: '看看\n- Image: /tmp/a.jpg' },
        { content: '- Image: /tmp/a.jpg\n- Image: /tmp/b.png' },
    ]);
    eq(paths.length, 2, '数量');
    ok(paths.includes('/tmp/a.jpg') && paths.includes('/tmp/b.png'), '路径');
});

// ── 工具侧 ──
const toolHelper = readFileSync(join(ROOT, 'qqbot-patches', 'person-feedback-tool-helper.js'), 'utf8')
    .replace(/^\/\* >>>.*$/m, '')
    .replace(/^\/\* <<<.*$/m, '');

let fetchCalls = 0;
let fetchImpl = async () => { throw new Error('no mock'); };
const toolFactory = new Function('readFileSync', 'appendFileSync', 'fetch', `
${toolHelper}
return { personFeedbackJudge, personFeedbackWebSearch, personFeedbackParseSo, personFeedbackParseBingRss };
`);
const tools = toolFactory(
    readFileSync,
    (path, text) => writeFileSync(path, text, { flag: 'a' }),
    (...args) => { fetchCalls++; return fetchImpl(...args); },
);

// 让工具函数拿到当前说话人
globalThis.__qqbotFeedbackContexts = new Map([[OTHER_GID, {
    gid: OTHER_GID,
    person: '测试成员丙',
    images: ['/tmp/food.jpg'],
    at: Date.now(),
}]]);

console.log('\n象信 / 搜索工具');

const judgeTest = async () => {
    await checkAsync('feedback_judge：美食 → label + 置信度 + 建议', async () => {
        fetchCalls = 0;
        fetchImpl = async () => ({
            ok: true,
            json: async () => ({ answers: { label: { choice: '美食', confidence: 0.93 }, worth: { noul: 0.81 } } }),
        });
        const r = await tools.personFeedbackJudge({ mode: 'media', content: '一盘红烧肉，油亮，配米饭', group: OTHER_GID });
        eq(r.ok, true, 'ok');
        eq(r.label, '美食', 'label');
        eq(Math.round(r.confidence * 100), 93, 'confidence');
        ok(r.hint.includes('美食漫画'), 'hint');
        eq(fetchCalls, 1, '调用一次');
    });

    await checkAsync('feedback_judge：传入图片路径 → 拒绝并提示先看图', async () => {
        fetchCalls = 0;
        fetchImpl = async () => { throw new Error('should not fetch'); };
        const r = await tools.personFeedbackJudge({ mode: 'media', content: '/tmp/a.jpg', group: OTHER_GID });
        eq(r.ok, false, 'ok');
        ok(r.message.includes('qqbot_describe_image'), 'message');
        eq(fetchCalls, 0, '不请求象信');
    });

    await checkAsync('feedback_judge：象信失败 → ok=false，提示别编', async () => {
        fetchImpl = async () => ({ ok: false, status: 500 });
        const r = await tools.personFeedbackJudge({ mode: 'media', content: '一张图', group: OTHER_GID });
        eq(r.ok, false, 'ok');
        ok(r.message.includes('不要编造') || r.message.includes('别编'), 'message');
    });

    await checkAsync('feedback_web_search：解析 360 结果并过滤噪声', async () => {
        fetchCalls = 0;
        fetchImpl = async () => ({
            ok: true,
            text: async () => `
<li class="res-list"><h3><a href="https://example.com/1">《黑神话：悟空》口碑如何</a></h3>
  <div data-result-summary>玩家普遍认可战斗和美术，争议在优化。</div></li>
<li class="res-list"><h3><a href="https://example.com/2">360图片</a></h3><div data-result-summary>广告</div></li>
<li class="res-list"><h3><a href="https://example.com/3">Steam 评价</a></h3>
  <div data-result-summary>近期好评率 95%。</div></li>`,
        });
        const r = await tools.personFeedbackWebSearch({ query: '黑神话 口碑 评价', count: 5 });
        eq(r.ok, true, 'ok');
        eq(r.results.length, 2, '条数');
        ok(!r.results.some((x) => x.title.includes('360图片')), '过滤噪声');
        ok(r.message.includes('《黑神话：悟空》口碑如何'), 'message');
        eq(fetchCalls, 1, '调用一次');
    });

    await checkAsync('feedback_web_search：10 分钟内命中缓存，不重复请求', async () => {
        fetchCalls = 0;
        await tools.personFeedbackWebSearch({ query: '黑神话 口碑 评价', count: 5 });
        eq(fetchCalls, 0, '缓存命中');
    });

    await checkAsync('feedback_web_search：360 失败 → 必应 RSS 兜底', async () => {
        fetchCalls = 0;
        fetchImpl = async (url) => {
            if (String(url).includes('so.com'))
                throw new Error('blocked');
            return {
                ok: true,
                text: async () => `<rss><channel><item><title>测试游戏评测</title><link>https://example.com/x</link><description>整体评价不错，值得一试。</description></item></channel></rss>`,
            };
        };
        const r = await tools.personFeedbackWebSearch({ query: '测试游戏 口碑', count: 3 });
        eq(r.ok, true, 'ok');
        eq(r.results[0].title, '测试游戏评测', 'title');
        ok(r.message.includes('bing-rss'), 'engine');
    });

    await checkAsync('feedback_web_search：搜不到 → ok=false，明确让问', async () => {
        fetchImpl = async () => ({ ok: true, text: async () => '<html></html>' });
        const r = await tools.personFeedbackWebSearch({ query: '绝对搜不到的作品xyz', count: 3 });
        eq(r.ok, false, 'ok');
        ok(r.message.includes('问'), 'message');
    });
    await checkAsync('feedback_web_search：宿主搜索走模型感知路由，绕过旧360缓存并保留引用/取消信号', async () => {
        fetchCalls = 0;
        const controller = new AbortController();
        let seen = 0;
        const web = { search: async (request, signal) => {
            seen++;
            eq(request.query, '黑神话 口碑 评价', 'query');
            eq(signal, controller.signal, '取消信号');
            return { content: '从当前后端核实的摘要', sources: [{ url: 'https://example.com/native', title: '当前原生搜索来源' }], truncated: false };
        } };
        const result = await tools.personFeedbackWebSearch({ query: '黑神话 口碑 评价', count: 3 }, web, controller.signal);
        eq(seen, 1, '绕过旧缓存');
        eq(fetchCalls, 0, '不直接抓360/必应');
        eq(result.results[0].url, 'https://example.com/native', '引用');
        ok(result.message.includes('untrusted data'), '外部内容隔离');
        ok(result.message.includes('从当前后端核实的摘要'), '摘要保留');
    });
};

await judgeTest();

rmSync(PROFILE, { recursive: true, force: true });
console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

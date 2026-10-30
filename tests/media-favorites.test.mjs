#!/usr/bin/env node
/**
 * 媒体库收藏（media_favorite）离线测试。
 *
 * 用真实的 node:sqlite 建临时媒体库，验证：
 *   归档 → 收藏（理由/标签）→ 只看收藏 → 取消收藏 → 未归档图按需补档
 *
 * 用法：node tests/media-favorites.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const PROFILE = mkdtempSync(join(tmpdir(), 'qqbot-media-fav-'));
const HOME = join(PROFILE, 'home');
const MEDIA_SRC = join(PROFILE, 'incoming');
mkdirSync(HOME, { recursive: true });
mkdirSync(MEDIA_SRC, { recursive: true });
process.env.QQBOT_PROFILE_DIR = PROFILE;
process.env.HOME = HOME;
process.env.XIANGXIN_API_KEY = ''; // Never inherit a developer's billable credential.
globalThis.fetch = async () => { throw new Error('network forbidden in media fixture'); };

const GID = 'GROUP_FIXTURE_A';
writeFileSync(join(PROFILE, 'qqbot-groups-meta.json'), JSON.stringify({ groups: [{ id: GID, name: '测试群甲' }] }));
writeFileSync(join(PROFILE, 'qqbot-people.json'), JSON.stringify({
    people: [{ name: '测试成员丁', openids: ['USER_FIXTURE_D'], groups: [GID], profile: {} }],
}));

// 最小 JPEG：FF D8 FF + 一点内容，够 archiveFile 复制/按 sha 去重
function jpeg(name, extra) {
    const file = join(MEDIA_SRC, name);
    writeFileSync(file, Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.from(extra)]));
    return file;
}

const helper = readFileSync(join(ROOT, 'qqbot-patches', 'media-archive-helper.js'), 'utf8')
    .replace(/^\/\* >>>.*$/m, '')
    .replace(/^\/\* <<<.*$/m, '');

const tools = {
    handlers: {},
    register(def) { this.handlers[def.name] = def; },
};
const ctx = { get: (name) => (name === 'tools' ? tools : undefined) };
const bot = {};
const manager = {};
const logger = { info() {}, warn() {} };

const factory = new Function('readFileSync', `${helper}\nreturn { setupMediaArchive };`);
const api = factory(readFileSync);

api.setupMediaArchive(ctx, bot, manager, {}, logger);
globalThis.__qqbotMediaForceArchive = true;

const archive = globalThis.__qqbotMediaArchive;
if (!archive) {
    console.error('媒体库没有启动');
    process.exit(1);
}

let pass = 0;
let fail = 0;
async function check(name, fn) {
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
function eq(actual, expected, label) {
    if (actual !== expected)
        throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function ok(value, label) {
    if (!value)
        throw new Error(`${label}: 期望为真`);
}

console.log('媒体库收藏测试');

const first = jpeg('first.jpg', 'landscape-photo');

await check('归档一张图 → media_search 能搜到', async () => {
    await archive.archive({
        message: {
            kind: 'group',
            groupOpenid: GID,
            senderId: 'USER_FIXTURE_D',
            senderName: '测试成员丁',
            content: `[图片]\n- Image: ${first} (use qqbot_describe_image with this exact path to view the picture)`,
            attachments: [],
        },
    });
    const result = tools.handlers.media_search.execute({ person: '测试成员丁' });
    eq(result.items.length, 1, '条数');
    eq(result.items[0].sender, '测试成员丁', '分享人');
    eq(result.items[0].liked, false, '默认未收藏');
});

globalThis.__qqbotMediaForceArchive = false;

await check('非个人生活图（梗图/无上下文）不自动归档', async () => {
    const meme = jpeg('meme.jpg', 'just-a-meme');
    await archive.archive({
        message: {
            kind: 'group',
            groupOpenid: GID,
            senderId: 'USER_FIXTURE_D',
            senderName: '测试成员丁',
            content: `[图片]\n- Image: ${meme}`,
            attachments: [],
        },
    });
    const result = tools.handlers.media_search.execute({ query: 'just-a-meme' });
    eq(result.items.length, 0, '梗图不应入库');
});

let firstId = 0;
await check('media_favorite：按图片路径收藏，写理由和标签', async () => {
    const result = tools.handlers.media_favorite.execute({
        image: first,
        reason: '侧逆光把山脊勾出金边，前景压得住画面',
        tags: ['风景', '摄影', '#构图'],
    });
    eq(result.ok, true, 'ok');
    eq(result.favorite, true, 'favorite');
    eq(result.tags, '风景,摄影,构图', '标签去重/去 #');
    ok(result.id > 0, 'id');
    firstId = result.id;
});

await check('media_search：favorites=true 只看收藏，带理由/标签/时间', async () => {
    const result = tools.handlers.media_search.execute({ favorites: true });
    eq(result.items.length, 1, '条数');
    eq(result.items[0].liked, true, 'liked');
    ok(result.items[0].reason.includes('侧逆光'), 'reason');
    eq(result.items[0].tags, '风景,摄影,构图', 'tags');
    ok(result.items[0].likedAt !== '', 'likedAt');
    eq(result.items[0].id, firstId, 'id 一致');
});

await check('media_search：按标签过滤', async () => {
    const hit = tools.handlers.media_search.execute({ favorites: true, tag: '摄影' });
    eq(hit.items.length, 1, '命中');
    const miss = tools.handlers.media_search.execute({ favorites: true, tag: '美食' });
    eq(miss.items.length, 0, '未命中');
});

await check('media_favorite：空理由拒绝', async () => {
    const result = tools.handlers.media_favorite.execute({ image: first, reason: '  ' });
    eq(result.ok, false, 'ok');
    ok(result.message.includes('理由'), 'message');
});

await check('media_favorite：取消收藏', async () => {
    const result = tools.handlers.media_favorite.execute({ id: firstId, remove: true });
    eq(result.ok, true, 'ok');
    eq(result.favorite, false, 'favorite');
    const list = tools.handlers.media_search.execute({ favorites: true });
    eq(list.items.length, 0, '收藏已清空');
});

await check('未归档的图直接收藏 → 按需补归档', async () => {
    const second = jpeg('second.jpg', 'another-photo');
    globalThis.__qqbotLastGid = GID;
    globalThis.__qqbotRecentMessages = new Map([[GID, [{ id: 'USER_FIXTURE_D', name: '测试成员丁', content: '这个好看', at: Date.now() }]]]);
    globalThis.__qqbotFeedbackContexts = new Map([[GID, {
        gid: GID,
        person: '测试成员丁',
        speaker: { id: 'USER_FIXTURE_D', name: '测试成员丁' },
        at: Date.now(),
    }]]);
    const result = tools.handlers.media_favorite.execute({ image: second, reason: '天色层次很干净', tags: ['风景'] });
    eq(result.ok, true, 'ok');
    eq(result.sender, '测试成员丁', '补档分享人');
    const list = tools.handlers.media_search.execute({ favorites: true });
    eq(list.items.length, 1, '收藏数');
    eq(list.items[0].reason, '天色层次很干净', 'reason');
});

await check('找不到的路径 → ok=false', async () => {
    const result = tools.handlers.media_favorite.execute({ image: join(MEDIA_SRC, 'nope.jpg'), reason: '好看' });
    eq(result.ok, false, 'ok');
});

await check('media_search：老图不受 favorites 影响仍可搜全部', async () => {
    const result = tools.handlers.media_search.execute({ query: 'another' });
    ok(Array.isArray(result.items), 'items');
});

archive.db.close();
rmSync(PROFILE, { recursive: true, force: true });
console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

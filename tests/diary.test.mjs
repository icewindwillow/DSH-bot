#!/usr/bin/env node
/**
 * 自传日记（diary）离线测试。
 *
 * 覆盖：注入文案（最近两篇、按群隔离）、公开版匿名清洗、空数据不注入。
 * 用法：node tests/diary.test.mjs
 */
import './fixtures/profile-documents-globals.mjs';
import { readQqbotGroupDirectory } from '../qqbot-patches/profile-document-reader.js';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PROFILE = mkdtempSync(join(tmpdir(), 'qqbot-diary-'));
process.env.QQBOT_PROFILE_DIR = PROFILE;
process.env.QQBOT_DIARY = 'on';
process.env.QQBOT_DIARY_PUBLISH = 'on';
process.env.QQBOT_DIARY_GUILD = 'fixture-guild';
process.env.QQBOT_DIARY_CHANNEL = 'fixture-channel';
process.env.QQBOT_VISION_PREFLIGHT = 'on';
process.env.QQBOT_CHANNEL_CLI = join(PROFILE, 'channel-cli');
writeFileSync(process.env.QQBOT_CHANNEL_CLI, `#!/bin/sh
printf '%s\\n' '{"success": true, "data": {"share_url": "https://pd.qq.com/s/example", "feed_id": "F1"}}'
`, { mode: 0o700 });

writeFileSync(join(PROFILE, 'qqbot-people.json'), JSON.stringify({
    people: [{ name: '测试成员甲' }, { name: '测试成员乙' }, { name: '测试成员丙' }],
}));
writeFileSync(join(PROFILE, 'qqbot-diary.jsonl'), [
    { at: 1, date: '2026-10-28', gid: 'G1', name: '测试群一', text: '第一篇：今天有点困。' },
    { at: 2, date: '2026-10-29', gid: 'G1', name: '测试群一', text: '第二篇：有人夸了我的穿搭。' },
    { at: 3, date: '2026-10-30', gid: 'G1', name: '测试群一', text: '第三篇：今天想早点睡。' },
    { at: 4, date: '2026-10-30', gid: 'G2', name: '测试群二', text: '别的群的事。' },
].map((e) => JSON.stringify(e)).join('\n') + '\n');

const strip = (p) => readFileSync(p, 'utf8')
    .replace(/^\/\* >>>.*$/m, '')
    .replace(/^\/\* <<<.*$/m, '');

const sandbox = {
    readQqbotGroupDirectory,
    process,
    console: { log: () => {}, error: console.error },
    setTimeout,
    clearTimeout,
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
};
const factory = new Function(...Object.keys(sandbox), `
    ${strip(join(ROOT, 'qqbot-patches', 'diary-helper.js'))}
    return { setupDiary };
`);
const { setupDiary } = factory(...Object.values(sandbox));
const tools = new Map();
setupDiary({ get: (name) => name === 'tools' ? { register: (tool) => tools.set(tool.name, tool) } : undefined }, { info: () => {} });
const diary = globalThis.__qqbotDiary;

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

console.log('diary: 群内注入');
{
    const line = diary.promptLine('G1');
    ok('包含手记段', line.includes('【你最近的手记】'), line);
    ok('只取最近两篇', line.includes('第二篇') && line.includes('第三篇') && !line.includes('第一篇'), line);
    ok('不串群', !line.includes('别的群的事'));
    ok('空群不注入', diary.promptLine('G404') === '');
}

console.log('diary: 公开版匿名');
{
    const { anonymize } = diary._test;
    const dirty = '今天测试成员甲说测试成员乙在群里被测试成员丙逗笑了，@123456 还发了 123456789 这个号。';
    const clean = anonymize(dirty);
    ok('人名被替换', !/测试成员甲|测试成员乙|测试成员丙/.test(clean), clean);
    ok('@ 被清掉', !clean.includes('@'), clean);
    ok('长数字被清掉', !/\d{5,}/.test(clean), clean);
    ok('保留正文', clean.includes('逗笑'), clean);
}

console.log('diary: 树洞配图');
{
    const { imagePrompt, makeImage } = diary._test;
    const prompt = imagePrompt('A person feels happy after a compliment about their outfit.');
    ok('保留英文场景描述', prompt.includes('compliment about their outfit'), prompt);
    ok('包含水彩手绘风格', /watercolor.*hand-drawn/i.test(prompt), prompt);
    ok('禁止文字水印', /no text.*watermark/i.test(prompt), prompt);
    globalThis.qqbotImageGenerateInternal = async () => ({ bytes: Buffer.from('fake-image'), extension: 'png', provider: 'fake', model: 'fake' });
    const file = await makeImage('今天有人夸我的穿搭。', '2026-10-30');
    ok('生成私有临时图片', typeof file === 'string' && existsSync(file), String(file));
    if (file) {
        ok('临时图片权限 0600', (statSync(file).mode & 0o777) === 0o600);
        unlinkSync(file);
    }
    globalThis.qqbotImageGenerateInternal = async () => { throw new Error('synthetic-image-down'); };
    ok('失败降级为 undefined', (await makeImage('今天有点困。', '2026-10-30')) === undefined);
    delete globalThis.qqbotImageGenerateInternal;
}

console.log('diary: 发帖频道');
{
    process.env.QQBOT_DIARY_CHANNELS = 'fixture-guild:fixture-channel,99:88,77';
    process.env.QQBOT_DIARY_PUBLISH = 'off';
    ok('关闭发布时不写入成功回执', !diary._test.archivePublic({ gid: 'public', text: '测试预览' })
        && !diary.readAll().some(entry => entry.text === '测试预览' && entry.published));
    process.env.QQBOT_DIARY_PUBLISH = 'on';
    const targets = diary._test.channels();
    ok('默认树洞 + 追加两个频道', targets.length === 3, JSON.stringify(targets));
    ok('同一频道不重复', targets.filter((t) => t.channel === 'fixture-channel').length === 1);
    ok('裸频道沿用默认 guild', targets.some((t) => t.channel === '77' && t.guild === 'fixture-guild'));
    delete process.env.QQBOT_DIARY_CHANNELS;
}

console.log('diary: 作品索引与截图召回');
{
    const body = '朋友说会每天在家里认真锻炼身体，我听到这句话特别开心，立刻坐下来给日记画了一幅插图。';
    globalThis.qqbotImageGenerateInternal = async () => ({ bytes: Buffer.from('published-image'), extension: 'png' });
    const artwork = await diary._test.makeImage('A quiet room.', '2026-11-19');
    delete globalThis.qqbotImageGenerateInternal;
    ok('发帖回执结构化存档并保留原图', diary._test.archivePublic({ date: '2026-11-19', gid: 'public', text: body }, artwork, 'A quiet room.')
        && existsSync(artwork) && diary.readAll().at(-1).publication.posts[0].shareUrl === 'https://pd.qq.com/s/example');
    const owns = (line) => line.includes('你自己写和发布的') && line.includes('原帖配图也是你画的');
    ok('相同配图可反查正文作者', owns(diary.recall({ imagePath: artwork })));
    ok('分享链接带参数也能定位原帖', owns(diary.recall({ text: '看看 https://pd.qq.com/s/example?from=share' })));
    ok('只有空泛指代时不认领', diary.recall({ text: '这个图是树洞日记吗' }) === '');
    ok('日常群手记不预加载公开作品', !diary.promptLine('G1').includes(body.slice(0, 20)));
    const result = await tools.get('qqbot_find_my_diary').execute({ keyword: '锻炼身体' });
    ok('可按关键词查询正文与配图归属', result.result.includes('配图也是我画的') && result.result.includes('https://pd.qq.com/s/example'));

    const middleware = [];
    const attachPreflight = new Function('bot', 'attachmentProcessor', 'config', 'logger', 'console', strip(join(ROOT, 'qqbot-patches', 'vision-preflight.js')));
    attachPreflight({ use: (fn) => middleware.push(fn) }, () => () => {}, {}, {}, sandbox.console);
    const screenshot = join(PROFILE, 'screenshot.jpg');
    writeFileSync(screenshot, 'test screenshot');
    globalThis.__qqbotVision = { describe: async () => ({ what: '一篇配图日记的截图', transcript: body.slice(0, 33) }) };
    const quoted = { message: { groupOpenid: 'G1', senderId: 'reader', content: '这个' },
        state: { downloadedQuoteFiles: [{ contentType: 'image/jpeg', localPath: screenshot }] } };
    await middleware[1](quoted, () => {});
    ok('引用截图通过 OCR 触发本轮作品归属', owns(quoted.message.content));
    const unrelated = { message: { groupOpenid: 'G1', senderId: 'other', content: '早上好' }, state: {} };
    await middleware[1](unrelated, () => {});
    ok('无关轮次不携带作品信息', unrelated.message.content === '早上好');
    delete globalThis.__qqbotVision;
}

rmSync(PROFILE, { recursive: true, force: true });
console.log(`\n${passed} 通过，${failures.length} 失败`);
if (failures.length > 0) {
    console.error(`失败项：${failures.join(' / ')}`);
    process.exit(1);
}

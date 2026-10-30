#!/usr/bin/env node
/**
 * 自传日记（diary）离线测试。
 *
 * 覆盖：注入文案（最近两篇、按群隔离）、公开版匿名清洗、空数据不注入。
 * 用法：node tests/diary.test.mjs
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PROFILE = mkdtempSync(join(tmpdir(), 'qqbot-diary-'));
process.env.QQBOT_PROFILE_DIR = PROFILE;
process.env.HOME = PROFILE;
process.env.QQBOT_MEMORY_DB = join(PROFILE, 'unused-synthetic-ltm.db');
process.env.QQBOT_DIARY_PUBLISH = 'off';
process.env.QQBOT_DIARY = 'on';

writeFileSync(join(PROFILE, 'qqbot-people.json'), JSON.stringify({
    people: [{ name: '测试成员乙' }, { name: '测试成员辛' }, { name: '测试成员壬' }],
}));
writeFileSync(join(PROFILE, 'qqbot-diary.jsonl'), [
    { at: 1, date: '2026-10-28', gid: 'G1', name: '测试群甲', text: '第一篇：今天有点困。' },
    { at: 2, date: '2026-10-29', gid: 'G1', name: '测试群甲', text: '第二篇：有人夸了我的穿搭。' },
    { at: 3, date: '2026-10-30', gid: 'G1', name: '测试群甲', text: '第三篇：今天想早点睡。' },
    { at: 4, date: '2026-10-30', gid: 'G2', name: '测试群乙', text: '别的群的事。' },
].map((e) => JSON.stringify(e)).join('\n') + '\n');

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
};
const factory = new Function(...Object.keys(sandbox), `
    ${strip(join(ROOT, 'qqbot-patches', 'diary-helper.js'))}
    return { setupDiary };
`);
const { setupDiary } = factory(...Object.values(sandbox));
setupDiary({ get: () => undefined }, { info: () => {} });
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
    const dirty = '今天测试成员乙说测试成员辛在群里被测试成员壬逗笑了，@123456 还发了 123456789 这个号。';
    const clean = anonymize(dirty);
    ok('人名被替换', !/测试成员乙|测试成员辛|测试成员壬/.test(clean), clean);
    ok('@ 被清掉', !clean.includes('@'), clean);
    ok('长数字被清掉', !/\d{5,}/.test(clean), clean);
    ok('保留正文', clean.includes('逗笑'), clean);
}

rmSync(PROFILE, { recursive: true, force: true });
console.log(`\n${passed} 通过，${failures.length} 失败`);
if (failures.length > 0) {
    console.error(`失败项：${failures.join(' / ')}`);
    process.exit(1);
}

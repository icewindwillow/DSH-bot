#!/usr/bin/env node
/**
 * 互动事件阈值测试（interaction-helper 的纯判定函数）。
 *
 * 语义：30 分钟窗口内「≥10 句且好感≥4 或烦躁≥8」或「被摸≥3 次」才写事件日记。
 * 用法：node tests/interaction.test.mjs
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PROFILE = mkdtempSync(join(tmpdir(), 'qqbot-interaction-'));
process.env.QQBOT_PROFILE_DIR = PROFILE;

const strip = (p) => readFileSync(p, 'utf8')
    .replace(/^\/\* >>>.*$/m, '')
    .replace(/^\/\* <<<.*$/m, '');

const sandbox = {
    process,
    console: { log: () => {}, error: console.error },
    setTimeout,
    clearTimeout,
};
const factory = new Function(...Object.keys(sandbox), `
    ${strip(join(ROOT, 'qqbot-patches', 'interaction-helper.js'))}
    return { setupInteraction };
`);
const { setupInteraction } = factory(...Object.values(sandbox));
setupInteraction({ get: () => undefined }, { use: () => {} }, {}, { info: () => {} });
const { decide } = globalThis.__qqbotInteraction;

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

console.log('interaction: 阈值判定');
{
    ok('10 句 + 好感 4 → 聊得开心', decide({ msgs: 10, pets: 0, da: 4, di: 0 }) === '聊得开心');
    ok('10 句 + 好感 2 → 不写', decide({ msgs: 10, pets: 0, da: 2, di: 0 }) === null);
    ok('9 句 + 好感 5 → 不写', decide({ msgs: 9, pets: 0, da: 5, di: 0 }) === null);
    ok('10 句 + 烦躁 8 → 被惹烦了', decide({ msgs: 10, pets: 0, da: 0, di: 8 }) === '被惹烦了');
    ok('被摸 3 次 → 被摸摸', decide({ msgs: 2, pets: 3, da: 0, di: 0 }) === '被摸摸');
    ok('被摸 2 次 → 不写', decide({ msgs: 2, pets: 2, da: 0, di: 0 }) === null);
    ok('被摸 + 聊很久 → 组合标签', decide({ msgs: 12, pets: 3, da: 5, di: 0 }) === '聊了很久还被摸摸');
    ok('好感掉 4 → 闹得有点僵', decide({ msgs: 10, pets: 0, da: -4, di: 0 }) === '闹得有点僵');
}

rmSync(PROFILE, { recursive: true, force: true });
console.log(`\n${passed} 通过，${failures.length} 失败`);
if (failures.length > 0) {
    console.error(`失败项：${failures.join(' / ')}`);
    process.exit(1);
}

#!/usr/bin/env node
/**
 * 每日日报（memory-summary-helper 的 [日报] 分支）离线测试。
 *
 * 不调用真实模型：ctx.get('llm') 返回一个只吐固定文本的假 stream。
 * 用法：node tests/memory-digest.test.mjs
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createMemoryStore } from './fixtures/memory-store.mjs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const home = mkdtempSync(join(tmpdir(), 'qqbot-digest-'));
process.env.HOME = home; // No real home/database/profile reads.
mkdirSync(join(home, '.dsh', 'memory'), { recursive: true });
mkdirSync(join(home, '.dsh', 'profiles', 'qqbot'), { recursive: true });
writeFileSyncSafe(join(home, '.dsh', 'profiles', 'qqbot', 'qqbot-groups-meta.json'), JSON.stringify({
    groups: [{ id: 'GID_TEST', name: '测试群' }],
}, null, 2));
process.env.HOME = home;
process.env.QQBOT_PROFILE_DIR = join(home, '.dsh', 'profiles', 'qqbot');

function writeFileSyncSafe(path, text) {
    // node:fs 的 writeFileSync 在这里按需引入，避免顶部再拆一次导入
    const fs = process.getBuiltinModule('node:fs');
    fs.writeFileSync(path, text, 'utf8');
}

const db = createMemoryStore(join(home, '.dsh', 'memory', 'ltm.db'));
const insert = db.prepare('insert into memories (text, tags, scope, pinned, created_at, updated_at, last_confirmed_at, revision) values (?, ?, ?, 0, ?, ?, ?, 1)');
const now = Date.now();
insert.run('测试成员乙：今天完成了一幅测试拼图', '近况 测试成员乙', 'qq:group:GID_TEST', now, now, now);
insert.run('[身份] 测试成员丙：测试职业乙', '身份 测试成员丙', 'qq:group:GID_TEST', now, now, now);
insert.run('[偏好] 测试成员壬：喜欢猫', '偏好 测试成员壬', 'qq:group:GID_TEST', now, now, now);
db.close();

let calls = 0;
const llm = {
    stream(options) {
        calls++;
        if (options.provider !== 'opencode-go' || options.model !== 'deepseek-v4.1-flash')
            throw new Error(`意外路由: ${options.provider}/${options.model}`);
        return (async function* () {
            yield { type: 'text-delta', text: '测试成员乙完成了测试拼图，测试成员丙是测试职业乙，测试成员壬喜欢猫。' };
            yield { type: 'finish', reason: { kind: 'completed' } };
        })();
    },
};
const ctx = { get: (name) => (name === 'llm' ? llm : undefined) };
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const src = readFileSync(join(ROOT, 'qqbot-patches', 'memory-summary-helper.js'), 'utf8')
    .replace(/^\/\* >>>.*$/m, '')
    .replace(/^\/\* <<<.*$/m, '');
const factory = new Function('readFileSync', 'writeFileSync', 'console', `
    ${src}
    return { setupMemorySummary };
`);
factory(readFileSync, writeFileSyncSafe, { log: () => {} })
    .setupMemorySummary(ctx, logger);

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
    try {
        await fn();
        pass++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        fail++;
        console.error(`  ✗ ${name}\n    ${err.message}`);
    }
};
const rowsOf = () => {
    const conn = new DatabaseSync(join(home, '.dsh', 'memory', 'ltm.db'), { readOnly: true });
    try {
        return conn.prepare("select id, text, tags, scope from memories where tags like '%日报%'").all();
    }
    finally {
        conn.close();
    }
};

console.log('每日日报测试');

await check('最近 24h 有 3 条记忆 → 生成一条 [日报]', async () => {
    await globalThis.__qqbotMemorySummary.runOnce(true);
    const rows = rowsOf();
    if (rows.length !== 1)
        throw new Error(`日报条数 ${rows.length}`);
    if (!String(rows[0].text).startsWith('[日报] '))
        throw new Error(`文本不对：${rows[0].text}`);
    if (!String(rows[0].text).includes('测试成员乙') || !String(rows[0].text).includes('测试成员丙'))
        throw new Error('日报没覆盖记忆');
    if (calls !== 1)
        throw new Error(`模型调用次数 ${calls}`);
});

await check('同一天再跑不重复写', async () => {
    await globalThis.__qqbotMemorySummary.runOnce(true);
    if (rowsOf().length !== 1)
        throw new Error('重复生成了日报');
});

// home is exclusively the mkdtemp-created synthetic fixture root.
rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

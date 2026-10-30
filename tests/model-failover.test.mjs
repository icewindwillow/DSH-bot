#!/usr/bin/env node
/**
 * 模型断联兜底（free → opencode-go → 探活切回）离线测试。
 *
 * 用法：node tests/model-failover.test.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

process.env.QQBOT_FAILOVER_PROBE_COOLDOWN_MS = '0';
process.env.QQBOT_FAILOVER_PROBE_TIMEOUT_MS = '1000';

const helperSrc = readFileSync(join(ROOT, 'qqbot-patches', 'model-failover-helper.js'), 'utf8')
    .replace(/^\/\* >>>.*$/m, '')
    .replace(/^\/\* <<<.*$/m, '');
const setup = new Function('console', `${helperSrc}\nreturn setupModelFailover;`)({ log: () => {} });

const handlers = new Map();
let freeHealthy = false;
let probeCalls = 0;

const llm = {
    stream(options) {
        probeCalls++;
        return (async function* () {
            if (!freeHealthy)
                throw new Error('ECONNRESET');
            yield { type: 'finish', reason: { kind: 'completed' } };
        })();
    },
};

const ctx = {
    get: (name) => (name === 'llm' ? llm : undefined),
    on: (event, fn) => {
        handlers.set(event, fn);
        return () => handlers.delete(event);
    },
};

const logger = { info: () => {} };
delete process.env.QQBOT_MODEL_FAILOVER;
setup(ctx, {}, logger);
if (handlers.size !== 0) throw new Error('Cross-provider fallback must be opt-in; default may not register hooks');
process.env.QQBOT_MODEL_FAILOVER = 'on';
setup(ctx, {}, logger);

const agent = {
    options: { provider: 'our-free-model', model: 'kilo-auto/free', reasoningEffort: 'high', maxTokens: 32768 },
};
const seed = { provider: 'our-free-model', model: 'kilo-auto/free', reasoningEffort: 'high', maxTokens: 32768 };
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

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
const eq = (actual, expected, label) => {
    if (actual !== expected)
        throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
};
const request = (turn, nextSeed = seed) => handlers.get('agent/request')({ agent, turn, step: 1 }, () => Promise.resolve(nextSeed));
const failed = (turn) => handlers.get('agent/request-error')({
    agent, provider: 'our-free-model', failure: { code: 'TRANSPORT' }, turn, step: 1,
}, () => Promise.resolve(undefined));

console.log('模型断联兜底测试');

await check('free 断联一次就由兜底接管（不返回 undefined）', async () => {
    const action = await failed(1);
    eq(action && action.kind, 'retry', 'action');
});

await check('失败的那一步改走 opencode-go，并卡在 8192 输出上限', async () => {
    const cfg = await request(1);
    eq(cfg.provider, 'opencode-go', 'provider');
    eq(cfg.model, 'deepseek-v4.1-flash', 'model');
    eq(cfg.maxTokens, 8192, 'maxTokens');
});

await check('下一轮仍走备用，同时后台探 free（此轮 free 仍不可用）', async () => {
    const before = probeCalls;
    const cfg = await request(2);
    await tick();
    eq(cfg.provider, 'opencode-go', 'provider');
    if (probeCalls <= before)
        throw new Error('没有发起探活');
});

await check('探活成功后下一轮切回 free', async () => {
    freeHealthy = true;
    const cfg2 = await request(3);     // 这一轮仍走备用，探活成功
    await tick();
    const cfg3 = await request(4);     // 下一轮切回
    eq(cfg2.provider, 'opencode-go', '探活当轮');
    eq(cfg3.provider, 'our-free-model', '切回');
    eq(cfg3.model, 'kilo-auto/free', '模型');
    eq(cfg3.maxTokens, 32768, 'maxTokens 恢复');
});

await check('用户选了别的模型时不插手', async () => {
    const other = { options: { provider: 'deepseek', model: 'deepseek-chat' } };
    const cfg = await handlers.get('agent/request')({ agent: other, turn: 9, step: 1 }, () => Promise.resolve({ provider: 'deepseek', model: 'deepseek-chat' }));
    eq(cfg.provider, 'deepseek', 'provider');
});

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

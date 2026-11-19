import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../qqbot-patches/model-failover-helper.js', import.meta.url), 'utf8');
const loadSetup = new Function('process', `${source}\nreturn setupModelFailover;`);
const setup = loadSetup({
    env: { QQBOT_MODEL_FAILOVER: 'on', QQBOT_FAILOVER_PROBE_COOLDOWN_MS: '0' },
});
const primary = { provider: 'our-free-model', model: 'combo:recommended-free', reasoningEffort: 'high' };
const backup = { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' };

test('cross-provider failover remains disabled without an explicit opt-in', () => {
    const disabled = loadSetup({ env: {} });
    assert.deepEqual(disabled({}, {}, {})(), { status: 'disabled' });
});

function fixture() {
    const handlers = new Map();
    const managed = new Set();
    const probes = [];
    let healthy = false;
    const llm = {
        async *stream(options) {
            probes.push(options);
            yield { type: 'finish', reason: { kind: healthy ? 'stop' : 'error' } };
        },
    };
    const health = setup({
        get: () => llm,
        on: (event, handler) => handlers.set(event, handler),
    }, { findByAgent: (agent) => managed.has(agent) }, {});
    function createAgent(route = primary, shouldManage = true) {
        let pending;
        let previous;
        let lastUsed;
        const agent = {
            options: { maxTokens: 32768 },
            model: {
                current: () => pending ?? lastUsed ?? route,
            },
            session: {
                requestHeader: () => previous && { config: previous },
            },
            use(value) {
                const preferred = agent.model.current();
                previous = value;
                const { provider, model, reasoningEffort } = value;
                lastUsed = { provider, model, reasoningEffort };
                if (pending?.provider === value.provider && pending.model === value.model) pending = undefined;
                if (preferred.provider !== provider || preferred.model !== model) pending = preferred;
            },
        };
        if (shouldManage) managed.add(agent);
        return agent;
    }
    const select = (agent, turn, signal) => handlers.get('agent/step-model')({ agent, turn, signal }, () => agent.model.current());
    const request = (agent, turn, seed) => handlers.get('agent/request')({ agent, turn }, () => seed);
    const fail = (agent, turn, provider = primary.provider, code = 'TRANSPORT', signal) =>
        handlers.get('agent/request-error')({ agent, turn, provider, failure: { code }, signal }, () => undefined);
    return { createAgent, select, request, fail, health, probes, recover: () => { healthy = true; } };
}

test('a failed free request schedules a newly prepared step using the backup in the same turn', async () => {
    const f = fixture();
    const agent = f.createAgent();
    const cfg = { ...primary, maxTokens: 32768 };
    assert.deepEqual(await f.select(agent, 1), primary);
    assert.deepEqual(await f.request(agent, 1, cfg), cfg);
    agent.use(cfg);

    assert.deepEqual(f.fail(agent, 1), { kind: 'retry', reprepare: true });
    const route = await f.select(agent, 1);
    assert.deepEqual(route, backup);
    const seed = { ...route, maxTokens: 32768 };
    const request = await f.request(agent, 1, seed);
    assert.deepEqual(request, { ...seed, maxTokens: 8192 });
    agent.use(request);
    assert.deepEqual(agent.model.current(), primary);
    assert.deepEqual(await f.select(agent, 1), backup);
    assert.equal(f.fail(agent, 1, backup.provider, 'SERVER'), undefined);
    assert.equal(f.health().preferredRoute, 'fallback');
});

test('sessions sharing a turn number keep their own route and new turns recover after a successful probe', async () => {
    const f = fixture();
    const first = f.createAgent(), concurrent = f.createAgent();
    await f.select(first, 1);
    await f.select(concurrent, 1);
    first.use({ ...primary, maxTokens: 32768 });
    f.fail(first, 1);
    const selected = await f.select(first, 1);
    first.use(await f.request(first, 1, { ...selected, maxTokens: 32768 }));
    assert.deepEqual(await f.select(concurrent, 1), primary);

    f.recover();
    assert.deepEqual(await f.select(first, 2), backup);
    await new Promise(setImmediate);
    assert.equal(f.probes.length, 1);
    assert.deepEqual(f.probes[0].messages, [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]);
    assert.equal(f.health().status, 'probe_passed');
    assert.deepEqual(await f.select(first, 2), backup);
    assert.deepEqual(await f.select(first, 3), primary);
    assert.deepEqual(await f.request(first, 3, { ...primary, maxTokens: 8192 }), { ...primary, maxTokens: 32768 });
    assert.equal(f.health().preferredRoute, 'primary');
});

test('cancellation, invalid requests, and unrelated agents or explicitly selected providers pass through', async () => {
    const f = fixture();
    const agent = f.createAgent();
    await f.select(agent, 1);
    assert.equal(f.fail(agent, 1, primary.provider, 'INVALID_ARGS'), undefined);
    assert.equal(f.fail(agent, 1, primary.provider, 'TRANSPORT', AbortSignal.abort()), undefined);

    const selected = { ...backup, reasoningEffort: 'high', maxTokens: 16384 };
    const direct = f.createAgent(selected), unrelated = f.createAgent(primary, false);
    assert.deepEqual(await f.select(direct, 1), selected);
    assert.deepEqual(await f.request(direct, 1, selected), selected);
    assert.deepEqual(await f.select(unrelated, 1), primary);
    assert.equal(f.fail(unrelated, 1), undefined);
    assert.equal(f.health().preferredRoute, 'primary');
});

// Replay using the installed DSH's real agent loop and an offline LLM.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [runtimeFile, candidateFile = runtimeFile] = process.argv.slice(2);
const runtimeUrl = pathToFileURL(runtimeFile).href;
const packages = dirname(dirname(dirname(runtimeFile)));
const load = (name) => import(pathToFileURL(join(packages, name, 'lib', 'index.js')).href);

const hook = registerHooks({
    load(url, context, next) {
        if (url === runtimeUrl)
            return { format: 'module', source: readFileSync(candidateFile), shortCircuit: true };
        return next(url, context);
    },
});
const { AgentLoop } = await import(runtimeUrl);
hook.deregister();
const [
    { Context }, { AgentRegistry }, { SessionStore }, { SessionProjectionRegistry },
    { ToolsService }, { SystemPrompt }, { createUserMessage }, nativeExecutor,
] = await Promise.all([
    'cordis', 'dsh-agent', 'dsh-session', 'dsh-session-projection',
    'dsh-tools', 'dsh-system-prompt', 'dsh-llm', 'dsh-tool-executor-native',
].map(load));

const helper = readFileSync(new URL('../../qqbot-patches/model-failover-helper.js', import.meta.url), 'utf8');
const setup = new Function('process', `${helper}\nreturn setupModelFailover;`)({
    env: { QQBOT_MODEL_FAILOVER: 'on', QQBOT_FAILOVER_PROBE_COOLDOWN_MS: '0' },
});
const primary = { provider: 'our-free-model', model: 'combo:recommended-free', reasoningEffort: 'high' };
const fallback = { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' };
const calls = [], probes = [], events = [], warnings = [];
let primaryDown = true;
let backupDown = false;
const ctx = new Context();
const managed = new Set();
const llm = {
    async prepareCall(config) {
        return {
            config,
            adapterDefaults: {},
            async *stream(request) {
                calls.push(request);
                if (request.provider === primary.provider && primaryDown) {
                    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'fixture disconnect' } } };
                }
                else if (request.provider === fallback.provider && backupDown) {
                    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'fixture backup unavailable' } } };
                }
                else {
                    yield { type: 'block-start', index: 0, blockType: 'text' };
                    yield { type: 'text-delta', index: 0, text: 'fixture reply' };
                    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fixture reply' } };
                    yield { type: 'finish', reason: { kind: 'stop' } };
                }
            },
        };
    },
    async *stream(options) {
        probes.push(options);
        yield { type: 'finish', reason: { kind: 'stop' } };
    },
};
ctx.provide('llm', llm);
ctx.plugin(SessionProjectionRegistry);
ctx.plugin(SessionStore);
ctx.plugin(SystemPrompt);
ctx.plugin(ToolsService);
ctx.plugin(nativeExecutor);
ctx.plugin(AgentRegistry);
ctx.plugin(AgentLoop);
ctx.on('session/event', (_session, event) => events.push(event));
const health = setup(ctx, { findByAgent: (agent) => managed.has(agent) }, { warn: (line) => warnings.push(line) });

await new Promise(setImmediate);
let handle;
try {
    handle = await ctx.agents.create({
        sessionId: 'fixture-model-failover',
        agentOptions: { ...primary, maxTokens: 32768 },
    });
    const { agent } = handle;
    managed.add(agent);
    const first = createUserMessage({ content: [{ type: 'text', text: 'first user message' }], source: { kind: 'user' } });
    agent.followup(first);
    await agent.whenIdle();

    assert.deepEqual(calls.map(({ provider, model, reasoningEffort }) => ({ provider, model, reasoningEffort })), [primary, fallback],
        JSON.stringify(events.findLast((event) => event.type === 'turn/end')?.data.reason));
    assert.deepEqual(calls.map(({ maxTokens }) => maxTokens), [32768, 8192]);
    assert.equal(events.filter((event) => event.type === 'turn/start').length, 1);
    assert.equal(events.filter((event) => event.type === 'user/message' && event.data.id === first.id).length, 1);
    const [reply] = events.filter((event) => event.type === 'assistant/message');
    assert.ok(reply, JSON.stringify(events.findLast((event) => event.type === 'turn/end')?.data.reason));
    assert.equal(reply.data.turn, 1);
    assert.equal(reply.data.message.source.provider, fallback.provider);
    assert.deepEqual(reply.data.message.content, [{ type: 'text', text: 'fixture reply' }]);
    assert.equal(events.findLast((event) => event.type === 'turn/end').data.reason.kind, 'completed');
    assert.deepEqual(agent.model.current(), primary);
    assert.equal(health().preferredRoute, 'fallback');
    assert.match(warnings[0], /TRANSPORT/);
    assert.doesNotMatch(warnings[0], /fixture disconnect/);

    primaryDown = false;
    const followup = (text) => agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
    followup('probe while backup answers');
    await agent.whenIdle();
    assert.equal(calls.at(-1).provider, fallback.provider);
    assert.deepEqual(probes.map(({ messages }) => messages), [[{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]]);
    followup('primary has recovered');
    await agent.whenIdle();
    assert.equal(calls.at(-1).provider, primary.provider);
    assert.equal(calls.at(-1).maxTokens, 32768);

    primaryDown = backupDown = true;
    const count = calls.length;
    followup('both routes fail');
    await agent.whenIdle();
    assert.deepEqual(calls.slice(count).map(({ provider }) => provider), [primary.provider, fallback.provider]);
    const end = events.findLast((event) => event.type === 'turn/end');
    assert.equal(end.data.reason.error.code, 'SERVER');
    assert.equal(events.filter((event) => event.type === 'assistant/message' && event.data.turn === end.data.turn).length, 0);
    assert.deepEqual(agent.model.current(), primary);
    console.log('DSH failover replay passed: same-turn backup reply, single user input, recovery, and bounded dual failure.');
}
finally {
    await handle?.dispose();
}

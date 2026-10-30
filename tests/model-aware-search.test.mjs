#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const source = readFileSync(new URL('qqbot-patches/model-aware-search-helper.js', root), 'utf8');
const { createModelAwareSearch, resolveModelAwareSearchRoute } = new Function(`${source}\nreturn {createModelAwareSearch, resolveModelAwareSearchRoute};`)();
class WebError extends Error { constructor(message, code) { super(message); this.name = 'WebError'; this.code = code; } }
const payload = () => ({ status: 'completed', output: [
  { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [
    { type: 'url', url: 'https://example.com/a', title: 'Source A' },
    { type: 'url', url: 'https://example.com/b', title: 'Source B' },
    { url: 'javascript:alert(1)' }, { url: 'https://user:password@example.com/secret' },
  ] } },
  { type: 'message', content: [{ type: 'output_text', text: 'Verified finding. citeturn0search0', annotations: [
    { type: 'url_citation', url: 'https://example.com/a', title: 'Source A' },
  ] }] },
] });
function harness(overrides = {}) {
  const calls = [], logs = [], credentialRefs = [];
  let route = { provider: 'openai', model: 'gpt-6.1-sol' };
  class DeepSeekSearchApiProvider {
    constructor(resolve) { this.options = resolve(); }
    available() { return true; }
    async search(request, signal) {
      calls.push({ backend: 'deepseek', request, signal, options: this.options });
      await this.options.resolveApiKey();
      return { sources: [{ url: 'https://deepseek.example/result' }], truncated: false };
    }
  }
  const deps = {
    WebError, DeepSeekSearchApiProvider,
    resolveRoute: () => route,
    resolveSettings: () => ({}),
    resolveCredential: async ref => { credentialRefs.push(ref); return 'test-key'; },
    fetch: async (url, options) => {
      calls.push({ backend: 'openai', url, options, body: JSON.parse(options.body) });
      return { ok: true, json: async () => payload() };
    },
    log: s => logs.push(s),
    ...overrides,
  };
  return { provider: createModelAwareSearch(deps), calls, logs, credentialRefs, setRoute: r => { route = r; } };
}

test('OpenAI -> 官方Responses原生web_search，携带真实模型和来源引用，不发送群历史', async () => {
  const h = harness(); const r = await h.provider.search({ query: 'test query', maxResults: 1 });
  const call = h.calls[0];
  assert.equal(call.url, 'https://api.openai.com/v1/responses');
  assert.equal(call.body.model, 'gpt-6.1-sol');
  assert.deepEqual(call.body.tools, [{ type: 'web_search', search_context_size: 'low' }]);
  assert.equal(call.body.tool_choice, 'required');
  assert.equal(call.body.store, false);
  assert.equal(call.body.input, 'test query');
  assert.equal(call.body.messages, undefined);
  assert.deepEqual(h.credentialRefs, ['OPENAI_API_KEY']);
  assert.deepEqual(r.sources, [{ url: 'https://example.com/a', title: 'Source A' }]);
  assert.equal(r.truncated, true);
  assert.ok(!r.content.includes('cite'));
  assert.ok(!JSON.stringify(h.logs).includes('test-key'));
});

test('切回DeepSeek及AMD/OpenCode/免费路由后自动恢复DeepSeek搜索；可再次切回OpenAI', async () => {
  const h = harness();
  for (const provider of ['deepseek', 'deepseek-official', 'opencode-go', 'amd-radeon', 'our-free-model']) {
    h.setRoute({ provider, model: 'deepseek-v4.1-flash' });
    await h.provider.search({ query: 'query', maxResults: 3 });
    const call = h.calls.at(-1);
    assert.equal(call.backend, 'deepseek');
    assert.equal(call.request.maxResults, 3);
    assert.equal(call.options.baseURL, 'https://api.deepseek.com/v1/tools');
  }
  assert.ok(h.credentialRefs.every(ref => ref === 'DEEPSEEK_API_KEY'));
  h.setRoute({ provider: 'openai', model: 'gpt-5.6-terra' });
  await h.provider.search({ query: 'query' });
  assert.equal(h.calls.at(-1).body.model, 'gpt-5.6-terra');
});

test('实际request/context优先于会话偏好和全局默认，包含模型兜底后的路由', () => {
  const services = { agents: { currentInitiator: () => ({
    session: { requestContext: () => ({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }) },
    options: { provider: 'openai', model: 'gpt-6.1-sol' },
  }) }, agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-v4-pro' }) } };
  const ctx = { get: name => services[name] };
  assert.equal(resolveModelAwareSearchRoute(ctx).provider, 'opencode-go');
  services.agents.currentInitiator = () => ({ options: { provider: 'openai', model: 'gpt-6.1-sol' } });
  assert.equal(resolveModelAwareSearchRoute(ctx).provider, 'openai');
  services.agents.currentInitiator = () => undefined;
  assert.equal(resolveModelAwareSearchRoute(ctx).provider, 'deepseek');
});

test('并行群会话不会因全局模型或其它群切换而串线', async () => {
  const local = new AsyncLocalStorage();
  const h = harness({ resolveRoute: () => local.getStore(), resolveCredential: async () => { await new Promise(resolve => setImmediate(resolve)); return 'test-key'; } });
  await Promise.all([
    local.run({ provider: 'openai', model: 'gpt-6.1-sol' }, () => h.provider.search({ query: 'OpenAI query' })),
    local.run({ provider: 'deepseek', model: 'deepseek-v4-pro' }, () => h.provider.search({ query: 'DeepSeek query' })),
    local.run({ provider: 'openai', model: 'gpt-5.6-luna' }, () => h.provider.search({ query: 'Other OpenAI query' })),
  ]);
  assert.equal(h.calls.filter(c => c.backend === 'deepseek').length, 1);
  assert.deepEqual(h.calls.filter(c => c.backend === 'openai').map(c => c.body.model).sort(), ['gpt-5.6-luna', 'gpt-6.1-sol']);
});

test('鉴权/限流/服务故障明确失败，不暗中回退DeepSeek，不泄露密钥或响应原文', async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    const h = harness({ fetch: async () => { calls++; return { ok: false, status, body: { cancel: async () => {} }, headers: { get: () => 'req_123' } }; } });
    await assert.rejects(h.provider.search({ query: 'query' }), error => error instanceof WebError && error.message.includes(`HTTP ${status}`) && !error.message.includes('test-key'));
    assert.equal(calls, 1); assert.equal(h.calls.length, 0);
  }
  const missing = harness({ resolveCredential: async () => undefined });
  await assert.rejects(missing.provider.search({ query: 'query' }), e => e.code === 'WEB_PROVIDER_CREDENTIAL_MISSING');
  assert.equal(missing.calls.length, 0);
});

test('取消请求在网络前/网络中正确传播，未知代理端点不得收到OpenAI密钥', async () => {
  const abort = new AbortController(); abort.abort();
  const h = harness();
  await assert.rejects(h.provider.search({ query: 'query' }, abort.signal), e => e.code === 'WEB_ABORTED');
  assert.equal(h.calls.length, 0);
  const live = new AbortController();
  const during = harness({ fetch: async (_url, options) => {
    live.abort(); assert.equal(options.signal.aborted, true); throw new Error('secret internal error');
  } });
  await assert.rejects(during.provider.search({ query: 'query' }, live.signal), e => e.code === 'WEB_ABORTED');
  const proxy = harness({ resolveSettings: () => ({ providers: { openai: { baseURL: 'https://untrusted.example/v1' } } }) });
  await assert.rejects(proxy.provider.search({ query: 'query' }), e => e.code === 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE');
  assert.equal(proxy.calls.length, 0); assert.equal(proxy.credentialRefs.length, 0);
});

test('保留DeepSeek配置、账号凭据与取消信号，不读取OpenAI凭据', async () => {
  const h = harness({ resolveSettings: ns => ns === 'web-deepseek-api' ? { baseURL: 'https://api.deepseek.com/v1/tools', apiKeyEnv: 'CUSTOM_DEEPSEEK_KEY', count: 5 } : {} });
  h.setRoute({ provider: 'deepseek-account', model: 'deepseek-v4-flash' });
  const controller = new AbortController();
  await h.provider.search({ query: 'query' }, controller.signal);
  assert.equal(h.calls[0].signal, controller.signal);
  assert.equal(h.calls[0].options.count, 5);
  assert.deepEqual(h.credentialRefs, ['CUSTOM_DEEPSEEK_KEY']);
  assert.equal(typeof h.calls[0].options.resolveAccountToken, 'function');
});

test('不把未执行搜索/缺失来源/未完成输出伪装为联网成功', async () => {
  for (const invalid of [
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'I know the answer' }] }] },
    { status: 'incomplete', output: [] },
    { status: 'completed', output: [{ type: 'web_search_call', status: 'completed' }, { type: 'message', content: [{ type: 'output_text', text: 'Unverified answer' }] }] },
  ]) {
    const h = harness({ fetch: async () => ({ ok: true, json: async () => invalid }) });
    await assert.rejects(h.provider.search({ query: 'query' }), e => e.code === 'WEB_PROVIDER_ERROR');
  }
});

test('定向部署可重复执行，不覆盖模型/搜索配置或无关补丁', () => {
  const temp = mkdtempSync(join(tmpdir(), 'qqbot-auto-search-'));
  const dir = join(temp, 'node_modules/@tencent-connect/dsh-qqbot/dist/gateway');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, 'bootstrap.js');
  const index = join(dir, '..', 'index.js');
  writeFileSync(index, "export const inject = ['agents'];\n");
  writeFileSync(target, 'export async function bootstrapGateway(ctx, agents, config, logger) {\n    const manager = new SessionManager(ctx, agents, config, logger);\n}\n');
  const args = [new URL('patch-qqbot.mjs', root).pathname, '--only=model-aware-search-inject,model-aware-search-helper,model-aware-fetch-helper,model-aware-search'];
  const run = () => spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, QQBOT_PROFILE_DIR: temp } });
  const first = run(); assert.equal(first.status, 0, first.stderr);
  const once = readFileSync(target, 'utf8');
  const second = run(); assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(target, 'utf8'), once);
  assert.ok(readFileSync(index, 'utf8').includes("export const inject = ['agents', 'web', 'tools', 'systemPrompt'];"));
  assert.equal(existsSync(join(temp, 'cordis.patch.yml')), false);
  assert.equal(existsSync(join(temp, 'qqbot-groups.json')), false);
});

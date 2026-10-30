import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
const root = new URL('../', import.meta.url);
const code = ['model-aware-search-helper.js', 'model-aware-fetch-helper.js'].map(file => readFileSync(new URL(`qqbot-patches/${file}`, root), 'utf8')).join('\n');
const { createModelAwareFetch } = new Function(`${code}\nreturn {createModelAwareFetch};`)();
class WebError extends Error { constructor(message, code) { super(message); this.name = 'WebError'; this.code = code; } }
const target = 'https://example.com/article?edition=1';
const page = (url = target) => ({ status: 'completed', output: [
  { type: 'web_search_call', status: 'completed', action: { type: 'open_page', url } },
  { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ readable: true, source_url: url, content: 'Actual extracted article facts. [Source](' + url + ')' }) }] },
] });
function harness(overrides = {}) {
  let route = { provider: 'openai', model: 'gpt-5.6-terra' };
  const calls = [], refs = [], logs = [];
  class DeepSeekFetchApiProvider {
    constructor(resolve) { calls.push({ backend: 'deepseek-constructor' }); this.options = resolve(); }
    async fetch(request, signal) {
      calls.push({ backend: 'deepseek', request, signal, options: this.options });
      await this.options.resolveApiKey();
      return { url: request.url, statusCode: 200, body: { kind: 'text', content: 'DeepSeek extracted body' }, truncated: false };
    }
  }
  const deps = {
    WebError, DeepSeekFetchApiProvider, resolveRoute: () => route,
    resolveSettings: () => ({}), resolveCredential: async ref => { refs.push(ref); return 'private-test-key'; },
    fetch: async (url, options) => { calls.push({ backend: 'openai', url, options, body: JSON.parse(options.body) }); return { ok: true, json: async () => page() }; },
    log: text => logs.push(text), ...overrides,
  };
  return { ...createModelAwareFetch(deps), calls, refs, logs, setRoute: value => { route = value; } };
}

test('全部七个OpenAI候选模型的网页读取都不构造DeepSeek后端/读取其凭据', async () => {
  for (const model of ['gpt-6.1-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.3-codex', 'gpt-5.4-mini', 'gpt-4.1']) {
    const h = harness(); h.setRoute({ provider: 'openai', model });
    const result = await h.tool.execute({ url: target }, {});
    assert.equal(result.accessed, true); assert.equal(result.backend, 'openai-native');
    assert.equal(result.isFullText, false); assert.equal(result.statusCode, undefined);
    assert.deepEqual(h.refs, ['OPENAI_API_KEY']); assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].body.model, 'gpt-5.6-terra');
    assert.deepEqual(h.calls[0].body.reasoning, { effort: 'low' });
    assert.equal(h.calls[0].body.tools[0].type, 'web_search');
    assert.equal(h.calls[0].body.tools[0].external_web_access, true);
    assert.deepEqual(JSON.parse(h.calls[0].body.input), { url: target });
    assert.equal(h.calls[0].body.store, false);
    const rendered = h.tool.output.render({}, result)[0].text;
    assert.ok(rendered.includes('unknown')); assert.ok(rendered.includes('untrusted data'));
    assert.ok(!rendered.includes('HTTP 200')); assert.ok(!JSON.stringify(h.logs).includes('private-test-key'));
  }
});

test('没有精确open_page证据时，不把搜索摘要、引用、其它页面或重定向猜测冒充原文', async () => {
  const variants = [
    { status: 'completed', output: [{ type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ url: target }] } }, page().output[1]] },
    page('https://example.com/different'), page('https://other.example/article'), page(null),
    { status: 'completed', output: [{ ...page().output[0], status: 'failed' }, page().output[1]] },
  ];
  for (const variant of variants) {
    const h = harness({ fetch: async () => ({ ok: true, json: async () => variant }) });
    const result = await h.read({ url: target });
    assert.equal(result.accessed, false); assert.equal(result.statusCode, undefined);
    assert.ok(!result.content.includes('Actual extracted article facts'));
    assert.equal(h.calls.length, 0); assert.deepEqual(h.refs, ['OPENAI_API_KEY']);
  }
});

test('open_page完成不等于正文可读；拒绝未读声明、空内容、错误归属、无效JSON和未完成响应', async () => {
  for (const extraction of [
    { readable: false, source_url: target, content: 'Blocked' },
    { readable: true, source_url: target, content: '' },
    { readable: true, source_url: 'https://example.com/wrong', content: 'wrong article' },
    'Not JSON: cannot read',
  ]) {
    const payload = page(); payload.output[1].content[0].text = typeof extraction === 'string' ? extraction : JSON.stringify(extraction);
    const h = harness({ fetch: async () => ({ ok: true, json: async () => payload }) });
    assert.equal((await h.read({ url: target })).accessed, false);
  }
  const incomplete = harness({ fetch: async () => ({ ok: true, json: async () => ({ status: 'incomplete', output: [] }) }) });
  await assert.rejects(incomplete.read({ url: target }), e => e.code === 'WEB_PROVIDER_ERROR');
});

test('切回DeepSeek/AMD/OpenCode后恢复DeepSeekFetch并保留真实状态/凭据/取消信号', async () => {
  for (const provider of ['deepseek', 'deepseek-account', 'opencode-go', 'amd-radeon', 'our-free-model']) {
    const h = harness(); h.setRoute({ provider, model: 'deepseek-v4.1-flash' });
    const controller = new AbortController();
    const result = await h.tool.execute({ url: target }, { signal: controller.signal });
    assert.equal(result.backend, 'deepseek-fetch-api'); assert.equal(result.statusCode, 200);
    assert.equal(h.calls[1].signal, controller.signal); assert.deepEqual(h.refs, ['DEEPSEEK_API_KEY']);
    assert.equal(h.calls[1].options.baseURL, 'https://api.deepseek.com/v1/tools');
    if (provider === 'deepseek-account') assert.equal(typeof h.calls[1].options.resolveAccountToken, 'function');
    const canonical = await h.service.fetch({ url: target }); assert.equal(canonical.body.content, 'DeepSeek extracted body');
  }
});

test('公共ctx.web.fetch残留入口在OpenAI下也禁止DeepSeek回退', async () => {
  const h = harness();
  await assert.rejects(h.service.fetch({ url: target }), e => e.code === 'WEB_NATIVE_READ_REQUIRED');
  assert.equal(h.calls.length, 0); assert.deepEqual(h.refs, []);
});

test('鉴权、限流、服务/网络/不支持原生工具都不跨厂商兜底', async () => {
  for (const status of [400, 401, 403, 429, 500]) {
    const h = harness({ fetch: async () => ({ ok: false, status, headers: { get: () => 'req_test' }, body: { cancel: async () => {} } }) });
    await assert.rejects(h.read({ url: target }), e => e instanceof WebError && e.message.includes(`HTTP ${status}`));
    assert.equal(h.calls.length, 0); assert.deepEqual(h.refs, ['OPENAI_API_KEY']);
  }
  const h = harness({ fetch: async () => { throw new Error('private-test-key in transport'); } });
  await assert.rejects(h.read({ url: target }), e => e.code === 'WEB_PROVIDER_ERROR' && !e.message.includes('private-test-key'));
  assert.equal(h.calls.length, 0);
});

test('拒绝私有地址/含密码链接/非网页协议，校验前不读取任何凭据或发起请求', async () => {
  for (const url of ['file:///etc/passwd', 'http://localhost/a', 'http://127.0.0.1/', 'http://10.0.0.1/', 'http://[::1]/', 'http://2130706433/', 'http://intranet.local/', 'http://test.internal/', 'https://user:pass@example.com/', 'https://example.com:7792/', 'not a URL']) {
    const h = harness(); await assert.rejects(h.read({ url }), e => e.code === 'WEB_URL_BLOCKED');
    assert.equal(h.calls.length, 0); assert.deepEqual(h.refs, []);
  }
});

test('并发会话和GPT4读取执行模型不改写其它群或全局模型', async () => {
  const local = new AsyncLocalStorage();
  const h = harness({ resolveRoute: () => local.getStore() });
  const a = { provider: 'openai', model: 'gpt-4.1' }, b = { provider: 'deepseek', model: 'deepseek-v4-pro' };
  const results = await Promise.all([
    local.run(a, () => h.read({ url: target })), local.run(b, () => h.read({ url: target })),
  ]);
  assert.deepEqual(results.map(r => r.backend), ['openai-native', 'deepseek-fetch-api']);
  assert.equal(a.model, 'gpt-4.1'); assert.equal(b.provider, 'deepseek');
});

test('工具取消信号传播，已取消时不联网', async () => {
  const controller = new AbortController(); controller.abort();
  const h = harness(); await assert.rejects(h.tool.execute({ url: target }, { signal: controller.signal }), e => e.code === 'WEB_ABORTED');
  assert.equal(h.calls.length, 0);
  const active = new AbortController();
  const during = harness({ fetch: async (_url, options) => { active.abort(); assert.equal(options.signal.aborted, true); throw new Error('aborted'); } });
  await assert.rejects(during.tool.execute({ url: target }, { signal: active.signal }), e => e.code === 'WEB_ABORTED');
});

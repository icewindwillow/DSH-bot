#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const source = readFileSync(new URL('qqbot-patches/model-aware-search-helper.js', root), 'utf8');
const { createModelAwareSearch } = new Function(`${source}\nreturn {createModelAwareSearch};`)();
class WebError extends Error { constructor(message, code) { super(message); this.name = 'WebError'; this.code = code; } }
const payload = () => ({ status: 'completed', output: [
  { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [
    { type: 'url', url: 'https://example.com/a', title: 'Source A' },
    { type: 'url', url: 'https://example.com/b', title: 'Source B' },
  ] } },
  { type: 'message', content: [{ type: 'output_text', text: 'Verified finding.', annotations: [] }] },
] });

function harness({ searchError, fallbackResponse } = {}) {
  const calls = [], logs = [];
  class DeepSeekSearchApiProvider {
    available() { return true; }
    async search(request) {
      calls.push({ backend: 'deepseek', request });
      if (searchError) throw searchError;
      return { sources: [{ url: 'https://deepseek.example/result' }], truncated: false };
    }
  }
  const deps = {
    WebError, DeepSeekSearchApiProvider,
    resolveRoute: () => ({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }),
    resolveSettings: () => ({}),
    resolveCredential: async () => 'test-key',
    fetch: async (url, options) => {
      calls.push({ backend: 'openai', url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => (fallbackResponse ?? payload()) };
    },
    log: s => logs.push(s),
  };
  return { provider: createModelAwareSearch(deps), calls, logs };
}

const withEnv = (vars, fn) => async () => {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};

const insufficient = () => new WebError('DeepSeek API error (HTTP 402): Insufficient Balance (request_id: abc)', 'WEB_PROVIDER_ERROR');

test('DeepSeek 402 余额不足时回退 OpenAI 原生搜索，仍只发送本次 query', withEnv({ QQBOT_WEB_SEARCH_FALLBACK: undefined, QQBOT_WEB_SEARCH_FALLBACK_MODEL: undefined }, async () => {
  const h = harness({ searchError: insufficient() });
  const r = await h.provider.search({ query: '罗森 近况' });
  assert.equal(h.calls.length, 2);
  const call = h.calls[1];
  assert.equal(call.url, 'https://api.openai.com/v1/responses');
  assert.equal(call.body.model, 'gpt-4o-mini');
  assert.equal(call.body.input, '罗森 近况');
  assert.equal(call.body.messages, undefined);
  assert.deepEqual(r.sources.map(s => s.url), ['https://example.com/a', 'https://example.com/b']);
  assert.ok(h.logs.some(l => l.includes('回退 OpenAI')));
}));

test('可用 QQBOT_WEB_SEARCH_FALLBACK_MODEL 指定回退模型', withEnv({ QQBOT_WEB_SEARCH_FALLBACK_MODEL: 'gpt-4.1-mini' }, async () => {
  const h = harness({ searchError: insufficient() });
  await h.provider.search({ query: 'query' });
  assert.equal(h.calls[1].body.model, 'gpt-4.1-mini');
}));

test('401 鉴权失败同样回退；其余 5xx/网络错误不回退', withEnv({ QQBOT_WEB_SEARCH_FALLBACK: undefined }, async () => {
  const auth = harness({ searchError: new WebError('DeepSeek API error (HTTP 401): invalid api key', 'WEB_PROVIDER_ERROR') });
  await auth.provider.search({ query: 'query' });
  assert.equal(auth.calls[1].backend, 'openai');
  for (const error of [
    new WebError('DeepSeek API error (HTTP 500): upstream error', 'WEB_PROVIDER_ERROR'),
    new WebError('DeepSeek web request failed: fetch failed', 'WEB_PROVIDER_ERROR'),
    new WebError('Web search aborted', 'WEB_ABORTED'),
  ]) {
    const h = harness({ searchError: error });
    await assert.rejects(h.provider.search({ query: 'query' }), e => e.code === error.code);
    assert.equal(h.calls.length, 1, error.message);
  }
}));

test('QQBOT_WEB_SEARCH_FALLBACK=off 时保持原错误，不产生 OpenAI 调用', withEnv({ QQBOT_WEB_SEARCH_FALLBACK: 'off' }, async () => {
  const h = harness({ searchError: insufficient() });
  await assert.rejects(h.provider.search({ query: 'query' }), e => e.code === 'WEB_PROVIDER_ERROR' && /402/.test(e.message));
  assert.equal(h.calls.length, 1);
}));

test('回退也失败时同时报告两条原因，不静默成功', withEnv({ QQBOT_WEB_SEARCH_FALLBACK: undefined }, async () => {
  const h = harness({ searchError: insufficient(), fallbackResponse: { status: 'incomplete', output: [] } });
  await assert.rejects(h.provider.search({ query: 'query' }),
    e => e.code === 'WEB_PROVIDER_ERROR' && /402/.test(e.message) && /回退也失败/.test(e.message));
}));

test('回退路径同样在取消时抛出 WEB_ABORTED', withEnv({ QQBOT_WEB_SEARCH_FALLBACK: undefined }, async () => {
  const controller = new AbortController();
  const h = harness({ searchError: insufficient() });
  const original = h.provider.search;
  controller.abort();
  await assert.rejects(original.call(h.provider, { query: 'query' }, controller.signal), e => e.code === 'WEB_ABORTED');
  assert.equal(h.calls.length, 0);
}));

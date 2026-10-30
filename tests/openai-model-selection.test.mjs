#!/usr/bin/env node
// 离线回归：直接抽取面板实际函数，不启动 HTTP 服务、不读取真实密钥。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../bot-config-panel/server.mjs', import.meta.url), 'utf8');
const constants = source.slice(source.indexOf('const EFFORT_SUPPORT ='), source.indexOf('// ── dsh-our-free-model'));
const functions = source.slice(source.indexOf('function findEntry('), source.indexOf('/** 用 python3'));
const ctx = vm.createContext({});
vm.runInContext(`${constants}\nconst OUR_FREE_PROVIDER = 'our-free-model';
const FREE_EFFORT_SUPPORT = {};
const ourFreeRoute = () => undefined;
${functions}
globalThis.api = { readPatchConfig, writePatchConfig, validateModelEfforts };`, ctx);
const { readPatchConfig, writePatchConfig, validateModelEfforts } = ctx.api;
const models = ['gpt-6.1-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.3-codex', 'gpt-5.4-mini', 'gpt-4.1'];
const fixture = `# 保留注释\n- id: llm-pi-ai\n  config:\n    providers:\n      openai:\n        displayName: OpenAI\n        apiKeyEnv: OPENAI_API_KEY\n        models:\n${models.map(id => `          - id: ${id}`).join('\n')}\n- id: agent-default-model\n  config:\n    provider: our-free-model\n    model: combo:recommended-free\n    reasoningEffort: low\n`;

test('OpenAI provider 和所有 catalog 模型均出现在选择列表', () => {
  const parsed = readPatchConfig(fixture);
  assert.equal(parsed.routes[0].provider, 'openai');
  assert.deepEqual(Array.from(parsed.routes[0].models, m => m.id), models);
  assert.equal(parsed.model.provider, 'our-free-model');
});

test('切换 OpenAI 并回读，保留凭据引用和原始注释', () => {
  const text = writePatchConfig(fixture, {
    provider: 'openai', model: 'gpt-6.1-sol', reasoningEffort: 'high',
    routeReasoning: { provider: 'openai', level: '' },
  });
  const { model } = readPatchConfig(text);
  assert.equal(model.provider, 'openai');
  assert.equal(model.model, 'gpt-6.1-sol');
  assert.equal(model.reasoningEffort, 'high');
  assert.ok(text.startsWith('# 保留注释\n'));
  assert.ok(text.includes('apiKeyEnv: OPENAI_API_KEY'));
});

test('推理档位遵循 OpenAI catalog，不接受不支持的档位', () => {
  for (const model of models) assert.doesNotThrow(() => validateModelEfforts('openai', model, '', ''));
  assert.doesNotThrow(() => validateModelEfforts('openai', 'gpt-6.1-sol', 'max', 'low'));
  assert.throws(() => validateModelEfforts('openai', 'gpt-6.1-sol', 'off', ''), /不支持/);
  assert.throws(() => validateModelEfforts('openai', 'gpt-5.3-codex', 'max', ''), /不支持/);
  assert.throws(() => validateModelEfforts('openai', 'gpt-5.4-mini', '', 'max'), /不支持/);
  assert.throws(() => validateModelEfforts('openai', 'gpt-4.1', 'low', ''), /不支持/);
  assert.throws(() => validateModelEfforts('openai', 'gpt-6.1-sol', '', 'bogus'), /未知/);
});

test('清除路由推理档位不会删除 OpenAI 路由或凭据引用', () => {
  const withEffort = fixture.replace('        apiKeyEnv: OPENAI_API_KEY', '        apiKeyEnv: OPENAI_API_KEY\n        reasoning: high');
  const next = writePatchConfig(withEffort, {
    provider: 'openai', model: 'gpt-4.1', reasoningEffort: '',
    routeReasoning: { provider: 'openai', level: '' },
  });
  assert.equal(readPatchConfig(next).routes[0].reasoning, '');
  assert.equal(readPatchConfig(next).model.reasoningEffort, '');
  assert.ok(next.includes('apiKeyEnv: OPENAI_API_KEY'));
});

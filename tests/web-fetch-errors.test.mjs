#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const load = (path) => readFileSync(new URL(path, root), 'utf8').trimEnd();
const helper = load('qqbot-patches/web-fetch-errors.js');
const guard = load('qqbot-patches/web-fetch-error-guard.js');
// Explicit synthetic contract fixture, not an installed upstream/profile integration.
const original = load('tests/fixtures/outbound-router.mjs');
const anchor = '        if (call === undefined)\n            return;\n        if (event.error === undefined && !this.config.showToolResults)\n            return;';
function patchGuard(source) {
  const start = '/* >>> dsh-qqbot-patch:web-fetch-error-guard >>> */';
  const end = '/* <<< dsh-qqbot-patch:web-fetch-error-guard <<< */';
  if (source.includes(start)) {
    const a = source.indexOf(start);
    return source.slice(0, a) + guard + source.slice(source.indexOf(end, a) + end.length);
  }
  assert.ok(source.includes(anchor), '出站锚点必须存在');
  return source.replace(anchor, guard);
}
const patched = patchGuard(original);
const classCode = patched.slice(patched.indexOf('class OutboundRouter {'), patched.indexOf('export function createOutboundHandler'));
const ctx = vm.createContext({ URL });
vm.runInContext(`${classCode}\n${helper}
globalThis.Router = OutboundRouter; globalThis.classify = recoverableWebFetchFailure;`, ctx);
const errorText = 'Error: DeepSeek API error (HTTP 404): failed to fetch URL (request_id: 00000000-0000-4000-8000-000000000001)\n\nThe web request used endpoint "https://api.deepseek.com/v1/tools/fetch".';
// Synthetic messages cover modern flat isError and legacy nested tool-result formats.
function result(text = errorText, code = 'WEB_PROVIDER_ERROR', legacy = false) {
  const content = [{ type: 'text', text }];
  return { type: 'tool/result', data: {
    message: { role: 'tool', source: { kind: 'tool', callId: 'call1' },
      ...(legacy ? { content: [{ type: 'tool-result', isError: true, content }] } : { isError: true, content }) },
    error: { name: 'WebError', code },
  } };
}
function frozen(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
function harness(scope = 'group', showToolResults = false) {
  const sent = [], warnings = [];
  const record = { agent: {}, replyTarget: { scope } };
  const router = new ctx.Router({ findBySessionId: () => record }, {}, { showToolResults }, { warn: s => warnings.push(s) });
  router.send = (_record, text, tag) => sent.push({ text, tag });
  const route = event => router.route({ header: { id: 'test' } }, event);
  const call = (name = 'web_fetch', id = 'call1') => route({ type: 'tool/call', data: {
    callId: id, name, arguments: '{"url":"https://example.com/article?token=secret"}',
  } });
  return { router, route, call, sent, warnings };
}

test('实际平铺单页404在群里降噪，与showToolResults开关无关；原错误完整保留', () => {
  for (const show of [true, false]) {
    const h = harness('group', show);
    h.call();
    const raw = frozen(result());
    const before = JSON.stringify(raw);
    h.route(raw);
    assert.equal(h.sent.length, 0);
    assert.equal(h.warnings.length, 1);
    assert.match(h.warnings[0], /HTTP 404 host=example.com/);
    assert.match(h.warnings[0], /00000000-0000-4000-8000-000000000001/);
    assert.ok(!h.warnings[0].includes('secret'));
    assert.equal(JSON.stringify(raw), before);
    assert.equal(h.router.toolCalls.size, 0);
  }
});

test('兼容旧版嵌套tool-result，但不混用成功标志和失败文本', () => {
  const h = harness(); h.call(); h.route(result(errorText.replace(/^Error: /, ''), undefined, true));
  assert.equal(h.sent.length, 0);
  const flat = result(); flat.data.message.isError = false;
  assert.equal(ctx.classify({ name: 'web_fetch' }, { error: flat.data.error, raw: flat.data }), undefined);
  const legacy = result(errorText, undefined, true); legacy.data.message.content[0].isError = false;
  assert.equal(ctx.classify({ name: 'web_fetch' }, { error: legacy.data.error, raw: legacy.data }), undefined);
});

test('私聊和其他工具的错误保持原有通知，不扩大过滤范围', () => {
  const privateChat = harness('c2c'); privateChat.call(); privateChat.route(result());
  assert.equal(privateChat.sent.length, 1);
  const other = harness(); other.call('web_search'); other.route(result());
  assert.equal(other.sent.length, 1);
});

test('鉴权/限流/服务故障/传输/未知404不得被单页规则吞掉', () => {
  for (const text of [
    ...[400, 401, 403, 429, 500, 502, 503].map(s => errorText.replace('HTTP 404', `HTTP ${s}`)),
    'DeepSeek API error (HTTP 404): endpoint not found',
    'DeepSeek web request failed: TypeError: fetch failed',
    'fetch timeout', 'missing credential', 'A page mentions: ' + errorText,
  ]) {
    const h = harness(); h.call(); h.route(result(text));
    assert.equal(h.sent.length, 1, text);
    assert.equal(h.warnings.length, 0);
  }
  for (const code of ['WEB_PROVIDER_CREDENTIAL_MISSING', 'WEB_ABORTED', 'TRANSPORT']) {
    const h = harness(); h.call(); h.route(result(errorText, code));
    assert.equal(h.sent.length, 1, code);
  }
});

test('缺失/损坏结果安全回退，成功正文提到404也不会被当成错误', () => {
  const call = { name: 'web_fetch' };
  for (const raw of [undefined, {}, { message: {} }, { message: { role: 'tool', content: 'bad' } }])
    assert.equal(ctx.classify(call, { error: { name: 'WebError', code: 'WEB_PROVIDER_ERROR' }, raw }), undefined);
  const success = result(); delete success.data.error; success.data.message.isError = false;
  assert.equal(ctx.classify(call, { raw: success.data }), undefined);
});

test('失败后可继续换源并发正常回答，没有伪造成功，也不污染后续调用', () => {
  const h = harness(); h.call(); h.route(result());
  h.call('web_fetch', 'next');
  h.route({ type: 'tool/result', data: { message: { role: 'tool', source: { callId: 'next' }, content: [{ type: 'text', text: 'verified content' }] } } });
  h.route({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '根据另一个来源，已核实这条消息。' }] } } });
  assert.deepEqual(h.sent.map(s => s.text), ['根据另一个来源，已核实这条消息。']);
  assert.equal(h.router.toolCalls.size, 0);
  h.call('web_fetch'); h.route(result('DeepSeek API error (HTTP 401): invalid credential'));
  assert.equal(h.sent.length, 2);
});

test('群规则提供有界换源、真实引用及不可核实时的诚实回退', () => {
  const rules = load('qqbot-patches/group-rules-helper.js');
  for (const text of ['最多 2 个不同链接', '不能说失败页面已读过', '替代来源', '不要编造内容', '这不允许读取或泄露本机文件'])
    assert.ok(rules.includes(text), text);
});

test('持久补丁可定向部署且重复应用字节幂等，不创建无关配置', () => {
  const temp = mkdtempSync(join(tmpdir(), 'qqbot-web-fetch-test-'));
  const target = join(temp, 'node_modules/@tencent-connect/dsh-qqbot/dist');
  mkdirSync(join(target, 'transport'), { recursive: true });
  mkdirSync(join(target, 'session'), { recursive: true });
  const outbound = join(target, 'transport/outbound.js');
  const manager = join(target, 'session/session-manager.js');
  writeFileSync(outbound, original);
  writeFileSync(manager, '// fixture\n');
  const run = () => spawnSync(process.execPath, [new URL('patch-qqbot.mjs', root).pathname,
    '--only=web-fetch-errors,web-fetch-error-guard,group-rules-helper'], {
    encoding: 'utf8', env: { ...process.env, QQBOT_PROFILE_DIR: temp },
  });
  const first = run(); assert.equal(first.status, 0, first.stderr);
  const once = readFileSync(outbound, 'utf8');
  const rulesOnce = readFileSync(manager, 'utf8');
  const second = run(); assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(outbound, 'utf8'), once);
  assert.equal(readFileSync(manager, 'utf8'), rulesOnce);
  assert.equal((once.match(/>>> dsh-qqbot-patch:web-fetch-error-guard/g) ?? []).length, 1);
  assert.equal(existsSync(join(temp, 'qqbot-groups.json')), false);
  assert.equal(existsSync(join(temp, 'skills')), false);
});

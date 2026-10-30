import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, realpathSync, readdirSync, existsSync, statSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { IMAGE_GENERATION_DEFAULTS, validateImageGenerationSettings } from '../bot-config-panel/image-generation.mjs';

const source = readFileSync(new URL('../qqbot-patches/image-generation-helper.js', import.meta.url), 'utf8');
const lib = new Function(`${source}\nreturn { setup: setupOpenAiImageTool, read: qqbotImageReadSettings, defaults: QQBOT_IMAGE_DEFAULTS, models: QQBOT_IMAGE_MODELS, explicit: qqbotImageExplicitRequest };`)();
const PNGS = new Map();
function png(size = '1024x1024') {
  if (PNGS.has(size)) return PNGS.get(size);
  const [width, height] = size.split('x').map(Number);
  const chunk = (type, data) => {
    const label = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([label, data])));
    return Buffer.concat([length, label, data, checksum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const output = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc(height * (1 + width * 4)))), chunk('IEND', Buffer.alloc(0))]);
  PNGS.set(size, output); return output;
}
function reply(bytes = png()) { return new Response(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] }), { status: 200 }); }
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function fixture(t, options = {}) {
  const prefix = join(realpathSync(tmpdir()), 'dsh-image-test-');
  const root = mkdtempSync(prefix), profile = join(root, 'private-profile'); mkdirSync(profile, { mode: 0o700 });
  const old = { profile: process.env.QQBOT_PROFILE_DIR, key: process.env.OPENAI_API_KEY, kill: process.env.QQBOT_IMAGE_GENERATION, home: process.env.HOME, fetch: globalThis.fetch, now: Date.now };
  process.env.QQBOT_PROFILE_DIR = profile; process.env.OPENAI_API_KEY = 'synthetic-image-credential'; delete process.env.QQBOT_IMAGE_GENERATION; process.env.HOME = root;
  let settings = { ...IMAGE_GENERATION_DEFAULTS, enabled: true, ...options.settings };
  const save = (next) => { settings = { ...settings, ...next }; writeFileSync(join(profile, 'qqbot-image-generation.json'), JSON.stringify(settings), { mode: 0o600 }); };
  save({});
  const tools = new Map(), events = new Map(), records = [], sent = [], requests = [];
  const manager = { findByAgent: (agent) => records.find((record) => record.agent === agent), findBySessionId: (id) => records.find((record) => record.agent.session.header.id === id) };
  const ctx = { get: (name) => name === 'tools' ? { register: (tool) => tools.set(tool.name, tool) } : undefined,
    on(name, callback) { events.set(name, callback); } };
  let sender = async () => ({ message: { id: 'synthetic-delivery-id' } });
  const bot = { async sendImage(target, payload) {
    assert.equal(statSync(payload.localPath).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(payload.localPath)).mode & 0o777, 0o700);
    assert.equal(statSync(dirname(dirname(payload.localPath))).mode & 0o777, 0o700);
    sent.push({ target: { ...target }, file: payload.localPath, bytes: readFileSync(payload.localPath) });
    return sender(target, payload);
  } };
  lib.setup(ctx, bot, manager, {}, { info() {} });
  const authorize = globalThis.__qqbotImageGenerationAuthorize;
  let responder = async () => reply();
  globalThis.fetch = async (url, request) => { requests.push({ url, ...request }); return responder(url, request); };
  let sequence = 0;
  function conversation(scope = 'group', id = 'synthetic-group-a') {
    const messages = [];
    const agent = { session: { header: { id: `synthetic-session-${records.length}` }, deriveMessages: () => messages } };
    const record = { scope, peerId: id, agent, replyTarget: undefined };
    records.push(record);
    const state = { record, agent, messages, exec: { agent, signal: new AbortController().signal } };
    state.inbound = (text = '/生图 一只看星星的鲸鱼', rawChanges = {}, messageChanges = {}) => {
      const id = `synthetic-message-${++sequence}`;
      const senderId = scope === 'group' ? 'synthetic-member-a' : record.peerId;
      const raw = { id, content: text, author: scope === 'group' ? { member_openid: senderId } : { user_openid: senderId }, ...(scope === 'group' ? { group_openid: record.peerId } : {}), ...rawChanges };
      const msg = { kind: scope, messageId: id, senderId, content: text, ...(scope === 'group' ? { groupOpenid: record.peerId } : {}), raw, ...messageChanges };
      const user = { id: `synthetic-user-${sequence}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic-assembled-history-not-forwarded' }] };
      record.replyTarget = { scope, targetId: record.peerId, msgId: id };
      messages.push(user); authorize(record, msg, user); return { msg, user };
    };
    state.inbound(); return state;
  }
  const primary = conversation();
  const run = (args = { prompt: '一只看星星的鲸鱼' }, context = primary.exec) => tools.get('generate_image').execute(args, context);
  t.after(() => {
    events.get('dispose')?.(); globalThis.fetch = old.fetch; Date.now = old.now;
    for (const [key, value] of [['QQBOT_PROFILE_DIR', old.profile], ['OPENAI_API_KEY', old.key], ['QQBOT_IMAGE_GENERATION', old.kill], ['HOME', old.home]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    assert.ok(root.startsWith(prefix)); assert.equal(realpathSync(root), root); rmSync(root, { recursive: true, force: true });
  });
  return { root, profile, primary, records, events, manager, sent, requests, tools, run, conversation, save,
    respond: (callback) => { responder = callback; }, sender: (callback) => { sender = callback; } };
}
function noArtifacts(f) { const folder = join(f.profile, 'generated-images'); if (existsSync(folder)) assert.deepEqual(readdirSync(folder), []); }

test('image defaults and all supported settings agree with the panel and public template', (t) => {
  const f = fixture(t);
  assert.deepEqual(lib.defaults, IMAGE_GENERATION_DEFAULTS);
  const template = JSON.parse(readFileSync(new URL('../examples/profile/qqbot-image-generation.json', import.meta.url)));
  assert.deepEqual(template, IMAGE_GENERATION_DEFAULTS);
  for (const model of lib.models) for (const size of ['1024x1024', '1536x1024', '1024x1536']) for (const quality of ['low', 'medium', 'high']) {
    const settings = { ...IMAGE_GENERATION_DEFAULTS, model, size, quality };
    validateImageGenerationSettings(settings); f.save(settings); assert.deepEqual(lib.read(f.profile), settings);
  }
});

test('explicit request recognition is conservative and does not authorize quotes, ordinary chat, negation or configuration questions', () => {
  for (const text of ['/生图 一只鲸鱼', '/image a whale', '<@!synthetic_bot> 帮我画一只猫', '请给我生成一张海报：海边的鲸鱼', 'please draw a whale']) assert.equal(lib.explicit(text), true, text);
  for (const text of ['天气不错', '不要画图', '请勿生图', '「帮我画只猫」是例子', '画图功能如何配置', '如何生图', '', null]) assert.equal(lib.explicit(text), false, String(text));
});

test('one official images request sends one PNG to the bound conversation and cleans private temporary output', async (t) => {
  const f = fixture(t); const output = await f.run();
  assert.equal(output.ok, true); assert.equal(output.status, 'sent'); assert.equal(f.requests.length, 1); assert.equal(f.sent.length, 1);
  const request = f.requests[0]; assert.equal(request.url, 'https://api.openai.com/v1/images/generations'); assert.equal(request.method, 'POST'); assert.equal(request.redirect, 'error');
  assert.equal(request.headers.authorization, 'Bearer synthetic-image-credential');
  assert.deepEqual(JSON.parse(request.body), { model: 'gpt-image-2', prompt: '一只看星星的鲸鱼', n: 1, size: '1024x1024', quality: 'low', output_format: 'png' });
  assert.ok(!request.body.includes('synthetic-assembled-history')); assert.deepEqual(f.sent[0].target, f.primary.record.replyTarget);
  assert.deepEqual(f.sent[0].bytes, png()); assert.equal(existsSync(f.sent[0].file), false); noArtifacts(f);
  assert.ok(!JSON.stringify(output).includes('synthetic-image-credential'));
});

test('c2c works without any OpenAI chat provider; global last-target mutation cannot reroute an image', async (t) => {
  const f = fixture(t), privateChat = f.conversation('c2c', 'synthetic-c2c-member');
  const old = globalThis.__qqbotLastTarget; globalThis.__qqbotLastTarget = { scope: 'group', targetId: 'synthetic-other-group' };
  t.after(() => { if (old === undefined) delete globalThis.__qqbotLastTarget; else globalThis.__qqbotLastTarget = old; });
  assert.equal((await f.run({ prompt: 'a whale' }, privateChat.exec)).status, 'sent');
  assert.equal(f.sent[0].target.scope, 'c2c'); assert.equal(f.sent[0].target.targetId, privateChat.record.peerId);
});

test('disabled, emergency off, missing key and invalid prompt cause zero network requests', async (t) => {
  const f = fixture(t);
  f.save({ enabled: false }); assert.equal((await f.run()).status, 'disabled');
  process.env.QQBOT_IMAGE_GENERATION = 'on'; assert.equal((await f.run()).status, 'disabled');
  f.save({ enabled: true }); process.env.QQBOT_IMAGE_GENERATION = 'off'; assert.equal((await f.run()).status, 'disabled'); delete process.env.QQBOT_IMAGE_GENERATION;
  delete process.env.OPENAI_API_KEY; assert.equal((await f.run()).status, 'missing_key'); process.env.OPENAI_API_KEY = 'synthetic-key';
  for (const args of [{}, { prompt: '' }, { prompt: 'x'.repeat(4001) }, { prompt: 'ok', n: 2 }, { prompt: 'ok', targetId: 'synthetic-other' }, { prompt: 'ok', url: 'https://example.com' }]) assert.equal((await f.run(args)).status, 'invalid_prompt');
  assert.equal(f.requests.length, 0); noArtifacts(f);
});

test('a launchd-started bot can use the DSH credentials file when the panel file is not loaded', async (t) => {
  const f = fixture(t);
  delete process.env.OPENAI_API_KEY;
  mkdirSync(join(f.root, '.dsh'), { recursive: true });
  writeFileSync(join(f.root, '.dsh', '.credentials.yaml'), 'version: 1\nOPENAI_API_KEY: synthetic-file-credential\n', { mode: 0o600 });
  assert.equal((await f.run()).status, 'sent');
  assert.equal(f.requests[0].headers.authorization, 'Bearer synthetic-file-credential');
  assert.ok(!JSON.stringify(f.sent).includes('synthetic-file-credential'));
});

test('missing, stale, injected and mismatched real-message permissions fail closed', async (t) => {
  const f = fixture(t);
  for (const kind of ['no-agent', 'no-grant', 'expired', 'different-peer', 'different-msg', 'compacted-user', 'plugin-user', 'unsupported-scope']) {
    const state = f.conversation('group', `synthetic-group-${kind}`);
    if (kind === 'no-grant') state.record.__qqbotImageGenerationGrant = undefined;
    if (kind === 'expired') state.record.__qqbotImageGenerationGrant.expiresAt = 0;
    if (kind === 'different-peer') state.record.replyTarget.targetId = 'synthetic-mismatch';
    if (kind === 'different-msg') state.record.replyTarget.msgId = 'synthetic-new-msg';
    if (kind === 'compacted-user') state.messages.length = 0;
    if (kind === 'plugin-user') state.messages.push({ role: 'user', id: 'synthetic-injected-user', source: { kind: 'plugin' } });
    if (kind === 'unsupported-scope') state.record.scope = 'dm';
    const context = kind === 'no-agent' ? {} : state.exec;
    assert.equal((await f.run({ prompt: 'a whale' }, context)).status, 'not_authorized', kind);
  }
  assert.equal(f.requests.length, 0);
});

test('authorization only uses matching original QQ raw events, never merged messages, ASR, history or forged sender fields', async (t) => {
  const f = fixture(t);
  for (const [raw, normalized] of [
    [{ content: '普通聊天' }, { content: '普通聊天\n/生图 一只鲸鱼' }],
    [{ id: 'synthetic-wrong-id' }, {}], [{ author: { member_openid: 'synthetic-wrong-member' } }, {}],
    [{ group_openid: 'synthetic-wrong-group' }, {}], [{ content: undefined }, {}], [{ content: '引用里有请求' }, {}],
    [{}, { raw: undefined }], [{ content: '请勿画图' }, {}],
  ]) {
    f.primary.inbound('/生图 一只鲸鱼', raw, normalized);
    assert.equal((await f.run()).status, 'not_authorized');
  }
  assert.equal(f.requests.length, 0);
});

test('a real turn/end revokes an unused grant before a background turn can spend it', async (t) => {
  const f = fixture(t);
  f.events.get('session/event')(f.primary.agent.session, { type: 'turn/end' });
  assert.equal((await f.run()).status, 'not_authorized'); assert.equal(f.requests.length, 0);
});

test('one incoming request cannot generate twice, even when the API rejects or the model retries', async (t) => {
  const f = fixture(t); f.respond(async () => new Response('synthetic-sensitive-error', { status: 500 }));
  assert.equal((await f.run()).status, 'provider_error'); assert.equal((await f.run()).status, 'not_authorized');
  assert.equal(f.requests.length, 1); assert.equal(f.sent.length, 0); noArtifacts(f);
});

test('per-conversation cooldown/hourly attempts and process-wide hard cap apply before network', async (t) => {
  const f = fixture(t, { settings: { cooldownSeconds: 60, maxPerHour: 1 } });
  let now = Date.now(); Date.now = () => now;
  assert.equal((await f.run()).status, 'sent'); f.primary.inbound(); now += 61000;
  assert.equal((await f.run()).status, 'rate_limited');
  for (let i = 0; i < 9; i++) {
    const state = f.conversation('group', `synthetic-budget-${i}`);
    assert.equal((await f.run({ prompt: 'a whale' }, state.exec)).status, 'sent');
  }
  const last = f.conversation('group', 'synthetic-over-budget');
  assert.equal((await f.run({ prompt: 'a whale' }, last.exec)).status, 'rate_limited'); assert.equal(f.requests.length, 10);
});

test('one in-flight request blocks a different group without queueing; abort does not retry', async (t) => {
  const f = fixture(t), started = deferred(), controller = new AbortController(); f.primary.exec.signal = controller.signal;
  f.respond(async (_url, request) => { started.resolve(); return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })); });
  const pending = f.run(); await started.promise;
  const second = f.conversation('group', 'synthetic-concurrent-group'); assert.equal((await f.run({ prompt: 'a whale' }, second.exec)).status, 'busy');
  controller.abort(); assert.equal((await pending).status, 'cancelled'); assert.equal(f.requests.length, 1); assert.equal(f.sent.length, 0); noArtifacts(f);
});

test('timeout is passed to fetch and aborts a charged/uncertain request without a retry', async (t) => {
  const f = fixture(t, { settings: { timeoutSeconds: 30 } }), started = deferred(), deadline = new AbortController();
  const original = AbortSignal.timeout; AbortSignal.timeout = (ms) => { assert.equal(ms, 30000); return deadline.signal; }; t.after(() => { AbortSignal.timeout = original; });
  f.respond(async (_url, request) => { started.resolve(); return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })); });
  const pending = f.run(); await started.promise; deadline.abort(new DOMException('synthetic timeout', 'TimeoutError'));
  assert.equal((await pending).status, 'cancelled'); assert.equal(f.requests.length, 1); assert.equal(f.sent.length, 0);
});

test('401, 403, 429, 400, 404, 5xx and redirect failures are safe and never return server secrets or retry', async (t) => {
  const f = fixture(t);
  for (const [status, expected] of [[401, 'access_denied'], [403, 'access_denied'], [429, 'provider_rate_limited'], [400, 'request_rejected'], [404, 'provider_error'], [503, 'provider_error']]) {
    const state = f.conversation('group', `synthetic-status-${status}`); f.respond(async () => new Response('synthetic-sensitive-provider-error', { status }));
    const output = await f.run({ prompt: 'a whale' }, state.exec); assert.equal(output.status, expected); assert.ok(!JSON.stringify(output).includes('synthetic-sensitive'));
  }
  const state = f.conversation('group', 'synthetic-redirect'); f.respond(async (_url, options) => { assert.equal(options.redirect, 'error'); throw new TypeError('synthetic-sensitive-redirect'); });
  assert.equal((await f.run({ prompt: 'a whale' }, state.exec)).status, 'generation_failed'); assert.equal(f.requests.length, 7); assert.equal(f.sent.length, 0);
});

test('malformed JSON, URL-only results, invalid/base64/non-PNG/wrong-size/error images are rejected, never downloaded', async (t) => {
  const f = fixture(t);
  const invalid = [null, {}, { data: [{ url: 'https://example.com/must-not-fetch.png' }] }, { data: [{ b64_json: 'not-base64' }] },
    { data: [{ b64_json: Buffer.alloc(50).toString('base64') }] }, { data: [{ b64_json: png('1536x1024').toString('base64') }] },
    { data: [{ b64_json: png().toString('base64') }], error: { message: 'synthetic-sensitive' } }, { data: [] }];
  for (let i = 0; i < invalid.length; i++) {
    const state = f.conversation('group', `synthetic-invalid-${i}`); f.respond(async () => new Response(JSON.stringify(invalid[i])));
    assert.equal((await f.run({ prompt: 'a whale' }, state.exec)).status, 'generation_failed');
  }
  const state = f.conversation('group', 'synthetic-invalid-json'); f.respond(async () => new Response('{synthetic-sensitive-invalid-json'));
  assert.equal((await f.run({ prompt: 'a whale' }, state.exec)).status, 'generation_failed'); assert.equal(f.sent.length, 0); noArtifacts(f);
});

test('oversized declared and streamed bodies are bounded and cancelled before disk writes', async (t) => {
  const f = fixture(t); let cancelled = 0;
  f.respond(async () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-length': String(13 * 1024 * 1024) } }));
  assert.equal((await f.run()).status, 'generation_failed');
  const second = f.conversation('group', 'synthetic-large-stream');
  f.respond(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(12 * 1024 * 1024 + 1)); }, cancel() { cancelled++; } })));
  assert.equal((await f.run({ prompt: 'a whale' }, second.exec)).status, 'generation_failed'); assert.equal(cancelled, 2); assert.equal(f.sent.length, 0); noArtifacts(f);
});

test('changed message, removed session and disabled settings after generation prevent delivery to a stale context', async (t) => {
  const f = fixture(t);
  for (const change of ['message', 'session', 'disabled']) {
    const state = f.conversation('group', `synthetic-changed-${change}`); f.save({ enabled: true });
    f.respond(async () => {
      if (change === 'message') state.record.replyTarget.msgId = 'synthetic-newer-message';
      if (change === 'session') f.records.splice(f.records.indexOf(state.record), 1);
      if (change === 'disabled') f.save({ enabled: false });
      return reply();
    });
    assert.equal((await f.run({ prompt: 'a whale' }, state.exec)).status, 'delivery_cancelled');
  }
  assert.equal(f.sent.length, 0); noArtifacts(f);
});

test('QQ send rejection and 2xx business errors never report success and always clean output', async (t) => {
  const f = fixture(t);
  const results = [undefined, {}, { success: false }, { message: { id: 'synthetic-id', success: false } }, { message: { id: 'synthetic-id', code: 500 } }, { message: {} }, { error: 'synthetic-sensitive' }, 'throw'];
  for (let i = 0; i < results.length; i++) {
    const state = f.conversation('group', `synthetic-send-failure-${i}`); f.sender(async () => { if (results[i] === 'throw') throw new Error('synthetic-sensitive-key'); return results[i]; });
    const output = await f.run({ prompt: 'a whale' }, state.exec); assert.equal(output.status, 'delivery_failed'); assert.equal(output.ok, false); assert.ok(!JSON.stringify(output).includes('synthetic-sensitive')); noArtifacts(f);
  }
});

test('configuration and output symlinks fail before paid requests; no external file is modified', async (t) => {
  const f = fixture(t); const external = join(f.root, 'external'); mkdirSync(external); const sentinel = join(external, 'sentinel'); writeFileSync(sentinel, 'synthetic-preserve');
  symlinkSync(external, join(f.profile, 'generated-images'), 'dir');
  assert.equal((await f.run()).status, 'storage_failed'); assert.equal(f.requests.length, 0); assert.equal(readFileSync(sentinel, 'utf8'), 'synthetic-preserve');
  writeFileSync(join(f.profile, 'qqbot-image-generation.json'), '{synthetic-sensitive-invalid');
  const output = await f.run(); assert.equal(output.status, 'configuration_error'); assert.ok(!JSON.stringify(output).includes('synthetic-sensitive')); assert.equal(f.requests.length, 0);
});

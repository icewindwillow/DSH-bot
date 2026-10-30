import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, realpathSync, readdirSync, existsSync, statSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { IMAGE_GENERATION_DEFAULTS, validateImageGenerationSettings } from '../bot-config-panel/image-generation.mjs';

const source = readFileSync(new URL('../qqbot-patches/image-generation-helper.js', import.meta.url), 'utf8');
const lib = new Function(`${source}\nreturn { setup: setupOpenAiImageTool, read: qqbotImageReadSettings, defaults: QQBOT_IMAGE_DEFAULTS, models: QQBOT_IMAGE_MODELS, clean: qqbotImageCleanPrompt };`)();
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
function jpeg(width, height) {
  const comment = Buffer.alloc(32); comment[0] = 0xff; comment[1] = 0xfe; comment.writeUInt16BE(30, 2);
  const sof = Buffer.alloc(19); sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8;
  sof.writeUInt16BE(height, 5); sof.writeUInt16BE(width, 7); sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), comment, sof, Buffer.from([0xff, 0xd9])]);
}
const siliconflow = (url) => new Response(JSON.stringify({ images: [{ url }] }), { status: 200 });
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function fixture(t, options = {}) {
  const prefix = join(realpathSync(tmpdir()), 'dsh-image-test-');
  const root = mkdtempSync(prefix), profile = join(root, 'private-profile'); mkdirSync(profile, { mode: 0o700 });
  const old = {
    profile: process.env.QQBOT_PROFILE_DIR, key: process.env.OPENAI_API_KEY, sfKey: process.env.SILICONFLOW_API_KEY,
    cfToken: process.env.CLOUDFLARE_API_TOKEN, cfAccount: process.env.CLOUDFLARE_ACCOUNT_ID,
    kill: process.env.QQBOT_IMAGE_GENERATION, home: process.env.HOME, fetch: globalThis.fetch, now: Date.now,
  };
  process.env.QQBOT_PROFILE_DIR = profile; process.env.OPENAI_API_KEY = 'synthetic-image-credential';
  process.env.SILICONFLOW_API_KEY = 'synthetic-siliconflow-credential';
  process.env.CLOUDFLARE_API_TOKEN = 'synthetic-cloudflare-token';
  process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
  delete process.env.QQBOT_IMAGE_GENERATION; process.env.HOME = root;
  let settings = { ...IMAGE_GENERATION_DEFAULTS, enabled: true, ...options.settings };
  const save = (next) => { settings = { ...settings, ...next }; writeFileSync(join(profile, 'qqbot-image-generation.json'), JSON.stringify(settings), { mode: 0o600 }); };
  save({});
  // Default fixture sender is the owner; permission-specific tests overwrite these files.
  const writeJson = (name, value) => writeFileSync(join(profile, name), JSON.stringify(value), { mode: 0o600 });
  writeJson('qqbot-command-owners.json', { openids: ['synthetic-member-a', 'synthetic-c2c-member'], names: [] });
  const tools = new Map(), events = new Map(), records = [], sent = [], requests = [];
  const manager = { findByAgent: (agent) => records.find((record) => record.agent === agent), findBySessionId: (id) => records.find((record) => record.agent.session.header.id === id) };
  const llm = options.llm ?? { async *stream() { /* 默认不产出，走“补全失败按原文发送”分支 */ } };
  const ctx = {
    get: (name) => name === 'tools' ? { register: (tool) => tools.set(tool.name, tool) } : name === 'llm' ? llm : undefined,
    on(name, callback) { events.set(name, callback); },
  };
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
    for (const [key, value] of [['QQBOT_PROFILE_DIR', old.profile], ['OPENAI_API_KEY', old.key], ['SILICONFLOW_API_KEY', old.sfKey],
      ['CLOUDFLARE_API_TOKEN', old.cfToken], ['CLOUDFLARE_ACCOUNT_ID', old.cfAccount], ['QQBOT_IMAGE_GENERATION', old.kill], ['HOME', old.home]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    assert.ok(root.startsWith(prefix)); assert.equal(realpathSync(root), root); rmSync(root, { recursive: true, force: true });
  });
  return { root, profile, primary, records, events, manager, sent, requests, tools, run, conversation, save, writeJson,
    respond: (callback) => { responder = callback; }, sender: (callback) => { sender = callback; } };
}
function noArtifacts(f) { const folder = join(f.profile, 'generated-images'); if (existsSync(folder)) assert.deepEqual(readdirSync(folder), []); }

test('image defaults and all supported settings agree with the panel and public template', (t) => {
  const f = fixture(t);
  assert.deepEqual(lib.defaults, IMAGE_GENERATION_DEFAULTS);
  const template = JSON.parse(readFileSync(new URL('../examples/profile/qqbot-image-generation.json', import.meta.url)));
  assert.deepEqual(template, IMAGE_GENERATION_DEFAULTS);
  const sizesFor = (model) => model === 'Kwai-Kolors/Kolors' ? ['1024x1024', '960x1280', '768x1024']
    : model === '@cf/black-forest-labs/flux-1-schnell' ? ['1024x1024'] : ['1024x1024', '1536x1024', '1024x1536'];
  for (const model of lib.models) for (const size of sizesFor(model)) for (const quality of ['low', 'medium', 'high']) {
    const settings = { ...IMAGE_GENERATION_DEFAULTS, model, size, quality };
    validateImageGenerationSettings(settings); f.save(settings); assert.deepEqual(lib.read(f.profile), settings);
  }
});

test('authorized members can ask in plain language; the tool call itself decides, not a slash command', async (t) => {
  const f = fixture(t);
  // 没有 /生图，只有一句大白话：授权照样成立，是否出图交给模型判断。
  f.primary.inbound('画只戴墨镜的柯基在冲浪');
  assert.equal((await f.run()).status, 'sent');
  // 没权限的人说什么都不行。
  f.writeJson('qqbot-command-owners.json', { openids: [], names: [] });
  const stranger = f.conversation('group', 'synthetic-plain-language-stranger');
  assert.equal((await f.run({ prompt: '一只猫' }, stranger.exec)).status, 'forbidden');
  assert.equal(f.requests.length, 1);
});

test('prompt cleaner strips code fences, quotes and prefixes and caps the length', () => {
  assert.equal(lib.clean('```\nprompt: a whale in space\n```'), 'a whale in space');
  assert.equal(lib.clean('“a cat on a roof”'), 'a cat on a roof');
  assert.equal(lib.clean('   '), '');
  assert.equal(lib.clean('x'.repeat(2500)).length, 2000);
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

test('authorization only trusts the original QQ raw event identity, never forged sender fields', async (t) => {
  const f = fixture(t);
  for (const [raw, normalized] of [
    [{ id: 'synthetic-wrong-id' }, {}], [{ author: { member_openid: 'synthetic-wrong-member' } }, {}],
    [{ group_openid: 'synthetic-wrong-group' }, {}], [{ content: undefined }, {}],
    [{}, { raw: undefined }],
  ]) {
    f.primary.inbound('随便说点什么', raw, normalized);
    assert.equal((await f.run()).status, 'not_authorized');
  }
  assert.equal(f.requests.length, 0);
  // 文本本身不再参与授权判定（自然语言放行交给模型），但伪造的原始事件仍然一律拒绝。
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

test('no cooldown or hourly quota: repeated requests in one conversation all reach the provider', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 4; i++) {
    f.primary.inbound();
    assert.equal((await f.run()).status, 'sent', `attempt ${i + 1}`);
  }
  assert.equal(f.requests.length, 4);
  // 仍然是一轮一张：同一轮的第二次调用拿不到授权。
  assert.equal((await f.run()).status, 'not_authorized');
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

test('siliconflow Kolors posts image_size only, downloads the returned https image once and sends it', async (t) => {
  const f = fixture(t, { settings: { model: 'Kwai-Kolors/Kolors', size: '960x1280' } });
  const image = jpeg(960, 1280);
  f.respond(async (url) => String(url).includes('api.siliconflow.cn')
    ? siliconflow('https://cdn.example.com/out.jpg')
    : new Response(image, { status: 200, headers: { 'content-type': 'image/jpeg' } }));
  const output = await f.run();
  assert.equal(output.status, 'sent');
  const [api, download] = f.requests;
  assert.equal(api.url, 'https://api.siliconflow.cn/v1/images/generations');
  assert.equal(api.method, 'POST'); assert.equal(api.redirect, 'error');
  assert.equal(api.headers.authorization, 'Bearer synthetic-siliconflow-credential');
  assert.deepEqual(JSON.parse(api.body), { model: 'Kwai-Kolors/Kolors', prompt: '一只看星星的鲸鱼', image_size: '960x1280' });
  assert.equal(download.url, 'https://cdn.example.com/out.jpg'); assert.equal(download.method, 'GET');
  assert.deepEqual(f.sent[0].bytes, image); assert.ok(f.sent[0].file.endsWith('image.jpg'));
  assert.equal(existsSync(f.sent[0].file), false); noArtifacts(f);
  assert.ok(!JSON.stringify(output).includes('synthetic-siliconflow-credential'));
});

test('siliconflow result URLs must be https, public and real images; nothing is written or sent', async (t) => {
  const cases = [
    ['http://cdn.example.com/a.png', null],
    ['https://127.0.0.1/a.png', null],
    ['https://localhost/a.png', null],
    ['https://10.0.0.8/a.png', null],
    ['https://192.168.1.9/a.png', null],
    ['https://[::1]/a.png', null],
    ['https://cdn.example.com/a.jpg', Buffer.from('synthetic-not-an-image-payload-at-all-0123456789')],
    ['https://cdn.example.com/a.jpg', jpeg(1024, 1024)],
  ];
  for (const [url, bytes] of cases) {
    const f = fixture(t, { settings: { model: 'Kwai-Kolors/Kolors', size: '960x1280' } });
    f.respond(async (target) => String(target).includes('api.siliconflow.cn')
      ? siliconflow(url)
      : new Response(bytes, { status: 200 }));
    const output = await f.run();
    assert.equal(output.ok, false, url);
    assert.equal(f.sent.length, 0, url);
    // Unsafe addresses are rejected before any download attempt; valid ones may be fetched but never sent.
    if (!bytes) assert.equal(f.requests.some((request) => request.url === url), false, url);
    noArtifacts(f);
  }
});

test('siliconflow and OpenAI credentials are not interchangeable', async (t) => {
  const f = fixture(t, { settings: { model: 'Kwai-Kolors/Kolors' } });
  delete process.env.SILICONFLOW_API_KEY;
  assert.equal((await f.run()).status, 'missing_key');
  assert.equal(f.requests.length, 0); noArtifacts(f);
  process.env.SILICONFLOW_API_KEY = 'synthetic-siliconflow-credential';
  f.save({ model: 'gpt-image-2' });
  delete process.env.OPENAI_API_KEY;
  assert.equal((await f.run()).status, 'missing_key');
  assert.equal(f.requests.length, 0); noArtifacts(f);
});

test('cloudflare flux-1-schnell uses the account-scoped endpoint and decodes JSON base64 JPEG', async (t) => {
  const f = fixture(t, { settings: { model: '@cf/black-forest-labs/flux-1-schnell' } });
  const image = jpeg(1024, 1024);
  f.respond(async () => new Response(JSON.stringify({
    result: { image: image.toString('base64') }, success: true, errors: [], messages: [],
  }), { status: 200 }));
  const output = await f.run();
  assert.equal(output.status, 'sent');
  assert.equal(f.requests.length, 1, 'no download for a JSON-wrapped image');
  const request = f.requests[0];
  assert.equal(request.url, 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/black-forest-labs/flux-1-schnell');
  assert.equal(request.method, 'POST'); assert.equal(request.redirect, 'error');
  assert.equal(request.headers.authorization, 'Bearer synthetic-cloudflare-token');
  assert.deepEqual(JSON.parse(request.body), { prompt: '一只看星星的鲸鱼', steps: 4 });
  assert.deepEqual(f.sent[0].bytes, image); assert.ok(f.sent[0].file.endsWith('image.jpg'));
  noArtifacts(f);
});

test('cloudflare requires both a token and a 32-hex account id before any request', async (t) => {
  const f = fixture(t, { settings: { model: '@cf/black-forest-labs/flux-1-schnell' } });
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  assert.equal((await f.run()).status, 'missing_key');
  process.env.CLOUDFLARE_ACCOUNT_ID = 'not-an-account-id';
  assert.equal((await f.run()).status, 'missing_key');
  process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
  delete process.env.CLOUDFLARE_API_TOKEN;
  assert.equal((await f.run()).status, 'missing_key');
  assert.equal(f.requests.length, 0); noArtifacts(f);
});

test('cloudflare prompt ceiling and provider errors are refused without a request', async (t) => {
  const f = fixture(t, { settings: { model: '@cf/black-forest-labs/flux-1-schnell' } });
  const image = jpeg(1024, 1024);
  f.respond(async () => new Response(JSON.stringify({ result: { image: image.toString('base64') }, success: true, errors: [] }), { status: 200 }));
  assert.equal((await f.run({ prompt: '鲸'.repeat(2049) })).status, 'prompt_too_long');
  assert.equal(f.requests.length, 0);
  assert.equal((await f.run({ prompt: '鲸'.repeat(2048) })).status, 'sent');
  f.respond(async () => new Response(JSON.stringify({ result: {}, success: false, errors: [{ code: 5001 }] }), { status: 200 }));
  const second = f.conversation('group', 'synthetic-cf-failure');
  assert.equal((await f.run({ prompt: 'a whale' }, second.exec)).status, 'generation_failed');
  assert.equal(f.sent.length, 1);
  noArtifacts(f);
});

test('permission: owner, role with permissions.image, or affinity at the threshold; everyone else is refused', async (t) => {
  const f = fixture(t);
  // 1) owner (fixture default) passes.
  assert.equal((await f.run()).status, 'sent');

  // 2) no owner match, no person record -> refused with a clear status and zero network.
  f.writeJson('qqbot-command-owners.json', { openids: [], names: [] });
  const stranger = f.conversation('group', 'synthetic-stranger-group');
  const denied = await f.run({ prompt: 'a whale' }, stranger.exec);
  assert.equal(denied.status, 'forbidden');
  assert.ok(denied.message.includes('没有生图权限'));
  assert.equal(f.requests.length, 1, 'a refused request must not reach the provider');

  // 3) role grant: the dedicated image skill's audience contains this sender.
  f.writeJson('qqbot-role-skills.json', {
    imagePermission: { affinityMin: 60, skill: 'image-gen' },
    skills: [{ id: 'image-gen', kind: 'capability', audiences: [{ openids: ['synthetic-member-a'], groups: [], default: true }] }],
  });
  assert.equal((await f.run({ prompt: 'a whale' }, f.conversation('group', 'synthetic-role-group').exec)).status, 'sent');

  // 4) affinity gate: below the threshold is refused, at the threshold passes.
  f.writeJson('qqbot-role-skills.json', { imagePermission: { affinityMin: 60, skill: 'image-gen' }, skills: [] });
  f.writeJson('qqbot-people.json', { people: [{ name: '测试员', openids: ['synthetic-member-a'], social: { affinity: 59.9 } }] });
  assert.equal((await f.run({ prompt: 'a whale' }, f.conversation('group', 'synthetic-affinity-low').exec)).status, 'forbidden');
  f.writeJson('qqbot-people.json', { people: [{ name: '测试员', openids: ['synthetic-member-a'], social: { affinity: 60 } }] });
  assert.equal((await f.run({ prompt: 'a whale' }, f.conversation('group', 'synthetic-affinity-ok').exec)).status, 'sent');

  // 5) only the named image skill grants; other skills with a stray permission field do not.
  f.writeJson('qqbot-people.json', { people: [] });
  f.writeJson('qqbot-role-skills.json', {
    imagePermission: { affinityMin: 100, skill: 'image-gen' },
    skills: [{ id: 'qiangzheyu', permissions: { image: true }, audiences: [{ openids: ['synthetic-member-a'], groups: [], default: true }] }],
  });
  assert.equal((await f.run({ prompt: 'a whale' }, f.conversation('group', 'synthetic-role-off').exec)).status, 'forbidden');
  // ... and the group filter on the real image skill still applies.
  f.writeJson('qqbot-role-skills.json', {
    imagePermission: { affinityMin: 100, skill: 'image-gen' },
    skills: [{ id: 'image-gen', kind: 'capability', audiences: [{ openids: ['synthetic-member-a'], groups: ['synthetic-other-group'], default: true }] }],
  });
  assert.equal((await f.run({ prompt: 'a whale' }, f.conversation('group', 'synthetic-role-wrong-group').exec)).status, 'forbidden');
  // ... and a missing image skill grants nothing.
  f.writeJson('qqbot-role-skills.json', { imagePermission: { affinityMin: 100, skill: 'image-gen' }, skills: [] });
  assert.equal((await f.run({ prompt: 'a whale' }, f.conversation('group', 'synthetic-role-missing').exec)).status, 'forbidden');
  noArtifacts(f);
});

test('cloudflare prompts are understood, completed and rewritten to English before the request', async (t) => {
  const calls = [];
  const f = fixture(t, {
    settings: { model: '@cf/black-forest-labs/flux-1-schnell' },
    llm: {
      async *stream(request) {
        calls.push(request);
        yield { type: 'text-delta', text: '```\nPrompt: a corgi wearing sunglasses surfing a wave, flat illustration, bright colors\n```' };
      },
    },
  });
  const image = jpeg(1024, 1024);
  f.respond(async () => new Response(JSON.stringify({ result: { image: image.toString('base64') }, success: true, errors: [] }), { status: 200 }));
  const output = await f.run({ prompt: '画只戴墨镜的柯基在冲浪' });
  assert.equal(output.status, 'sent');
  assert.equal(calls.length, 1, 'exactly one rewrite call');
  assert.ok(calls[0].system.includes('FLUX'));
  assert.equal(calls[0].messages[0].content[0].text, '画只戴墨镜的柯基在冲浪');
  assert.equal(JSON.parse(f.requests[0].body).prompt, 'a corgi wearing sunglasses surfing a wave, flat illustration, bright colors');
  assert.ok(output.message.includes('英文'));
});

test('a failed rewrite falls back to the original prompt and says so', async (t) => {
  const f = fixture(t, {
    settings: { model: '@cf/black-forest-labs/flux-1-schnell' },
    llm: { async *stream() { throw new Error('synthetic-llm-down'); } },
  });
  const image = jpeg(1024, 1024);
  f.respond(async () => new Response(JSON.stringify({ result: { image: image.toString('base64') }, success: true, errors: [] }), { status: 200 }));
  const output = await f.run({ prompt: '一只猫' });
  assert.equal(output.status, 'sent');
  assert.equal(JSON.parse(f.requests[0].body).prompt, '一只猫');
  assert.ok(output.message.includes('补全失败'));
});

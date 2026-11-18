import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = readFileSync(new URL('../qqbot-patches/tts-tool-helper.js', import.meta.url), 'utf8');
const DEFAULTS = JSON.parse(readFileSync(new URL('../examples/profile/qqbot-tts.json', import.meta.url), 'utf8'));

function setup(t, {
  settings = DEFAULTS,
  env = { SILICONFLOW_API_KEY: 'synthetic-tts-key' },
  target = { scope: 'group', targetId: 'synthetic-group', msgId: 'synthetic-msg', senderId: 'synthetic-owner', kind: 'group', groupOpenid: 'synthetic-group' },
  files = { 'qqbot-command-owners.json': { openids: ['synthetic-owner'], names: [] } },
} = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-tts-tool-'));
  const profile = join(root, 'profile');
  mkdirSync(profile);
  for (const [name, value] of Object.entries(files)) writeFileSync(join(profile, name), JSON.stringify(value));
  const previousEnv = {};
  for (const [name, value] of Object.entries(env)) { previousEnv[name] = process.env[name]; process.env[name] = value; }
  const previous = { profile: process.env.QQBOT_PROFILE_DIR, fetch: globalThis.fetch };
  process.env.QQBOT_PROFILE_DIR = profile;
  const writeSettings = (value) => writeFileSync(join(profile, 'qqbot-tts.json'), JSON.stringify(value));
  if (settings) writeSettings(settings);
  const tools = new Map();
  const sent = [];
  const requests = [];
  const ctx = { get: (name) => (name === 'tools' ? { register: (tool) => tools.set(tool.name, tool) } : undefined) };
  const bot = {
    async sendVoice(_target, payload) {
      assert.equal(statSync(payload.localPath).mode & 0o777, 0o600);
      sent.push(payload.localPath);
    },
  };
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined, auth: init?.headers?.authorization });
    const handler = globalThis.__ttsResponder;
    return handler ? handler(url, init) : new Response(Buffer.from('audio-bytes'), { status: 200 });
  };
  globalThis.__qqbotLastTarget = target;
  new Function(`${source}\nreturn setupTtsTool;`)()(ctx, bot, {}, { info() {} });
  t.after(() => {
    process.env.QQBOT_PROFILE_DIR = previous.profile;
    for (const [name, value] of Object.entries(previousEnv))
      { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    globalThis.fetch = previous.fetch;
    delete globalThis.__qqbotLastTarget;
    delete globalThis.__ttsResponder;
    rmSync(root, { recursive: true, force: true });
  });
  return { tool: tools.get('send_voice'), sent, requests, writeSettings };
}

test('tts tool: falls back to the built-in default chain when the settings file is missing', async (t) => {
  const { tool, sent, requests } = setup(t, { settings: null });
  const result = await tool.execute({ text: '早上好呀。' });
  assert.equal(result.ok, true);
  assert.equal(requests[0].url, 'http://127.0.0.1:7793/tts');
  assert.equal(requests[0].body.voice, 'u2');
  assert.equal(requests[0].body.durationFactor, 0.95);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].endsWith('.wav'));
});

test('tts tool: local failure falls through to the next provider with its own credential', async (t) => {
  const { tool, sent, requests } = setup(t);
  globalThis.__ttsResponder = (url) => (url.includes('7793')
    ? new Response('{"error":"local-down"}', { status: 500 })
    : new Response(Buffer.from('mp3-bytes'), { status: 200 }));
  const result = await tool.execute({ text: '测试降级。' });
  assert.equal(result.ok, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, 'https://api.siliconflow.cn/v1/audio/speech');
  assert.equal(requests[1].auth, 'Bearer synthetic-tts-key');
  assert.equal(requests[1].body.voice, 'FunAudioLLM/CosyVoice2-0.5B:diana');
  assert.ok(sent[0].endsWith('.mp3'));
});

test('tts tool: text over the local limit skips local and goes straight to the cloud provider', async (t) => {
  const settings = structuredClone(DEFAULTS);
  settings.providers[0].maxChars = 10;
  const { tool, requests } = setup(t, { settings });
  await tool.execute({ text: '这句话超过了本地十字符的限制，所以应该直接走云端模型。' });
  assert.equal(requests[0].url, 'https://api.siliconflow.cn/v1/audio/speech');
});

test('tts tool: a custom OpenAI-compatible endpoint is honoured without code changes', async (t) => {
  const settings = structuredClone(DEFAULTS);
  const custom = {
    ...settings.providers[1],
    baseUrl: 'https://synthetic-tts.example.com/v1',
    model: 'synthetic-model',
    voice: 'synthetic-voice',
    credential: 'CUSTOM_TTS_KEY',
    responseFormat: 'wav',
  };
  settings.providers = [custom];
  const { tool, requests, sent } = setup(t, { settings, env: { CUSTOM_TTS_KEY: 'custom-key' } });
  const result = await tool.execute({ text: '自定义接口测试。' });
  assert.equal(result.ok, true);
  assert.equal(requests[0].url, 'https://synthetic-tts.example.com/v1/audio/speech');
  assert.equal(requests[0].auth, 'Bearer custom-key');
  assert.deepEqual(requests[0].body, { model: 'synthetic-model', voice: 'synthetic-voice', input: '自定义接口测试。', response_format: 'wav', speed: 1.1 });
  assert.ok(sent[0].endsWith('.wav'));
});

test('tts tool: panel switches (enabled / maxChars / cooldown) are read on every call', async (t) => {
  const { tool, writeSettings, requests } = setup(t);
  writeSettings({ ...DEFAULTS, enabled: false });
  assert.equal((await tool.execute({ text: '关闭时不应该合成。' })).message, '语音功能已在控制面板关闭。');
  assert.equal(requests.length, 0);
  writeSettings({ ...DEFAULTS, maxChars: 5 });
  const limited = await tool.execute({ text: '这句话超长了。' });
  assert.equal(limited.ok, false);
  assert.match(limited.message, /最多 5 字/);
  writeSettings(DEFAULTS);
  assert.equal((await tool.execute({ text: '第一条。' })).ok, true);
  const second = await tool.execute({ text: '第二条。' });
  assert.equal(second.ok, false);
  assert.match(second.message, /秒内不能连发/);
});

test('tts tool: local voice follows the bot mood; followMood=false keeps the fixed emotion', async (t) => {
  const mood = { snapshot: () => ({ label: '烦躁' }), globalSnapshot: () => ({ label: '兴奋' }) };
  globalThis.__qqbotMood = mood;
  t.after(() => { delete globalThis.__qqbotMood; });

  const lively = setup(t);
  await lively.tool.execute({ text: '快点啦。' });
  assert.equal(lively.requests[0].body.emotion, 'angry');
  assert.equal(lively.requests[0].body.emoAlpha, 0.2);

  mood.snapshot = () => undefined;   // 这个群还没心情记录 → 用全局底色
  const global = setup(t);
  await global.tool.execute({ text: '快点啦。' });
  assert.equal(global.requests[0].body.emotion, 'happy');
  assert.equal(global.requests[0].body.emoAlpha, 0.3);

  const fixedSettings = structuredClone(DEFAULTS);
  fixedSettings.providers[0].followMood = false;
  fixedSettings.providers[0].emotion = 'sad';
  fixedSettings.providers[0].emoAlpha = 0.4;
  const fixed = setup(t, { settings: fixedSettings });
  await fixed.tool.execute({ text: '快点啦。' });
  assert.equal(fixed.requests[0].body.emotion, 'sad');
  assert.equal(fixed.requests[0].body.emoAlpha, 0.4);
});

test('tts tool: only owner / voice-gen audience / affinity threshold may send voice', async (t) => {
  const stranger = { scope: 'group', targetId: 'synthetic-group', msgId: 'synthetic-msg', senderId: 'synthetic-stranger', kind: 'group', groupOpenid: 'synthetic-group' };

  // 不是主人，档案里也查不到：直接拒绝，且不发起任何合成
  const anonymous = setup(t, { target: stranger, files: {} });
  const denied = await anonymous.tool.execute({ text: '你好呀。' });
  assert.equal(denied.ok, false);
  assert.match(denied.message, /没有语音权限/);
  assert.equal(anonymous.requests.length, 0);

  // 有档案但好感度不够
  const low = setup(t, { target: stranger, files: {
    'qqbot-people.json': { people: [{ name: '路人', openids: ['synthetic-stranger'], social: { affinity: 30 } }] },
  } });
  const lowResult = await low.tool.execute({ text: '你好呀。' });
  assert.equal(lowResult.ok, false);
  assert.match(lowResult.message, /好感度 30/);
  assert.equal(low.requests.length, 0);

  // 好感度达到门槛
  const affinity = setup(t, { target: stranger, files: {
    'qqbot-people.json': { people: [{ name: '路人', openids: ['synthetic-stranger'], social: { affinity: 72 } }] },
  } });
  assert.equal((await affinity.tool.execute({ text: '你好呀。' })).ok, true);

  // 好感度不够，但被 voice-gen 技能点名
  const role = setup(t, { target: stranger, files: {
    'qqbot-people.json': { people: [{ name: '路人', openids: ['synthetic-stranger'], social: { affinity: 10 } }] },
    'qqbot-role-skills.json': {
      voicePermission: { skill: 'voice-gen', affinityMin: 60 },
      skills: [{ id: 'voice-gen', kind: 'capability', audiences: [{ openids: ['synthetic-stranger'], groups: [] }] }],
    },
  } });
  assert.equal((await role.tool.execute({ text: '你好呀。' })).ok, true);
});

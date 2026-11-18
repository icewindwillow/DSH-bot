/** Strict, local-only TTS settings. No credentials, network requests or import-time I/O. */
import {
  constants, lstatSync, mkdirSync, openSync, closeSync, fstatSync, readSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readQqbotProfileDocument, withQqbotProfileDocuments } from '../plugins/qqbot-core/profile-documents.js';

/**
 * 语音合成配置：providers 数组顺序就是调用优先级，前一个失败自动用下一个。
 * 想接别家的模型，改 openai-compatible 的 baseUrl / model / voice 即可
 * （凡是实现了 POST /audio/speech 的服务都能这样接）。
 */
export const TTS_DEFAULTS = Object.freeze({
  enabled: true,
  maxChars: 120,
  cooldownSeconds: 60,
  providers: Object.freeze([
    Object.freeze({
      id: 'index-tts-local', enabled: true, followMood: true, url: 'http://127.0.0.1:7793', voice: 'u2',
      emotion: '', emoAlpha: 0.5, durationFactor: 0.95, maxChars: 120, timeoutSeconds: 150,
    }),
    Object.freeze({
      id: 'openai-compatible', enabled: true, baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'FunAudioLLM/CosyVoice2-0.5B', voice: 'FunAudioLLM/CosyVoice2-0.5B:diana',
      credential: 'SILICONFLOW_API_KEY', responseFormat: 'mp3', speed: 1.1, timeoutSeconds: 20,
    }),
    Object.freeze({ id: 'edge', enabled: true, voice: 'zh-CN-XiaoyiNeural' }),
  ]),
});

export const TTS_PROVIDER_FIELDS = Object.freeze({
  'index-tts-local': Object.freeze(['id', 'enabled', 'followMood', 'url', 'voice', 'emotion', 'emoAlpha', 'durationFactor', 'maxChars', 'timeoutSeconds']),
  'openai-compatible': Object.freeze(['id', 'enabled', 'baseUrl', 'model', 'voice', 'credential', 'responseFormat', 'speed', 'timeoutSeconds']),
  'edge': Object.freeze(['id', 'enabled', 'voice']),
});

export const TTS_EMOTIONS = Object.freeze(['', 'happy', 'angry', 'sad', 'afraid', 'disgusted', 'melancholic', 'surprised', 'calm']);
export const TTS_RESPONSE_FORMATS = Object.freeze(['mp3', 'wav', 'opus', 'aac', 'flac']);
export const TTS_PROVIDER_LABELS = Object.freeze({
  'index-tts-local': '本地 IndexTTS（自建服务）',
  'openai-compatible': 'OpenAI 兼容 /audio/speech',
  'edge': 'Edge TTS（免费兜底）',
});

const FIELDS = Object.keys(TTS_DEFAULTS);
const FILE_NAME = 'qqbot-tts.json';
const MAX_FILE_BYTES = 16 * 1024;
const MAX_PROVIDERS = 4;

function fail(message, code = 'ERR_TTS_INVALID', statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  throw error;
}
function safeError(error, action) {
  if (String(error?.code ?? '').startsWith('ERR_TTS_')) return error;
  const result = new Error(action === 'read' ? '无法读取语音配置，请检查本地文件格式和权限' : '无法保存语音配置，请检查本地文件权限');
  result.code = action === 'read' ? 'ERR_TTS_READ' : 'ERR_TTS_WRITE';
  result.statusCode = 500;
  return result;
}
function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exactKeys(value, fields, what) {
  if (!plainObject(value)) fail(`${what}必须是对象`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))
      || fields.some((key) => !Object.hasOwn(value, key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')))
    fail(`${what}字段不完整或含未知字段`);
}
function text(value, what, max) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max || /[\r\n\u0000]/.test(value))
    fail(`${what}必须是不含换行的非空文本（≤${max} 字符）`);
  return value.trim();
}
function number(value, what, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    fail(`${what}必须是 ${min}–${max} 之间的数字`);
  return value;
}
function integer(value, what, min, max) {
  if (!Number.isInteger(value) || value < min || value > max)
    fail(`${what}必须是 ${min}–${max} 之间的整数`);
  return value;
}
function localUrl(value, what) {
  const url = text(value, what, 200);
  let parsed;
  try { parsed = new URL(url); }
  catch { fail(`${what}不是合法 URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost'].includes(parsed.hostname))
    fail(`${what}只允许本机地址（127.0.0.1 或 localhost）`);
  return url.replace(/\/+$/, '');
}
function remoteUrl(value, what) {
  const url = text(value, what, 300);
  let parsed;
  try { parsed = new URL(url); }
  catch { fail(`${what}不是合法 URL`); }
  // 明文 http 只放行本机回环，其余必须是 https，避免把 Key 发到不可信链路。
  if (parsed.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(parsed.hostname))
    fail(`${what}必须使用 https（本机地址除外）`);
  return url.replace(/\/+$/, '');
}
function validateProvider(provider) {
  if (!plainObject(provider)) fail('语音服务项必须是对象');
  const id = provider.id;
  if (typeof id !== 'string' || !Object.hasOwn(TTS_PROVIDER_FIELDS, id))
    fail('未知的语音服务类型');
  exactKeys(provider, TTS_PROVIDER_FIELDS[id], `${TTS_PROVIDER_LABELS[id]} 的`);
  if (typeof provider.enabled !== 'boolean') fail(`${TTS_PROVIDER_LABELS[id]} 启用状态必须为布尔值`);
  if (id === 'index-tts-local') {
    const voice = text(provider.voice, '本地音色名', 40);
    // 音色名会拼成 voices/<name>.wav，只允许普通文件名，不做静默替换。
    if (/[\\/]/.test(voice) || voice.startsWith('.'))
      fail('本地音色名不能包含斜杠或以点开头');
    if (typeof provider.followMood !== 'boolean')
      fail('「情绪跟随心情」必须是布尔值');
    return {
      id,
      enabled: provider.enabled,
      followMood: provider.followMood,
      url: localUrl(provider.url, '本地服务地址'),
      voice,
      emotion: TTS_EMOTIONS.includes(provider.emotion) ? provider.emotion : fail('不支持的情绪'),
      emoAlpha: number(provider.emoAlpha, '情绪强度', 0, 1),
      durationFactor: number(provider.durationFactor, '语速系数', 0.5, 2),
      maxChars: integer(provider.maxChars, '本地长度上限', 1, 500),
      timeoutSeconds: integer(provider.timeoutSeconds, '本地超时', 5, 300),
    };
  }
  if (id === 'openai-compatible') {
    if (!/^[A-Z0-9_]{1,64}$/.test(provider.credential))
      fail('凭据名只能是大写字母、数字和下划线');
    if (!TTS_RESPONSE_FORMATS.includes(provider.responseFormat)) fail('不支持的音频格式');
    return {
      id,
      enabled: provider.enabled,
      baseUrl: remoteUrl(provider.baseUrl, '接口地址'),
      model: text(provider.model, '模型名', 120),
      voice: text(provider.voice, '音色名', 120),
      credential: provider.credential,
      responseFormat: provider.responseFormat,
      speed: number(provider.speed, '语速', 0.25, 4),
      timeoutSeconds: integer(provider.timeoutSeconds, '接口超时', 5, 300),
    };
  }
  return {
    id,
    enabled: provider.enabled,
    voice: text(provider.voice, 'Edge 声线', 60),
  };
}
export function validateTtsSettings(value) {
  exactKeys(value, FIELDS, '语音配置');
  if (typeof value.enabled !== 'boolean') fail('语音启用状态必须为布尔值');
  integer(value.maxChars, '语音长度上限', 1, 500);
  integer(value.cooldownSeconds, '冷却时间', 0, 3600);
  if (!Array.isArray(value.providers) || value.providers.length < 1 || value.providers.length > MAX_PROVIDERS)
    fail(`语音服务项必须是 1–${MAX_PROVIDERS} 个的数组`);
  const providers = value.providers.map(validateProvider);
  const ids = new Set(providers.map((provider) => provider.id));
  if (ids.size !== providers.length) fail('语音服务项不能重复');
  if (!providers.some((provider) => provider.enabled)) fail('至少要启用一个语音服务');
  return {
    enabled: value.enabled,
    maxChars: value.maxChars,
    cooldownSeconds: value.cooldownSeconds,
    providers,
  };
}
function safeStat(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function directory(profileDir, create = false) {
  if (typeof profileDir !== 'string' || !profileDir.trim()) fail('需要明确指定配置目录');
  const dir = resolve(profileDir);
  for (let component = dir; ; component = dirname(component)) {
    const stat = safeStat(component);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      fail('语音配置目录不能包含符号链接或非目录', 'ERR_TTS_UNSAFE');
    if (component === dirname(component)) break;
  }
  if (!safeStat(dir) && create) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return directory(dir);
  }
  return { dir, exists: Boolean(safeStat(dir)) };
}
function checkFile(stat) {
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1))
    fail('语音配置必须是普通文件，不能使用符号链接或硬链接', 'ERR_TTS_UNSAFE');
  if (stat && stat.size > MAX_FILE_BYTES)
    fail('语音配置超过 16 KiB 上限', 'ERR_TTS_TOO_LARGE', 413);
}
function readLegacyTtsSettings(profileDir) {
  let fd;
  try {
    const { dir, exists } = directory(profileDir);
    if (!exists) return structuredClone(TTS_DEFAULTS);
    const path = join(dir, FILE_NAME);
    const before = safeStat(path);
    checkFile(before);
    if (!before) return structuredClone(TTS_DEFAULTS);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    checkFile(stat);
    if (stat.dev !== before.dev || stat.ino !== before.ino)
      fail('语音配置已变化，请重试', 'ERR_TTS_UNSAFE');
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > MAX_FILE_BYTES) fail('语音配置超过 16 KiB 上限', 'ERR_TTS_TOO_LARGE', 413);
    checkFile(fstatSync(fd));
    directory(profileDir);
    const after = safeStat(path);
    checkFile(after);
    if (!after || after.dev !== stat.dev || after.ino !== stat.ino)
      fail('语音配置已变化，请重试', 'ERR_TTS_UNSAFE');
    let parsed;
    try { parsed = JSON.parse(bytes.subarray(0, length).toString('utf8')); }
    catch { fail('语音配置不是合法 JSON'); }
    return validateTtsSettings(parsed);
  } catch (error) { throw safeError(error, 'read'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function readTtsSettings(profileDir) {
  try {
    directory(profileDir);
    return validateTtsSettings(readQqbotProfileDocument(profileDir, 'tts', {
      empty: () => (structuredClone(TTS_DEFAULTS)),
      readLegacy: () => readLegacyTtsSettings(profileDir),
    }));
  } catch (error) { throw safeError(error, 'read'); }
}

export function writeTtsSettings(profileDir, value) {
  try {
    const settings = validateTtsSettings(value);
    const { dir } = directory(profileDir, true);
    checkFile(safeStat(join(dir, FILE_NAME)));
    return withQqbotProfileDocuments(dir, db => db.update('tts', () => settings));
  } catch (error) { throw safeError(error, 'write'); }
}

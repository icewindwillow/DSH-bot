/** Strict, local-only image settings. No credentials, network requests or import-time I/O. */
import {
  constants, lstatSync, mkdirSync, openSync, closeSync, fstatSync, readSync,
  writeFileSync, fchmodSync, fsyncSync, renameSync, unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export const IMAGE_GENERATION_DEFAULTS = Object.freeze({
  enabled: false,
  model: 'gpt-image-2',
  size: '1024x1024',
  quality: 'low',
  cooldownSeconds: 120,
  maxPerHour: 3,
  timeoutSeconds: 180,
});
// The provider is derived from the whitelisted model id, never from a configurable URL.
// Adding a provider here is the only way to change where a paid or free request may go.
export const IMAGE_GENERATION_PROVIDERS = Object.freeze({
  openai: Object.freeze({
    label: 'OpenAI',
    credential: 'OPENAI_API_KEY',
    endpoint: 'https://api.openai.com/v1/images/generations',
    models: Object.freeze(['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-1.5', 'gpt-image-1-mini']),
    sizes: Object.freeze(['1024x1024', '1536x1024', '1024x1536']),
    quality: true,
    billing: 'paid',
  }),
  siliconflow: Object.freeze({
    label: '硅基流动',
    credential: 'SILICONFLOW_API_KEY',
    endpoint: 'https://api.siliconflow.cn/v1/images/generations',
    models: Object.freeze(['Kwai-Kolors/Kolors']),
    sizes: Object.freeze(['1024x1024', '960x1280', '768x1024']),
    quality: false,
    billing: 'free',
  }),
});
export const IMAGE_GENERATION_MODELS = Object.freeze(
  Object.values(IMAGE_GENERATION_PROVIDERS).flatMap((provider) => provider.models),
);
export function imageGenerationProvider(model) {
  for (const [name, provider] of Object.entries(IMAGE_GENERATION_PROVIDERS))
    if (provider.models.includes(model)) return { name, ...provider };
  return undefined;
}
const MODELS = new Set(IMAGE_GENERATION_MODELS);
const QUALITIES = new Set(['low', 'medium', 'high']);
const FIELDS = Object.keys(IMAGE_GENERATION_DEFAULTS);
const FILE_NAME = 'qqbot-image-generation.json';
const MAX_FILE_BYTES = 16 * 1024;

function fail(message, code = 'ERR_IMAGE_GENERATION_INVALID', statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  throw error;
}
function safeError(error, action) {
  if (String(error?.code ?? '').startsWith('ERR_IMAGE_GENERATION_')) return error;
  const result = new Error(action === 'read' ? '无法读取生图配置，请检查本地文件格式和权限' : '无法保存生图配置，请检查本地文件权限');
  result.code = action === 'read' ? 'ERR_IMAGE_GENERATION_READ' : 'ERR_IMAGE_GENERATION_WRITE';
  result.statusCode = 500;
  return result;
}
export function validateImageGenerationSettings(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    fail('生图配置必须是完整对象');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== FIELDS.length || keys.some((key) => !FIELDS.includes(key))
      || FIELDS.some((key) => !Object.hasOwn(value, key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')))
    fail('生图配置必须包含且仅包含规定的完整字段');
  if (typeof value.enabled !== 'boolean') fail('生图启用状态必须为布尔值');
  if (!MODELS.has(value.model)) fail('不支持的生图模型');
  if (!imageGenerationProvider(value.model).sizes.includes(value.size))
    fail(`该模型不支持的图片尺寸；可选 ${imageGenerationProvider(value.model).sizes.join(' / ')}`);
  if (!QUALITIES.has(value.quality)) fail('不支持的图片质量');
  for (const [field, min, max] of [['cooldownSeconds', 60, 3600], ['maxPerHour', 1, 10], ['timeoutSeconds', 30, 300]]) {
    if (!Number.isInteger(value[field]) || value[field] < min || value[field] > max)
      fail('生图频率或超时必须为规定范围内的整数');
  }
  return Object.fromEntries(FIELDS.map((field) => [field, value[field]]));
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
      fail('生图配置目录不能包含符号链接或非目录', 'ERR_IMAGE_GENERATION_UNSAFE');
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
    fail('生图配置必须是普通文件，不能使用符号链接或硬链接', 'ERR_IMAGE_GENERATION_UNSAFE');
  if (stat && stat.size > MAX_FILE_BYTES)
    fail('生图配置超过 16 KiB 上限', 'ERR_IMAGE_GENERATION_TOO_LARGE', 413);
}
export function readImageGenerationSettings(profileDir) {
  let fd;
  try {
    const { dir, exists } = directory(profileDir);
    if (!exists) return { ...IMAGE_GENERATION_DEFAULTS };
    const path = join(dir, FILE_NAME);
    const before = safeStat(path);
    checkFile(before);
    if (!before) return { ...IMAGE_GENERATION_DEFAULTS };
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    checkFile(stat);
    if (stat.dev !== before.dev || stat.ino !== before.ino)
      fail('生图配置已变化，请重试', 'ERR_IMAGE_GENERATION_UNSAFE');
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > MAX_FILE_BYTES) fail('生图配置超过 16 KiB 上限', 'ERR_IMAGE_GENERATION_TOO_LARGE', 413);
    checkFile(fstatSync(fd));
    directory(profileDir);
    const after = safeStat(path);
    checkFile(after);
    if (!after || after.dev !== stat.dev || after.ino !== stat.ino)
      fail('生图配置已变化，请重试', 'ERR_IMAGE_GENERATION_UNSAFE');
    let parsed;
    try { parsed = JSON.parse(bytes.subarray(0, length).toString('utf8')); }
    catch { fail('生图配置不是合法 JSON'); }
    return validateImageGenerationSettings(parsed);
  } catch (error) { throw safeError(error, 'read'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function writeImageGenerationSettings(profileDir, value) {
  let fd;
  let temp;
  let created = false;
  try {
    const settings = validateImageGenerationSettings(value);
    const { dir } = directory(profileDir, true);
    const path = join(dir, FILE_NAME);
    checkFile(safeStat(path));
    temp = join(dir, `.qqbot-image-generation.${randomBytes(16).toString('hex')}.tmp`);
    fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    created = true;
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    directory(profileDir);
    checkFile(safeStat(path));
    renameSync(temp, path);
    created = false;
    return settings;
  } catch (error) { throw safeError(error, 'write'); }
  finally {
    if (fd !== undefined) closeSync(fd);
    // Only the exact exclusive temporary path created in the validated directory is removed.
    if (created && temp && dirname(temp) === resolve(profileDir)) {
      directory(profileDir);
      unlinkSync(temp);
    }
  }
}

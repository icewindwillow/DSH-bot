/** Local-only credential storage. Importing this module performs no I/O.
 * File format: a JSON object of allowlisted environment names to strings.
 * Inherited nonblank environment values always take precedence over this file.
 * This is a private plaintext file, NOT an encrypted vault.
 */
import {
  constants, lstatSync, mkdirSync, openSync, closeSync, fstatSync, readSync,
  writeFileSync, fchmodSync, fsyncSync, renameSync, unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export const CREDENTIAL_KEYS = Object.freeze([
  'OPENAI_API_KEY', 'SILICONFLOW_API_KEY', 'DEEPSEEK_API_KEY', 'XIANGXIN_API_KEY',
  'OPENCODE_GO_API_KEY', 'QQBOT_APPID', 'QQBOT_SECRET',
]);
const ALLOWED = new Set(CREDENTIAL_KEYS);
const FILE_NAME = '.bot-secrets.json';
const MAX_FILE_BYTES = 64 * 1024;
const MAX_VALUE_BYTES = 8 * 1024;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const nonblank = (v) => typeof v === 'string' && v.trim().length > 0;
const record = (o) => o !== null && typeof o === 'object' && !Array.isArray(o)
  && (Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null);

function fail(message, code = 'ERR_CREDENTIALS_INVALID', statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  throw error;
}
function safeStat(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function directory(profileDir, create = false) {
  if (typeof profileDir !== 'string' || !profileDir.trim()) fail('需要明确指定 profile 目录');
  const dir = resolve(profileDir);
  // Reject links in every existing directory component, not just the final filename.
  // Callers using OS aliases such as /tmp on macOS should pass their canonical directory.
  for (let component = dir; ; component = dirname(component)) {
    const existing = safeStat(component);
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
      fail('凭据目录路径不能包含符号链接或非目录', 'ERR_CREDENTIALS_UNSAFE');
    if (component === dirname(component)) break;
  }
  let stat = safeStat(dir);
  if (!stat && create) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    stat = safeStat(dir);
  }
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
    fail('凭据目录不能是符号链接或非目录', 'ERR_CREDENTIALS_UNSAFE');
  return { dir, exists: Boolean(stat) };
}
function checkFile(stat) {
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1))
    fail('凭据文件必须是普通文件，不能使用符号链接或硬链接', 'ERR_CREDENTIALS_UNSAFE');
  if (stat && stat.size > MAX_FILE_BYTES)
    fail('凭据文件超过大小限制', 'ERR_CREDENTIALS_TOO_LARGE', 413);
}
function validateValues(values) {
  if (!record(values)) fail('密钥内容必须是对象');
  for (const key of Object.keys(values)) {
    if (!ALLOWED.has(key)) fail('包含不支持的密钥字段');
    if (typeof values[key] !== 'string') fail('密钥必须是字符串');
    if (Buffer.byteLength(values[key], 'utf8') > MAX_VALUE_BYTES)
      fail('单个密钥超过大小限制', 'ERR_CREDENTIALS_TOO_LARGE', 413);
    if (nonblank(values[key]) && /[\u0000\r\n]/u.test(values[key])) fail('密钥不能包含换行或空字符');
  }
}
function readLocal(profileDir) {
  const { dir, exists } = directory(profileDir);
  if (!exists) return {};
  const path = join(dir, FILE_NAME);
  const before = safeStat(path);
  checkFile(before);
  if (!before) return {};
  let fd;
  let text;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    checkFile(stat);
    if (stat.dev !== before.dev || stat.ino !== before.ino)
      fail('凭据文件已变化，请重试', 'ERR_CREDENTIALS_CHANGED', 409);
    // A bounded descriptor read also prevents a concurrently grown file from exhausting memory.
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const count = readSync(fd, buffer, total, buffer.length - total, null);
      if (!count) break;
      total += count;
    }
    if (total > MAX_FILE_BYTES) fail('凭据文件超过大小限制', 'ERR_CREDENTIALS_TOO_LARGE', 413);
    text = buffer.toString('utf8', 0, total);
  } finally { if (fd !== undefined) closeSync(fd); }
  let values;
  try { values = JSON.parse(text); }
  catch { fail('凭据文件不是有效 JSON；请在本机检查，勿粘贴其内容', 'ERR_CREDENTIALS_INVALID_FILE'); }
  validateValues(values);
  return values;
}
function statusFor(local, env) {
  return { keys: Object.fromEntries(CREDENTIAL_KEYS.map((key) => {
    const source = nonblank(env[key]) ? 'environment' : nonblank(local[key]) ? 'local' : 'missing';
    return [key, { configured: source !== 'missing', source }];
  })) };
}

/** Returns presence/source only. No values, prefixes, or suffixes are exposed. */
export function credentialStatus(profileDir, env = process.env) {
  return statusFor(readLocal(profileDir), env);
}

/** Returns a NEW merged environment; never mutates env or overwrites nonblank inherited values. */
export function loadCredentialEnvironment(profileDir, env = process.env) {
  const local = readLocal(profileDir);
  const merged = { ...env };
  for (const key of CREDENTIAL_KEYS)
    if (!nonblank(merged[key]) && nonblank(local[key])) merged[key] = local[key];
  return merged;
}

/** {values?: {ENV: string}, remove?: string[]} -> the same status-only shape as GET.
 * Blank inputs keep existing local values. remove deletes local only, never inherited env.
 * A nonblank value and remove for the same key is rejected as ambiguous.
 */
export function updateCredentials(profileDir, body, env = process.env) {
  if (!record(body) || Object.keys(body).some((key) => key !== 'values' && key !== 'remove'))
    fail('请求只允许 values 和 remove 字段');
  const values = has(body, 'values') ? body.values : {};
  const remove = has(body, 'remove') ? body.remove : [];
  validateValues(values);
  if (!Array.isArray(remove) || remove.some((key) => typeof key !== 'string' || !ALLOWED.has(key)))
    fail('remove 必须是受支持的密钥名称数组');
  if (remove.length > CREDENTIAL_KEYS.length || new Set(remove).size !== remove.length)
    fail('remove 不能重复或超过密钥数量');
  if (remove.some((key) => nonblank(values[key]))) fail('同一密钥不能同时保存并删除');
  const local = readLocal(profileDir);
  const next = { ...local };
  for (const key of remove) delete next[key];
  for (const key of Object.keys(values)) if (nonblank(values[key])) next[key] = values[key].trim();
  const content = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_FILE_BYTES)
    fail('凭据文件超过大小限制', 'ERR_CREDENTIALS_TOO_LARGE', 413);
  const { dir } = directory(profileDir, true);
  const path = join(dir, FILE_NAME);
  checkFile(safeStat(path));
  // Same-directory exclusive temporary file + rename: readers see old or new JSON, never partial data.
  const temp = join(dir, `.bot-secrets.${randomBytes(16).toString('hex')}.tmp`);
  let fd;
  let created = false;
  try {
    fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    created = true;
    fchmodSync(fd, 0o600);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    directory(profileDir);
    checkFile(safeStat(path));
    renameSync(temp, path);
    created = false;
  } finally {
    if (fd !== undefined) closeSync(fd);
    // temp is an explicitly constructed path in the already validated profile directory.
    if (created) unlinkSync(temp);
  }
  return statusFor(next, env);
}

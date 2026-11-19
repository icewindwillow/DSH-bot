#!/usr/bin/env node
/**
 * 小易机器人配置面板 —— 零依赖 HTTP 服务
 *
 * 一个页面管几件事：
 *   1. 用哪个模型（agent-default-model.provider / model）
 *   2. 推理强度（agent-default-model.reasoningEffort + llm-pi-ai 路由默认 reasoning）
 *   3. 人格设定（SQLite personas：模块文本、每个群用哪套人格）
 *   4. 每个群的唤醒指数（SQLite groups-config：wakeIndex，0 = 只听 @ 和名字，100 = 老行为）
 *
 * 直接改 profile 里的真实配置文件：
 *   ~/.dsh/profiles/qqbot/cordis.patch.yml     ← 模型 / 推理强度（改完要重启机器人）
 *   ~/.dsh/profiles/qqbot/qqbot-documents.sqlite / personas ← 人格（机器人每轮热读，保存即生效）
 *   ~/.dsh/profiles/qqbot/qqbot-documents.sqlite ← 唤醒指数（每条群消息热读，保存即生效）
 *
 * 每次写入前自动备份成 <文件>.bak-<时间戳>；YAML 写坏了会自动回滚并报错。
 *
 * 启动：node bot-config-panel/server.mjs [端口]     # 默认 http://127.0.0.1:7791
 */
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { openProfileDocuments, profileDocumentTypes } from '../lib/profile-documents.mjs';
import { archiveObservedGroup, readObservedGroups } from './group-archive.mjs';
import { mutateQqbotEvents, readProfileDocument, readQqbotGroupDirectory, readQqbotProfileDocument } from '../qqbot-patches/profile-document-reader.js';
import { credentialStatus, updateCredentials } from './credentials.mjs';
import { readImageGenerationSettings, writeImageGenerationSettings } from './image-generation.mjs';
import { readTtsSettings, writeTtsSettings } from './tts.mjs';
import { memoryPresentation } from './memory-presentation.mjs';
import { validateComplexWorkPolicy } from '../qqbot-patches/complex-work-helper.js';
import {
  hasManualMemory, listAlbumPhotos, listOwnedMemories, memoryImageMaxBytes, readAlbumPhoto,
  readMemoryImage, saveMemoryImage, validateMemoryImage, withMemoryImages,
} from './personal-album.mjs';
import { beijingScheduleTime, currentPersonaSchedule, personaSchedulePrompt, validatePersonaSchedule } from './public/app/shared/persona-schedule.js';
import { DAY_MS, dashboardDayKey, dashboardDayStart } from './public/app/shared/dashboard-day.js';
import {
  readFileSync, writeFileSync, copyFileSync, existsSync, statSync,
  openSync, closeSync, readSync, renameSync, readdirSync, chmodSync, unlinkSync, mkdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE_NAME = process.env.QQBOT_PROFILE_NAME ?? 'qqbot';
if (!/^[A-Za-z0-9_-]+$/.test(PROFILE_NAME)) throw new Error('Invalid QQBOT_PROFILE_NAME');
const PROFILE_DIR = resolve(process.env.QQBOT_PROFILE_DIR ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', PROFILE_NAME));
const OVERLAY = join(PROFILE_DIR, 'dsh-bot.patch.yml');
const PATCH = existsSync(OVERLAY) ? OVERLAY : join(PROFILE_DIR, 'cordis.patch.yml');
const GROUPS_META = join(PROFILE_DIR, 'qqbot-documents.sqlite');
const PEOPLE = GROUPS_META;
const OWNERS = GROUPS_META;
const GROUPS = GROUPS_META;
const PERSONAS = GROUPS_META;
const SEEN_GROUPS = join(PROFILE_DIR, 'qqbot-seen-groups.log');
const MODEL_STATUS = join(PROFILE_DIR, 'qqbot-model-status.json');
function withProfileDocuments(fn) {
  const store = openProfileDocuments(PROFILE_DIR);
  try { return fn(store); }
  finally { store.close(); }
}
const MEDIA_PRIMARY = join(PROFILE_DIR, 'media');
const INTEREST_CONFIG = GROUPS_META;
const INTEREST_STATE = join(PROFILE_DIR, 'qqbot-interest-state.json');
const INTEREST_DB = resolve(process.env.QQBOT_MEMORY_DB ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'memory', 'ltm.db'));
const MEMORY_IMAGE_BODY_LIMIT = Math.ceil(memoryImageMaxBytes / 3) * 4 + 8192;
const MEDIA_FALLBACK = join(homedir(), '.dsh', 'qqbot-media');
const WAKE_INDEX_DEFAULT = 100;
const INDEX = join(HERE, 'public', 'index.html');
const PANEL_APP = join(HERE, 'public', 'app');
const PANEL_PAGES = Object.freeze(['home', 'settings', 'persona', 'schedule', 'people', 'memories', 'interest', 'gallery', 'album', 'events', 'owners']);
const PANEL_COMPONENTS = Object.freeze(['overlays']);
const DSH_CREDENTIALS = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml');
const DSH_MODEL_KEYS = ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'XIANGXIN_API_KEY', 'OPENCODE_GO_API_KEY'];

// Read only the presence of allowlisted strings in DSH refs or legacy top-level keys.
// Keep YAML values and parser diagnostics out of stdout, stderr and HTTP responses.
function dshModelCredentialNames() {
  if (!existsSync(DSH_CREDENTIALS)) return [];
  const script = `
import json, sys, yaml
with open(sys.argv[1], 'rb') as file:
    text = file.read(1024 * 1024 + 1)
if len(text) > 1024 * 1024:
    raise ValueError('credential file too large')
doc = yaml.safe_load(text)
if doc is None:
    doc = {}
if not isinstance(doc, dict):
    raise ValueError('invalid credential document')
refs = doc.get('refs')
refs = refs if isinstance(refs, dict) else {}
def present(value):
    return isinstance(value, str) and bool(value.strip())
print(json.dumps([key for key in sys.argv[2:] if present(refs.get(key)) or present(doc.get(key))]))
`;
  return JSON.parse(execFileSync('python3', ['-c', script, DSH_CREDENTIALS, ...DSH_MODEL_KEYS], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, maxBuffer: 4096,
  }));
}
function withDshCredentialStatus(status, names) {
  for (const key of names) {
    if (!status.keys[key].configured) status.keys[key] = { configured: true, source: 'dsh' };
  }
  return status;
}
const WORKDIR = process.env.QQBOT_WORKDIR ?? join(PROFILE_DIR, 'workspace');
const SESSION_COOKIE = randomBytes(32).toString('hex');
const LOG = process.env.QQBOT_LOG ?? join(WORKDIR, 'qqbot-restart.log');
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 7791);
const CONTROL_PORT = Number(process.env.QQBOT_CONTROL_PORT ?? 7792);
const CONTROL_URL = `http://127.0.0.1:${CONTROL_PORT}`;

/**
 * opencode-go 路由下各模型的思考档位（从 pi-ai 内嵌 catalog 抄下来的）。
 * off = 不发思考参数；不在表里的模型按「未知」处理，界面会提示自行核实。
 */
const EFFORT_SUPPORT = {
  'deepseek-v4.1-flash': ['off', 'low', 'high', 'max'],
  'deepseek-v4-pro': ['high', 'max'],
  'glm-5.3': ['off', 'low', 'high', 'max'],
  'glm-5.3-flash': ['off', 'low', 'high', 'max'],
  'glm-5.2': ['off', 'high', 'max'],
  'deepseek-v4-flash-vision-exp': ['off', 'low', 'high', 'max'],
  'qwen3.8-max': ['off', 'low', 'high', 'max'],
  'kimi-k2.7-code': ['off', 'max'],
  'minimax-m2.7': ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  // OpenAI 官方路由：与机器人运行时 pi-ai 内置 catalog 的 thinkingLevelMap 保持一致。
  'gpt-6.1-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-sol': ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-terra': ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-luna': ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.3-codex': ['off', 'low', 'medium', 'high', 'xhigh'],
  'gpt-5.4-mini': ['off', 'low', 'medium', 'high', 'xhigh'],
  'gpt-4.1': [],
  // AMD Radeon（llm-pi-ai 的 amd-radeon 路由）：这两个模型没有思考档位，空数组 = 只允许「不设置」
  'DeepSeek-V4.1-Flash': [],
  'DeepSeek-V4-Flash': [],
};
const ALL_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// ── dsh-our-free-model 插件（免费车道 + Kilo 免费池） ──
//
// 这个 provider 不由 cordis.patch.yml 的 llm-pi-ai 定义，而是插件运行时注册的，
// 所以模型清单直接读插件自己的落盘状态（catalog.json / settings.json），
// 每次请求现读，插件探测完刷新后面板自动跟上。
const OUR_FREE_PROVIDER = 'our-free-model';
const OUR_FREE_DIR = process.env.OUR_FREE_MODEL_DIR ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'our-free-model');

/** 插件源码里声明的档位（只保留本面板认识的档位名；插件的 disabled 用「不设置」表达） */
const FREE_EFFORT_SUPPORT = {
  'deepseek-v4.1-flash-free': ['low', 'high', 'max'],
  'glm-5.3-flash-free': ['low', 'high', 'max'],
  'mimo-v2.6-flash-free': ['low', 'high', 'max'],
};

/** 插件是否真的装在这个 profile 里（没装就别把 provider 列出来） */
function ourFreeInstalled() {
  try {
    const pkg = JSON.parse(readFileSync(join(PROFILE_DIR, 'package.json'), 'utf8'));
    return Boolean(pkg?.dependencies?.['dsh-our-free-model']);
  }
  catch { return false; }
}

/**
 * 免费车道的 route 描述，形状与 llm-pi-ai 的 route 一致（provider / reasoning / models），
 * 另带 external: true 供前端区分。插件没装或还没有 catalog 时返回 undefined。
 */
function ourFreeRoute() {
  if (!ourFreeInstalled()) return undefined;
  const catalogPath = join(OUR_FREE_DIR, 'catalog.json');
  if (!existsSync(catalogPath)) return undefined;
  let catalog;
  try { catalog = JSON.parse(readFileSync(catalogPath, 'utf8')); }
  catch { return undefined; }

  const models = [];
  const seen = new Set();
  const push = (id, name, lane) => {
    if (typeof id !== 'string' || id.trim() === '' || seen.has(id)) return;
    seen.add(id);
    models.push({ id, name: name || id, lane: lane || 'opencode' });
  };

  // 1) 插件里的降级链（combo:… 是虚拟模型，链上任意一段能出话就成）
  try {
    const settings = JSON.parse(readFileSync(join(OUR_FREE_DIR, 'settings.json'), 'utf8'));
    for (const combo of settings.combos ?? []) {
      if (combo?.enabled === false) continue;
      push(combo.id, `${combo.name ?? combo.id}（降级链）`, 'combo');
    }
  }
  catch { /* 没有 settings.json 就只列模型 */ }

  // 2) Kilo 免费池（插件给的是完整行，带名字）
  for (const row of catalog.kiloRows ?? []) push(row.id, row.name, 'kilo');

  // 3) OpenCode 免费车道（上游只给 id）
  for (const id of catalog.entries ?? []) push(id, 'OpenCode 免费车道', 'opencode');

  if (models.length === 0) return undefined;
  return { provider: OUR_FREE_PROVIDER, reasoning: '', external: true, models, attempts: catalog.at ?? 0 };
}

// ─────────────────────────── 通用小工具 ───────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readText(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

function mtimeOf(file) {
  try { return statSync(file).mtimeMs; } catch { return 0; }
}

/** 原子写 + 备份；返回备份路径 */
function writeWithBackup(file, text) {
  const suffix = `${stamp()}-${process.pid}-${randomBytes(3).toString('hex')}`;
  const backup = `${file}.bak-${suffix}`;
  const exists = existsSync(file);
  const mode = exists ? statSync(file).mode & 0o777 : 0o600;   // profile 里有 appSecret，别把 600 写成 644
  if (exists) copyFileSync(file, backup);
  const tmp = `${file}.tmp-${suffix}`;
  writeFileSync(tmp, text, { encoding: 'utf8', mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
  return backup;
}

/** 跨面板进程串行化同一份 JSON 的读-改-写事务。 */
async function withFileLock(file, fn, label = '配置文件') {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 3000;
  let fd;
  for (;;) {
    try {
      fd = openSync(lock, 'wx');
      break;
    }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 8000) unlinkSync(lock);
      }
      catch { /* 已经被别人清掉 */ }
      if (Date.now() > deadline) throw new Error(`${label}正被其他请求修改，请稍后重试`);
      await sleep(15);
    }
  }
  try { return await fn(); }
  finally {
    try { closeSync(fd); } catch { /* 忽略 */ }
    try { unlinkSync(lock); } catch { /* 忽略 */ }
  }
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ─────────────────────────── cordis.patch.yml 读写 ───────────────────────────
//
// 这份 YAML 是手写的、带大量注释，不能整体 parse 再序列化（会丢注释）。
// 所以只做「按缩进定位某一行，替换它的值」，其余字节原样保留。

/** 找到顶层 `- id: xxx` 条目，返回该条目的行区间 [start, end) */
function findEntry(lines, id) {
  const start = lines.findIndex((l) => new RegExp(`^- id:\\s*${escapeRe(id)}\\s*$`).test(l));
  if (start === -1) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^- (id|name):/.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 在 [start,end) 里找缩进为 indent、键名为 key 的行 */
function findKeyLine(lines, start, end, indent, key) {
  const re = new RegExp(`^ {${indent}}${escapeRe(key)}:(\\s|$)`);
  for (let i = start; i < end; i++) if (re.test(lines[i])) return i;
  return -1;
}

/** 某个键的值（去掉行尾注释与空白） */
function readKeyValue(lines, start, end, indent, key) {
  const i = findKeyLine(lines, start, end, indent, key);
  if (i === -1) return undefined;
  const raw = lines[i].slice(indent + key.length + 1).trim();
  return raw.replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '');
}

/** 写键：存在就改值，不存在就插在 afterKey 之后；value 为空串表示删掉这一行 */
function setKeyLine(lines, start, end, indent, key, value, afterKey) {
  const idx = findKeyLine(lines, start, end, indent, key);
  const pad = ' '.repeat(indent);
  if (value === '' || value === null || value === undefined) {
    if (idx !== -1) lines.splice(idx, 1);
    return;
  }
  if (idx !== -1) {
    lines[idx] = `${pad}${key}: ${value}`;
    return;
  }
  // 不存在：插在 afterKey 后面（没有就插在 start+1）
  let at = afterKey === undefined ? -1 : findKeyLine(lines, start, end, indent, afterKey);
  if (at === -1) at = start;
  lines.splice(at + 1, 0, `${pad}${key}: ${value}`);
}


/** 删掉某一行键，并清掉紧贴在上面、明显属于这个键的说明注释 */
function deleteKeyLine(lines, start, end, indent, key) {
  const idx = findKeyLine(lines, start, end, indent, key);
  if (idx === -1) return;
  lines.splice(idx, 1);
  const pad = ' '.repeat(indent);
  let at = idx - 1;
  while (at >= start + 1) {
    const line = lines[at];
    if (!line.startsWith(`${pad}#`)) break;
    if (!/推理强度|思考档|档位/.test(line)) break;
    lines.splice(at, 1);
    at -= 1;
  }
}


/** llm-pi-ai 里某个 provider 的行区间 */
function findProviderBlock(lines, provider) {
  const entry = findEntry(lines, 'llm-pi-ai');
  if (!entry) return undefined;
  const providersAt = findKeyLine(lines, entry.start, entry.end, 4, 'providers');
  if (providersAt === -1) return undefined;
  const re = new RegExp(`^ {6}${escapeRe(provider)}:\\s*$`);
  let start = -1;
  for (let i = providersAt + 1; i < entry.end; i++) {
    if (/^ {0,4}\S/.test(lines[i])) break;         // 回到 config 层，providers 结束
    if (re.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return undefined;
  let end = entry.end;
  for (let i = start + 1; i < entry.end; i++) {
    if (/^ {0,6}\S/.test(lines[i])) { end = i; break; }   // 下一个 provider 或回到上层
  }
  return { start, end };
}

/** provider 块里的模型列表：[{ id, name }] */
function readProviderModels(lines, provider) {
  const block = findProviderBlock(lines, provider);
  if (!block) return [];
  const models = [];
  for (let i = block.start; i < block.end; i++) {
    const m = /^ {10}- id:\s*(.+?)\s*$/.exec(lines[i]);
    if (!m) continue;
    const id = m[1].replace(/^['"]|['"]$/g, '');
    let name = id;
    for (let j = i + 1; j < block.end && j < i + 6; j++) {
      const n = /^ {12}name:\s*(.+?)\s*$/.exec(lines[j]);
      if (n) { name = n[1].replace(/^['"]|['"]$/g, ''); break; }
      if (/^ {10}- id:/.test(lines[j])) break;
    }
    models.push({ id, name });
  }
  return models;
}

/** providers 列表（键名） */
function readProviders(lines) {
  const entry = findEntry(lines, 'llm-pi-ai');
  if (!entry) return [];
  const providersAt = findKeyLine(lines, entry.start, entry.end, 4, 'providers');
  if (providersAt === -1) return [];
  const out = [];
  for (let i = providersAt + 1; i < entry.end; i++) {
    if (/^ {0,4}\S/.test(lines[i])) break;
    const m = /^ {6}([A-Za-z0-9._-]+):\s*$/.exec(lines[i]);
    if (m) out.push(m[1]);
  }
  return out;
}

function readPatchConfig(text) {
  const lines = text.split('\n');
  const def = findEntry(lines, 'agent-default-model');
  const model = def
    ? {
      provider: readKeyValue(lines, def.start, def.end, 4, 'provider') ?? '',
      model: readKeyValue(lines, def.start, def.end, 4, 'model') ?? '',
      reasoningEffort: readKeyValue(lines, def.start, def.end, 4, 'reasoningEffort') ?? '',
    }
    : { provider: '', model: '', reasoningEffort: '' };

  const providers = readProviders(lines);
  const routes = providers.map((name) => {
    const block = findProviderBlock(lines, name);
    return {
      provider: name,
      reasoning: block ? (readKeyValue(lines, block.start, block.end, 8, 'reasoning') ?? '') : '',
      models: readProviderModels(lines, name),
    };
  });
  // 插件注册的 provider：不在 YAML 里，清单从插件落盘状态现读
  const free = ourFreeRoute();
  if (free) routes.push(free);
  return { model, routes, lines };
}

/** 前后端使用同一档位表；不能通过直接调用保存接口绕过模型能力校验。 */
function validateModelEfforts(provider, model, reasoningEffort, routeReasoning) {
  const levels = provider === OUR_FREE_PROVIDER ? FREE_EFFORT_SUPPORT[model] : EFFORT_SUPPORT[model];
  for (const [label, level] of [['推理强度', reasoningEffort], ['路由默认推理强度', routeReasoning]]) {
    if (level && !ALL_EFFORTS.includes(level)) throw new Error(`未知${label}：${level}`);
    if (level && levels && !levels.includes(level))
      throw new Error(`模型 ${model} 不支持${label}「${level}」`);
  }
}

/** 写模型 + 默认推理强度；routeReasoning = { provider, level } */
function writePatchConfig(text, next) {
  const lines = text.split('\n');

  // 1) agent-default-model
  let def = findEntry(lines, 'agent-default-model');
  if (!def) {
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push('', '- id: agent-default-model', '  config:',
      `    provider: ${next.provider}`, `    model: ${next.model}`);
    if (next.reasoningEffort) lines.push(`    reasoningEffort: ${next.reasoningEffort}`);
    lines.push('');
    def = findEntry(lines, 'agent-default-model');
  }
  setKeyLine(lines, def.start, def.end, 4, 'provider', next.provider);
  def = findEntry(lines, 'agent-default-model');
  setKeyLine(lines, def.start, def.end, 4, 'model', next.model);
  def = findEntry(lines, 'agent-default-model');
  setKeyLine(lines, def.start, def.end, 4, 'reasoningEffort', next.reasoningEffort, 'model');

  // 2) 路由默认推理强度
  if (next.routeReasoning !== undefined) {
    const block = findProviderBlock(lines, next.routeReasoning.provider);
    if (block) {
      if (next.routeReasoning.level === '') deleteKeyLine(lines, block.start, block.end, 8, 'reasoning');
      else setKeyLine(lines, block.start, block.end, 8, 'reasoning', next.routeReasoning.level, 'apiKeyEnv');
    }
  }
  return lines.join('\n');
}

/** 用 python3 的 PyYAML 校验刚写出的 YAML；没有 python3/yaml 时跳过（返回 undefined） */
function validateYaml(text) {
  const tmp = `${PATCH}.check-${process.pid}`;
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    execFileSync('python3', ['-c', 'import sys,yaml;yaml.safe_load(open(sys.argv[1],encoding="utf-8").read())', tmp],
      { stdio: 'pipe', timeout: 15000 });
    return { ok: true };
  }
  catch (err) {
    if (err?.code === 'ENOENT') return undefined;      // 没装 python3：跳过校验
    const msg = String(err?.stderr ?? err?.message ?? err).trim().split('\n').slice(-3).join(' ');
    if (/ModuleNotFoundError|No module named 'yaml'/.test(msg)) return undefined;
    return { ok: false, error: msg };
  }
  finally {
    try { unlinkSync(tmp); } catch { /* 忽略 */ }
  }
}

// ─────────────────────────── 人格 JSON ───────────────────────────

function readPersonas() {
  return readProfileDocument(PROFILE_DIR, 'personas');
}

/** 结构校验：模块必须是字符串、引用必须存在、人格条目形状正确 */
function validatePersonas(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('数据必须是对象');
  const modules = data.modules ?? {};
  if (typeof modules !== 'object' || Array.isArray(modules)) throw new Error('modules 必须是对象');
  for (const [id, text] of Object.entries(modules)) {
    if (id.trim() === '') throw new Error('存在空模块 id');
    if (typeof text !== 'string') throw new Error(`模块 ${id} 的文本不是字符串`);
  }
  const archetypes = data.archetypes ?? {};
  if (typeof archetypes !== 'object' || Array.isArray(archetypes)) throw new Error('archetypes 必须是对象');
  for (const [id, text] of Object.entries(archetypes)) {
    if (typeof text !== 'string') throw new Error(`人格类型 ${id} 的文本不是字符串`);
  }
  const personas = data.personas ?? {};
  if (typeof personas !== 'object' || Array.isArray(personas)) throw new Error('personas 必须是对象');
  for (const [key, entry] of Object.entries(personas)) {
    const ids = Array.isArray(entry) ? entry : entry?.modules;
    if (!Array.isArray(ids))
      throw new Error(`人格 ${key} 的模块列表必须是数组`);   // 空数组 = 这份人格暂时不用，运行时回落到默认
    for (const id of ids) {
      if (typeof id !== 'string' || !(id in modules))
        throw new Error(`人格 ${key} 引用了不存在的模块：${String(id)}`);
    }
    if (entry?.complexWork !== undefined) validateComplexWorkPolicy(entry.complexWork);
    if (entry?.useSchedule !== undefined && typeof entry.useSchedule !== 'boolean')
      throw new Error(`人格 ${key} 的时间表开关必须是布尔值`);
    const personaName = entry?.name;
    if (personaName !== undefined && personaName !== null && typeof personaName !== 'string')
      throw new Error(`人格 ${key} 的名称必须是字符串`);
    const archetype = entry?.archetype;
    if (archetype !== undefined && archetype !== null && archetype !== '') {
      if (typeof archetype !== 'string' || !(archetype in archetypes))
        throw new Error(`人格 ${key} 引用了不存在的人格类型：${String(archetype)}`);
    }
  }
}

// ─────────────────────────── 群列表 / 机器人进程 ───────────────────────────

function readGroups() {
  try { return readQqbotGroupDirectory(PROFILE_DIR); }
  catch { return []; }
}

/**
 * 每群唤醒指数：0–100，存在 groups-config 的 wakeIndex 字段里。
 * 100 = 老行为（没被点名也每条都接），越低越少主动插话；@ 和叫名字不受影响。
 */
function clampIndex(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function profileDocumentVersion(doc) {
  return createHash('sha256').update(JSON.stringify(doc)).digest('hex');
}

function requireProfileDocumentVersion(doc, version, label, recovery = '请先刷新页面再保存。') {
  if (version === profileDocumentVersion(doc)) return;
  const error = new Error(`${label}版本已变化，${recovery}`);
  error.status = 409;
  throw error;
}

function wakeIndexSnapshot(doc) {
  const entries = doc.wakeIndex && typeof doc.wakeIndex === 'object' && !Array.isArray(doc.wakeIndex)
    ? Object.entries(doc.wakeIndex) : [];
  const map = Object.fromEntries(entries.filter(([gid, value]) => gid.trim() && Number.isFinite(Number(value)))
    .map(([gid, value]) => [gid, clampIndex(Number(value))]));
  const def = Number(doc.wakeIndexDefault);
  return { map, default: Number.isFinite(def) ? clampIndex(def) : WAKE_INDEX_DEFAULT,
    path: GROUPS, version: profileDocumentVersion(doc) };
}

function readWakeIndex() {
  try { return wakeIndexSnapshot(readProfileDocument(PROFILE_DIR, 'groups-config')); }
  catch { return { map: {}, default: WAKE_INDEX_DEFAULT, path: GROUPS, version: null }; }
}

/** Update one group's wake index, without replacing other group settings. */
function writeWakeIndex(groupOpenid, value, baseVersion) {
  if (typeof groupOpenid !== 'string' || groupOpenid.trim() === '')
    throw new Error('缺少群 id');
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100)
    throw new Error('唤醒指数必须是 0–100 的数字');

  const saved = withProfileDocuments(db => db.update('groups-config', doc => {
    requireProfileDocumentVersion(doc, baseVersion, '群配置');
    const { default: def } = wakeIndexSnapshot(doc);
    const entries = doc.wakeIndex && typeof doc.wakeIndex === 'object' && !Array.isArray(doc.wakeIndex)
      ? Object.entries(doc.wakeIndex).filter(([id]) => id !== groupOpenid) : [];
    const next = clampIndex(n);
    if (next !== def) entries.push([groupOpenid, next]);
    if (entries.length) doc.wakeIndex = Object.fromEntries(entries);
    else delete doc.wakeIndex;
    return doc;
  }));
  return wakeIndexSnapshot(saved);
}


function readJsonFile(file, fallback) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  }
  catch {
    return fallback;
  }
}

// 角色模块：面板按人勾选，勾选结果落到各自的数据文件里。
// 新增模块时只改这里 + 前端 P_MODULES + PUT 的写入逻辑。
function moduleAudienceMatch(skill, name, person) {
  return (Array.isArray(skill?.audiences) ? skill.audiences : []).some((audience) =>
    audience && (audience.person === name || (Array.isArray(audience.openids) && Array.isArray(person?.openids)
      && audience.openids.some((id) => person.openids.includes(id)))));
}
function imageSkillIdOf(roleDoc) {
  return String(roleDoc?.imagePermission?.skill ?? 'image-gen');
}
function voiceSkillIdOf(roleDoc) {
  return String(roleDoc?.voicePermission?.skill ?? 'voice-gen');
}

function effectiveModuleFor(person, docs) {
  const name = String(person?.name ?? '');
  const modules = docs['person-modules'];
  const mod = modules.people?.[name] ?? {};
  const allowDoc = docs['media-allow'];
  const allowEntry = (Array.isArray(allowDoc.people) ? allowDoc.people : []).find((entry) =>
    entry && (entry.name === name || (Array.isArray(entry.openids) && Array.isArray(person?.openids)
      && entry.openids.some((id) => person.openids.includes(id)))));
  const roleDoc = docs['role-skills'];
  const skills = Array.isArray(roleDoc.skills) ? roleDoc.skills : [];
  // 能力型技能（生图）不是语言风格，不参与 style 模块的判定。
  const styleSkill = skills.find((skill) => skill && skill.kind !== 'capability' && moduleAudienceMatch(skill, name, person));
  const imageSkill = skills.find((skill) => skill && String(skill.id ?? '') === imageSkillIdOf(roleDoc));
  const voiceSkill = skills.find((skill) => skill && String(skill.id ?? '') === voiceSkillIdOf(roleDoc));
  return {
    collectImages: {
      enabled: Boolean(allowEntry),
      categories: Array.isArray(allowEntry?.categories) ? allowEntry.categories : [],
    },
    topics: {
      enabled: mod.topics?.enabled === true,
      topics: Array.isArray(mod.topics?.topics) ? mod.topics.topics : [],
    },
    style: {
      enabled: Boolean(styleSkill),
      skill: String(styleSkill?.id ?? ''),
    },
    imageGen: {
      enabled: Boolean(imageSkill) && moduleAudienceMatch(imageSkill, name, person),
    },
    voiceGen: {
      enabled: Boolean(voiceSkill) && moduleAudienceMatch(voiceSkill, name, person),
    },
  };
}

/** 指令白名单：{ openids: string[], names: string[] } */
function readOwners() {
  const parsed = readProfileDocument(PROFILE_DIR, 'command-owners');
  return {
    openids: Array.isArray(parsed.openids) ? parsed.openids.filter((x) => typeof x === 'string' && x !== '') : [],
    names: Array.isArray(parsed.names) ? parsed.names.filter((x) => typeof x === 'string' && x.trim() !== '') : [],
  };
}

function cleanList(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`${label} 里有非字符串项`);
    const trimmed = item.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function writeOwners(next) {
  const openids = cleanList(next.openids, 'openids');
  const names = cleanList(next.names, 'names');
  withProfileDocuments(db => db.update('command-owners', previous => ({ ...previous, openids, names })));
  return { openids, names };
}

/** 群成员档案里能当主人候选的人：名字 + 已知 openid */
function peopleIndex() {
  try {
    const parsed = readPeopleStore();
    return (parsed.people ?? [])
      .filter((p) => typeof p?.name === 'string')
      .map((p) => ({ name: p.name, openids: Array.isArray(p.openids) ? p.openids : [], groups: Array.isArray(p.groups) ? p.groups : [] }));
  }
  catch { return []; }
}



/** 完整群成员档案（编辑器用；peopleIndex 只给主人页的名字/openid） */
function readPeopleStore() {
  const doc = readProfileDocument(PROFILE_DIR, 'people');
  if (!Array.isArray(doc.people)) throw new Error('People document must have a people array');
  return doc;
}

function readPeopleSnapshot() {
  const data = readPeopleStore();
  return { data, version: profileDocumentVersion(data) };
}

/** 写入 SQLite people 文档；版本校验与更新在同一事务内完成。 */
function writePeopleStore(data, baseVersion) {
  if (!data || !Array.isArray(data.people)) throw new Error('JSON 必须是 { "people": [...] } 结构');
  for (const [i, person] of data.people.entries()) {
    if (!person || typeof person !== 'object' || typeof person.name !== 'string' || person.name.trim() === '')
      throw new Error(`第 ${i + 1} 条缺少 name`);
  }
  const stored = withProfileDocuments(store => store.update('people', current => {
    requireProfileDocumentVersion(current, baseVersion, '人员档案');
    return data;
  }));
  return { count: stored.people.length, version: profileDocumentVersion(stored) };
}

function readEventsStore() {
  const raw = readProfileDocument(PROFILE_DIR, 'events');
  if (!Array.isArray(raw.events)) throw new Error('Event document must have an events array');
  return raw;
}

function writeEventsStore(mutator) {
  return mutateQqbotEvents(PROFILE_DIR, mutator);
}

/** 写群列表元数据：校验 id/name/重复，数据和审计同事务提交。 */
function writeGroupsMeta(groups) {
  if (!Array.isArray(groups))
    throw new Error('groups 必须是数组');
  const seen = new Set();
  const clean = [];
  for (const [i, group] of groups.entries()) {
    if (!group || typeof group !== 'object')
      throw new Error(`第 ${i + 1} 个群格式不对`);
    const id = String(group.id ?? '').trim();
    const name = String(group.name ?? '').trim();
    if (id === '') throw new Error(`第 ${i + 1} 个群缺少 id（group_openid）`);
    if (name === '') throw new Error(`第 ${i + 1} 个群缺少群名`);
    if (seen.has(id)) throw new Error(`群 ${id} 重复`);
    seen.add(id);
    clean.push({ id, name });
  }
  const stored = withProfileDocuments(store => store.update('groups-meta', current => ({ ...current, groups: clean })));
  return { count: clean.length, groups: stored.groups };
}

// ── 群兴趣画像（P0–P3）────────────────────────────────────────────

const INTEREST_MODES = new Set(['off', 'shadow']);
const INTEREST_SEARCH_MODES = new Set(['off', 'manual', 'auto']);
const INTEREST_SHARE_MODES = new Set(['off', 'auto']);

function interestClamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function readInterestConfig() {
  const raw = readProfileDocument(PROFILE_DIR, 'interest-config');
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function readInterestStateDocument() {
  const file = join(PROFILE_DIR, 'qqbot-interest-state.sqlite');
  if (!existsSync(file)) return readJsonFile(INTEREST_STATE, {});
  let db;
  try {
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    if (!sqlite) return {};
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    db.exec('pragma busy_timeout = 500');
    const initialized = db.prepare("select 1 from sqlite_schema where type = 'table' and name = 'interest_state'").get();
    const row = initialized && db.prepare('select payload from interest_state where id = 1').get();
    return row ? JSON.parse(row.payload) : readJsonFile(INTEREST_STATE, {});
  }
  catch { return {}; }
  finally { db?.close(); }
}

function readInterestState() {
  const raw = readInterestStateDocument();
  const groups = raw && typeof raw.groups === 'object' ? raw.groups : {};
  const global = raw && typeof raw.global === 'object' ? raw.global : {};
  return { groups, global };
}

function readInterestActivity() {
  const raw = readProfileDocument(PROFILE_DIR, 'interest-activity');
  const groups = raw && typeof raw.groups === 'object' ? raw.groups : {};
  return { at: Number(raw?.at) || 0, groups };
}

function openInterestDb() {
  const sqlite = process.getBuiltinModule?.('node:sqlite');
  if (!sqlite || !existsSync(INTEREST_DB)) return null;
  try {
    const db = new sqlite.DatabaseSync(INTEREST_DB);
    // 主题层是向后兼容的：面板先行打开旧库时也完成迁移，避免话题列表因列不存在而整段为空。
    try { db.exec("alter table group_interests add column broad_topic text not null default ''"); } catch { /* 已有 */ }
    try {
      db.prepare(`update group_interests set broad_topic = '魔兽世界无限服'
                  where broad_topic = '' and (topic like '%魔兽%' or topic like '%无限服%' or topic like '%乌龟服%')`).run();
    } catch { /* 旧库或表不存在 */ }
    return db;
  }
  catch {
    return null;
  }
}

function interestCounts(db) {
  const counts = new Map();
  const bump = (gid, key, value) => {
    const item = counts.get(gid) ?? { topics: 0, findings: 0 };
    item[key] = value;
    counts.set(gid, item);
  };
  try {
    for (const row of db.prepare('select gid, count(*) as c from group_interests group by gid').all())
      bump(String(row.gid), 'topics', Number(row.c) || 0);
  }
  catch { /* 表还没建 */ }
  try {
    for (const row of db.prepare('select gid, count(*) as c from interest_findings group by gid').all())
      bump(String(row.gid), 'findings', Number(row.c) || 0);
  }
  catch { /* 表还没建 */ }
  return counts;
}

/** 一个群的话题 / 发现 / 最近运行，供面板展开 */
function interestGroupDetail(db, gid) {
  const out = { topics: [], findings: [], runs: [] };
  if (!db || !gid) return out;
  try {
    out.topics = db.prepare(`
      select topic, broad_topic, category, heat, bond, searchable, sensitivity, mentions,
             last_evidence_at, last_checked_at, next_check_at
      from group_interests where gid = ?
      order by (heat + bond * 0.5) desc
      limit 40
    `).all(gid);
  }
  catch { /* 表还没建 */ }
  try {
    out.findings = db.prepare(`
      select topic_key, title, summary, url, angle, score, status,
             target_person_name, found_at, shared_at, offered_count
      from interest_findings where gid = ?
      order by found_at desc
      limit 20
    `).all(gid);
  }
  catch { /* 表还没建 */ }
  try {
    out.runs = db.prepare(`
      select topic_key, started_at, finished_at, searches, result, detail, error
      from interest_runs where gid = ?
      order by started_at desc
      limit 10
    `).all(gid);
  }
  catch { /* 表还没建 */ }
  return out;
}

function normalizeInterestConfig(input) {
  const source = input && typeof input === 'object' ? input : {};
  const out = {};
  if (source.enabled !== undefined) out.enabled = source.enabled !== false;
  if (source.mode !== undefined) out.mode = INTEREST_MODES.has(String(source.mode)) ? String(source.mode) : 'shadow';
  if (source.activeMin !== undefined) out.activeMin = interestClamp(source.activeMin, 0, 1, 0.15);
  if (source.observeMinMsgs !== undefined) out.observeMinMsgs = interestClamp(source.observeMinMsgs, 1, 100, 8);
  if (source.observeIntervalMs !== undefined) out.observeIntervalMs = interestClamp(source.observeIntervalMs, 300000, 86400000, 3600000);
  if (source.observeMaxPerDay !== undefined) out.observeMaxPerDay = interestClamp(source.observeMaxPerDay, 1, 96, 12);
  if (source.observeGlobalMaxPerDay !== undefined) out.observeGlobalMaxPerDay = interestClamp(source.observeGlobalMaxPerDay, 1, 500, 60);
  if (source.searchMode !== undefined)
    out.searchMode = INTEREST_SEARCH_MODES.has(String(source.searchMode)) ? String(source.searchMode) : 'manual';
  if (source.bring !== undefined) out.bring = source.bring !== false;
  if (source.bringIntervalMs !== undefined) out.bringIntervalMs = interestClamp(source.bringIntervalMs, 1800000, 172800000, 14400000);
  if (source.bringMaxPerDay !== undefined) out.bringMaxPerDay = interestClamp(source.bringMaxPerDay, 0, 10, 2);
  if (source.bringMinScore !== undefined) out.bringMinScore = interestClamp(source.bringMinScore, 0, 1, 0.5);
  if (source.bringMaxAgeMs !== undefined) out.bringMaxAgeMs = interestClamp(source.bringMaxAgeMs, 3600000, 2592000000, 259200000);
  if (source.shareMode !== undefined)
    out.shareMode = INTEREST_SHARE_MODES.has(String(source.shareMode)) ? String(source.shareMode) : 'off';
  if (source.shareMinScore !== undefined) out.shareMinScore = interestClamp(source.shareMinScore, 0, 1, 0.6);
  if (source.shareMaxPerDay !== undefined) out.shareMaxPerDay = interestClamp(source.shareMaxPerDay, 0, 10, 1);
  if (source.shareMinGapMs !== undefined) out.shareMinGapMs = interestClamp(source.shareMinGapMs, 3600000, 259200000, 21600000);
  if (source.shareMaxAgeMs !== undefined) out.shareMaxAgeMs = interestClamp(source.shareMaxAgeMs, 3600000, 2592000000, 172800000);
  if (source.search && typeof source.search === 'object') {
    out.search = {};
    if (source.search.enabled !== undefined) out.search.enabled = source.search.enabled !== false;
    if (source.search.mode !== undefined)
      out.search.mode = INTEREST_SEARCH_MODES.has(String(source.search.mode)) ? String(source.search.mode) : 'manual';
    if (source.search.intervalMs !== undefined) out.search.intervalMs = interestClamp(source.search.intervalMs, 600000, 86400000, 3600000);
    if (source.search.maxSearchesPerRun !== undefined) out.search.maxSearchesPerRun = interestClamp(source.search.maxSearchesPerRun, 1, 20, 6);
    if (source.search.maxSearchesTotal !== undefined) out.search.maxSearchesTotal = interestClamp(source.search.maxSearchesTotal, 1, 20, 20);
    if (source.search.minScore !== undefined) out.search.minScore = interestClamp(source.search.minScore, 0, 1, 0.45);
    if (source.search.maxFindingsPerRun !== undefined) out.search.maxFindingsPerRun = interestClamp(source.search.maxFindingsPerRun, 1, 20, 6);
  }
  return out;
}

function normalizeInterestGroup(input) {
  const source = input && typeof input === 'object' ? input : {};
  const out = {};
  if (source.enabled !== undefined) out.enabled = source.enabled !== false;
  if (source.searchMode !== undefined)
    out.searchMode = INTEREST_SEARCH_MODES.has(String(source.searchMode)) ? String(source.searchMode) : 'manual';
  if (source.shareMode !== undefined)
    out.shareMode = INTEREST_SHARE_MODES.has(String(source.shareMode)) ? String(source.shareMode) : 'off';
  if (source.bring !== undefined) out.bring = source.bring !== false;
  if (source.activeMin !== undefined) out.activeMin = interestClamp(source.activeMin, 0, 1, 0.15);
  return out;
}

/** 正在跑的机器人进程（pgrep 一把梭，排除面板自己的 shell） */
function botPids() {
  try {
    // 注意：不能匹配 "dsh --profile"，因为面板拉起的是 node …/@deepseek-ai/dsh/lib/bin.js --profile qqbot
    const out = execFileSync('pgrep', ['-fl', `profile ${PROFILE_NAME}`], { encoding: 'utf8' });
    return out.split('\n')
      .map((l) => l.trim())
      .filter((l) => new RegExp(`--profile\\s+${PROFILE_NAME}(?:\\s|$)`).test(l) && l.includes('dsh'))
      .filter((l) => {
        const argv1 = l.split(/\s+/)[1] ?? '';
        return /(^|\/)(node|bun)(\s|$)/.test(argv1);   // 只要真正的 node 进程，排除 bash -c 包裹层
      })
      .map((l) => Number(l.split(/\s+/)[0]))
      .filter((n) => Number.isInteger(n) && n > 0);
  }
  catch { return []; }
}

/** 找 dsh 可执行入口：环境变量 → PATH 里的 dsh → npx 缓存里最新的那个 */
function resolveDsh() {
  const explicit = process.env.QQBOT_DSH_BIN;
  if (explicit && existsSync(explicit)) return explicit;
  try {
    const which = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim();
    if (which && existsSync(which)) return which;
  }
  catch { /* 没装到 PATH，继续找 */ }
  const npxRoot = join(homedir(), '.npm', '_npx');
  if (existsSync(npxRoot)) {
    const bins = [];
    for (const dir of readdirSync(npxRoot)) {
      const bin = join(npxRoot, dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (existsSync(bin)) bins.push({ bin, mtime: mtimeOf(bin) });
    }
    bins.sort((a, b) => b.mtime - a.mtime);
    if (bins.length > 0) return bins[0].bin;
  }
  return undefined;
}

function tailLog(n = 8) {
  try {
    const text = readFileSync(LOG, 'utf8');
    return text.trimEnd().split('\n').slice(-n);
  }
  catch { return []; }
}

/** 读某个日志文件 offset 之后的新增内容（重启前先记 offset，避免把旧进程的 Bot ready 当成新的） */
function readLogSince(path, offset) {
  try {
    const size = statSync(path).size;
    const from = size < offset ? 0 : offset;   // 文件被截断/轮转过就从 0 读
    if (size <= from) return { text: '', size };
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(size - from);
      const read = readSync(fd, buf, 0, buf.length, from);
      return { text: buf.subarray(0, read).toString('utf8'), size };
    }
    finally { closeSync(fd); }
  }
  catch { return { text: '', size: 0 }; }
}

/**
 * 等机器人就绪：必须同时满足「出现新 PID」和「新日志里有 Bot ready」。
 * 只看 PID 会把 launchd 刚拉起、还没连上网关的进程误判成就绪；只看日志会把旧进程的输出误判成新的。
 */
async function waitForBotReady({ oldPids, logPath, offset, timeoutMs = 45000 }) {
  const deadline = Date.now() + timeoutMs;
  let pids = [];
  let newLog = '';
  let cursor = offset;               // 每次只读新增的部分，别把同一段反复追加
  while (Date.now() < deadline) {
    pids = botPids().filter((pid) => !oldPids.includes(pid));
    if (logPath) {
      const { text, size } = readLogSince(logPath, cursor);
      if (size > cursor) cursor = size;
      if (text) newLog += text;
      if (newLog.length > 200_000) newLog = newLog.slice(-200_000);
    }
    if (pids.length > 0 && /Bot ready/.test(newLog)) return { ready: true, pids, log: newLog };
    await sleep(1000);
  }
  return { ready: false, pids, log: newLog };
}

/**
 * 找管着机器人的 launchd 任务：~/Library/LaunchAgents 里 ProgramArguments 带「--profile qqbot」的那个。
 * 有它守护时不能用「杀掉再自己 spawn」的老办法：KeepAlive 会把被杀的那个立刻拉起来，
 * 于是机器上同时跑两个机器人、抢同一个 appId，网关会报 Invalid gateway session / 频率限制。
 */
function findLaunchdJob() {
  const dir = join(homedir(), 'Library', 'LaunchAgents');
  if (!existsSync(dir)) return undefined;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.plist')) continue;
    const path = join(dir, file);
    let text;
    try { text = readFileSync(path, 'utf8'); }
    catch { continue; }
    if (!new RegExp(`--profile</string>\\s*<string>${PROFILE_NAME}</string>`).test(text)) continue;
    const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1];
    if (!label) continue;
    const out = /<key>StandardOutPath<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1];
    return { label, out, path };
  }
  return undefined;
}

async function restartBot() {
  if (process.env.QQBOT_PANEL_RESTART !== 'on')
    throw new Error('面板重启默认关闭：请用 ./panel-run.sh 启动面板（或在启动面板时设 QQBOT_PANEL_RESTART=on、QQBOT_LAUNCHD_LABEL=<launchd label>）。');
  if (process.platform !== 'darwin') throw new Error('面板重启仅支持显式配置的 macOS launchd 服务');
  const label = process.env.QQBOT_LAUNCHD_LABEL;
  const job = findLaunchdJob();
  if (!label || !job || job.label !== label)
    throw new Error('请配置与当前 profile 匹配的 QQBOT_LAUNCHD_LABEL；不会猜测或直接拉起其它进程');

  const oldPids = botPids();
  // 就绪日志：plist 的 StandardOutPath（当前 /tmp/qqbot-launchd.out），没有就退回 QQBOT_LOG
  const logPath = job.out || LOG;
  const offset = (() => { try { return statSync(logPath).size; } catch { return 0; } })();
  console.log(`[panel] ${new Date().toISOString()} 重启机器人（launchd ${label}）：请求收到，旧 PID ${oldPids.join(',') || '无'}`);

  execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${label}`], { encoding: 'utf8', timeout: 15000 });

  const waitMs = Number(process.env.QQBOT_READY_TIMEOUT_MS ?? 45000);
  const { ready, pids, log } = await waitForBotReady({ oldPids, logPath, offset, timeoutMs: waitMs });
  const all = botPids();
  const tail = log.trimEnd().split('\n').filter(Boolean).slice(-6);

  if (all.length > 1)
    console.log(`[panel] 警告：重启后发现 ${all.length} 个机器人进程（${all.join(',')}），可能重复连网关`);

  console.log(`[panel] ${new Date().toISOString()} 重启机器人（launchd ${label}）：PID ${pids.join(',') || '无'}，ready=${ready}`);

  return {
    mode: 'launchd',
    pids: all,
    running: all.length > 0,
    ready,
    logPath,
    tail,
    note: ready
      ? '已通过 launchd 重启，并在日志里看到 Bot ready。不会额外启动第二个机器人。'
      : `已请求 launchd 重启，但 ${Math.round(waitMs / 1000)} 秒内没等到 Bot ready；看 ${logPath}`,
  };
}

// ─────────────────────────── HTTP ───────────────────────────

/** 调机器人进程里的本地控制接口（新会话 / 压缩） */
async function botControl(path, body, timeoutMs = 15000) {
  try {
    const res = await fetch(`${CONTROL_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${readText(join(PROFILE_DIR, '.control-token')).trim()}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false)
      throw new Error(json.error ?? `控制接口 HTTP ${res.status}`);
    return json;
  }
  catch (err) {
    throw new Error(`机器人控制接口不可用（${CONTROL_URL}）：${err?.message ?? err}`);
  }
}

function dashboardData() {
  const now = Date.now();
  const todayStart = dashboardDayStart(now);
  const horizon = todayStart - 6 * DAY_MS;
  const byDay = new Map();
  const groups24 = new Set();
  const lines = [];
  try {
    const stat = statSync(SEEN_GROUPS);
    const size = Math.min(stat.size, 8 * 1024 * 1024);
    const fd = openSync(SEEN_GROUPS, 'r');
    try { const buf = Buffer.alloc(size); readSync(fd, buf, 0, size, Math.max(0, stat.size - size)); lines.push(...buf.toString('utf8').split('\n')); }
    finally { closeSync(fd); }
  } catch { /* no activity log yet */ }
  let latestActivityTs = 0;
  for (const line of lines) {
    const m = line.match(/^(\S+)\s+(\S+)\s+event=GROUP_MESSAGE_CREATE\b([^\n]*)$/);
    if (!m) continue;
    const ts = Date.parse(m[1]);
    if (!Number.isFinite(ts) || ts < horizon || ts > now + 60000) continue;
    const gid = m[2];
    latestActivityTs = Math.max(latestActivityTs, ts);
    const dayStart = dashboardDayStart(ts);
    const row = byDay.get(dayStart) ?? { messages: 0, wake: 0 };
    row.messages += 1;
    if (/\bwake=true\b/.test(m[3])) row.wake += 1;
    byDay.set(dayStart, row);
    if (ts >= now - DAY_MS) groups24.add(gid);
  }
  const days = [];
  for (let dayStart = horizon; dayStart <= todayStart; dayStart += DAY_MS) {
    days.push({ date: dashboardDayKey(dayStart), ...(byDay.get(dayStart) ?? { messages: 0, wake: 0 }) });
  }
  const { messages: today, wake: triggeredToday } = days.at(-1);
  const activity24h = latestActivityTs >= now - DAY_MS;
  const modelStatus = readJsonFile(MODEL_STATUS, null);
  const running = botPids().length > 0;
  const modelUpdatedAt = modelStatus?.updatedAt ? Date.parse(modelStatus.updatedAt) : NaN;
  const modelFresh = Number.isFinite(modelUpdatedAt) && now - modelUpdatedAt < 10 * 60 * 1000;
  let storageReady = false;
  try {
    readFileSync(PATCH, 'utf8');
    readPersonas();
    readProfileDocument(PROFILE_DIR, 'groups-config');
    readEventsStore();
    storageReady = true;
  } catch { /* A missing/invalid deployment config is reflected in health only. */ }
  const checks = [
    { id: 'bot', label: '机器人进程', ok: running, detail: running ? `运行中 · PID ${botPids().join(', ')}` : '未检测到运行中的机器人' },
    { id: 'model', label: '模型调用', ok: modelStatus?.ok === true && modelFresh,
      warning: modelStatus?.ok === true && !modelFresh,
      detail: modelStatus?.ok === false ? `最近一次调用失败${modelStatus.lastError?.code ? ` · ${modelStatus.lastError.code}` : ''}` : (modelFresh ? '最近 10 分钟有状态上报' : '暂无新状态上报') },
    { id: 'storage', label: '本地存储', ok: storageReady, detail: storageReady ? '配置与事件可读' : '部分配置或事件不可读' },
    { id: 'activity', label: '消息活动', ok: activity24h, detail: activity24h ? `今天已收到 ${today} 条消息` : '近 24 小时没有消息活动' },
  ];
  const score = Math.round(checks.reduce((sum, check) => sum + (check.ok ? 25 : check.warning ? 12 : 0), 0));
  const status = score >= 80 ? '状态良好' : score >= 60 ? '部分需要关注' : '存在异常';
  return { ok: true, source: SEEN_GROUPS, generatedAt: new Date().toISOString(), todayMessages: today, activeGroups24h: groups24.size, triggeredToday, days, health: { score, status, checks } };
}

function overview() {
  const patchText = readText(PATCH);
  const parsed = readPatchConfig(patchText);
  const route = parsed.routes.find((r) => r.provider === parsed.model.provider) ?? parsed.routes[0];

  const supportOf = (id) => EFFORT_SUPPORT[id];
  const effortSupport = { ...EFFORT_SUPPORT };
  for (const r of parsed.routes) {
    if (!r.external) continue;
    for (const m of r.models) if (FREE_EFFORT_SUPPORT[m.id]) effortSupport[m.id] = FREE_EFFORT_SUPPORT[m.id];
  }
  const warnings = [];
  if (route?.reasoning) {
    for (const m of route.models) {
      const levels = supportOf(m.id);
      if (levels && !levels.includes(route.reasoning))
        warnings.push(`路由默认推理强度「${route.reasoning}」不被模型 ${m.id} 支持（它只支持 ${levels.join(' / ')}），该模型的请求会报错。`);
    }
  }

  const personaDoc = readPersonas();
  return {
    ok: true,
    paths: { patch: PATCH, personas: PERSONAS, groups: GROUPS, log: LOG, workdir: WORKDIR },
    model: parsed.model,
    providers: parsed.routes.map((r) => r.provider),
    route: route ? { provider: route.provider, models: route.models, reasoning: route.reasoning } : null,
    routes: parsed.routes,
    effortSupport,
    allEfforts: ALL_EFFORTS,
    bot: {
      running: botPids().length > 0,
      pids: botPids(),
      bin: resolveDsh() ?? null,
      log: LOG,
    },
    modelStatus: readJsonFile(MODEL_STATUS, null),
    groups: readGroups(),
    wakeIndex: readWakeIndex(),
    owners: readOwners(),
    people: peopleIndex(),
    personas: personaDoc,
    personaVersion: profileDocumentVersion(personaDoc),
    mtimes: { patch: mtimeOf(PATCH) },
    warnings,
  };
}

// The HTML shell owns layout and overlays; page bodies live in app/pages/*.html.
// Assemble them at request time so the panel remains dependency-free while pages
// can evolve independently from the shared shell.
function renderPanelIndex() {
  let html = readFileSync(INDEX, 'utf8');
  for (const page of PANEL_PAGES) {
    const file = join(PANEL_APP, 'pages', `${page}.html`);
    if (!existsSync(file)) throw new Error(`面板页面缺失：${page}`);
    html = html.replace(`<!--PAGE:${page}-->`, readFileSync(file, 'utf8'));
  }
  for (const component of PANEL_COMPONENTS) {
    const file = join(PANEL_APP, 'components', `${component}.html`);
    if (!existsSync(file)) throw new Error(`面板组件缺失：${component}`);
    html = html.replace(`<!--COMPONENT:${component}-->`, readFileSync(file, 'utf8'));
  }
  return html;
}

function readOwnedMemories() {
  const schedule = validatePersonaSchedule(readProfileDocument(PROFILE_DIR, 'persona-schedule'));
  return listOwnedMemories(INTEREST_DB, schedule);
}

function memoryImageTargetExists(memoryId) {
  if (memoryId === 'bjd') return readOwnedMemories().some(memory => memory.id === memoryId);
  return hasManualMemory(INTEREST_DB, memoryId);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);

  const send = (code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'content-security-policy': "frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  const expectedHost = `127.0.0.1:${PORT}`;
  const expectedOrigin = `http://${expectedHost}`;
  if (req.headers.host !== expectedHost ||
      (req.headers.origin && req.headers.origin !== expectedOrigin) ||
      (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])))
    return send(403, { ok: false, error: '仅允许本机同源访问，请使用控制台打印的 127.0.0.1 地址' });
  const cookies = String(req.headers.cookie ?? '').split(';').map(v => v.trim());
  if (url.pathname.startsWith('/api/') && !cookies.includes(`dsh_bot_session=${SESSION_COOKIE}`))
    return send(401, { ok: false, error: '请先打开本机面板页面' });
  const readBody = (limit = 1024 * 1024, tooLarge = '请求体超出 1 MiB 上限') => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { chunks.length = 0; return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > limit) return reject(Object.assign(new Error(tooLarge), { status: 413 }));
      try { resolve(size === 0 ? {} : JSON.parse(Buffer.concat(chunks, size).toString('utf8'))); }
      catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });

  // Shared panel assets are same-origin and intentionally limited to public/app.
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/app/')) {
    const relative = url.pathname.slice('/app/'.length);
    const file = resolve(PANEL_APP, relative);
    if (!file.startsWith(`${PANEL_APP}${sep}`) || !existsSync(file)) return send(404, { ok: false, error: '面板资源不存在' });
    const type = file.endsWith('.css') ? 'text/css; charset=utf-8'
      : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
    return send(200, readFileSync(file, 'utf8'), type);
  }

  // 页面：任何非 /api 的 GET 都返回面板（换个路径可绕缓存）
  if ((req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/')) {
    if (!existsSync(INDEX)) return send(500, { ok: false, error: 'index.html 缺失' });
    res.setHeader('set-cookie', `dsh_bot_session=${SESSION_COOKIE}; HttpOnly; SameSite=Strict; Path=/`);
    try { return send(200, renderPanelIndex(), 'text/html; charset=utf-8'); }
    catch (err) { return send(500, { ok: false, error: String(err?.message ?? err) }); }
  }

  if (req.method === 'GET' && url.pathname === '/api/provider-settings') {
    try { return send(200, { ok: true, settings: readQqbotProfileDocument(PROFILE_DIR, 'model-providers', profileDocumentTypes['model-providers']) }); }
    catch { return send(500, { ok: false, error: '无法读取模型服务商配置' }); }
  }
  if (req.method === 'PUT' && url.pathname === '/api/provider-settings') {
    readBody().then(body => {
      const provider = String(body.provider || '').trim();
      if (!provider || !/^[\w .-]{1,80}$/.test(provider)) throw new Error('服务商名称无效');
      const current = withProfileDocuments(store => store.update('model-providers', settings => ({
        ...settings,
        [provider]: { ...(Object.hasOwn(settings, provider) ? settings[provider] : {}), baseUrl: String(body.baseUrl || '').trim(), protocol: String(body.protocol || 'openai-completions'), defaultModel: String(body.defaultModel || '').trim(), label: String(body.label || provider).trim() },
      })));
      return send(200, { ok: true, settings: current });
    }).catch(err => send(400, { ok: false, error: String(err?.message ?? err) }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/credentials') {
    try { return send(200, { ok: true, ...withDshCredentialStatus(credentialStatus(PROFILE_DIR), dshModelCredentialNames()) }); }
    catch { return send(500, { ok: false, error: '无法读取本地密钥状态，请检查凭据文件及 Python YAML 支持' }); }
  }
  if (req.method === 'PUT' && url.pathname === '/api/credentials') {
    readBody().then(body => {
      const names = dshModelCredentialNames();
      return send(200, { ok: true, ...withDshCredentialStatus(updateCredentials(PROFILE_DIR, body), names), restartRequired: true });
    }).catch(() => send(400, { ok: false, error: '密钥未保存：请检查输入字段、本地文件格式和权限。不会显示密钥内容。' }));
    return;
  }

  // Settings only: these endpoints never contact OpenAI or start a generation.
  if (req.method === 'GET' && url.pathname === '/api/image-generation') {
    try { return send(200, { ok: true, settings: readImageGenerationSettings(PROFILE_DIR) }); }
    catch { return send(500, { ok: false, error: '无法读取生图配置，请检查本地文件格式和权限。不会显示文件内容。' }); }
  }
  if (req.method === 'PUT' && url.pathname === '/api/image-generation') {
    readBody().then(body => send(200, { ok: true, settings: writeImageGenerationSettings(PROFILE_DIR, body), restartRequired: false }))
      .catch(() => send(400, { ok: false, error: '生图设置未保存：请检查完整字段、枚举值、数值范围及本地文件权限。不会显示文件内容。' }));
    return;
  }

  // 语音合成：只读写配置，不发起任何合成请求。
  if (req.method === 'GET' && url.pathname === '/api/tts') {
    try { return send(200, { ok: true, settings: readTtsSettings(PROFILE_DIR) }); }
    catch { return send(500, { ok: false, error: '无法读取语音配置，请检查本地文件格式和权限。不会显示文件内容。' }); }
  }
  if (req.method === 'PUT' && url.pathname === '/api/tts') {
    readBody().then(body => send(200, { ok: true, settings: writeTtsSettings(PROFILE_DIR, body), restartRequired: false }))
      .catch(() => send(400, { ok: false, error: '语音设置未保存：请检查服务项、顺序、枚举值与数值范围及本地文件权限。不会显示文件内容。' }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard') {
    try { return send(200, dashboardData()); }
    catch (err) { return send(500, { ok: false, error: String(err?.message ?? err) }); }
  }

  if (req.method === 'GET' && url.pathname === '/api/overview') {
    try { return send(200, overview()); }
    catch (err) { return send(500, { ok: false, error: String(err?.message ?? err) }); }
  }

  if (req.method === 'GET' && url.pathname === '/api/bot/status') {
    return send(200, { ok: true, running: botPids().length > 0, pids: botPids(), tail: tailLog(6) });
  }

  if (req.method === 'GET' && url.pathname === '/api/model/status') {
    return send(200, { ok: true, status: readJsonFile(MODEL_STATUS, null) });
  }

  if (req.method === 'POST' && url.pathname === '/api/bot/restart') {
    restartBot()
      .then((result) => send(200, { ok: true, ...result }))
      .catch((err) => send(500, { ok: false, error: String(err?.message ?? err) }));
    return;
  }


  if (req.method === 'GET' && url.pathname === '/api/owners') {
    try { return send(200, { ok: true, owners: readOwners(), people: peopleIndex(), path: OWNERS }); }
    catch (err) { return send(500, { ok: false, error: String(err?.message ?? err) }); }
  }

  if (req.method === 'PUT' && url.pathname === '/api/owners') {
    readBody().then((body) => {
      const result = writeOwners(body);
      return send(200, { ok: true, ...result, restartRequired: false });
    }).catch((err) => send(400, { ok: false, error: String(err?.message ?? err) }));
    return;
  }


  if (req.method === 'PUT' && url.pathname === '/api/model') {
    readBody().then((body) => {
      const provider = String(body.provider ?? '').trim();
      const model = String(body.model ?? '').trim();
      const reasoningEffort = String(body.reasoningEffort ?? '').trim();
      const routeReasoning = String(body.routeReasoning ?? '').trim();
      if (!provider || !model) throw new Error('provider / model 不能为空');
      if (reasoningEffort && !ALL_EFFORTS.includes(reasoningEffort))
        throw new Error(`未知推理强度：${reasoningEffort}`);

      const current = mtimeOf(PATCH);
      if (typeof body.baseMtimeMs === 'number' && body.baseMtimeMs !== 0
        && Math.abs(current - body.baseMtimeMs) > 1)
        return send(409, { ok: false, error: '配置文件已被别处修改，请先刷新页面再保存。' });

      const text = readText(PATCH);
      const parsed = readPatchConfig(text);
      if (!parsed.routes.some((r) => r.provider === provider))
        throw new Error(`provider ${provider} 不在 llm-pi-ai 里`);
      if (!parsed.routes.find((r) => r.provider === provider).models.some((m) => m.id === model))
        throw new Error(`模型 ${model} 不在 ${provider} 的模型列表里`);

      validateModelEfforts(provider, model, reasoningEffort, routeReasoning);
      const next = writePatchConfig(text, {
        provider, model, reasoningEffort,
        routeReasoning: { provider, level: routeReasoning },
      });

      const verdict = validateYaml(next);
      if (verdict && verdict.ok === false) throw new Error(`写出来的 YAML 不合法，已放弃：${verdict.error}`);

      const backup = writeWithBackup(PATCH, next);
      console.log(`[panel] ${new Date().toISOString()} 模型配置已保存：${provider}/${model}${reasoningEffort ? ` effort=${reasoningEffort}` : ''}`);
      return send(200, {
        ok: true, backup, validated: verdict === undefined ? 'skipped' : 'yaml',
        restartRequired: true, mtimeMs: mtimeOf(PATCH),
      });
    }).catch((err) => send(400, { ok: false, error: String(err?.message ?? err) }));
    return;
  }

  if (req.method === 'PUT' && url.pathname === '/api/wake-index') {
    readBody().then((body) => {
      const result = writeWakeIndex(body.groupOpenid, body.value, body.baseVersion);
      console.log(`[panel] ${new Date().toISOString()} 唤醒指数已保存：${body.groupOpenid} = ${result.map[body.groupOpenid] ?? '默认'}`);
      return send(200, { ok: true, ...result, restartRequired: false });
    }).catch((err) => {
      const status = err?.status === 409 ? 409 : 400;
      return send(status, { ok: false, error: String(err?.message ?? err) });
    });
    return;
  }

  if (url.pathname === '/api/persona-schedule') {
    const snapshot = (data) => {
      const normalized = validatePersonaSchedule(data);
      const time = beijingScheduleTime();
      const current = currentPersonaSchedule(normalized, time);
      return { ok: true, scheduleRevision: 2, data: normalized, version: profileDocumentVersion(data), time,
        current: current ? { id: current.id, title: current.title, probability: current.probability, sleep: current.sleep } : null, preview: personaSchedulePrompt(current, time) };
    };
    if (req.method === 'GET') {
      try {
        const data = readProfileDocument(PROFILE_DIR, 'persona-schedule');
        return send(200, snapshot(data));
      } catch {
        return send(500, { ok: false, error: '无法读取周表，请检查本地配置后重试。' });
      }
    }
    if (req.method === 'PUT') {
      readBody().then(({ data, baseVersion }) => {
        const validated = validatePersonaSchedule(data);
        const saved = withProfileDocuments(db => db.update('persona-schedule', current => {
          requireProfileDocumentVersion(current, baseVersion, '时间表', '请先点击「重新读取」。');
          return validated;
        }));
        return send(200, { ...snapshot(saved), restartRequired: false });
      }).catch(err => send(err?.status === 409 ? 409 : 400, { ok: false, error: String(err?.message ?? err) }));
      return;
    }
  }

  if (req.method === 'PUT' && url.pathname === '/api/personas') {
    readBody().then(({ data, baseVersion }) => {
      validatePersonas(data);
      const saved = withProfileDocuments(db => db.update('personas', current => {
        requireProfileDocumentVersion(current, baseVersion, '人格配置');
        return data;
      }));
      return send(200, { ok: true, version: profileDocumentVersion(saved), restartRequired: false });
    }).catch(err => send(err?.status === 409 ? 409 : 400, { ok: false, error: String(err?.message ?? err) }));
    return;
  }

  // ── 群成员档案 ──
  if (req.method === 'GET' && url.pathname === '/api/events') {
    try {
      return send(200, { ok: true, events: readEventsStore().events });
    }
    catch (err) {
      return send(500, { ok: false, error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/events/update') {
    readBody().then((body) => {
      const id = String(body?.id ?? '').trim();
      const status = String(body?.status ?? '').trim();
      if (!id || !['open', 'done', 'dropped'].includes(status))
        return send(400, { ok: false, error: 'id 和 status(open/done/dropped) 必填' });
      const changed = writeEventsStore((state) => {
        const target = state.events.find((event) => event && event.id === id);
        if (!target) return false;
        if (target.status === status) return true;
        if (target.closedAt && target.resultEvidence
            && !target.history?.some(entry => entry.kind === 'close' && entry.at === target.closedAt)) {
          target.history ??= [];
          target.history.push({ kind: 'close', at: target.closedAt, status: target.status, reason: target.closeReason,
            outcomeKind: target.outcomeKind, evidence: target.resultEvidence, person: target.resultPerson });
        }
        target.status = status;
        target.closedAt = status === 'open' ? undefined : Date.now();
        target.closeReason = status === 'open' ? undefined : 'manual';
        target.outcomeKind = undefined;
        target.resultEvidence = undefined;
        target.resultMessageId = undefined;
        target.resultPerson = undefined;
        target.resultPersonId = undefined;
        return true;
      });
      return send(changed ? 200 : 404, changed ? { ok: true } : { ok: false, error: '没有这条事件' });
    }).catch((err) => send(400, { ok: false, error: String(err?.message ?? err) }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/person-memories') {
    const gid = url.searchParams.get('gid') ?? '';
    const name = url.searchParams.get('name') ?? '';
    if (!gid || !name)
      return send(400, { ok: false, error: 'gid 和 name 必填' });
    import('node:sqlite').then(({ DatabaseSync }) => {
      const dbPath = join(homedir(), '.dsh', 'memory', 'ltm.db');
      if (!existsSync(dbPath))
        return send(200, { ok: true, memories: [] });
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const scope = `qq:group:${gid}`;
        const card = db.prepare("select text, tags, created_at, updated_at from memories where tags like ? order by updated_at desc limit 1")
          .get(`%近况卡 ${name}%`);
        const rows = db.prepare("select text, tags, created_at, updated_at from memories where scope = ? and tags not like '%近况卡%' and ((' ' || tags || ' ') like ? or text like ?) order by updated_at desc limit 9")
          .all(scope, `% ${name} %`, `%] ${name}：%`);
        const all = [card, ...rows].filter(Boolean);
        return send(200, {
          ok: true,
          memories: all.map((row) => ({
            text: String(row.text ?? ''),
            tags: String(row.tags ?? ''),
            at: new Date(Number(row.updated_at || row.created_at)).toISOString(),
            card: String(row.tags ?? '').includes('近况卡'),
          })),
        });
      }
      finally {
        db.close();
      }
    }).catch((err) => send(500, { ok: false, error: String(err?.message ?? err) }));
    return;
  }

  // ── 私人记忆库：整套人格范围；旧按群范围保留至手动切换 ──
  const memoryDbPath = () => INTEREST_DB;
  const memoryMarker = (id) => `pm:${id}`;
  const ensureMemoryTables = (db) => {
    db.exec(`create table if not exists bot_memory_library (
      id integer primary key autoincrement,
      topic text not null default '',
      text text not null,
      tags text not null default '',
      pinned integer not null default 0,
      min_affinity integer not null default 0 check(min_affinity between 0 and 100),
      min_familiarity integer not null default 0 check(min_familiarity between 0 and 100),
      created_at integer not null,
      updated_at integer not null
    )`);
    const columns = () => db.prepare('pragma table_info(bot_memory_library)').all().map(row => row.name);
    const required = {
      topic: "text not null default ''",
      min_affinity: 'integer not null default 0 check(min_affinity between 0 and 100)',
      min_familiarity: 'integer not null default 0 check(min_familiarity between 0 and 100)',
    };
    const before = columns();
    if (Object.keys(required).some(column => !before.includes(column))) {
      db.exec('begin immediate');
      try {
        const existing = columns();
        for (const [column, definition] of Object.entries(required)) {
          if (!existing.includes(column)) db.exec(`alter table bot_memory_library add column ${column} ${definition}`);
        }
        db.exec('commit');
      } catch (err) {
        db.exec('rollback');
        throw err;
      }
    }
    db.exec(`create table if not exists bot_memory_groups (
      memory_id integer not null,
      group_openid text not null,
      primary key (memory_id, group_openid)
    )`);
    db.exec('create index if not exists idx_bot_memory_groups_group on bot_memory_groups(group_openid)');
    // 旧片段范围只保留用于提示，不再参与召回。
    db.exec(`create table if not exists bot_memory_module_scope (
      memory_id integer primary key, module_ids text not null
    )`);
    db.exec(`create table if not exists bot_memory_persona_scope (
      memory_id integer primary key, persona_ids text not null
    )`);
    // 仅旧按群记忆继续使用 self_memories 投影。
    db.exec(`create table if not exists self_memories (
      id integer primary key autoincrement,
      topic text not null,
      summary text not null,
      detail text not null default '',
      tags text not null default '',
      created_at integer not null,
      updated_at integer not null,
      last_used_at integer not null default 0,
      use_count integer not null default 0
    )`);
    db.exec('create unique index if not exists self_memories_topic on self_memories(topic)');
  };

  /** 内容没有主题时，取第一行当 topic */
  const privateMemoryTopic = (text, id) => {
    const line = String(text ?? '').split('\n').map((s) => s.trim()).find(Boolean) ?? '';
    return line.slice(0, 40) || `记忆 #${id}`;
  };

  const hasMemoryTable = (db, name) => Boolean(db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name));
  const clearGroupProjections = (db, marker) => {
    if (!hasMemoryTable(db, 'memories')) return;
    const projected = db.prepare("select id from memories where (' ' || tags || ' ') like ?").all(`% ${marker} %`);
    const vectors = hasMemoryTable(db, 'memory_vectors');
    for (const row of projected) {
      db.prepare('delete from memories where id = ?').run(row.id);
      if (vectors) db.prepare('delete from memory_vectors where memory_id = ?').run(row.id);
    }
  };

  const syncPrivateMemory = (db, id) => {
    const lib = db.prepare('select * from bot_memory_library where id = ?').get(id);
    if (!lib) return;
    const groups = db.prepare('select group_openid from bot_memory_groups where memory_id = ?').all(id);
    const marker = memoryMarker(id);
    clearGroupProjections(db, marker);
    const existing = db.prepare("select * from self_memories where (' ' || tags || ' ') like ? limit 1")
      .get(`% ${marker} %`);
    if (groups.length === 0 || db.prepare('select 1 from bot_memory_persona_scope where memory_id = ?').get(id)
      || db.prepare('select 1 from bot_memory_module_scope where memory_id = ?').get(id)) {
      if (existing)
        db.prepare('delete from self_memories where id = ?').run(existing.id);
      return;
    }

    const text = String(lib.text ?? '').trim();
    const topic = String(lib.topic ?? '').trim().slice(0, 40) || privateMemoryTopic(text, id);
    // self_memories 的概括上限 160 字；更长的正文放 detail，注入时只截前 200 字
    const summary = text.length > 160 ? text.slice(0, 160) : text;
    const detail = text.length > 160 ? text : '';
    const tags = [String(lib.tags ?? '').trim(), marker].filter(Boolean).join(' ');
    const now = Date.now();

    let nextTopic = topic;
    const clash = db.prepare('select id from self_memories where lower(topic) = lower(?) and id <> ? limit 1')
      .get(nextTopic, Number(existing?.id ?? 0));
    if (clash)
      nextTopic = `${nextTopic.slice(0, 34)} #${id}`;

    if (existing) {
      db.prepare('update self_memories set topic = ?, summary = ?, detail = ?, tags = ?, updated_at = ? where id = ?')
        .run(nextTopic, summary, detail, tags, now, existing.id);
      return;
    }
    db.prepare('insert into self_memories (topic, summary, detail, tags, created_at, updated_at, last_used_at, use_count) values (?, ?, ?, ?, ?, ?, 0, 0)')
      .run(nextTopic, summary, detail, tags, now, now);
  };
  const readMemoryLibrary = (db, gid) => {
    const rows = db.prepare('select * from bot_memory_library order by pinned desc, updated_at desc').all();
    const links = db.prepare('select memory_id, group_openid from bot_memory_groups').all();
    const byId = new Map();
    const scopes = new Map(db.prepare('select * from bot_memory_persona_scope').all().map(
      (row) => [Number(row.memory_id), JSON.parse(row.persona_ids)],
    ));
    const paused = new Set(db.prepare("select memory_id from bot_memory_module_scope where json_array_length(module_ids) > 0")
      .all().map((row) => Number(row.memory_id)));
    for (const link of links) {
      const key = Number(link.memory_id);
      if (!byId.has(key))
        byId.set(key, []);
      byId.get(key).push(String(link.group_openid ?? ''));
    }
    return rows
      .map((row) => ({
        id: Number(row.id),
        topic: String(row.topic ?? ''),
        text: String(row.text ?? ''),
        tags: String(row.tags ?? ''),
        pinned: Number(row.pinned) === 1,
        minAffinity: row.min_affinity,
        minFamiliarity: row.min_familiarity,
        scopeType: scopes.has(Number(row.id)) ? 'personas' : paused.has(Number(row.id)) ? 'legacy-modules' : byId.has(Number(row.id)) ? 'legacy-groups' : 'personas',
        personaIds: scopes.get(Number(row.id)) ?? [],
        groups: scopes.has(Number(row.id)) || paused.has(Number(row.id)) ? [] : byId.get(Number(row.id)) ?? [],
        createdAt: new Date(Number(row.created_at)).toISOString(),
        updatedAt: new Date(Number(row.updated_at)).toISOString(),
      }))
      .filter((item) => !gid || item.groups.includes(gid));
  };
  const privateMemoryTags = (value) => String(value ?? '').trim().slice(0, 300)
    .split(/\s+/).filter((tag) => !/^pm:\d+$/i.test(tag)).join(' ');
  const memoryShareThresholds = ({ minAffinity, minFamiliarity }) => {
    if ([minAffinity, minFamiliarity].some(value =>
      value !== undefined && (!Number.isInteger(value) || value < 0 || value > 100))) {
      throw new Error('分享阈值须为 0 到 100 的整数。');
    }
    return [minAffinity, minFamiliarity];
  };
  const memoryPersonaCatalog = () => {
    const doc = readPersonas();
    const entries = doc.personas ?? {};
    // Match the studio ordering and group identical assembled profiles. Do not offer an inherited placeholder.
    const keys = new Set(['default', '*', ...readGroups().map(({ id }) => id), ...Object.keys(entries)]);
    const profiles = new Map();
    for (const key of keys) {
      if (!Object.hasOwn(entries, key)) continue;
      const entry = entries[key];
      const modules = Array.isArray(entry) ? entry : entry?.modules;
      if (!Array.isArray(modules) || !modules.some((id) => typeof doc.modules?.[id] === 'string' && doc.modules[id].trim())) continue;
      const archetype = entry?.archetype ?? '';
      // Composition is the studio's identity, not the group key (group assignment can change).
      const id = JSON.stringify([modules, archetype]);
      if (!profiles.has(id)) profiles.set(id, { id, key, name: typeof entry?.name === 'string' ? entry.name.trim() : '', modules: modules.slice(), archetype, firstModule: modules[0] });
    }
    return [...profiles.values()];
  };

  if (req.method === 'GET' && url.pathname === '/api/memory-library/personas') {
    try { return send(200, { ok: true, profiles: memoryPersonaCatalog() }); }
    catch (err) { return send(500, { ok: false, error: `读取已保存的人格失败：${err.message}` }); }
  }

  if (req.method === 'PUT' && url.pathname === '/api/memory-library/scope') {
    readBody().then(async (body) => {
      const id = Number(body?.id);
      if (!Number.isInteger(id) || id <= 0 || !Array.isArray(body?.personaIds)
        || body.personaIds.some((value) => typeof value !== 'string'))
        return send(400, { ok: false, error: '请输入有效的记忆 id 和人格列表。' });
      const personaIds = [...new Set(body.personaIds)];
      const { DatabaseSync } = await import('node:sqlite');
      const known = new Set(memoryPersonaCatalog().map(({ id }) => id));
      if (personaIds.some((personaId) => !known.has(personaId)))
        return send(409, { ok: false, error: '人格列表已变化，请关闭弹窗后重新打开。' });
      const dbPath = memoryDbPath();
      if (!existsSync(dbPath)) return send(404, { ok: false, error: '记忆不存在。' });
      const db = new DatabaseSync(dbPath);
      try {
        ensureMemoryTables(db);
        db.exec('begin immediate');
        if (!db.prepare('select 1 from bot_memory_library where id = ?').get(id)) {
          db.exec('rollback');
          return send(404, { ok: false, error: '记忆不存在。' });
        }
        db.prepare(`insert into bot_memory_persona_scope (memory_id, persona_ids) values (?, ?)
          on conflict(memory_id) do update set persona_ids = excluded.persona_ids`).run(id, JSON.stringify(personaIds));
        db.prepare('delete from bot_memory_groups where memory_id = ?').run(id);
        db.prepare('delete from bot_memory_module_scope where memory_id = ?').run(id);
        syncPrivateMemory(db, id);
        db.exec('commit');
        return send(200, { ok: true, personaIds });
      }
      catch (err) {
        try { db.exec('rollback'); } catch { /* 无活动事务 */ }
        throw err;
      }
      finally { db.close(); }
    }).catch((err) => send(500, { ok: false, error: err.message }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/memory-library') {
    const gid = url.searchParams.get('gid') ?? '';
    const dbPath = memoryDbPath();
    if (!existsSync(dbPath))
      return send(200, { ok: true, memories: [] });
    import('node:sqlite').then(({ DatabaseSync }) => {
      const db = new DatabaseSync(dbPath);
      try {
        ensureMemoryTables(db);
        return send(200, { ok: true, memories: withMemoryImages(PROFILE_DIR, readMemoryLibrary(db, gid)) });
      }
      finally {
        db.close();
      }
    }).catch((err) => send(500, { ok: false, error: String(err?.message ?? err) }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/memory-library') {
    readBody().then((body) => {
      const topic = String(body?.topic ?? '').trim().slice(0, 40);
      const text = String(body?.text ?? '').trim();
      const tags = privateMemoryTags(body?.tags);
      const pinned = body?.pinned === true ? 1 : 0;
      const [minAffinity = 0, minFamiliarity = 0] = memoryShareThresholds(body ?? {});
      if (!text)
        return send(400, { ok: false, error: '内容必填' });
      if (text.length > 4000)
        return send(400, { ok: false, error: '内容太长（上限 4000 字）' });
      const dbPath = memoryDbPath();
      import('node:sqlite').then(({ DatabaseSync }) => {
        mkdirSync(dirname(dbPath), { recursive: true });
        const db = new DatabaseSync(dbPath);
        try {
          ensureMemoryTables(db);
          db.exec('begin');
          const now = Date.now();
          const info = db.prepare(`insert into bot_memory_library
            (topic, text, tags, pinned, min_affinity, min_familiarity, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(topic, text, tags, pinned, minAffinity, minFamiliarity, now, now);
          const id = Number(info.lastInsertRowid);
          db.prepare("insert into bot_memory_persona_scope (memory_id, persona_ids) values (?, '[]')").run(id);
          db.exec('commit');
          return send(200, { ok: true, id });
        }
        catch (err) {
          try { db.exec('rollback'); } catch { /* 忽略 */ }
          throw err;
        }
        finally {
          db.close();
        }
      }).catch((err) => send(500, { ok: false, error: String(err?.message ?? err) }));
    }).catch((err) => send(400, { ok: false, error: String(err?.message ?? err) }));
    return;
  }

  if (req.method === 'PUT' && url.pathname === '/api/memory-library') {
    readBody().then((body) => {
      const id = Number(body?.id);
      const topic = String(body?.topic ?? '').trim().slice(0, 40);
      const text = String(body?.text ?? '').trim();
      const tags = privateMemoryTags(body?.tags);
      const pinned = body?.pinned === true ? 1 : 0;
      const [minAffinity = null, minFamiliarity = null] = memoryShareThresholds(body ?? {});
      if (!Number.isInteger(id) || id <= 0 || !text)
        return send(400, { ok: false, error: 'id 和内容必填' });
      if (text.length > 4000)
        return send(400, { ok: false, error: '内容太长（上限 4000 字）' });
      const dbPath = memoryDbPath();
      if (!existsSync(dbPath))
        return send(400, { ok: false, error: '长期记忆库还不存在。' });
      import('node:sqlite').then(({ DatabaseSync }) => {
        const db = new DatabaseSync(dbPath);
        try {
          ensureMemoryTables(db);
          db.exec('begin');
          const info = db.prepare(`update bot_memory_library set topic = ?, text = ?, tags = ?, pinned = ?,
            min_affinity = coalesce(?, min_affinity), min_familiarity = coalesce(?, min_familiarity), updated_at = ? where id = ?`)
            .run(topic, text, tags, pinned, minAffinity, minFamiliarity, Date.now(), id);
          if (Number(info.changes) === 0) {
            db.exec('rollback');
            return send(404, { ok: false, error: '没有这条记忆。' });
          }
          syncPrivateMemory(db, id);
          db.exec('commit');
          return send(200, { ok: true });
        }
        catch (err) {
          try { db.exec('rollback'); } catch { /* 忽略 */ }
          throw err;
        }
        finally {
          db.close();
        }
      }).catch((err) => send(500, { ok: false, error: String(err?.message ?? err) }));
    }).catch((err) => send(400, { ok: false, error: String(err?.message ?? err) }));
    return;
  }

  if (req.method === 'DELETE' && url.pathname === '/api/memory-library') {
    const id = Number(url.searchParams.get('id'));
    if (!Number.isInteger(id) || id <= 0)
      return send(400, { ok: false, error: 'id 必填' });
    const dbPath = memoryDbPath();
    if (!existsSync(dbPath))
      return send(404, { ok: false, error: '长期记忆库还不存在。' });
    import('node:sqlite').then(({ DatabaseSync }) => {
      const db = new DatabaseSync(dbPath);
      try {
        ensureMemoryTables(db);
        db.exec('begin');
        const marker = memoryMarker(id);
        clearGroupProjections(db, marker);
        db.prepare("delete from self_memories where (' ' || tags || ' ') like ?").run(`% ${marker} %`);
        db.prepare('delete from bot_memory_groups where memory_id = ?').run(id);
        db.prepare('delete from bot_memory_module_scope where memory_id = ?').run(id);
        db.prepare('delete from bot_memory_persona_scope where memory_id = ?').run(id);
        db.prepare('delete from bot_memory_library where id = ?').run(id);
        db.exec('commit');
        return send(200, { ok: true });
      }
      catch (err) {
        try { db.exec('rollback'); } catch { /* 忽略 */ }
        throw err;
      }
      finally {
        db.close();
      }
    }).catch((err) => send(500, { ok: false, error: String(err?.message ?? err) }));
    return;
  }

  // ── 群内自动记忆：机器人自己攒的，按群查看 / 编辑 / 删除 ──
  if (req.method === 'GET' && url.pathname === '/api/memories') {
    const gid = url.searchParams.get('gid') ?? '';
    const q = (url.searchParams.get('q') ?? '').trim();
    if (!gid)
      return send(400, { ok: false, error: 'gid 必填' });
    const dbPath = memoryDbPath();
    if (!existsSync(dbPath))
      return send(200, { ok: true, memories: [] });
    import('node:sqlite').then(({ DatabaseSync }) => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        if (!hasMemoryTable(db, 'memories')) return send(200, { ok: true, memories: [] });
        const params = [`qq:group:${gid}`];
        let where = "scope = ? and tags not like '%pm:%'";
        if (q !== '') {
          where += ' and (text like ? or tags like ?)';
          params.push(`%${q}%`, `%${q}%`);
        }
        const rows = db.prepare(`select id, text, tags, pinned, created_at, updated_at from memories where ${where} order by pinned desc, updated_at desc limit 300`).all(...params);
        return send(200, {
          ok: true,
          memories: rows.map((row) => ({
            id: Number(row.id),
            text: String(row.text ?? ''),
            tags: String(row.tags ?? ''),
            pinned: Number(row.pinned) === 1,
            createdAt: new Date(Number(row.created_at)).toISOString(),
            updatedAt: new Date(Number(row.updated_at)).toISOString(),
            ...memoryPresentation(row),
          })),
        });
      }
      finally {
        db.close();
      }
    }).catch((err) => send(500, { ok: false, error: String(err?.message ?? err) }));
    return;
  }

  if (req.method === 'PUT' && url.pathname === '/api/memories') {
    readBody().then((body) => {
      const id = Number(body?.id);
      const gid = String(body?.gid ?? '').trim();
      const text = String(body?.text ?? '').trim();
      const tags = String(body?.tags ?? '').trim().slice(0, 300);
      const pinned = body?.pinned === true ? 1 : 0;
      if (!Number.isInteger(id) || id <= 0 || !gid || !text)
        return send(400, { ok: false, error: 'id、群和内容必填' });
      if (text.length > 4000)
        return send(400, { ok: false, error: '内容太长（上限 4000 字）' });
      const dbPath = memoryDbPath();
      if (!existsSync(dbPath))
        return send(400, { ok: false, error: '长期记忆库还不存在。' });
      import('node:sqlite').then(({ DatabaseSync }) => {
        const db = new DatabaseSync(dbPath);
        try {
          const info = db.prepare("update memories set text = ?, tags = ?, pinned = ?, updated_at = ?, revision = revision + 1 where id = ? and scope = ? and tags not like '%pm:%'")
            .run(text, tags, pinned, Date.now(), id, `qq:group:${gid}`);
          if (Number(info.changes) === 0)
            return send(404, { ok: false, error: '没有这条记忆，或它是记忆库投影（请到记忆库编辑）。' });
          try { db.prepare('delete from memory_vectors where memory_id = ?').run(id); } catch { /* 表不存在 */ }
          return send(200, { ok: true });
        }
        finally {
          db.close();
        }
      }).catch((err) => send(500, { ok: false, error: String(err?.message ?? err) }));
    }).catch((err) => send(400, { ok: false, error: String(err?.message ?? err) }));
    return;
  }

  if (req.method === 'DELETE' && url.pathname === '/api/memories') {
    const id = Number(url.searchParams.get('id'));
    const gid = url.searchParams.get('gid') ?? '';
    if (!Number.isInteger(id) || id <= 0 || !gid)
      return send(400, { ok: false, error: 'id 和 gid 必填' });
    const dbPath = memoryDbPath();
    if (!existsSync(dbPath))
      return send(404, { ok: false, error: '长期记忆库还不存在。' });
    import('node:sqlite').then(({ DatabaseSync }) => {
      const db = new DatabaseSync(dbPath);
      try {
        const info = db.prepare("delete from memories where id = ? and scope = ? and tags not like '%pm:%'").run(id, `qq:group:${gid}`);
        if (Number(info.changes) === 0)
          return send(404, { ok: false, error: '没有这条记忆，或它是记忆库投影（请到记忆库删除）。' });
        try { db.prepare('delete from memory_vectors where memory_id = ?').run(id); } catch { /* 表不存在 */ }
        return send(200, { ok: true });
      }
      finally {
        db.close();
      }
    }).catch((err) => send(500, { ok: false, error: String(err?.message ?? err) }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/people') {
    try {
      return send(200, { ok: true, path: PEOPLE, ...readPeopleSnapshot(), groupsPath: GROUPS_META });
    }
    catch (err) {
      return send(500, { ok: false, error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'PUT' && url.pathname === '/api/people') {
    readBody().then((body) => {
      const result = writePeopleStore(body.data, body.baseVersion);
      console.log(`[panel] ${new Date().toISOString()} 群成员档案已保存：${result.count} 人`);
      return send(200, { ok: true, ...result, path: PEOPLE });
    }).catch((err) => send(err?.status === 409 ? 409 : 400, { ok: false, error: String(err?.message ?? err) }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/groups') {
    Promise.resolve().then(async () => {
      const result = { ok: true, groups: readQqbotGroupDirectory(PROFILE_DIR), path: GROUPS_META };
      if (url.searchParams.get('discover') === '1') {
        const registered = new Set(result.groups.map(group => group.id));
        const observed = await readObservedGroups(PROFILE_DIR);
        result.discovered = [...observed.values()].reverse()
          .filter(group => !registered.has(group.id))
          .map(group => ({ id: group.id, observed: group.members.size }));
      }
      return send(200, result);
    }).catch(() => send(500, { ok: false, error: '无法读取群列表' }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/groups/archive') {
    readBody().then(async body => {
      const id = typeof body?.groupOpenid === 'string' ? body.groupOpenid.trim() : '';
      if (!/^[\w-]{1,128}$/.test(id)) return send(400, { ok: false, error: '群 OpenID 格式有误' });
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      try {
        const result = await archiveObservedGroup(PROFILE_DIR, id, name);
        return send(200, { ok: true, ...result, version: profileDocumentVersion(result.data) });
      }
      catch (error) { return send(error.status ?? 500, { ok: false, error: error.message }); }
    }).catch(error => send(400, { ok: false, error: error.message }));
    return;
  }

  if (req.method === 'PUT' && url.pathname === '/api/groups') {
    readBody().then((body) => {
      const result = writeGroupsMeta(body.groups);
      console.log(`[panel] ${new Date().toISOString()} 群列表已保存：${result.count} 个群`);
      return send(200, { ok: true, ...result, path: GROUPS_META });
    }).catch((err) => send(400, { ok: false, error: String(err?.message ?? err) }));
    return;
  }

  // 群兴趣画像：总开关 / 搜索模式 / 分享模式 / 每个群的话题和发现
  if (req.method === 'GET' && url.pathname === '/api/interest') {
    try {
      const gid = String(url.searchParams.get('gid') ?? '').trim();
      const config = readInterestConfig();
      const state = readInterestState();
      const activity = readInterestActivity();
      const db = openInterestDb();
      const counts = db ? interestCounts(db) : new Map();
      const meta = new Map(readGroups().map((group) => [String(group.id ?? ''), String(group.name ?? '')]));
      for (const id of Object.keys(config.groups ?? {})) {
        if (!meta.has(id)) meta.set(id, id);
      }
      const groups = [...meta.entries()].map(([id, name]) => ({
        gid: id,
        name,
        activity: Number(activity.groups[id]?.score ?? 0),
        messages24h: Number(activity.groups[id]?.msg24h ?? 0),
        topics: counts.get(id)?.topics ?? 0,
        findings: counts.get(id)?.findings ?? 0,
        config: config.groups?.[id] ?? {},
        state: state.groups?.[id] ?? {},
      })).sort((a, b) => (b.activity - a.activity) || a.name.localeCompare(b.name, 'zh'));
      const detail = gid !== '' ? interestGroupDetail(db, gid) : { topics: [], findings: [], runs: [] };
      try { db?.close(); } catch { /* 忽略 */ }
      return send(200, {
        ok: true,
        config,
        searchMode: String(config.search?.mode ?? config.searchMode ?? 'manual'),
        shareMode: String(config.shareMode ?? 'off'),
        activityAt: activity.at,
        groups,
        ...detail,
        paths: { config: INTEREST_CONFIG, db: INTEREST_DB },
      });
    }
    catch (err) {
      return send(500, { ok: false, error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'PUT' && url.pathname === '/api/interest') {
    readBody().then(async (body) => {
      const config = withProfileDocuments(db => db.update('interest-config', current => {
        if (body && typeof body.gid === 'string' && body.gid.trim() !== '') {
          const gid = body.gid.trim();
          const groups = current.groups && typeof current.groups === 'object' ? { ...current.groups } : {};
          const patch = normalizeInterestGroup(body.group);
          groups[gid] = { ...(groups[gid] ?? {}), ...patch };
          const next = { ...current, groups };
          return next;
        }
        const patch = normalizeInterestConfig(body?.config ?? body);
        const next = { ...current, ...patch };
        if (patch.search)
          next.search = { ...(current.search && typeof current.search === 'object' ? current.search : {}), ...patch.search };
        return next;
      }));
      return send(200, { ok: true, config, backup: null });
    }).catch((err) => send(400, { ok: false, error: String(err?.message ?? err) }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/personal-album') {
    try { return send(200, { ok: true, photos: listAlbumPhotos(PROFILE_DIR) }); }
    catch { return send(500, { ok: false, error: '无法读取小易的相册索引' }); }
  }

  if (req.method === 'GET' && url.pathname === '/api/personal-album/memories') {
    try {
      return send(200, { ok: true, memories: withMemoryImages(PROFILE_DIR, readOwnedMemories()) });
    } catch {
      return send(500, { ok: false, error: '无法读取小易自己的东西' });
    }
  }

  if (url.pathname === '/api/personal-album/memory-image') {
    if (req.method === 'POST') {
      readBody(MEMORY_IMAGE_BODY_LIMIT, '图片大小不能超过 8 MiB。').then(body => {
        if (body?.memoryId !== 'bjd' && (!Number.isSafeInteger(body?.memoryId) || body.memoryId <= 0)) {
          return send(400, { ok: false, error: '请选择要关联的记忆。' });
        }
        let image;
        try { image = validateMemoryImage(body); }
        catch (err) { return send(400, { ok: false, error: err.message }); }
        try {
          if (!memoryImageTargetExists(body.memoryId)) {
            return send(404, { ok: false, error: '这条记忆已不存在，请刷新后重试。' });
          }
          return send(200, { ok: true, ...saveMemoryImage(PROFILE_DIR, body.memoryId, image) });
        } catch {
          return send(500, { ok: false, error: '无法保存记忆图片，请重试。' });
        }
      }).catch(err => send(err.status ?? 400, { ok: false, error: err.message }));
      return;
    }
    if (req.method === 'GET') {
      const id = Number(url.searchParams.get('id'));
      const value = url.searchParams.get('memoryId');
      const memoryId = value === 'bjd' ? value : Number(value);
      if (!Number.isSafeInteger(id) || id <= 0 ||
          (memoryId !== 'bjd' && (!Number.isSafeInteger(memoryId) || memoryId <= 0))) {
        return send(400, { ok: false, error: '图片编号或记忆编号无效。' });
      }
      try {
        const photo = memoryImageTargetExists(memoryId) && readMemoryImage(PROFILE_DIR, id, memoryId);
        if (!photo) return send(404, { ok: false, error: '这条记忆下没有这张图片。' });
        res.writeHead(200, { 'content-type': photo.type, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
        return res.end(photo.data);
      } catch {
        return send(500, { ok: false, error: '无法读取记忆图片。' });
      }
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/personal-album/photo') {
    const id = Number(url.searchParams.get('id'));
    if (!Number.isSafeInteger(id) || id <= 0) return send(400, { ok: false, error: '图片编号无效' });
    try {
      const photo = readAlbumPhoto(PROFILE_DIR, id);
      if (!photo) return send(404, { ok: false, error: '图片文件不存在' });
      res.writeHead(200, { 'content-type': photo.type, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
      return res.end(photo.data);
    } catch {
      return send(500, { ok: false, error: '无法读取相册图片' });
    }
  }

  // 图库：收图/放图名单（只读，供面板显示）
  if (req.method === 'GET' && url.pathname === '/api/media/allow') {
    try {
      const parsed = readProfileDocument(PROFILE_DIR, 'media-allow');
      return send(200, { ok: true, people: Array.isArray(parsed.people) ? parsed.people : [] });
    }
    catch {
      return send(200, { ok: true, people: [] });
    }
  }

  // 角色模块：按人读各模块的生效状态
  if (req.method === 'GET' && url.pathname === '/api/modules') {
    try {
      const people = readPeopleStore().people;
      const docs = Object.fromEntries(['person-modules', 'media-allow', 'role-skills'].map(type => [type, readProfileDocument(PROFILE_DIR, type)]));
      const out = {};
      for (const person of people) {
        if (!person?.name) continue;
        out[person.name] = effectiveModuleFor(person, docs);
      }
        const roleDoc = docs['role-skills'];
        // 能力型技能（如生图权限）不是语言风格，不列入「风格」下拉。
        const skills = (Array.isArray(roleDoc.skills) ? roleDoc.skills : [])
          .filter((skill) => skill && skill.enabled !== false && skill.kind !== 'capability')
          .map((skill) => ({ id: String(skill.id ?? ''), name: String(skill.name ?? skill.id ?? '') }));
        return send(200, { ok: true, people: out, skills });
      } catch (err) { return send(500, { ok: false, error: String(err?.message ?? err) }); }
    }

    // 角色模块：保存一个人的各模块，并同步收图名单 / 角色技能
    if (req.method === 'PUT' && url.pathname === '/api/modules') {
      readBody().then((body) => {
        const name = String(body.name ?? '').trim();
        const person = readPeopleStore().people.find((item) => item.name === name);
        if (!person)
          return send(404, { ok: false, error: `档案里没有「${name}」` });
        const input = body.modules && typeof body.modules === 'object' ? body.modules : {};
        const categories = Array.isArray(input.collectImages?.categories)
          ? [...new Set(input.collectImages.categories.map((value) => String(value ?? '').trim()).filter(Boolean))].slice(0, 5)
          : [];
        const topics = Array.isArray(input.topics?.topics)
          ? [...new Set(input.topics.topics.map((value) => String(value ?? '').trim()).filter(Boolean))].slice(0, 10)
          : [];
        const styleSkill = String(input.style?.skill ?? '').trim();
        const saved = withProfileDocuments(db => db.updateMany(['person-modules', 'media-allow', 'role-skills'], docs => {
        const roleDoc = docs['role-skills'];
        if (!Array.isArray(roleDoc.skills)) roleDoc.skills = [];
        const skillExists = roleDoc.skills.some(skill => skill?.id === styleSkill && skill.kind !== 'capability');
        const next = {
          collectImages: { enabled: input.collectImages?.enabled === true, categories },
          topics: { enabled: input.topics?.enabled === true, topics },
          style: { enabled: input.style?.enabled === true && styleSkill !== '' && skillExists, skill: styleSkill },
          imageGen: { enabled: input.imageGen?.enabled === true },
          voiceGen: { enabled: input.voiceGen?.enabled === true },
        };

        const modulesDoc = docs['person-modules'];
        modulesDoc.people = { ...modulesDoc.people, [name]: next };

        // 收图模块 → 收图名单（媒体库读的是这份）
        const allowDoc = docs['media-allow'];
        const openids = Array.isArray(person.openids) ? person.openids : [];
        const groups = Array.isArray(person.groups) ? person.groups : [];
        const allowPeople = (Array.isArray(allowDoc.people) ? allowDoc.people : []).filter((entry) =>
          entry && !(entry.name === name || (Array.isArray(entry.openids) && entry.openids.some((id) => openids.includes(id)))));
        if (next.collectImages.enabled) {
          allowPeople.push({ name, openids, groups, categories, all: false });
        }
        allowDoc.people = allowPeople;

        // 语言风格模块 → 角色技能注册表
        for (const skill of roleDoc.skills) {
          if (!Array.isArray(skill.audiences)) skill.audiences = [];
          skill.audiences = skill.audiences.filter((audience) =>
            audience && !(audience.person === name || (Array.isArray(audience.openids) && audience.openids.some((id) => openids.includes(id)))));
        }
        if (next.style.enabled) {
          const skill = roleDoc.skills.find((item) => item.id === styleSkill);
          if (skill) skill.audiences.push({ person: name, openids, groups, default: true });
        }
        // 生图模块 → 生图技能（imagePermission.skill，缺省 image-gen）的受众；
        // 技能不存在就建一个纯权限技能（没有 SKILL.md，不注入提示词）。
        const imageSkillId = imageSkillIdOf(roleDoc);
        let imageSkill = roleDoc.skills.find((item) => item && String(item.id ?? '') === imageSkillId);
        if (imageSkill && Array.isArray(imageSkill.audiences)) {
          imageSkill.audiences = imageSkill.audiences.filter((audience) =>
            audience && !(audience.person === name || (Array.isArray(audience.openids) && audience.openids.some((id) => openids.includes(id)))));
        }
        if (next.imageGen.enabled) {
          if (!imageSkill) {
            imageSkill = {
              id: imageSkillId, name: '生图', category: '能力', kind: 'capability', enabled: true,
              description: '允许让机器人画图的人。只认这个技能的受众，不注入提示词。', audiences: [],
            };
            roleDoc.skills.push(imageSkill);
          }
          if (!Array.isArray(imageSkill.audiences)) imageSkill.audiences = [];
          imageSkill.audiences.push({ person: name, openids, groups, default: true });
        }
        // 语音模块 → 语音技能（voicePermission.skill，缺省 voice-gen）的受众；同样只建纯权限技能。
        const voiceSkillId = voiceSkillIdOf(roleDoc);
        let voiceSkill = roleDoc.skills.find((item) => item && String(item.id ?? '') === voiceSkillId);
        if (next.voiceGen.enabled) {
          if (!voiceSkill) {
            voiceSkill = {
              id: voiceSkillId, name: '语音', category: '能力', kind: 'capability', enabled: true,
              description: '允许让机器人发语音的人。只认这个技能的受众，不注入提示词。语音要烧本机算力。', audiences: [],
            };
            roleDoc.skills.push(voiceSkill);
          }
          if (!Array.isArray(voiceSkill.audiences)) voiceSkill.audiences = [];
          voiceSkill.audiences.push({ person: name, openids, groups, default: true });
        }
        return docs;
      }));
      return send(200, { ok: true, modules: effectiveModuleFor(person, saved) });
    }).catch((err) => send(400, { ok: false, error: String(err?.message ?? err) }));
    return;
  }

  // 图库：保存收图/放图名单（勾人 + 分类）
  if (req.method === 'PUT' && url.pathname === '/api/media/allow') {
    readBody().then((body) => {
      const wanted = Array.isArray(body.people) ? body.people : [];
      const store = readPeopleStore();
      const { people } = withProfileDocuments(db => db.update('media-allow', previous => {
        const prevMap = new Map((Array.isArray(previous.people) ? previous.people : []).map((person) => [String(person.name ?? ''), person]));
        const people = [];
        const seen = new Set();
        for (const item of wanted) {
          const name = String(item?.name ?? '').trim();
          if (name === '' || seen.has(name)) continue;
          seen.add(name);
          const person = (Array.isArray(store.people) ? store.people : []).find((p) => p.name === name);
          const prev = prevMap.get(name);
          const categories = Array.isArray(item.categories)
            ? [...new Set(item.categories.map((category) => String(category ?? '').trim()).filter(Boolean))].slice(0, 5)
            : [];
          people.push({
            name,
            openids: Array.isArray(person?.openids) ? person.openids : (Array.isArray(prev?.openids) ? prev.openids : []),
            groups: Array.isArray(person?.groups) ? person.groups : (Array.isArray(prev?.groups) ? prev.groups : []),
            categories,
            all: false,
          });
        }
        return { ...previous, people };
      }));
      console.log(`[panel] ${new Date().toISOString()} 保存收图名单 ${people.length} 人`);
      return send(200, { ok: true, people });
    }).catch((err) => send(400, { ok: false, error: String(err?.message ?? err) }));
    return;
  }

  // 图库：转发给机器人进程里同一个 media_search 函数
  if (req.method === 'GET' && url.pathname === '/api/media') {
    const query = url.searchParams.get('query') ?? '';
    const person = url.searchParams.get('person') ?? '';
    const group = url.searchParams.get('group') ?? '';
    const tag = url.searchParams.get('tag') ?? '';
    const favorites = url.searchParams.get('favorites') === '1';
    const limit = Number(url.searchParams.get('limit') ?? 40) || 40;
    botControl('/media/search', { query, person, group, tag, favorites, limit, excludeStickers: true })
      .then((result) => send(200, { ok: true, items: result.items ?? [] }))
      .catch((err) => send(502, { ok: false, error: String(err?.message ?? err) }));
    return;
  }

  // 图库删除 / 批量删除：同时删索引行、收藏记录和媒体文件
  if (req.method === 'POST' && url.pathname === '/api/media/delete') {
    readBody().then((body) => {
      const ids = Array.isArray(body.ids)
        ? [...new Set(body.ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))].slice(0, 200)
        : [];
      if (ids.length === 0)
        return send(400, { ok: false, error: 'ids 不能为空' });
      const candidates = [join(MEDIA_PRIMARY, 'index.db'), join(MEDIA_FALLBACK, 'index.db')];
      const dbFile = candidates.find((file) => existsSync(file));
      if (!dbFile)
        return send(404, { ok: false, error: '媒体库还没有索引' });
      const sqlite = process.getBuiltinModule?.('node:sqlite');
      if (!sqlite)
        return send(500, { ok: false, error: '当前 Node 不支持 node:sqlite' });
      let deleted = 0;
      try {
        const db = new sqlite.DatabaseSync(dbFile);
        db.exec('PRAGMA busy_timeout = 5000');
        const mediaDir = resolve(dirname(dbFile));
        const get = db.prepare('select path from media where id = ?');
        const delLike = db.prepare('delete from media_likes where media_id = ?');
        const del = db.prepare('delete from media where id = ?');
        const ref = db.prepare('select count(*) c from media where path = ?');
        for (const id of ids) {
          const row = get.get(id);
          if (!row)
            continue;
          delLike.run(id);
          del.run(id);
          deleted++;
          if (ref.get(row.path).c === 0) {
            const filePath = resolve(String(row.path));
            if ((filePath === mediaDir || filePath.startsWith(`${mediaDir}${sep}`)) && existsSync(filePath))
              unlinkSync(filePath);
          }
        }
        db.close();
      }
      catch (err) {
        return send(500, { ok: false, error: String(err?.message ?? err) });
      }
      console.log(`[panel] ${new Date().toISOString()} 删除媒体 ${deleted} 张: ${ids.join(',')}`);
      return send(200, { ok: true, deleted, ids });
    }).catch((err) => send(400, { ok: false, error: String(err?.message ?? err) }));
    return;
  }

  // 图库缩略图：按 id 从媒体库目录读文件（只允许 media 目录内）
  if (req.method === 'GET' && url.pathname === '/api/media/file') {
    const id = Number(url.searchParams.get('id'));
    if (!Number.isInteger(id) || id <= 0)
      return send(400, { ok: false, error: 'id 不合法' });
    const candidates = [join(MEDIA_PRIMARY, 'index.db'), join(MEDIA_FALLBACK, 'index.db')];
    const dbFile = candidates.find((file) => existsSync(file));
    if (!dbFile)
      return send(404, { ok: false, error: '媒体库还没有索引' });
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    if (!sqlite)
      return send(500, { ok: false, error: '当前 Node 不支持 node:sqlite' });
    let row;
    try {
      const db = new sqlite.DatabaseSync(dbFile, { readOnly: true });
      try {
        row = db.prepare('select path from media where id = ?').get(id);
      }
      finally {
        db.close();
      }
    }
    catch (err) {
      return send(500, { ok: false, error: String(err?.message ?? err) });
    }
    if (!row)
      return send(404, { ok: false, error: '没有这张图' });
    const mediaDir = resolve(dirname(dbFile));
    const filePath = resolve(String(row.path));
    if (!(filePath === mediaDir || filePath.startsWith(`${mediaDir}${sep}`)))
      return send(403, { ok: false, error: '路径不在媒体库内' });
    if (!existsSync(filePath))
      return send(404, { ok: false, error: '图片文件不存在' });
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    const type = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' }[ext] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'private, max-age=300' });
    res.end(readFileSync(filePath));
    return;
  }

  // 群操作：新会话 / 压缩（转给机器人进程的控制接口）
  if (req.method === 'POST' && url.pathname === '/api/groups/session') {
    readBody().then(async (body) => {
      const groupOpenid = String(body.groupOpenid ?? '').trim();
      const action = String(body.action ?? '').trim();
      if (groupOpenid === '')
        return send(400, { ok: false, error: 'groupOpenid 不能为空' });
      if (action !== 'new' && action !== 'compact')
        return send(400, { ok: false, error: 'action 只能是 new 或 compact' });
      try {
        const result = await botControl(`/session/${action}`, { groupOpenid });
        console.log(`[panel] ${new Date().toISOString()} 群操作 ${action}: ${groupOpenid}`);
        return send(200, { ok: true, ...result });
      }
      catch (err) {
        return send(502, { ok: false, error: String(err?.message ?? err) });
      }
    }).catch((err) => send(400, { ok: false, error: String(err?.message ?? err) }));
    return;
  }

  return send(404, { ok: false, error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`机器人控制台已启动: http://127.0.0.1:${server.address().port}`);
  console.log(`配置文件: ${PATCH}`);
  console.log(`文档数据库: ${PERSONAS}`);
  console.log(`档案文件: ${PEOPLE}`);
});

// 旧的 7790（群档案编辑器）留个跳转，书签不用改
const LEGACY_PORT = Number(process.env.QQBOT_LEGACY_PORT ?? 0);
if (LEGACY_PORT > 0 && LEGACY_PORT !== PORT) {
  const legacy = createServer((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${PORT}${req.url ?? '/'}` });
    res.end();
  });
  legacy.on('error', (err) => console.warn(`[panel] 旧端口 ${LEGACY_PORT} 未启用重定向：${err.message}`));
  legacy.listen(LEGACY_PORT, '127.0.0.1', () => console.log(`旧地址已重定向: http://127.0.0.1:${LEGACY_PORT} → ${PORT}`));
}

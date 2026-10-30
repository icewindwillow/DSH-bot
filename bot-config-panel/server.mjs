#!/usr/bin/env node
/**
 * 小易机器人配置面板 —— 零依赖 HTTP 服务
 *
 * 一个页面管几件事：
 *   1. 用哪个模型（agent-default-model.provider / model）
 *   2. 推理强度（agent-default-model.reasoningEffort + llm-pi-ai 路由默认 reasoning）
 *   3. 人格设定（qqbot-personas.json：模块文本、每个群用哪套人格）
 *   4. 每个群的唤醒指数（qqbot-groups.json：wakeIndex，0 = 只听 @ 和名字，100 = 老行为）
 *
 * 直接改 profile 里的真实配置文件：
 *   ~/.dsh/profiles/qqbot/cordis.patch.yml     ← 模型 / 推理强度（改完要重启机器人）
 *   ~/.dsh/profiles/qqbot/qqbot-personas.json  ← 人格（机器人每轮热读，保存即生效）
 *   ~/.dsh/profiles/qqbot/qqbot-groups.json    ← 唤醒指数（每条群消息热读，保存即生效）
 *
 * 每次写入前自动备份成 <文件>.bak-<时间戳>；YAML 写坏了会自动回滚并报错。
 *
 * 启动：node bot-config-panel/server.mjs [端口]     # 默认 http://127.0.0.1:7791
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { credentialStatus, updateCredentials } from './credentials.mjs';
import { readImageGenerationSettings, writeImageGenerationSettings } from './image-generation.mjs';
import {
  readFileSync, writeFileSync, copyFileSync, existsSync, statSync,
  openSync, closeSync, renameSync, readdirSync, chmodSync, unlinkSync,
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
const PERSONAS = join(PROFILE_DIR, 'qqbot-personas.json');
const OWNERS = join(PROFILE_DIR, 'qqbot-command-owners.json');
const PEOPLE = join(PROFILE_DIR, 'qqbot-people.json');
const GROUPS = join(PROFILE_DIR, 'qqbot-groups.json');
const GROUPS_META = join(PROFILE_DIR, 'qqbot-groups-meta.json');
const EVENTS = join(PROFILE_DIR, 'qqbot-events.json');
const MEDIA_PRIMARY = join(PROFILE_DIR, 'media');
const MEDIA_ALLOW = join(PROFILE_DIR, 'qqbot-media-allow.json');
const MODULES = join(PROFILE_DIR, 'qqbot-person-modules.json');
const ROLE_REGISTRY = join(PROFILE_DIR, 'qqbot-role-skills.json');
const MEDIA_FALLBACK = join(homedir(), '.dsh', 'qqbot-media');
const WAKE_INDEX_DEFAULT = 100;
const INDEX = join(HERE, 'public', 'index.html');
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
  const backup = `${file}.bak-${stamp()}`;
  const exists = existsSync(file);
  const mode = exists ? statSync(file).mode & 0o777 : 0o600;   // profile 里有 appSecret，别把 600 写成 644
  if (exists) copyFileSync(file, backup);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { encoding: 'utf8', mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
  return backup;
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
  if (!existsSync(PERSONAS)) return { modules: {}, personas: {}, archetypes: {} };
  const parsed = JSON.parse(readFileSync(PERSONAS, 'utf8'));
  if (!parsed || typeof parsed !== 'object') throw new Error('qqbot-personas.json 不是对象');
  return parsed;
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
    const archetype = entry?.archetype;
    if (archetype !== undefined && archetype !== null && archetype !== '') {
      if (typeof archetype !== 'string' || !(archetype in archetypes))
        throw new Error(`人格 ${key} 引用了不存在的人格类型：${String(archetype)}`);
    }
  }
}

// ─────────────────────────── 群列表 / 机器人进程 ───────────────────────────

function readGroups() {
  if (!existsSync(GROUPS_META)) return [];
  try {
    const parsed = JSON.parse(readFileSync(GROUPS_META, 'utf8'));
    return Array.isArray(parsed.groups) ? parsed.groups : [];
  }
  catch { return []; }
}

/**
 * 每群唤醒指数：0–100，存在 qqbot-groups.json 的 wakeIndex 表里。
 * 100 = 老行为（没被点名也每条都接），越低越少主动插话；@ 和叫名字不受影响。
 */
function clampIndex(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function readWakeIndex() {
  const fallback = { map: {}, default: WAKE_INDEX_DEFAULT, path: GROUPS, mtimeMs: mtimeOf(GROUPS) };
  if (!existsSync(GROUPS)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(GROUPS, 'utf8'));
    const map = {};
    const raw = parsed?.wakeIndex;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [gid, value] of Object.entries(raw)) {
        const n = Number(value);
        if (typeof gid === 'string' && gid.trim() !== '' && Number.isFinite(n))
          map[gid] = clampIndex(n);
      }
    }
    const def = Number(parsed?.wakeIndexDefault);
    return {
      map,
      default: Number.isFinite(def) ? clampIndex(def) : WAKE_INDEX_DEFAULT,
      path: GROUPS,
      mtimeMs: mtimeOf(GROUPS),
    };
  }
  catch { return fallback; }
}

/** 写一个群的唤醒指数；值等于默认值时删掉这条，文件保持干净 */
function writeWakeIndex(groupOpenid, value, baseMtimeMs) {
  if (typeof groupOpenid !== 'string' || groupOpenid.trim() === '')
    throw new Error('缺少群 id');
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100)
    throw new Error('唤醒指数必须是 0–100 的数字');

  const current = mtimeOf(GROUPS);
  if (typeof baseMtimeMs === 'number' && baseMtimeMs !== 0 && Math.abs(current - baseMtimeMs) > 1) {
    const err = new Error('qqbot-groups.json 已被别处修改，请先刷新页面再保存。');
    err.status = 409;
    throw err;
  }

  let data = {};
  if (existsSync(GROUPS)) {
    try { data = JSON.parse(readFileSync(GROUPS, 'utf8')); }
    catch { throw new Error('qqbot-groups.json 不是合法 JSON，先修好再改'); }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('qqbot-groups.json 顶层必须是对象');

  const def = Number.isFinite(Number(data.wakeIndexDefault)) ? clampIndex(Number(data.wakeIndexDefault)) : WAKE_INDEX_DEFAULT;
  const map = (data.wakeIndex && typeof data.wakeIndex === 'object' && !Array.isArray(data.wakeIndex))
    ? { ...data.wakeIndex } : {};
  const next = clampIndex(n);
  if (next === def) delete map[groupOpenid];
  else map[groupOpenid] = next;
  if (Object.keys(map).length > 0) data.wakeIndex = map;
  else delete data.wakeIndex;

  const backup = writeWithBackup(GROUPS, `${JSON.stringify(data, null, 2)}\n`);
  return { backup, mtimeMs: mtimeOf(GROUPS), map };
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

function effectiveModuleFor(person) {
  const name = String(person?.name ?? '');
  const modules = readJsonFile(MODULES, { people: {} });
  const mod = modules.people?.[name] ?? {};
  const allowDoc = readJsonFile(MEDIA_ALLOW, { people: [] });
  const allowEntry = (Array.isArray(allowDoc.people) ? allowDoc.people : []).find((entry) =>
    entry && (entry.name === name || (Array.isArray(entry.openids) && Array.isArray(person?.openids)
      && entry.openids.some((id) => person.openids.includes(id)))));
  const roleDoc = readJsonFile(ROLE_REGISTRY, { skills: [] });
  const styleSkill = (Array.isArray(roleDoc.skills) ? roleDoc.skills : []).find((skill) =>
    skill && Array.isArray(skill.audiences) && skill.audiences.some((audience) =>
      audience && (audience.person === name || (Array.isArray(audience.openids) && Array.isArray(person?.openids)
        && audience.openids.some((id) => person.openids.includes(id))))));
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
  };
}

/** 指令白名单：{ openids: string[], names: string[] } */
function readOwners() {
  if (!existsSync(OWNERS)) return { openids: [], names: [] };
  const parsed = JSON.parse(readFileSync(OWNERS, 'utf8'));
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
  const previous = existsSync(OWNERS) ? JSON.parse(readFileSync(OWNERS, 'utf8')) : {};
  const data = {
    ...previous,
    _说明: previous._说明 ?? '能对机器人发 /compact /new /model 等斜杠指令的人。openids 精确匹配；names 会去 qqbot-people.json 里查同名成员的 openid。',
    openids,
    names,
  };
  const backup = writeWithBackup(OWNERS, `${JSON.stringify(data, null, 2)}\n`);
  return { openids, names, backup };
}

/** 群成员档案里能当主人候选的人：名字 + 已知 openid */
function peopleIndex() {
  if (!existsSync(PEOPLE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(PEOPLE, 'utf8'));
    return (parsed.people ?? [])
      .filter((p) => typeof p?.name === 'string')
      .map((p) => ({ name: p.name, openids: Array.isArray(p.openids) ? p.openids : [], groups: Array.isArray(p.groups) ? p.groups : [] }));
  }
  catch { return []; }
}



/** 完整群成员档案（编辑器用；peopleIndex 只给主人页的名字/openid） */
function readPeopleStore() {
  if (!existsSync(PEOPLE)) return { people: [] };
  return JSON.parse(readFileSync(PEOPLE, 'utf8'));
}

/**
 * 和机器人用同一把文件锁（qqbot-people.json.lock）：
 * 机器人的 people-store 补丁也认这个锁，谁先拿到谁写，避免整文件互相覆盖。
 * 控制台是同步阻塞的短写，等不到 3 秒就报错让用户重试。
 */
function withPeopleLock(fn) {
  const lock = `${PEOPLE}.lock`;
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
      if (Date.now() > deadline) throw new Error('档案正被机器人写入，请稍后重试');
      const end = Date.now() + 15;
      while (Date.now() < end) { /* 15ms 自旋 */ }
    }
  }
  try {
    return fn();
  }
  finally {
    try { closeSync(fd); } catch { /* 忽略 */ }
    try { unlinkSync(lock); } catch { /* 忽略 */ }
  }
}

function readEventsStore() {
  try {
    const raw = JSON.parse(readFileSync(EVENTS, 'utf8'));
    return raw && Array.isArray(raw.events) ? raw : { version: 1, events: [] };
  }
  catch {
    return { version: 1, events: [] };
  }
}

/** 写事件库：和机器人同一把锁（qqbot-events.json.lock），原子写 + 备份 */
function writeEventsStore(mutator) {
  const lock = `${EVENTS}.lock`;
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
      if (Date.now() > deadline) throw new Error('事件库正被机器人写入，请稍后重试');
      const end = Date.now() + 15;
      while (Date.now() < end) { /* 15ms 自旋 */ }
    }
  }
  try {
    const state = readEventsStore();
    const result = mutator(state);
    if (result === false) return undefined;
    const tmp = `${EVENTS}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    try { copyFileSync(EVENTS, `${EVENTS}.bak`); } catch { /* 首次写 */ }
    renameSync(tmp, EVENTS);
    return result;
  }
  finally {
    try { closeSync(fd); } catch { /* 忽略 */ }
    try { unlinkSync(lock); } catch { /* 忽略 */ }
  }
}

/** 写群成员档案：校验 name、拿机器人同一把锁、自动备份、原子写 */
function writePeopleStore(data) {
  if (!data || !Array.isArray(data.people))
    throw new Error('JSON 必须是 { "people": [...] } 结构');
  for (const [i, person] of data.people.entries()) {
    if (!person || typeof person !== 'object' || typeof person.name !== 'string' || person.name.trim() === '')
      throw new Error(`第 ${i + 1} 条缺少 name`);
  }
  return withPeopleLock(() => {
    const backup = writeWithBackup(PEOPLE, `${JSON.stringify(data, null, 2)}\n`);
    return { backup, count: data.people.length };
  });
}

/** 写群列表元数据：校验 id/name/重复、自动备份、原子写 */
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
  const backup = writeWithBackup(GROUPS_META, `${JSON.stringify({ groups: clean }, null, 2)}\n`);
  return { backup, count: clean.length };
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
    throw new Error('面板重启默认关闭。请在终端停止并运行 npm run bot；使用 launchd 时可显式启用。');
  if (process.platform !== 'darwin') throw new Error('面板重启仅支持显式配置的 macOS launchd 服务');
  const label = process.env.QQBOT_LAUNCHD_LABEL;
  const job = findLaunchdJob();
  if (!label || !job || job.label !== label)
    throw new Error('请配置与当前 profile 匹配的 QQBOT_LAUNCHD_LABEL；不会猜测或直接拉起其它进程');
  execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${label}`], { encoding: 'utf8', timeout: 15000 });
  return { mode: 'launchd', pids: botPids(), running: botPids().length > 0, ready: false,
    note: '已请求守护服务重启；请检查就绪日志。不会额外启动第二个机器人。' };
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
    groups: readGroups(),
    wakeIndex: readWakeIndex(),
    owners: readOwners(),
    people: peopleIndex(),
    personas: readPersonas(),
    mtimes: { patch: mtimeOf(PATCH), personas: mtimeOf(PERSONAS) },
    warnings,
  };
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
  const readBody = () => new Promise((resolve, reject) => {
    let raw = '', size = 0, tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) { tooLarge = true; raw = ''; return; }
      if (!tooLarge) raw += chunk;
    });
    req.on('end', () => {
      if (tooLarge) return reject(new Error('请求体超出 1 MiB 上限'));
      try { resolve(raw === '' ? {} : JSON.parse(raw)); }
      catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });

  // 页面：任何非 /api 的 GET 都返回面板（换个路径可绕缓存）
  if ((req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/')) {
    if (!existsSync(INDEX)) return send(500, { ok: false, error: 'index.html 缺失' });
    res.setHeader('set-cookie', `dsh_bot_session=${SESSION_COOKIE}; HttpOnly; SameSite=Strict; Path=/`);
    return send(200, readFileSync(INDEX, 'utf8'), 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && url.pathname === '/api/credentials') {
    try { return send(200, { ok: true, ...credentialStatus(PROFILE_DIR) }); }
    catch { return send(500, { ok: false, error: '无法读取本地密钥状态，请检查文件权限和格式' }); }
  }
  if (req.method === 'PUT' && url.pathname === '/api/credentials') {
    readBody().then(body => send(200, { ok: true, ...updateCredentials(PROFILE_DIR, body), restartRequired: true }))
      .catch(() => send(400, { ok: false, error: '密钥未保存：请检查输入字段、本地文件格式和权限。不会显示密钥内容。' }));
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

  if (req.method === 'GET' && url.pathname === '/api/overview') {
    try { return send(200, overview()); }
    catch (err) { return send(500, { ok: false, error: String(err?.message ?? err) }); }
  }

  if (req.method === 'GET' && url.pathname === '/api/bot/status') {
    return send(200, { ok: true, running: botPids().length > 0, pids: botPids(), tail: tailLog(6) });
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
      const result = writeWakeIndex(body.groupOpenid, body.value, body.baseMtimeMs);
      console.log(`[panel] ${new Date().toISOString()} 唤醒指数已保存：${body.groupOpenid} = ${result.map[body.groupOpenid] ?? '默认'}`);
      return send(200, { ok: true, ...result, restartRequired: false });
    }).catch((err) => {
      const status = err?.status === 409 ? 409 : 400;
      return send(status, { ok: false, error: String(err?.message ?? err) });
    });
    return;
  }

  if (req.method === 'PUT' && url.pathname === '/api/personas') {    readBody().then((body) => {
      const data = body.data;
      validatePersonas(data);

      const current = mtimeOf(PERSONAS);
      if (typeof body.baseMtimeMs === 'number' && body.baseMtimeMs !== 0
        && Math.abs(current - body.baseMtimeMs) > 1)
        return send(409, { ok: false, error: '人格文件已被别处修改，请先刷新页面再保存。' });

      const text = `${JSON.stringify(data, null, 2)}\n`;
      const backup = writeWithBackup(PERSONAS, text);
      return send(200, { ok: true, backup, restartRequired: false, mtimeMs: mtimeOf(PERSONAS) });
    }).catch((err) => send(400, { ok: false, error: String(err?.message ?? err) }));
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
        target.status = status;
        target.closedAt = status === 'open' ? undefined : Date.now();
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

  if (req.method === 'GET' && url.pathname === '/api/people') {
    try {
      const data = readPeopleStore();
      return send(200, { ok: true, path: PEOPLE, data, mtimeMs: mtimeOf(PEOPLE), groupsPath: GROUPS_META });
    }
    catch (err) {
      return send(500, { ok: false, error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'PUT' && url.pathname === '/api/people') {
    readBody().then((body) => {
      const current = mtimeOf(PEOPLE);
      if (typeof body.baseMtimeMs === 'number' && body.baseMtimeMs !== 0
        && Math.abs(current - body.baseMtimeMs) > 1)
        return send(409, { ok: false, error: '档案文件已被其他地方修改，请先重新读取再保存。' });

      const result = writePeopleStore(body.data);
      console.log(`[panel] ${new Date().toISOString()} 群成员档案已保存：${result.count} 人`);
      return send(200, { ok: true, ...result, path: PEOPLE, mtimeMs: mtimeOf(PEOPLE) });
    }).catch((err) => send(400, { ok: false, error: String(err?.message ?? err) }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/groups') {
    return send(200, { ok: true, groups: readGroups(), path: GROUPS_META });
  }

  if (req.method === 'PUT' && url.pathname === '/api/groups') {
    readBody().then((body) => {
      const result = writeGroupsMeta(body.groups);
      console.log(`[panel] ${new Date().toISOString()} 群列表已保存：${result.count} 个群`);
      return send(200, { ok: true, ...result, path: GROUPS_META, groups: readGroups() });
    }).catch((err) => send(400, { ok: false, error: String(err?.message ?? err) }));
    return;
  }

  // 图库：收图/放图名单（只读，供面板显示）
  if (req.method === 'GET' && url.pathname === '/api/media/allow') {
    try {
      const parsed = JSON.parse(readFileSync(MEDIA_ALLOW, 'utf8'));
      return send(200, { ok: true, people: Array.isArray(parsed.people) ? parsed.people : [] });
    }
    catch {
      return send(200, { ok: true, people: [] });
    }
  }

  // 角色模块：按人读三个模块的生效状态
  if (req.method === 'GET' && url.pathname === '/api/modules') {
    const people = readPeopleStore().people;
    const out = {};
    for (const person of people) {
      if (!person?.name) continue;
      out[person.name] = effectiveModuleFor(person);
    }
    const roleDoc = readJsonFile(ROLE_REGISTRY, { skills: [] });
    // 能力型技能（如生图权限）不是语言风格，不列入「风格」下拉。
    const skills = (Array.isArray(roleDoc.skills) ? roleDoc.skills : [])
      .filter((skill) => skill && skill.enabled !== false && skill.kind !== 'capability')
      .map((skill) => ({ id: String(skill.id ?? ''), name: String(skill.name ?? skill.id ?? '') }));
    return send(200, { ok: true, people: out, skills });
  }

  // 角色模块：保存一个人的三个模块，并同步收图名单 / 角色技能
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
      const roleDocForSkill = readJsonFile(ROLE_REGISTRY, { skills: [] });
      const skillExists = (Array.isArray(roleDocForSkill.skills) ? roleDocForSkill.skills : [])
        .some((skill) => skill.id === styleSkill && skill.kind !== 'capability');
      const next = {
        collectImages: { enabled: input.collectImages?.enabled === true, categories },
        topics: { enabled: input.topics?.enabled === true, topics },
        style: { enabled: input.style?.enabled === true && styleSkill !== '' && skillExists, skill: styleSkill },
      };

      const modulesDoc = readJsonFile(MODULES, { people: {} });
      if (!modulesDoc.people || typeof modulesDoc.people !== 'object') modulesDoc.people = {};
      modulesDoc.people[name] = next;
      modulesDoc._说明 = modulesDoc._说明 ?? '按人启用的三个通用模块：collectImages / topics / style';
      const moduleBackup = writeWithBackup(MODULES, `${JSON.stringify(modulesDoc, null, 2)}\n`);

      // 收图模块 → 收图名单（媒体库读的是这份）
      const allowDoc = readJsonFile(MEDIA_ALLOW, { people: [] });
      const openids = Array.isArray(person.openids) ? person.openids : [];
      const groups = Array.isArray(person.groups) ? person.groups : [];
      let allowPeople = (Array.isArray(allowDoc.people) ? allowDoc.people : []).filter((entry) =>
        entry && !(entry.name === name || (Array.isArray(entry.openids) && entry.openids.some((id) => openids.includes(id)))));
      if (next.collectImages.enabled) {
        allowPeople.push({ name, openids, groups, categories, all: false });
      }
      const allowBackup = writeWithBackup(MEDIA_ALLOW, `${JSON.stringify({
        _说明: '收图/放图名单：名单里的人发图时按 categories 做视觉分类，只收对应类别；梗图/表情包排除。groups 为空表示所有群。',
        people: allowPeople,
      }, null, 2)}\n`);

      // 语言风格模块 → 角色技能注册表
      const roleDoc = readJsonFile(ROLE_REGISTRY, { skills: [] });
      if (!Array.isArray(roleDoc.skills)) roleDoc.skills = [];
      for (const skill of roleDoc.skills) {
        if (!Array.isArray(skill.audiences)) skill.audiences = [];
        skill.audiences = skill.audiences.filter((audience) =>
          audience && !(audience.person === name || (Array.isArray(audience.openids) && audience.openids.some((id) => openids.includes(id)))));
      }
      if (next.style.enabled) {
        const skill = roleDoc.skills.find((item) => item.id === styleSkill);
        if (skill) skill.audiences.push({ person: name, openids, groups, default: true });
      }
      const roleBackup = writeWithBackup(ROLE_REGISTRY, `${JSON.stringify(roleDoc, null, 2)}\n`);

      console.log(`[panel] ${new Date().toISOString()} 保存角色模块 ${name}: 收图=${next.collectImages.enabled} 主题=${next.topics.enabled} 风格=${next.style.enabled ? styleSkill : '-'}`);
      return send(200, { ok: true, modules: effectiveModuleFor(person), backups: { modules: moduleBackup, allow: allowBackup, role: roleBackup } });
    }).catch((err) => send(400, { ok: false, error: String(err?.message ?? err) }));
    return;
  }

  // 图库：保存收图/放图名单（勾人 + 分类）
  if (req.method === 'PUT' && url.pathname === '/api/media/allow') {
    readBody().then((body) => {
      const wanted = Array.isArray(body.people) ? body.people : [];
      const store = readPeopleStore();
      const previous = existsSync(MEDIA_ALLOW) ? JSON.parse(readFileSync(MEDIA_ALLOW, 'utf8')) : { people: [] };
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
      const data = {
        _说明: '收图/放图名单：名单里的人发图时按 categories 做视觉分类，只收对应类别；梗图/表情包排除。groups 为空表示所有群。',
        people,
      };
      const backup = writeWithBackup(MEDIA_ALLOW, `${JSON.stringify(data, null, 2)}\n`);
      console.log(`[panel] ${new Date().toISOString()} 保存收图名单 ${people.length} 人`);
      return send(200, { ok: true, people, backup });
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
    botControl('/media/search', { query, person, group, tag, favorites, limit })
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
  console.log(`机器人控制台已启动: http://127.0.0.1:${PORT}`);
  console.log(`配置文件: ${PATCH}`);
  console.log(`人格文件: ${PERSONAS}`);
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

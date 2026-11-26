import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { basename, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAccess, identityHeaders } from './access.mjs';
import {
  handleOwnerAction, isTaskConversationQuery, parseOwnerAction, startOwnerWatchNotifier,
} from './qq-owner-actions.mjs';
import { selectTaskBackend } from './task-shell.mjs';

const active = new Set(['queued', 'running', 'cancelling']);
const progressStages = new Set(['reading', 'drawing', 'polishing', 'finalizing']);
const pptIntakes = new Map();
const labels = {
  queued: '排队中', running: '运行中，若需要确认请在对应执行端处理',
  cancelling: '正在取消', cancelled: '已取消', done: '已完成',
  'no-result': '已结束，桌面里没有可回传的文字',
  'timed-out': '等待超时，可以到工作区查看',
  partial: '一条车道完成，另一条失败',
  mixed: '这轮还收到了桌面输入，请在 DSH 桌面查看结果',
  failed: '执行失败，可以到工作区查看',
};

export function mentionsExecutionLane(input) {
  const text = String(input ?? '').toLocaleLowerCase();
  return text.includes('dsh') || text.includes('codex');
}

// 明确写在消息里的 DSH 委派不必经过模型判断。自然入口除了原来的
// 「让我的 DSH」，也接受「你用 DSH」「用 DSH」这类说法；否则一旦分类模型
// 不可用，整条消息就会掉回普通聊天，表现得像小易拒绝接活。
const naturalDshAction = /(?:开|跑|执行|做|查|检查|测试|审查|修|处理|生成|制作|整理|分析|部署|启动|创建|新建|运行|验证|复盘|看看|查查|给我|帮我|回复|发|写|改|装|编译|构建|拉|推|提交|对比|统计|导出|转换|审阅|重跑|再跑)/u;
const naturalDshQuestion = /^(?:是|能|可以|会|怎么|为什么|什么|干啥|做什么|干嘛|有啥|有没有|在哪|谁|多久|多少)/u;
const naturalDshWatch = /(?:有没有\s*任务|是否有\s*任务|有哪些任务|有什么任务|任务列表|任务状态|任务进度|任务号|任务在跑|在跑的任务|正在跑|跑完了?[吗么没]|盯一?下|盯着|等它|等这|watch)/iu;
const naturalDshWorkspace = /(?:^|[\s，,、])(?:在|用|使用)\s*[「“"']?([^\s，,。；;：:」”"']{1,40})[」”"']?\s*工作区/u;

export function parseNaturalDsh(input, scope) {
  const text = String(input ?? '').trim();
  if (!text) return undefined;
  // 「帮我把 DSH 的机器人工作区，当前的修改提交并推送」也是委派；
  // 把工作区名从任务正文里拆出来，交给 Host 的 findWorkspace 解析。
  const ownership = scope === 'group'
    ? /(?:^|[。！？!?；;\n])\s*小易[，,、：:\s]*(?:帮我)?把\s*DSH\s*的?\s*(.+?)\s*工作区[，,:：]?\s*([\s\S]+)$/iu
    : /^小易[，,、：:\s]*(?:帮我)?把\s*DSH\s*的?\s*(.+?)\s*工作区[，,:：]?\s*([\s\S]+)$/iu;
  const owned = ownership.exec(text);
  if (owned) {
    const task = (owned[2] ?? '').trim();
    if (task && naturalDshAction.test(task) && !/(?:权限|授权|审批|沙箱|sandbox)/iu.test(task)) {
      const workspace = (owned[1] ?? '').trim().replace(/^[「“"']+|[」”"']+$/gu, '');
      return { task, workspace: workspace || undefined };
    }
    return undefined;
  }
  // 「帮我用 DSH 给 SIMDM 工作区发个任务，提交并推送」这类说法要把
  // 工作区从任务正文里拆出来，否则 DSH 会看到「给工作区发个任务」这层壳。
  const delegation = scope === 'group'
    ? /(?:^|[。！？!?；;\n])\s*小易[，,、：:\s]*(?:帮我)?(?:用|使用|让)\s*DSH\s*(?:给|在)\s*([^\s，,。；;：:]{1,40})\s*工作区\s*(?:发个任务|开个任务|开一个新任务|跑个任务|执行|做|创建|新建)?[，,:：]?\s*([\s\S]+)$/iu
    : /^小易[，,、：:\s]*(?:帮我)?(?:用|使用|让)\s*DSH\s*(?:给|在)\s*([^\s，,。；;：:]{1,40})\s*工作区\s*(?:发个任务|开个任务|开一个新任务|跑个任务|执行|做|创建|新建)?[，,:：]?\s*([\s\S]+)$/iu;
  const delegated = delegation.exec(text);
  if (delegated) {
    const task = (delegated[2] ?? '').trim();
    if (!task) return undefined;
    const workspace = (delegated[1] ?? '').trim().replace(/^[「“"']+|[」”"']+$/gu, '');
    return { task, workspace: workspace || undefined };
  }
  const pattern = scope === 'group'
    ? /(?:^|[。！？!?；;\n])\s*小易[，,、：:\s]*(?:\/?群技能\s+DSH|(?:让我的|你用|用|使用)\s*DSH)(?:[\s：:，,]+([\s\S]+))?$/iu
    : /^小易[，,、：:\s]*(?:让我的|你用|用|使用)\s*DSH(?:[\s：:，,]+([\s\S]+))?$/iu;
  const match = pattern.exec(text);
  if (!match) return undefined;
  const task = (match[1] ?? '').trim();
  if (!task) return { task: '', workspace: undefined };
  // 「小易，你用 DSH 是做什么的？」是在问能力，不是委派任务。
  if (naturalDshQuestion.test(task)) return undefined;
  // 查询/盯任务交给 ownerAction 或分类器，避免把「看看有没有任务」当成新任务。
  if (naturalDshWatch.test(task)) return undefined;
  if (!naturalDshAction.test(task) && !naturalDshWorkspace.test(task)) return undefined;
  const workspace = naturalDshWorkspace.exec(task)?.[1]?.trim();
  return {
    task,
    workspace: workspace && !/^(?:这个|那个|当前|我的|自己|同一|原|该)$/u.test(workspace)
      ? workspace : undefined,
  };
}

async function renderPptSummary(ctx, config, llm, current, group) {
  const raw = [
    `主题：${current.topic}`,
    `用途和受众：${current.purpose}`,
    `课程与内容要求：${current.course}`,
    `形式与视觉：${current.format}`,
  ].join('\n');
  const prompt = [
    '把下面已经确认的 PPT 信息整理成给用户确认的中文需求摘要。',
    '只保留原文明确说过的内容，不补充未知信息。去掉重复表达和口语尾巴。',
    '输出四行，固定使用「主题」「用途和受众」「课程与内容要求」「形式与视觉」这四个标签。',
    raw,
  ].join('\n');
  const rendered = await renderPersonaReply(ctx, config, { scope: 'group', group }, prompt, llm);
  return rendered === prompt ? raw : rendered;
}

function defaultSelection(ctx) {
  try {
    const service = ctx?.get?.('agentDefaultModel');
    const selection = service?.currentSelection?.();
    if (selection?.provider && selection?.model) return selection;
  } catch { /* no default model service in this composition */ }
  return undefined;
}

export async function classifyTaskIntent(ctx, llm, input, selectionOverride) {
  let service = llm;
  try { service ??= ctx?.get?.('llm'); } catch { /* use injected service */ }
  if (!service?.stream) return undefined;
  // QQ 中间件拿到的是消息上下文（message/replyTarget/state），不是 Cordis 上下文；
  // agentDefaultModel 只能从创建中间件时捕获的服务里取，否则这里永远拿不到 selection。
  const selection = selectionOverride ?? defaultSelection(ctx);
  if (!selection) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  let raw = '';
  try {
    for await (const chunk of service.stream({
      ...selection, reasoningEffort: 'low', maxTokens: 220,
      system: [
        '判断这条已明确发给机器人的消息是否请求本地工作任务。只输出 JSON，不要解释。',
        '字段固定为 isTask、isPpt、backend（codex/dsh/both/auto）、parallel、task、model、provider、ownerAction。',
        '普通闲聊、询问功能、抱怨和确认消息输出 isTask=false。',
        '查询或盯住已有 DSH 任务/会话时输出 isTask=false，并设置 ownerAction={"operation":"watch","workspace":"我的工作区"}；只是问有没有正在运行的任务也属于这个动作。',
        '消息明确说“用 DSH/Codex 开任务、跑测试、审查、检查、执行、制作或修改”时必须输出 isTask=true；不要因为执行可能失败、权限或实机困难而把它判成普通聊天，也不要替用户拒绝。',
        '“看这个”“看这张图”“帮我看看图片”“分析这张图”只是看图或聊天，输出 isTask=false、isPpt=false。只有明确要求制作、修改、导出、写入或交付成品时才输出 isTask=true。',
        'PPT/幻灯片/演示文稿请求只有在明确要求制作、修改、转换或审阅该演示文稿时才输出 isPpt=true。',
        '明确要求 DSH 和 Codex 一起做时 backend=both、parallel=true。',
        '用户点名模型时把模型名写进 model；provider 不确定就省略。',
        'task 保留完整任务要求。',
      ].join(''),
      messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
      signal: controller.signal,
    })) if (chunk?.type === 'text-delta') raw += chunk.text ?? '';
  } catch { return undefined; }
  finally { clearTimeout(timer); }
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    const value = JSON.parse(match[0]);
    const model = typeof value.model === 'string' ? value.model.trim().slice(0, 80) : '';
    const provider = typeof value.provider === 'string' ? value.provider.trim().slice(0, 40) : '';
    const backend = ['codex', 'dsh', 'both', 'auto'].includes(value.backend) ? value.backend : 'auto';
    const parallel = value.parallel === true;
    const ownerAction = value.ownerAction?.operation === 'watch'
      ? { operation: 'watch', workspace: String(value.ownerAction.workspace || '我的工作区').trim() || '我的工作区' }
      : undefined;
    return {
      isTask: value.isTask === true,
      isPpt: value.isPpt === true,
      backend: parallel && backend === 'auto' ? 'both' : backend,
      parallel,
      task: typeof value.task === 'string' && value.task.trim() ? value.task.trim() : input,
      ...(ownerAction && { ownerAction }),
      ...(model && { model }),
      ...(provider && { provider }),
    };
  } catch { return undefined; }
}

async function advancePptIntake(key, input, ctx, config, llm, group, attachments = []) {
  const text = input.trim();
  let current = pptIntakes.get(key);
  if (current && Date.now() - (current.updatedAt ?? 0) > 30 * 60_000) {
    pptIntakes.delete(key);
    current = undefined;
  }
  if (!current) {
    pptIntakes.set(key, { stage: 1, topic: text, group, request: text, attachments, createdAt: Date.now(), updatedAt: Date.now() });
    return '这个 PPT 用来做什么？面向谁、预计讲多久？';
  }
  current.updatedAt = Date.now();
  if (attachments.length > 0) {
    const existing = Array.isArray(current.attachments) ? current.attachments : [];
    const seen = new Set(existing.map(item => item?.path));
    current.attachments = [...existing, ...attachments.filter(item => item?.path && !seen.has(item.path))];
  }
  if (current.stage === 1) {
    current.purpose = text; current.stage = 2;
    return '这是哪门课或什么主题？有没有指定阅读材料、切入角度或必须覆盖的内容？';
  }
  if (current.stage === 2) {
    current.course = text; current.stage = 3;
    return '最后确认一下页数、比例、风格、配图/图表需求，以及是否需要演讲备注。';
  }
  if (current.stage === 3) {
    current.format = text; current.stage = 4;
    current.summary = await renderPptSummary(ctx, config, llm, current, current.group);
    return `我整理的 PPT 需求如下。\n${current.summary}\n默认制作图文 PPT，输出完整可下载的 PPTX 和逐页图文清单。\n确认后我就安排制作，可以吗？`;
  }
  if (/^(?:可以|确认|好|好的|好呢|开始|就这样|没问题|可以呀)/iu.test(text)) {
    if (/(?:\bCodex\b|\bDSH\b|\bDeepSeek\b|同时|一起|并行|各自|两份|两个版本)/iu.test(text)) {
      current.request = text;
    }
    const task = [
      '【PPT 统一需求】',
      current.summary ?? `主题：${current.topic}\n用途和受众：${current.purpose}\n课程与内容要求：${current.course}\n形式与视觉：${current.format}`,
      '请在当前用户的隔离工作区完整制作可下载的 PPTX。先写视觉脚本再制作，至少 70% 的内容页必须有实际嵌入的图片、插画、图表、流程图或信息图，不能用纯色矩形和长段文字代替视觉素材。默认加入页间转场或分步出现效果。执行方必须负责审美、图片、排版、文件写入和验收，不要把制作降级为 Python/Blender 代生成后再由别人审校。生成器必须支持媒体嵌入、图片关系和 transition。完成后检查 PPTX 文件存在、媒体引用完整、页面无明显溢出，并提供 PPTX 路径、页数和逐页图文 Markdown 清单。不要只回复文案。',
    ].join('\n');
    pptIntakes.delete(key);
    return { task, request: current.request, attachments: current.attachments ?? [] };
  }
  pptIntakes.delete(key);
  return '好的，我们重新开始。请先告诉我这个 PPT 的主题和用途。';
}

async function renderPersonaReply(ctx, config, { scope, group }, text, configuredLlm, fallbackText = text, selectionOverride, instructions, timeoutMs = 20_000) {
  let llm;
  try { llm = ctx?.get?.('llm'); } catch { llm = undefined; }
  llm ??= configuredLlm;
  if (!llm || typeof llm.stream !== 'function') return fallbackText;
  const selection = selectionOverride ?? defaultSelection(ctx);
  if (!selection) return fallbackText;
  const configured = scope === 'group'
    ? globalThis.__qqbotGroupPromptOverride?.(group)
    : config?.directPrompt;
  const persona = String(configured ?? (scope === 'group' ? config?.groupPrompt : config?.directPrompt) ?? '').trim();
  const system = [
    persona,
    instructions ?? '你是 QQ 机器人小易。把下面的工作流追问改写成你平时在当前会话里的自然回复。',
    '保留问题中的全部信息和顺序，语气亲切、简洁，符合你的人格。只输出要发给用户的回复正文，不要解释改写过程，不要加引号、标题或代码块。',
  ].filter(Boolean).join('\n\n');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let out = '';
  try {
    for await (const chunk of llm.stream({
      ...selection,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      maxTokens: 300,
      reasoningEffort: 'low',
      signal: controller.signal,
    })) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text;
    }
  } catch { return fallbackText; }
  finally { clearTimeout(timer); }
  const rendered = out.replace(/```[\s\S]*?```/g, '').trim();
  return rendered && !/^\[SILENT\]$/iu.test(rendered) ? rendered : fallbackText;
}

function requestBridge(socketPath, method, path, actor, task) {
  return new Promise((resolve, reject) => {
    const body = task ? JSON.stringify(task) : undefined;
    const req = request({
      socketPath, path, method, signal: AbortSignal.timeout(5000),
      headers: { ...identityHeaders(actor), ...(body && { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }) },
    }, async res => {
      try {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        resolve({ code: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) });
      } catch (error) { reject(error); }
    });
    req.on('error', reject);
    req.end(body);
  });
}

function progressPersonaFallback(progress) {
  switch (progress?.stage) {
    case 'reading':
      return '小易正在认真读材料、记小本本喵。';
    case 'drawing':
      return '小易正在把结构排成页面，开始画图和版式啦喵。';
    case 'finalizing':
      return '小易正在检查成品和文件，马上就好喵。';
    default:
      return '小易还在认真打磨每一页喵。';
  }
}


export function buildTaskRequest(text, workspace, route) {
  const isCodexModel = model => /^(?:gpt-|o\d|codex)/iu.test(model ?? '');
  const providerFor = model => {
    if (!model) return undefined;
    if (isCodexModel(model)) return 'openai';
    if (/^(?:deepseek-|glm-|kimi-|qwen-)/iu.test(model)) return 'opencode-go';
    return route.provider;
  };
  const model = route.model;
  const codexModel = model && (route.backend === 'codex' || (route.backend === 'both' && isCodexModel(model)))
    ? model : undefined;
  const dshProvider = route.provider ?? providerFor(model);
  const dshModel = model && dshProvider
    && (route.backend === 'dsh' || (route.backend === 'both' && !isCodexModel(model)))
    ? { provider: dshProvider, model } : undefined;
  return {
    text,
    workspace,
    backend: route.backend,
    ...(codexModel && { model: codexModel }),
    ...(dshModel && { dshModel }),
  };
}

function hideLocalPaths(value) {
  // 只去掉目录，保留文件名；成品列表里出现 [文件附件] 反而看不出是哪个文件。
  return String(value ?? '').replace(/(?:\/Users|\/private|\/tmp)\/(?:[^\s"'`)>/]+\/)*([^\s"'`)>/]+)/gu, '$1');
}

function format(job, includeResult = true, includeId = true) {
  const detail = includeResult ? hideLocalPaths(job.result || job.error) : '';
  return `${includeId ? `任务 ${job.id} · ` : ''}${labels[job.status] ?? '状态未知'}${detail ? `\n\n${detail}` : ''}`;
}

export function createOwnerDshMiddleware(bot, {
  socket = process.env.QQBOT_OWNER_DSH_SOCKET,
  owner = process.env.QQBOT_OWNER_DSH_OPENID,
  loadAccess = () => ({ owner }),
  pollMs = 1500,
  watchNotifications = false,
  logger,
  config,
  llm,
  getDefaultSelection = () => undefined,
} = {}) {
  if (!isAbsolute(socket ?? '')) return (_ctx, next) => next();
  const delivered = new Set();
  const submitting = new Set();
  const bridge = (method, path, actor, body) => requestBridge(socket, method, path, actor, body);
  const hostRequest = (method, id, actor, task) => bridge(method, `/jobs/${id}`, actor, task)
    .then(({ code, body }) => ({ code, job: body }));
  if (watchNotifications) startOwnerWatchNotifier({ bot, bridge, loadAccess, logger });

  return async (ctx, next) => {
    const { message, replyTarget } = ctx;
    const scope = message?.kind;
    if (scope !== 'c2c' && scope !== 'group') return next();
    const sender = message.senderId;
    const group = scope === 'group' ? message.groupOpenid : undefined;
    const directTarget = replyTarget?.scope === scope && replyTarget.targetId === (group ?? sender)
      && message.messageId && message.messageId === replyTarget.msgId;
    const input = typeof message.content === 'string' ? message.content.trim() : '';
    // 「看一下当前在推进的任务对话」不一定带 DSH 字样，但主人问的就是 DSH 会话；
    // 不能让它掉回普通聊天去看工作区。
    const ownerTaskQuery = scope === 'group' && isTaskConversationQuery(input);
    const keywordGroupMessage = scope === 'group' && mentionsExecutionLane(message.content);
    if (!directTarget && !keywordGroupMessage && !ownerTaskQuery) return next();
    const routeTarget = directTarget ? replyTarget : { scope, targetId: group, msgId: message.messageId };

    const command = /^\/dsh(?:\s+([\s\S]+))?$/.exec(input) ??
      (scope === 'group' && /^\/?群技能\s+DSH(?:[\s：:]+([\s\S]+))?$/i.exec(input));
    const natural = parseNaturalDsh(input, scope);
    const linkCommand = /^\/dsh\s+link(?:\s+([a-f0-9]{10}))?$/i.exec(input);
    let preIdentity;
    try {
      const preAccess = createAccess(await loadAccess());
      preIdentity = preAccess.identify({ scope, sender, group });
    } catch { /* normal flow will handle access failures */ }
    if (ownerTaskQuery && !preIdentity?.owner) return next();
    const parsedOwnerAction = parseOwnerAction(input);
    const ownerAction = scope === 'c2c' ? parsedOwnerAction
      : parsedOwnerAction?.operation === 'list' && preIdentity?.owner ? parsedOwnerAction
        : /^\/dsh\s+(watch|send|choose)(?:\s|$)/i.test(input) && { operation: 'private-only' };
    let earlyAckSent = false;
    const addressed = scope === 'c2c'
      || message.rawEventType === 'GROUP_AT_MESSAGE_CREATE'
      || globalThis.__qqbotMention?.addressed?.(message) === true
      || (preIdentity && (input.startsWith('小易') || input.startsWith('群技能')));
    let classifiedIntent;
    if (!command && !natural && !ownerAction && !linkCommand && mentionsExecutionLane(input)) {
      let selection;
      try { selection = getDefaultSelection(); } catch { /* fall back to ctx.get below */ }
      classifiedIntent = await classifyTaskIntent(ctx, llm, input, selection);
    }
    const hasAttachment = (Array.isArray(message.attachments) && message.attachments.length > 0)
      || (Array.isArray(ctx.state?.quote?.attachments) && ctx.state.quote.attachments.length > 0);
    const imageLookOnly = hasAttachment
      && /(?:看这个|看这张|看看|图片|图|截图)/u.test(input)
      && !/(?:制作|生成|修改|编辑|导出|转换|写入|交付|做成|整理成|PPT|PowerPoint|幻灯片|演示文稿)/iu.test(input);
    const intent = imageLookOnly
      ? { isTask: false, isPpt: false, backend: 'auto', parallel: false, task: input }
      : classifiedIntent;
    if (!ownerAction && intent?.ownerAction) ownerAction = intent.ownerAction;
    const dshTaskIntent = intent?.isTask || intent?.backend === 'dsh' || intent?.backend === 'both';
    const naturalC2cDsh = scope === 'c2c' && dshTaskIntent ? { task: intent.task } : undefined;
    const naturalGroupDsh = scope === 'group' && dshTaskIntent ? { task: intent.task } : undefined;
    const identityCommand = scope === 'group' && /^\/dsh\s+(?:身份|identity)$/i.test(input);
    const pptKey = `${sender}:${group ?? 'c2c'}`;
    const pptActive = pptIntakes.has(pptKey);
    if (!command && !natural && !naturalC2cDsh && !naturalGroupDsh && !ownerAction && !linkCommand && !pptActive && !intent?.isTask && !intent?.isPpt) return next();
    const actor = { scope, sender, group };
    if (identityCommand) {
      const target = { scope, targetId: routeTarget.targetId, msgId: routeTarget.msgId };
      try {
        const { code, body } = await bridge('GET', '/owner/group-identity', actor);
        if (code === 200) return bot.sendText(target, `群身份码 ${body.code}。十分钟内有效，请把这条消息发给管理员关联档案。`);
      } catch { /* Retry through chat after the bridge reconnects. */ }
      return bot.sendText(target, '暂时无法取群身份码，请稍后重试。');
    }
    let access;
    try { access = createAccess(await loadAccess()); }
    catch { return; }
    const identity = access.identify(actor);
    if (ownerAction?.operation === 'list' && !identity?.owner) return next();
    if (linkCommand) {
      const target = { scope, targetId: routeTarget.targetId, msgId: routeTarget.msgId };
      if (scope === 'c2c' && identity?.owner) return bot.sendText(target, '主人账号已经可用。');
      try {
        const { body } = await bridge('POST', '/owner/link', actor, { code: linkCommand[1]?.toUpperCase() });
        if (body.status === 'link-code') return bot.sendText(target, `请在已获授权的群里 @小易 发送 /dsh link ${body.code}。五分钟内有效。`);
        if (body.status === 'linked') return bot.sendText(target, '已绑定 DSH 个人技能。用 /dsh 任务内容 就可以开始。');
        if (body.status === 'busy') return bot.sendText(target, '当前绑定请求较多，请过几分钟再试。');
        return bot.sendText(target, '没有匹配到有效绑定。请先在私聊取码，再从已获授权的群发送。');
      } catch { return bot.sendText(target, '暂时连不上 DSH 桌面，请稍后再试。'); }
    }
    if (!identity) return ownerAction?.allowFallback ? next() : undefined;
    const inGroup = scope === 'group';
    const groupOnly = inGroup && !identity.owner;
    const receivedAt = Date.now();
    const target = { scope, targetId: routeTarget.targetId, msgId: routeTarget.msgId };
    const reply = value => bot.sendText(
      Date.now() - receivedAt < 4 * 60_000 ? target : { scope: target.scope, targetId: target.targetId },
      value,
    );
    let pptTask;
    let pptRouteText;
    let pptAttachments = [];
    const imageFiles = [
      ...(Array.isArray(ctx.state?.downloadedFiles) ? ctx.state.downloadedFiles : []),
      ...(Array.isArray(ctx.state?.downloadedQuoteFiles) ? ctx.state.downloadedQuoteFiles : []),
    ];
    const seenImagePaths = new Set();
    const downloadedImages = imageFiles
      .filter(file => typeof file?.localPath === 'string' && /\.(?:png|jpe?g|gif|webp|bmp|svg)$/iu.test(file.localPath))
      .filter(file => !seenImagePaths.has(file.localPath) && seenImagePaths.add(file.localPath))
      .map(file => ({ path: file.localPath, name: typeof file.filename === 'string' ? file.filename : '' }));
    const explicitDshInput = Boolean(command || natural || naturalC2cDsh || naturalGroupDsh || intent?.backend === 'dsh');
    if (identity && (inGroup || scope === 'c2c') && !explicitDshInput && (pptActive || intent?.isPpt === true)) {
      const intake = await advancePptIntake(pptKey, input, ctx, config, llm, group, downloadedImages);
      if (typeof intake === 'string') {
        await reply(await renderPersonaReply(ctx, config, { scope, group }, intake, llm));
        return;
      }
      pptTask = intake.task;
      pptRouteText = intake.request;
      pptAttachments = intake.attachments ?? [];
    }
    const inputTask = (pptTask ?? command?.[1] ?? natural?.task ?? naturalC2cDsh?.task ?? naturalGroupDsh?.task ?? '').trim();
    const routing = /^--workspace\s+(\S+)\s+([\s\S]+)$/.exec(inputTask);
    const task = routing?.[2]?.trim() ?? inputTask;
    // 自然语言里的「在 simdm 工作区」由 Host 解析为已有工作区；显式 --workspace 优先。
    const workspace = routing?.[1] ?? natural?.workspace;
    const control = !routing && /^(status|cancel|result)\s+([a-f0-9]{24})$/.exec(task);
    const privateReply = value => inGroup && !groupOnly
      ? bot.sendText({ scope: 'c2c', targetId: identity.dmOpenid }, value)
      : reply(value);
    const sendFiles = async (files, fileTarget = Date.now() - receivedAt < 4 * 60_000
      ? target : { scope: target.scope, targetId: target.targetId }) => {
      if (!Array.isArray(files) || !files.length || typeof bot.sendFile !== 'function') return;
      for (const file of files.slice(0, 4)) {
        if (typeof file !== 'string' || !isAbsolute(file)) continue;
        await bot.sendFile(fileTarget, { localPath: file }, { fileName: basename(file) }).catch(() => {});
      }
    };
    const resultReply = async (value, files = []) => {
      if (!inGroup || groupOnly) {
        await reply(value);
        await sendFiles(files);
        return;
      }
      // 主人在群里下的任务，回执留在群里，最终结果和成品回主人私聊。
      const ownerTarget = { scope: 'c2c', targetId: identity.dmOpenid };
      try {
        await bot.sendText(ownerTarget, value);
        await sendFiles(files, ownerTarget);
      } catch {
        await reply(value);
        await sendFiles(files);
      }
    };
    const selectionForRender = () => {
      try { return getDefaultSelection(); } catch { return undefined; }
    };
    const renderTaskText = (kind, value, { timeoutMs, fallbackText = value } = {}) => {
      const instructions = {
        ack: '把下面的任务接收回执改写成小易平时在当前会话里的自然回复。必须明确说出任务能不能执行、是否已经开始（已开始执行/接单排队/无法执行），保留任务号和结果去向；不要编造进度。',
        result: '把下面的任务结果改写成小易平时在当前会话里的自然回复。保留所有事实、数字、文件路径、commit hash、报错原文和列表结构，不要删减或改写技术内容。',
        'result-lead': '只写一句自然的结果提示，告诉主人任务已经结束、正文在下面；不要概括或改写技术内容。',
        progress: '把小易当前的任务进度改写成她平时在群里的自然播报，保留进度内容，不要提内部实现。只输出一到两句话。',
      }[kind] ?? '把下面的任务状态改写成小易平时在当前会话里的自然回复。';
      return renderPersonaReply(
        ctx, config, { scope, group }, value, llm, fallbackText,
        selectionForRender(), instructions, timeoutMs,
      );
    };
    if (ownerAction?.operation === 'private-only') return reply(groupOnly
      ? '群里可用 /dsh 任务内容、/dsh status 任务号、/dsh cancel 任务号 和 /dsh result 任务号。'
      : '盯任务和给桌面会话发消息，请私聊我操作。');
    if (ownerAction) {
      const renderList = ownerAction.operation === 'list'
        ? text => renderPersonaReply(
          ctx, config, { scope, group }, text, llm, text,
          (() => { try { return getDefaultSelection(); } catch { return undefined; } })(),
          '把下面的 DSH 任务会话列表改写成小易平时在群里的自然播报。保留每一项的工作区、会话名、运行状态和顺序；不要增删事实；不要提内部路径、会话 ID 或实现细节；可以加一句自然的口吻，但不要改变列表内容。',
        )
        : undefined;
      return handleOwnerAction(ownerAction, {
        bridge, actor, messageId: message.messageId, reply, next, render: renderList,
      });
    }
    if (!task || /^(status|cancel|result)(?:\s|$)/.test(task) && !control || inputTask.startsWith('--workspace') && !routing) {
      await reply('用 /dsh 任务内容 下任务。用 /dsh status 任务号 查询，或用 /dsh cancel 任务号 取消。' +
        (identity.owner ? ' 指定成员工作区用 /dsh --workspace 别名 任务内容。'
          : ' 用 /dsh result 任务号 可把任务结果发到当前群。'));
      return;
    }

    if (!access.workspace(identity, workspace) && !(identity.owner && workspace)) {
      await privateReply('喵，这个工作区现在用不了，换一个再发我一次吧。');
      return;
    }

    if (control) {
      const [, action, id] = control;
      try {
        const { code, job } = await hostRequest(action === 'cancel' ? 'DELETE' : 'GET', id, actor);
        await privateReply(code === 200 ? format(job, !groupOnly || action === 'result')
          : code === 404 ? '当前找不到这个任务。' : '当前无法操作这条任务。');
      } catch {
        await reply('暂时连不上主人侧 DSH。');
      }
      return;
    }
    if (task.length > 3000) {
      await reply('喵，任务说明太长啦，3000 字以内再发我一次好不好？');
      return;
    }
    const id = createHash('sha256').update(JSON.stringify([identity.principal, scope, group, message.messageId])).digest('hex').slice(0, 24);
    if (submitting.has(id) || delivered.has(id)) return;
    submitting.add(id);
    const route = selectTaskBackend(pptRouteText ?? input, {
      intent,
      forceDsh: Boolean(command || natural || naturalC2cDsh || naturalGroupDsh),
    });
    const taskRequest = buildTaskRequest(task, workspace, route);
    const taskAttachments = pptAttachments.length > 0 ? pptAttachments : downloadedImages;
    if (taskAttachments.length > 0) taskRequest.attachments = taskAttachments;
    let accepted;
    try {
      accepted = await hostRequest('PUT', id, actor, taskRequest);
    } catch {
      submitting.delete(id);
      await reply(`喵，我暂时不确定任务有没有送到 DSH，你先用 /dsh status ${id} 查一下好不好？`);
      return;
    }
    if (![200, 202].includes(accepted.code)) {
      submitting.delete(id);
      await reply(accepted.code === 409
        ? '喵，DSH 那边现在有点忙，这个任务暂时没法执行，稍后再发我一次好不好？'
        : '喵，DSH 没有接下这个任务，暂时没法执行。');
      return;
    }
    const replyOnce = async job => {
      const activeIdentity = createAccess(await loadAccess()).identify(actor);
      if (!activeIdentity || activeIdentity.principal !== identity.principal || activeIdentity.dmOpenid !== identity.dmOpenid) return;
      const statusOnly = format(job, false, false);
      const raw = format(job, !groupOnly, false);
      let output;
      if (raw.length <= 900) {
        output = await renderTaskText('result', raw);
      } else {
        const body = job.result || job.error || '';
        const lead = await renderTaskText('result-lead', `${statusOnly}。结果比较长，正文在下面。`, { timeoutMs: 8_000 });
        output = body ? `${lead}\n\n${body}` : lead;
      }
      await resultReply(groupOnly && job.result ? `${output}。用 /dsh result ${id} 可在群里查看正文。` : output, job.files);
      delivered.add(id);
      if (delivered.size > 128) delivered.delete(delivered.values().next().value);
    };
    // Start observing even if the immediate acknowledgement fails to reach QQ.
    void (async () => {
      let job = accepted.job;
      let lastProgressStage = '';
      let lastProgressAt = 0;
      if (active.has(job.status)) {
        const engine = route.backend === 'both' ? 'DSH 和本机 Codex' : route.backend === 'codex' ? '本机 Codex' : 'DSH';
        if (!earlyAckSent) {
          earlyAckSent = true;
          const started = job.status === 'queued' ? '已经接单，排队准备执行' : '已经开始执行';
          const destination = inGroup ? groupOnly ? '状态会回到本群。' : '结果回私聊。' : '';
          const fallbackAck = `喵，收到啦，这个任务可以执行，${started}。任务号 ${id}。执行端是${engine}。${destination}`;
          let ack = await renderTaskText('ack', fallbackAck, { timeoutMs: 6_000 });
          if (!ack.includes(id)) ack += `\n任务号 ${id}`;
          if (!/(开始执行|排队|执行中|接单)/u.test(ack)) ack += `\n${started}。`;
          await reply(ack).catch(() => {});
        }
      }
      // The DSH Host owns the long-running job. This loop only observes it in the
      // background and never converts a notification delay into a task timeout.
      while (active.has(job.status)) {
        await delay(pollMs, undefined, { ref: false });
        const state = await hostRequest('GET', id, actor).catch(() => null);
        if (state?.code === 200) job = state.job;
        if (state?.code === 403) return;
        if (state?.code === 404) {
          await resultReply('喵，这轮任务的连接断掉了，去 DSH 桌面看一眼好不好？');
          return;
        }
        const progress = job.progress;
        if (inGroup && !groupOnly && progressStages.has(progress?.stage)
          && progress.stage !== lastProgressStage && Date.now() - lastProgressAt >= 120_000) {
          lastProgressStage = progress.stage;
          lastProgressAt = Date.now();
          const rendered = await renderTaskText('progress', `当前进度：${progress.label}`, {
            fallbackText: progressPersonaFallback(progress),
          });
          await reply(rendered).catch(() => {});
        }
      }
      if (!active.has(job.status)) await replyOnce(job);
    })().catch(() => logger?.warn?.('owner DSH result delivery failed (%s)', id))
      .finally(() => submitting.delete(id));
  };
}

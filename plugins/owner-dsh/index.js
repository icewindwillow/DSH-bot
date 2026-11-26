import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { createAccess, wireIdentity } from './access.mjs';
import { memberPreset, memberWorkspacePath, registerMemberTools } from './member-files.mjs';
import { createOwnerSessions } from './owner-sessions.mjs';
import { personalAccessForProfile } from './personal-profile.mjs';

export const name = 'qqbot-owner-dsh';
export const inject = ['sessionController', 'workspaceController', 'tools', 'agents', 'llm'];

const jobIdPattern = /^[a-f0-9]{24}$/;
const identityCodePattern = /^[A-F0-9]{12}$/;
const qqIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const maxText = 3000;
const defaultJobTimeoutMs = 24 * 60 * 60_000;
const deliverableExtensions = new Set(['.pptx', '.html', '.pdf', '.md']);
const active = job => ['queued', 'running', 'cancelling'].includes(job.status);

export function taskDirectories(directory, id) {
  const base = join(directory, `task-${id.slice(0, 8)}`);
  return { base, codex: join(base, 'codex'), dsh: join(base, 'dsh') };
}

/**
 * 主人点名已有 DSH 工作区时，DSH 车道直接跑在该工作区根目录；
 * 未点名工作区的主人的默认任务仍落在 task-xxx/dsh 隔离目录，成员也保持隔离。
 * 附件始终落在 task-xxx/dsh/input，避免把仓库根目录当附件暂存区。
 */
export function ownerLaneWorkspace(selected, directory, lanes) {
  const root = selected?.owner === true
    && typeof selected.workspacePath === 'string' && selected.workspacePath !== '';
  return {
    root,
    dsh: root ? directory : selected?.owner === true ? lanes.dsh : directory,
    attachments: root || selected?.owner === true ? lanes.dsh : directory,
  };
}

export async function collectDeliverables(directories) {
  const files = [];
  for (const directory of directories) {
    let entries;
    try {
      entries = await readdir(directory, { recursive: true, withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.') || entry.name.startsWith('~$')) continue;
      if (!deliverableExtensions.has(extname(entry.name).toLowerCase())) continue;
      const parent = typeof entry.parentPath === 'string' ? entry.parentPath : directory;
      files.push(join(parent, entry.name));
      if (files.length >= 12) return [...new Set(files)];
    }
  }
  return [...new Set(files)];
}

export function appendDeliverables(result, files) {
  if (!files.length) return result;
  const body = String(result || '已完成')
    .split('\n')
    .filter(line => !line.includes('codex-file-citation')
      && !/^\s*[-*]?\s*(?:\/Users|\/private|\/tmp)\//u.test(line))
    .join('\n')
    .trim();
  return `${body || '已完成'}\n\n文件已附加：\n${files.map(file => `- ${basename(file)}`).join('\n')}`;
}

function laneResult(job) {
  if (job?.status === 'done') return job.result || '已完成';
  if (job?.status === 'timed-out') return '超时';
  return `失败：${job?.error || '未知错误'}`;
}

export function combineLaneResults(codexJob, dshJob) {
  return `【Codex】\n${laneResult(codexJob)}\n\n【DSH】\n${laneResult(dshJob)}`;
}

function defaultSelection(ctx) {
  try {
    const service = ctx?.get?.('agentDefaultModel');
    const selection = service?.currentSelection?.();
    if (selection?.provider && selection?.model) return selection;
  } catch { /* no default model service in this composition */ }
  return undefined;
}

async function findWorkspace(workspaces, llm, requested, signal, selection) {
  if (typeof requested !== 'string' || !requested.trim()) return;
  const stream = workspaces.follow(signal)[Symbol.asyncIterator]();
  try {
    const frame = await stream.next();
    const items = frame.value?.type === 'baseline' ? frame.value.value?.items ?? [] : [];
    const wanted = requested.trim().toLocaleLowerCase();
    const exact = items.filter(item => [item.title, item.path, basename(item.path ?? '')]
      .some(value => typeof value === 'string' && value.trim().toLocaleLowerCase() === wanted));
    if (exact.length === 1) return exact[0];
    const words = wanted.split(/[^\p{L}\p{N}_-]+/u).filter(word => word.length > 1);
    const fuzzy = items.map(item => {
      const haystack = [item.title, item.path, basename(item.path ?? '')].join(' ').toLocaleLowerCase();
      return { item, score: words.filter(word => haystack.includes(word)).length };
    }).filter(entry => entry.score > 0).sort((a, b) => b.score - a.score);
    if (fuzzy.length && fuzzy[0].score > (fuzzy[1]?.score ?? 0)) return fuzzy[0].item;
    if (!llm || typeof llm.stream !== 'function' || !items.length || !selection) return;
    let output = '';
    for await (const chunk of llm.stream({
      ...selection, reasoningEffort: selection.reasoningEffort ?? 'low', maxTokens: 120,
      system: '从候选 DSH 工作区中解析用户提到的目标。只输出 JSON，例如 {"index":0}，无法确定时输出 {"index":null}。不要执行任务。',
      messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify({ requested, workspaces: items.map((item, index) => ({ index, title: item.title, path: item.path })) }) }] }],
      signal,
    })) if (chunk?.type === 'text-delta') output += chunk.text ?? '';
    const match = output.match(/\{\s*"index"\s*:\s*(\d+|null)\s*\}/);
    const index = match && match[1] !== 'null' ? Number(match[1]) : -1;
    return Number.isInteger(index) && items[index] ? items[index] : undefined;
  } finally { await stream.return?.(); }
}

function publicJob(job) {
  const { id, sessionId, status, result, progress, files, error } = job;
  return { id, sessionId, status, result, progress, files: files ?? [], error };
}

async function runJob(job, sessions, workspaceId, text, signal, agentPreset, options = {}) {
  const { sessionId, agentPreset: mounted } = await sessions.create({ workspaceId, ...(agentPreset && { agentPreset }) });
  if (agentPreset === memberPreset && mounted !== memberPreset) throw new Error('Member isolation preset unavailable');
  if (options.model?.provider && options.model?.model) {
    const agents = options.ctx?.get?.('agents');
    const agent = agents?.get?.(sessionId);
    if (agent?.model?.select) {
      await options.ctx.get('llm')?.resolveCallConfig?.(options.model);
      agent.model.select(options.model);
    }
  }
  job.sessionId = sessionId;
  await sessions.rename({ sessionId, title: `小易委派 ${job.id.slice(0, 8)}` });
  const events = sessions.observeEvent({ address: { kind: 'session', sessionId } }, signal)[Symbol.asyncIterator]();
  try {
    if ((await events.next()).value?.type !== 'ready') throw new Error('Session observer unavailable');
    signal.throwIfAborted();
    await sessions.prompt({
      requestId: `qqbot-${job.id}`, sessionId, mode: 'queue', content: [{ type: 'text', text }],
    }, signal);
    let currentTurn;
    let result = '';
    let mixed = false;
    let otherInput = false;
    for await (const frame of { [Symbol.asyncIterator]: () => events }) {
      if (frame.type !== 'event') continue;
      const { event } = frame;
      if (event.type === 'turn/start') {
        job.canCancel = false;
        currentTurn = event.data.turn;
        result = '';
        mixed = false;
        otherInput = false;
      }
      if (event.type === 'user/message' && event.data.source?.kind === 'user') {
        if (event.data.source.rpcId === `qqbot-${job.id}`) {
          job.turn = currentTurn;
          job.status = 'running';
        } else {
          otherInput = true;
        }
        mixed = otherInput;
        job.canCancel = job.turn === currentTurn && !mixed;
      }
      if (job.turn === undefined || currentTurn !== job.turn) continue;
      if (event.type === 'assistant/message' && !event.data.interrupted) {
        const content = event.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('');
        if (content.trim()) result = content.trim();
      }
      if (event.type === 'turn/end') {
        job.canCancel = false;
        const reason = event.data.reason.kind;
        if (mixed) job.status = 'mixed';
        else if (reason === 'aborted') job.status = 'cancelled';
        else if (reason === 'completed' || reason === 'max-tokens') {
          job.status = result ? 'done' : 'no-result';
          const characters = Array.from(result);
          job.result = characters.length > 1200 ? characters.slice(0, 1200).join('') + '\n…完整结果请在 DSH 桌面查看。' : result;
        } else job.status = 'failed';
        return;
      }
    }
    throw new Error('Session observer closed');
  } finally {
    await events.return?.();
  }
}

export function codexArguments(directory, text, model, lastMessagePath) {
  return [
    '-C', directory, 'exec', '--sandbox', 'workspace-write', '--skip-git-repo-check',
    ...(model ? ['--model', model] : []),
    ...(lastMessagePath ? ['--output-last-message', lastMessagePath] : []),
    text,
  ];
}

async function runCodex(job, directory, text, signal, model, runner) {
  if (typeof runner === 'function') {
    job.status = 'running';
    job.progress = { stage: 'drawing', label: 'Codex 正在制作' };
    const output = await runner({ directory, text, model, signal });
    job.progress = { stage: 'done', label: '已完成，正在整理结果' };
    job.status = 'done';
    job.result = typeof output === 'string' && output.trim() ? output.trim() : '已完成';
    return;
  }
  const binary = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  const lastMessagePath = join(directory, `.codex-last-${job.id}.txt`);
  const args = codexArguments(directory, text, model, lastMessagePath);
  job.status = 'running';
  const startedAt = Date.now();
  const progressTimer = setInterval(async () => {
    const elapsed = Date.now() - startedAt;
    let hasPptx = false;
    try {
      const entries = await readdir(directory);
      hasPptx = entries.some(name => /\.pptx$/iu.test(name));
    } catch { /* 进度扫描失败不影响 Codex */ }
    job.progress = hasPptx
      ? { stage: 'finalizing', label: '正在检查 PPTX 成品' }
      : elapsed < 8 * 60_000
        ? { stage: 'reading', label: '正在读取材料和整理结构' }
        : elapsed < 16 * 60_000
          ? { stage: 'drawing', label: '正在制作页面和图文版式' }
          : { stage: 'polishing', label: '正在打磨细节并准备导出' };
  }, 30_000);
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(binary, args, { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
      let result = '';
      const append = chunk => { result += chunk.toString(); if (Buffer.byteLength(result) > 256 * 1024) child.kill('SIGTERM'); };
      child.stdout.on('data', append); child.stderr.on('data', append);
      const abort = () => child.kill('SIGTERM');
      signal.addEventListener('abort', abort, { once: true });
      child.on('error', error => { signal.removeEventListener('abort', abort); reject(error); });
      child.on('close', code => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) return reject(signal.reason ?? new Error('Codex cancelled'));
        if (code !== 0) return reject(new Error(`Codex exited with ${code}: ${result.slice(-2000)}`));
        resolve(result.trim());
      });
    });
    let lastMessage = '';
    try { lastMessage = (await readFile(lastMessagePath, 'utf8')).trim(); } catch { /* use captured output */ }
    const result = lastMessage || output.trim();
    job.progress = { stage: 'done', label: '已完成，正在整理结果' };
    job.status = 'done';
    job.result = result.length > 1200 ? `…${result.slice(-1200)}\n（完整结果请在 DSH 工作区查看）` : result;
  } finally {
    clearInterval(progressTimer);
    await unlink(lastMessagePath).catch(() => {});
  }
}

async function readTask(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return;
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    if ((size += chunk.length) > 16_384) return;
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks));
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  const backend = ['codex', 'dsh', 'both'].includes(body?.backend) ? body.backend : 'dsh';
  const model = typeof body?.model === 'string' && body.model.trim() && body.model.length <= 128
    ? body.model.trim() : undefined;
  const dshModel = body?.dshModel && typeof body.dshModel.provider === 'string'
    && typeof body.dshModel.model === 'string'
    ? { provider: body.dshModel.provider.trim().slice(0, 60), model: body.dshModel.model.trim().slice(0, 128) }
    : undefined;
  const attachments = Array.isArray(body?.attachments)
    ? body.attachments.slice(0, 8).map(item => ({
      path: typeof item?.path === 'string' ? item.path.trim() : '',
      name: typeof item?.name === 'string' ? item.name.trim().slice(0, 160) : '',
    })).filter(item => item.path.startsWith('/') && item.path.length <= 500)
    : [];
  if (text && text.length <= maxText && (body.workspace === undefined || typeof body.workspace === 'string')) {
    return { text, workspace: body.workspace, backend, ...(model && { model }), ...(dshModel && { dshModel }), ...(attachments.length && { attachments }) };
  }
}

async function stageAttachments(attachments, targetDirectory, sourceRoot) {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  const inputDirectory = join(targetDirectory, 'input');
  await mkdir(inputDirectory, { recursive: true, mode: 0o700 });
  const references = [];
  for (const [index, item] of attachments.entries()) {
    let source;
    try { source = await realpath(item.path); } catch { continue; }
    if (sourceRoot && source !== sourceRoot && !source.startsWith(sourceRoot + '/')) continue;
    const original = basename(item.name || source).replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^\.+/u, '_');
    const name = `${String(index + 1).padStart(2, '0')}-${original || 'image'}`;
    const destination = join(inputDirectory, name);
    try {
      const stat = await lstat(source);
      if (!stat.isFile() || stat.size > 25 * 1024 * 1024) continue;
      await copyFile(source, destination);
      references.push(`input/${name}`);
    } catch { /* one unavailable attachment must not cancel the whole task */ }
  }
  return references;
}

async function removeStaleSocket(path) {
  const previous = await lstat(path).catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!previous) return;
  if (!previous.isSocket() || previous.uid !== process.getuid()) {
    throw new Error('The owner DSH socket path is occupied by a different file');
  }

  const probe = connect({ path, signal: AbortSignal.timeout(1000) });
  try {
    await once(probe, 'connect');
    throw new Error('Another owner DSH bridge is already listening');
  } catch (error) {
    if (error.code !== 'ECONNREFUSED') throw error;
  } finally {
    probe.destroy();
  }

  const current = await lstat(path);
  if (current.dev !== previous.dev || current.ino !== previous.ino || current.ctimeMs !== previous.ctimeMs) {
    throw new Error('The owner DSH socket changed during startup');
  }
  await unlink(path);
}

export async function apply(ctx, config = {}) {
  const socket = config.socket ?? process.env.QQBOT_OWNER_DSH_SOCKET;
  const directory = config.workspace ?? process.env.QQBOT_OWNER_DSH_WORKSPACE;
  if (!socket && !directory) return;
  if (!isAbsolute(socket ?? '') || !isAbsolute(directory ?? '')) throw new Error('Configure an absolute socket and workspace path');
  const parent = await lstat(dirname(socket));
  if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o077)) {
    throw new Error('The owner DSH socket requires a private directory (0700)');
  }
  await removeStaleSocket(socket);
  const workspace = await realpath(directory);
  if (!(await lstat(workspace)).isDirectory()) throw new Error('The owner DSH workspace must be a directory');

  const bridgeDir = await realpath(dirname(socket));
  // 附件实际下载在 ~/.dsh-qqbot/media（dsh-qqbot 的 MEDIA_ROOT），
  // 不是 profile 目录；这里允许 entry 通过 mediaRoot 覆盖，默认指向真实目录。
  const mediaRoot = typeof config.mediaRoot === 'string' && config.mediaRoot
    ? config.mediaRoot
    : join(process.env.HOME ?? '', '.dsh-qqbot', 'media');
  const attachmentRoot = await realpath(mediaRoot).catch(() => undefined);
  const file = config.accessFile ?? join(bridgeDir, 'qq.json');
  const membersPath = join(bridgeDir, 'members');
  await mkdir(membersPath, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const membersRoot = await realpath(membersPath);
  const memberStat = await lstat(membersPath);
  if (membersRoot !== membersPath || !memberStat.isDirectory() || memberStat.uid !== process.getuid() || (memberStat.mode & 0o077)) {
    throw new Error('The DSH member root must be a private directory');
  }
  const personal = config.qqProfile ? personalAccessForProfile(bridgeDir, config.qqProfile,
    (await import('./profile-documents.mjs')).readProfileDocument) : undefined;
  const loadAccess = async () => createAccess(personal?.load() ?? config.access ?? JSON.parse(await readFile(file, 'utf8')));
  await loadAccess();
  registerMemberTools(ctx, membersRoot, workspace);

  const sessions = ctx.get('sessionController');
  const workspaces = ctx.get('workspaceController');
  const llm = ctx.get('llm');
  const defaultModel = defaultSelection(ctx);
  const codexRunner = typeof config.codexRunner === 'function' ? config.codexRunner : undefined;
  const lifetime = new AbortController();
  const jobs = new Map();
  const groupIdentities = new Map();
  const ownerSessions = createOwnerSessions({
    workspaces, sessions, agents: ctx.get('agents'), dbPath: join(bridgeDir, 'watched-turns.sqlite'),
    lifetime: lifetime.signal, loadAccess, logger: ctx.logger,
    ownWorkspace: principal => memberWorkspacePath(membersRoot, principal),
  });
  const server = createServer({ requestTimeout: 5000 }, async (req, res) => {
    const respond = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    try {
      if (req.method === 'GET' && req.url === '/health') return respond(200, { status: 'ready' });
      if (personal && req.method === 'GET' && req.url?.startsWith('/owner/group-identity')) {
        const actor = wireIdentity(req.headers);
        const prefix = '/owner/group-identity/';
        const now = Date.now();
        for (const [code, claim] of groupIdentities) if (claim.expires <= now) groupIdentities.delete(code);
        if (req.url === '/owner/group-identity' && actor.scope === 'group'
          && qqIdPattern.test(actor.group ?? '') && qqIdPattern.test(actor.sender ?? '')) {
          const previous = [...groupIdentities].find(([, claim]) => claim.sender === actor.sender && claim.group === actor.group);
          if (previous) return respond(200, { code: previous[0] });
          if (groupIdentities.size >= 128) return respond(429, { error: 'busy' });
          const code = randomBytes(6).toString('hex').toUpperCase();
          groupIdentities.set(code, { sender: actor.sender, group: actor.group, expires: now + 10 * 60_000 });
          return respond(200, { code });
        }
        if (req.url.startsWith(prefix) && actor.scope === 'c2c' && (await loadAccess()).identify(actor)?.owner) {
          const code = req.url.slice(prefix.length);
          const claim = identityCodePattern.test(code) && groupIdentities.get(code);
          if (claim) return respond(200, { sender: claim.sender, group: claim.group });
          return respond(404, { error: 'unknown-code' });
        }
        return respond(403, { error: 'forbidden' });
      }
      if (req.url === '/owner/link' && req.method === 'POST' && personal) {
        let bytes = 0;
        const chunks = [];
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 1024) return respond(400, { status: 'invalid' });
          chunks.push(chunk);
        }
        const { code } = JSON.parse(Buffer.concat(chunks));
        return respond(200, personal.link(wireIdentity(req.headers), code));
      }
      if (req.url?.startsWith('/owner/')) {
        const { code, body } = await ownerSessions.route(req, req.url);
        return respond(code, body);
      }
      const [, resource, id] = (req.url ?? '').split('/');
      if (resource !== 'jobs' || !jobIdPattern.test(id ?? '') || req.url !== `/jobs/${id}`) {
        return respond(404, { error: 'not-found' });
      }
      const access = await loadAccess();
      const actor = wireIdentity(req.headers);
      const identity = access.identify(actor);
      if (!identity) return respond(403, { error: 'forbidden' });
      const existing = jobs.get(id);
      const jobGroup = !identity.owner && actor.scope === 'group' ? actor.group : undefined;
      const owns = job => job.principal === identity.principal && (!jobGroup || job.group === jobGroup);
      if (existing && !owns(existing)) return respond(404, { error: 'not-found' });
      if (req.method === 'GET') return existing ? respond(200, publicJob(existing)) : respond(404, { error: 'not-found' });
      if (req.method === 'DELETE') {
        if (!existing) return respond(404, { error: 'not-found' });
        if (!existing.canCancel || existing.status !== 'running') return respond(409, { error: 'cannot-cancel' });
        sessions.cancel({ sessionId: existing.sessionId });
        existing.status = 'cancelling';
        existing.canCancel = false;
        return respond(200, publicJob(existing));
      }
      if (req.method !== 'PUT') return respond(405, { error: 'method' });
      const task = await readTask(req).catch(() => undefined);
      if (!task) return respond(400, { error: 'invalid-task' });
      let selected = access.workspace(identity, task.workspace);
      if (!selected && identity.owner && task.workspace) {
        const target = await findWorkspace(workspaces, llm, task.workspace, AbortSignal.timeout(3500), defaultModel);
        if (target) selected = { ...identity, workspace: target.title, workspacePath: target.path };
      }
      if (!selected) return respond(403, { error: 'forbidden' });
      const cutoff = Date.now() - 60 * 60_000;
      for (const [key, job] of jobs) if (job.settledAt < cutoff) jobs.delete(key);
      const latest = jobs.get(id);
      if (latest) return owns(latest) ? respond(200, publicJob(latest)) : respond(404, { error: 'not-found' });
      if ([...jobs.values()].some(job => active(job) && job.workspace === selected.principal) || jobs.size >= 128) {
        return respond(409, { error: 'busy' });
      }
      const job = { id, principal: identity.principal, workspace: selected.principal, group: jobGroup, status: 'queued' };
      jobs.set(id, job);
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(config.jobTimeoutMs ?? defaultJobTimeoutMs)]);
      void (async () => {
        let directory = selected.workspacePath ?? workspace;
        // 主人（私聊或已绑定的群身份）使用主人默认预设，才能操作目标仓库；
        // 成员仍强制使用 qqbot-member 隔离预设。
        let preset = selected.owner ? config.agentPreset : memberPreset;
        if (!selected.owner) {
          directory = memberWorkspacePath(membersRoot, selected.principal);
          await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
          const entry = await lstat(directory);
          if (!entry.isDirectory() || entry.uid !== process.getuid() || (entry.mode & 0o077)) {
            throw new Error('Invalid isolated workspace');
          }
          preset = memberPreset;
        }
        const lanes = taskDirectories(directory, id);
        await mkdir(lanes.base, { recursive: true, mode: 0o700 });
        const lane = ownerLaneWorkspace(selected, directory, lanes);
        const dshWorkspace = lane.dsh;
        const dshRelative = relative(directory, lanes.dsh);
        const codexInputs = task.backend === 'dsh' ? [] : await stageAttachments(task.attachments, lanes.codex, attachmentRoot);
        const dshInputs = task.backend === 'codex' ? [] : await stageAttachments(task.attachments, lane.attachments, attachmentRoot);
        const dshInputRefs = lane.root ? dshInputs.map(ref => `${dshRelative}/${ref}`) : dshInputs;
        const inputPrompt = (label, refs) => refs.length
          ? [`【${label}】`, '用户随消息提供的图片已复制到当前任务工作区。请直接使用这些相对路径，不要猜测或重新下载。', ...refs.map(ref => `- ${ref}`)].join('\n')
          : '';
        const codexText = [
          task.text,
          inputPrompt('输入素材', codexInputs),
          '',
          '【Codex 独立车道】',
          '这一份完全由 Codex 执行：设计、审美、素材、排版、文件写入和验收都由你负责。',
          '不要等待 DSH，也不要把制作交给 DSH。所有成品写入当前目录。',
          'Python、Blender 或本地工具只能由你主动调用，不能替代你完成设计和成品。',
        ].join('\n');
        const dshText = [
          task.text,
          inputPrompt('输入素材', dshInputRefs),
          '',
          '【DSH 独立车道】',
          '这一份完全由你当前的默认模型执行：设计、审美、素材、排版、文件写入和验收都由你负责。',
          '不要调用 Codex，也不要把制作交给 Codex。',
          lane.root
            ? `当前工作区是「${selected.workspace}」的根目录，直接在这里操作，不要切换到 task-* 子目录。测试和命令都在仓库根目录执行；报告直接回复正文，如需回传文件请写入 ${dshRelative}/。`
            : selected.owner ? '所有成品写入当前工作区。' : `所有成品写入当前工作区的 ${dshRelative}/ 目录。`,
        ].join('\n');
        const runDshLane = async targetJob => {
          await mkdir(lanes.dsh, { recursive: true, mode: 0o700 });
          const { workspace: { workspaceId }, created } = await workspaces.create({ path: dshWorkspace });
          if (created && !lane.root) await workspaces.rename({
            workspaceId,
            title: selected.owner ? `小易 · ${id.slice(0, 8)}` : `小易 · ${selected.workspace}`,
          });
          signal.throwIfAborted();
          await runJob(targetJob, sessions, workspaceId, dshText, signal, preset, { model: task.dshModel, ctx });
          targetJob.files = await collectDeliverables([lanes.dsh]);
          targetJob.result = appendDeliverables(targetJob.result, targetJob.files);
        };

        if (task.backend === 'codex') {
          await mkdir(lanes.codex, { recursive: true, mode: 0o700 });
          await runCodex(job, lanes.codex, codexText, signal, task.model, codexRunner);
          job.files = await collectDeliverables([lanes.codex]);
          job.result = appendDeliverables(job.result, job.files);
          return;
        }
        if (task.backend === 'dsh') {
          await runDshLane(job);
          return;
        }

        job.status = 'running';
        job.progress = { stage: 'drawing', label: 'DSH 和 Codex 正在同时制作' };
        await mkdir(lanes.codex, { recursive: true, mode: 0o700 });
        const codexJob = { id, status: 'queued' };
        const dshJob = { id, status: 'queued' };
        const codexPromise = runCodex(codexJob, lanes.codex, codexText, signal, task.model, codexRunner)
          .then(async () => {
            codexJob.files = await collectDeliverables([lanes.codex]);
            codexJob.result = appendDeliverables(codexJob.result, codexJob.files);
          })
          .catch(error => {
            codexJob.status = signal.aborted ? 'timed-out' : 'failed';
            codexJob.error = error.message;
          });
        const dshPromise = runDshLane(dshJob).catch(error => {
          dshJob.status = signal.aborted ? 'timed-out' : 'failed';
          dshJob.error = error.message;
        });
        await Promise.all([codexPromise, dshPromise]);
        job.sessionId = dshJob.sessionId;
        job.result = combineLaneResults(codexJob, dshJob);
        job.files = [...new Set([...(codexJob.files ?? []), ...(dshJob.files ?? [])])];
        job.progress = { stage: 'done', label: '两份都已完成' };
        const done = [codexJob, dshJob].filter(item => item.status === 'done').length;
        job.status = signal.aborted ? 'timed-out' : done === 2 ? 'done' : done === 1 ? 'partial' : 'failed';
      })().catch(error => {
        job.canCancel = false;
        job.status = signal.aborted ? 'timed-out' : 'failed';
        job.error = error.message;
        if (!signal.aborted) ctx.logger?.warn?.('owner DSH job failed (%s)', id);
      }).finally(() => { job.settledAt = Date.now(); });
      return respond(202, publicJob(job));
    } catch {
      if (!res.headersSent) respond(500, { error: 'host-error' });
    }
  });
  const dispose = () => {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    server.close();
    ownerSessions.close();
    personal?.close();
  };
  ctx.on('dispose', dispose);
  ctx.effect(() => dispose);
  server.listen(socket);
  await once(server, 'listening');
}

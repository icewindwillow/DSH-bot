import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdir, readFile, realpath, unlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, isAbsolute, join } from 'node:path';
import { createAccess, wireIdentity } from './access.mjs';
import { memberPreset, memberWorkspacePath, registerMemberTools } from './member-files.mjs';
import { createOwnerSessions } from './owner-sessions.mjs';
import { personalAccessForProfile } from './personal-profile.mjs';

export const name = 'qqbot-owner-dsh';
export const inject = ['sessionController', 'workspaceController', 'tools', 'agents'];

const jobIdPattern = /^[a-f0-9]{24}$/;
const identityCodePattern = /^[A-F0-9]{12}$/;
const qqIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const maxText = 3000;
const active = job => ['queued', 'running', 'cancelling'].includes(job.status);

function publicJob(job) {
  const { id, sessionId, status, result } = job;
  return { id, sessionId, status, result };
}

async function runJob(job, sessions, workspaceId, text, signal, agentPreset) {
  const { sessionId, agentPreset: mounted } = await sessions.create({ workspaceId, ...(agentPreset && { agentPreset }) });
  if (agentPreset === memberPreset && mounted !== memberPreset) throw new Error('Member isolation preset unavailable');
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
  if (text && text.length <= maxText && (body.workspace === undefined || typeof body.workspace === 'string')) {
    return { text, workspace: body.workspace };
  }
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
      const selected = access.workspace(identity, task.workspace);
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
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(10 * 60_000)]);
      void (async () => {
        let directory = workspace;
        let preset = actor.scope === 'group' ? memberPreset : config.agentPreset;
        if (!selected.owner) {
          directory = memberWorkspacePath(membersRoot, selected.principal);
          await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
          const entry = await lstat(directory);
          if (!entry.isDirectory() || entry.uid !== process.getuid() || (entry.mode & 0o077)) {
            throw new Error('Invalid isolated workspace');
          }
          preset = memberPreset;
        }
        const { workspace: { workspaceId }, created } = await workspaces.create({ path: directory });
        if (!selected.owner && created) await workspaces.rename({ workspaceId, title: `小易 · ${selected.workspace}` });
        signal.throwIfAborted();
        await runJob(job, sessions, workspaceId, task.text, signal, preset);
      })().catch(() => {
        job.canCancel = false;
        job.status = signal.aborted ? 'timed-out' : 'failed';
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

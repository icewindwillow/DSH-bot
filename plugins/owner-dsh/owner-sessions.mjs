import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { wireIdentity } from './access.mjs';
import { memberPreset } from './member-files.mjs';

const idPattern = /^[a-f0-9]{24}$/;
const choiceLimit = 8;
const lifetimeMs = 5 * 60_000;
const watchLimit = 12;
const watchLifetimeMs = 7 * 24 * 60 * 60_000;
const nameOf = (value, fallback) => typeof value === 'string' && value.trim()
  ? [...value.replace(/\s+/g, ' ').trim()].slice(0, 90).join('') : fallback;
const key = value => value.normalize('NFKC').trim().toLowerCase();
const matches = (value, label) => key(value) === key(label);
const address = sessionId => ({ kind: 'session', sessionId });

async function baseline(workspaces, signal) {
  const stream = workspaces.follow(signal)[Symbol.asyncIterator]();
  try {
    const { value } = await stream.next();
    if (value?.type !== 'baseline') throw new Error('Workspace baseline unavailable');
    return value.value;
  } finally { await stream.return?.(); }
}

function pickTitles(items, label) {
  if (!label) return items;
  const exact = items.filter(item => matches(item.title, label));
  return exact.length ? exact : items.filter(item => key(item.title).includes(key(label)));
}

function liveBoundary(agents, sessionId) {
  const agent = agents.get(sessionId);
  return agent ? agents.turnBoundaryOf(agent.session) : undefined;
}

async function lastExcerpt(sessions, sessionId, signal) {
  try {
    const result = await sessions.events({ address: address(sessionId), maxMessages: 20 }, signal);
    const events = (result.records ?? []).filter(frame => frame.type === 'event').map(frame => frame.event);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const item = events[index];
      if (item.type !== 'assistant/message' || item.data?.interrupted) continue;
      const content = Array.isArray(item.data?.message?.content) ? item.data.message.content : [];
      const text = content.filter(part => part.type === 'text').map(part => part.text).join('').replace(/\s+/g, ' ').trim();
      if (text) return [...text].slice(0, 160).join('');
    }
  }
  catch { /* 单个会话读不到时不影响列表 */ }
  return '';
}

const memberSession = (item, privatePath) =>
  item.cwd === privatePath && item.projections?.values?.agentPreset === memberPreset;

async function candidates(workspaces, sessions, agents, action, signal, privatePath) {
  const snapshot = await baseline(workspaces, signal);
  const visible = privatePath ? snapshot.items.filter(item => item.path === privatePath) : snapshot.items;
  const found = privatePath && ['我的工作区', '自己的工作区', '我的'].includes(action.workspace)
    ? visible : pickTitles(visible, action.workspace);
  if (!found.length) return { status: 'workspace-missing' };
  if (found.length > 1) return { status: 'workspace-ambiguous', names: found.slice(0, choiceLimit).map(x => nameOf(x.title)) };
  const [workspace] = found;
  const memberIds = new Set(workspace.sessionIds);
  const archived = new Set(snapshot.archivedSessionIds);
  const { items } = await sessions.list({}, signal);
  const eligible = items.filter(item => memberIds.has(item.sessionId) && !archived.has(item.sessionId) &&
    !item.parentSessionId && !item.origin && (!privatePath || memberSession(item, privatePath)) && item.formatStatus !== 'migration-required' &&
    (action.operation === 'watch' ? item.running : !item.blank));
  const ordered = eligible
    .map(item => ({ ...item, title: nameOf(item.projections?.values?.title, '未命名会话') }))
    .sort((left, right) => Number(right.running) - Number(left.running) || right.updatedAt - left.updatedAt);
  const matching = pickTitles(ordered, action.session);
  const limited = matching.slice(0, choiceLimit);
  const entries = limited.map(item => {
    const target = {
      workspaceId: workspace.workspaceId,
      path: workspace.path,
      workspace: nameOf(workspace.title, '未命名工作区'),
      sessionId: item.sessionId,
      title: item.title,
      running: item.running,
    };
    if (action.operation === 'send') return target;
    const turn = liveBoundary(agents, item.sessionId);
    return Number.isSafeInteger(turn?.openTurnStartSeq) && Number.isSafeInteger(turn.lastTurn)
      ? { ...target, start: turn.openTurnStartSeq, turn: turn.lastTurn } : undefined;
  });
  return { status: 'candidates', targets: entries.filter(Boolean), more: matching.length > choiceLimit };
}

async function listActive(workspaces, sessions, action, signal, privatePath, lifetime) {
  const snapshot = await baseline(workspaces, signal);
  const visible = privatePath ? snapshot.items.filter(item => item.path === privatePath) : snapshot.items;
  const requested = String(action.workspace ?? '').trim();
  let selected = visible;
  if (requested && !/^(?:全部|所有|当前|all)$/iu.test(requested)) {
    selected = privatePath && ['我的工作区', '自己的工作区', '我的'].includes(requested)
      ? visible : pickTitles(visible, requested);
    if (!selected.length) return { status: 'workspace-missing' };
    if (selected.length > 1) return { status: 'workspace-ambiguous', names: selected.slice(0, choiceLimit).map(item => nameOf(item.title)) };
  }
  const archived = new Set(snapshot.archivedSessionIds);
  const { items } = await sessions.list({}, signal);
  const cutoff = Date.now() - 24 * 60 * 60_000;
  const rows = [];
  for (const workspace of selected) {
    const memberIds = new Set(workspace.sessionIds);
    for (const item of items) {
      if (!memberIds.has(item.sessionId) || archived.has(item.sessionId) ||
          item.parentSessionId || item.origin || item.formatStatus === 'migration-required') continue;
      if (privatePath && !memberSession(item, privatePath)) continue;
      const updatedAt = Number(item.updatedAt ?? 0);
      if (!item.running && updatedAt < cutoff) continue;
      rows.push({
        workspaceId: workspace.workspaceId,
        path: workspace.path,
        workspace: nameOf(workspace.title, '未命名工作区'),
        sessionId: item.sessionId,
        title: nameOf(item.projections?.values?.title, '未命名会话'),
        running: item.running === true,
        updatedAt,
      });
    }
  }
  rows.sort((left, right) => Number(right.running) - Number(left.running) || right.updatedAt - left.updatedAt);
  const running = rows.filter(row => row.running);
  const selectedRows = running.length ? running : rows;
  const limited = selectedRows.slice(0, choiceLimit);
  const targets = await Promise.all(limited.map(async row => ({
    ...row,
    excerpt: await lastExcerpt(sessions, row.sessionId, AbortSignal.any([lifetime, AbortSignal.timeout(1200)])),
  })));
  return { status: 'list', targets, more: selectedRows.length > limited.length, runningOnly: running.length > 0 };
}

async function stillInWorkspace(workspaces, sessions, target, signal, privatePath) {
  const snapshot = await baseline(workspaces, signal);
  const listed = !snapshot.archivedSessionIds.includes(target.sessionId) &&
    snapshot.items.some(ws => ws.workspaceId === target.workspaceId && ws.path === target.path && ws.sessionIds.includes(target.sessionId));
  if (!listed || !privatePath) return listed;
  if (target.path !== privatePath) return false;
  const { items } = await sessions.list({}, signal);
  return items.some(item => item.sessionId === target.sessionId && memberSession(item, privatePath) && !item.parentSessionId && !item.origin);
}

function watchStatus(reason) {
  switch (reason) {
    case 'completed': return 'done';
    case 'aborted': return 'cancelled';
    default: return 'failed';
  }
}

async function readWatch(sessions, agents, watch, signal) {
  const options = { sessionId: watch.session_id };
  const pinned = turn => turn?.lastTurn === watch.turn && turn.openTurnStartSeq === watch.start_seq;
  let current = liveBoundary(agents, watch.session_id);
  if (pinned(current)) {
    const state = await sessions.state(options, signal);
    current = liveBoundary(agents, watch.session_id);
    if (pinned(current) && state.pendingInput.includes('approval')) return { kind: 'approval' };
    if (pinned(current) && state.running) return;
  }
  // Look for the end of the pinned turn even if another turn has already started.
  // Advance a durable cursor a bounded number of pages per poll to avoid replaying long histories.
  let beforeSeq = watch.before_seq ?? undefined;
  let high = watch.high_seq ?? undefined;
  for (let page = 0; page < 12; page++) {
    const result = await sessions.events({
      address: address(watch.session_id), maxMessages: 20,
      ...(beforeSeq !== undefined && { beforeSeq }),
      ...(high !== undefined && { throughSeq: high }),
    }, signal);
    high ??= result.cursor;
    const events = result.records.filter(frame => frame.type === 'event').map(frame => frame.event);
    const end = events.find(event => event.type === 'turn/end' && event.data.turn === watch.turn && event.seq > watch.start_seq);
    if (end) return { kind: watchStatus(end.data.reason.kind) };
    const first = events[0]?.seq;
    if (!result.hasMore || !Number.isSafeInteger(first) || (beforeSeq !== undefined && first >= beforeSeq) || first <= watch.start_seq) break;
    beforeSeq = first;
    if (page === 11) return { beforeSeq, high };
  }
  // A previously open, now absent turn without a retained completion must not become a watch of a new turn.
  if (!pinned(current)) {
    return { kind: 'unavailable' };
  }
  if (watch.before_seq != null) return { beforeSeq: null, high: null };
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw new Error('Request size exceeded');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks));
}

function parseAction(body) {
  if (!idPattern.test(body?.id ?? '') || !['watch', 'send', 'list'].includes(body.operation)) return;
  if (body.workspace !== undefined && (typeof body.workspace !== 'string' || body.workspace.length > 180)) return;
  if (body.operation !== 'list' && (typeof body.workspace !== 'string' || !body.workspace.trim())) return;
  if (body.session !== undefined && (typeof body.session !== 'string' || body.session.length > 180)) return;
  if (body.operation === 'send' && (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 3000)) return;
  return {
    id: body.id, operation: body.operation,
    workspace: typeof body.workspace === 'string' ? body.workspace.trim() : '',
    session: body.session?.trim(),
    text: typeof body.text === 'string' ? body.text.trim() : undefined,
  };
}

export function createOwnerSessions({ workspaces, sessions, agents, dbPath, lifetime, loadAccess, logger, ownWorkspace }) {
  const db = new DatabaseSync(dbPath);
  chmodSync(dbPath, 0o600);
  db.exec(`
    CREATE TABLE IF NOT EXISTS watched_turns (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, session_id TEXT NOT NULL,
      workspace TEXT NOT NULL, title TEXT NOT NULL,
      turn INTEGER NOT NULL, start_seq INTEGER NOT NULL, created INTEGER NOT NULL,
      before_seq INTEGER, high_seq INTEGER, finished INTEGER,
      UNIQUE(owner, session_id, start_seq)
    );
    CREATE TABLE IF NOT EXISTS watch_notifications (
      id TEXT PRIMARY KEY, watch_id TEXT NOT NULL, kind TEXT NOT NULL, delivered INTEGER
    );
    CREATE TABLE IF NOT EXISTS sent_owner_prompts (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, session_id TEXT NOT NULL, workspace TEXT NOT NULL,
      title TEXT NOT NULL, created INTEGER NOT NULL, admitted INTEGER
    );
  `);
  const selections = new Map();
  const requests = new Map();
  let scanning;
  const signal = () => AbortSignal.any([lifetime, AbortSignal.timeout(3800)]);
  function transaction(run) {
    db.exec('BEGIN IMMEDIATE');
    try { const value = run(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  async function act(action, target, identity) {
    const owner = identity.principal;
    const privatePath = identity.owner ? undefined : ownWorkspace(identity.principal);
    if (!(await stillInWorkspace(workspaces, sessions, target, signal(), privatePath))) return { status: 'stale-session' };
    if (action.operation === 'watch') {
      return transaction(() => {
        const previous = db.prepare('SELECT finished FROM watched_turns WHERE owner=? AND session_id=? AND start_seq=?')
          .get(owner, target.sessionId, target.start);
        if (previous) return { status: previous.finished ? 'already-finished' : 'watching', target };
        const { count } = db.prepare('SELECT count(*) AS count FROM watched_turns WHERE owner=? AND finished IS NULL').get(owner);
        if (count >= watchLimit) return { status: 'watch-limit' };
        const existing = db.prepare('SELECT id FROM watched_turns WHERE id=?').get(action.id);
        if (existing) return { status: 'stale-session' };
        db.prepare('INSERT INTO watched_turns(id,owner,session_id,workspace,title,turn,start_seq,created) VALUES(?,?,?,?,?,?,?,?)')
          .run(action.id, owner, target.sessionId, target.workspace, target.title, target.turn, target.start, Date.now());
        return { status: 'watching', target };
      });
    }
    const row = db.prepare('SELECT * FROM sent_owner_prompts WHERE id=?').get(action.id);
    if (row && (row.owner !== owner || row.session_id !== target.sessionId)) return { status: 'stale-session' };
    if (!row) db.prepare('INSERT INTO sent_owner_prompts(id,owner,session_id,workspace,title,created) VALUES(?,?,?,?,?,?)')
      .run(action.id, owner, target.sessionId, target.workspace, target.title, Date.now());
    if (!row?.admitted) {
      await sessions.prompt({
        requestId: `qqbot-owner-${action.id}`, sessionId: target.sessionId,
        mode: 'queue', content: [{ type: 'text', text: action.text }],
      }, signal());
      db.prepare('UPDATE sent_owner_prompts SET admitted=? WHERE id=?').run(Date.now(), action.id);
    }
    return { status: 'sent', target };
  }

  async function advance(owners) {
    // Each observer only exports notices, never session events or message contents.
    const watchedByOwner = db.prepare('SELECT * FROM watched_turns WHERE owner=? AND finished IS NULL LIMIT ?');
    const watches = owners.flatMap(owner => watchedByOwner.all(owner, watchLimit));
    await Promise.all(watches.map(async watch => {
      try {
        const event = Date.now() - watch.created > watchLifetimeMs ? { kind: 'expired' } : await readWatch(sessions, agents, watch, signal());
        if (!event) return;
        if (!event.kind) {
          db.prepare('UPDATE watched_turns SET before_seq=?, high_seq=? WHERE id=?').run(event.beforeSeq, event.high, watch.id);
          return;
        }
        transaction(() => {
          db.prepare('INSERT OR IGNORE INTO watch_notifications(id,watch_id,kind) VALUES(?,?,?)')
            .run(`${watch.id}-${event.kind}`, watch.id, event.kind);
          if (event.kind !== 'approval') db.prepare('UPDATE watched_turns SET finished=? WHERE id=?').run(Date.now(), watch.id);
        });
      } catch (error) {
        if (error?.code === 'session/not-found') {
          transaction(() => {
            db.prepare('INSERT OR IGNORE INTO watch_notifications(id,watch_id,kind) VALUES(?,?,?)')
              .run(`${watch.id}-unavailable`, watch.id, 'unavailable');
            db.prepare('UPDATE watched_turns SET finished=? WHERE id=?').run(Date.now(), watch.id);
          });
        } else if (!lifetime.aborted && error?.name !== 'TimeoutError' && error?.name !== 'AbortError') {
          logger?.debug?.('Could not sample a watched DSH session');
        }
      }
    }));
  }

  function close() {
    const pending = [scanning, ...[...requests.values()].map(entry => entry.promise)].filter(Boolean);
    return Promise.allSettled(pending).then(() => db.close());
  }

  function track(key, fn) {
    const now = Date.now();
    for (const [id, entry] of requests) if (entry.expires < now) requests.delete(id);
    const current = requests.get(key);
    if (current) return current.promise;
    if (requests.size >= 128) return Promise.resolve({ status: 'busy' });
    const entry = { expires: Infinity, promise: null };
    entry.promise = Promise.resolve().then(fn).finally(() => { entry.expires = Date.now() + lifetimeMs; });
    entry.promise.catch(() => requests.delete(key));
    requests.set(key, entry);
    return entry.promise;
  }

  async function start(action, identity) {
    const owner = identity.principal;
    const privatePath = identity.owner ? undefined : ownWorkspace(owner);
    if (action.operation === 'list') return listActive(workspaces, sessions, action, signal(), privatePath, lifetime);
    const done = db.prepare('SELECT * FROM sent_owner_prompts WHERE id=? AND owner=?').get(action.id, owner);
    if (done?.admitted) return { status: 'sent', target: { title: done.title, workspace: done.workspace } };
    const found = await candidates(workspaces, sessions, agents, action, signal(), privatePath);
    if (found.status !== 'candidates') return found;
    if (!found.targets.length) return { status: action.operation === 'watch' ? 'no-running' : 'no-session' };
    if (found.targets.length === 1 && !found.more) return act(action, found.targets[0], identity);
    for (const [id, choice] of selections) if (choice.expires < Date.now()) selections.delete(id);
    if (selections.size >= 24) return { status: 'busy' };
    const code = randomUUID().slice(0, 8);
    selections.set(code, { owner, action, targets: found.targets, expires: Date.now() + lifetimeMs });
    return {
      status: 'choose', code, more: found.more,
      choices: found.targets.map(({ title, running }) => ({ title, running })),
    };
  }

  async function route(req, path) {
    const actor = wireIdentity(req.headers);
    const access = await loadAccess();
    const direct = access.identify(actor);
    // 群的 list 查询只读，允许已绑定的群主人；watch/send 仍保持私聊专用。
    const identity = direct && (actor.scope === 'c2c' || direct.owner) ? direct : undefined;
    if (!identity) return { code: 403, body: { status: 'forbidden' } };
    const owner = identity.principal;
    if (path === '/owner/notifications' && req.method === 'GET') {
      if (!identity.owner) return { code: 403, body: { status: 'forbidden' } };
      const recipients = access.recipients();
      if (!scanning) scanning = advance(recipients.map(item => item.principal)).finally(() => { scanning = undefined; });
      await scanning;
      const pending = db.prepare(`
        SELECT n.id, n.kind, w.workspace, w.title
        FROM watch_notifications n INNER JOIN watched_turns w ON w.id=n.watch_id
        WHERE w.owner=? AND n.delivered IS NULL ORDER BY n.rowid LIMIT 12
      `);
      const notices = recipients.flatMap(item => pending.all(item.principal).map(notice =>
        item.owner ? notice : { ...notice, recipient: item.dmOpenid })).slice(0, 48);
      return { code: 200, body: { notices } };
    }
    if (path === '/owner/ack' && req.method === 'POST') {
      if (!identity.owner) return { code: 403, body: { status: 'forbidden' } };
      const body = await readJson(req).catch(() => ({}));
      if (!/^[a-f0-9]{24}-(approval|done|cancelled|failed|unavailable|expired)$/.test(body.id ?? '')) return { code: 400, body: { status: 'invalid' } };
      db.prepare('UPDATE watch_notifications SET delivered=? WHERE id=?').run(Date.now(), body.id);
      return { code: 200, body: { status: 'acknowledged' } };
    }
    if (path === '/owner/actions' && req.method === 'POST') {
      const action = parseAction(await readJson(req).catch(() => null));
      if (!action) return { code: 400, body: { status: 'invalid' } };
      if (actor.scope === 'group' && action.operation !== 'list') return { code: 403, body: { status: 'forbidden' } };
      return { code: 200, body: await track(`${owner}:${action.id}`, () => start(action, identity)) };
    }
    if (path === '/owner/choose' && req.method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      if (!idPattern.test(body.id ?? '') || !Number.isInteger(body.number)) return { code: 400, body: { status: 'invalid' } };
      const open = [...selections].filter(([, choice]) => choice.owner === owner && choice.expires > Date.now());
      if (!body.selection && open.length > 1) return { code: 200, body: { status: 'choose-code', codes: open.map(([code]) => code) } };
      const code = body.selection ?? open[0]?.[0];
      return { code: 200, body: await track(`${owner}:${body.id}`, async () => {
        const choice = selections.get(code);
        if (!choice || choice.owner !== owner || choice.expires <= Date.now()) return { status: 'no-choice' };
        const target = choice.targets[body.number - 1];
        if (!target) return { status: 'invalid-choice' };
        selections.delete(code);
        return act(choice.action, target, identity);
      }) };
    }
    return { code: 404, body: { status: 'not-found' } };
  }

  return { route, close };
}

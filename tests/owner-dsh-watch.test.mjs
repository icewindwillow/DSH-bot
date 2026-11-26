import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { createAccess, identityHeaders } from '../plugins/owner-dsh/access.mjs';
import { createOwnerSessions } from '../plugins/owner-dsh/owner-sessions.mjs';
import { parseOwnerAction, startOwnerWatchNotifier } from '../plugins/owner-dsh/qq-owner-actions.mjs';
import { createPersonalAccess } from '../plugins/owner-dsh/personal-access.mjs';

const owner = { scope: 'c2c', sender: 'owner' };
const id = character => character.repeat(24);
const event = (type, seq, data) => ({ type: 'event', event: { type, seq, data } });

function call(controller, path, body, actor = owner) {
  return controller.route(Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
    method: body ? 'POST' : 'GET', headers: identityHeaders(actor),
  }), path);
}

test('panel grants pair group and private users and scope existing session actions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qqbot-dsh-personal-'));
  const abort = new AbortController();
  const member = { scope: 'c2c', sender: 'member-dm' };
  const groupActor = { scope: 'group', sender: 'member-group', group: 'group-1' };
  const grantKey = 'group-1:openid:member-group:owner-dsh';
  const state = { [grantKey]: { enabled: true, by: 'tool' } };
  const personal = createPersonalAccess({
    bridgeDir: root, loadConfig: () => ({ owner: owner.sender }),
    readDocuments: () => ({
      skills: { skills: [{ id: 'owner-dsh', scope: 'personal', kind: 'access' }] },
      people: { people: [{ name: '成员', openids: ['member-group'], groups: ['group-1'] }] },
      state,
    }),
  });
  const access = () => createAccess(personal.load());
  assert.equal(access().identify(groupActor), undefined);
  state[grantKey].by = 'panel';
  assert.equal(access().identify(groupActor).dmOpenid, undefined);
  const { code } = personal.link(member);
  assert.match(code, /^[A-F0-9]{10}$/);
  assert.equal(personal.link({ ...groupActor, group: 'group-2' }, code).status, 'link-denied');
  assert.equal(personal.link(groupActor, code).status, 'linked');
  assert.equal(personal.link(groupActor, code).status, 'link-denied');
  assert.equal(access().identify(member).principal, groupActor.sender);
  const mislabeled = { sessionId: 'other', cwd: root + '/other', projections: { values: { agentPreset: 'qqbot-member' } } };
  const elevated = { sessionId: 'elevated', cwd: root, projections: { values: { agentPreset: 'default' } } };
  const own = { sessionId: 'own', cwd: root, running: true, projections: { values: { agentPreset: 'qqbot-member' } } };
  const prompts = [];
  const controller = createOwnerSessions({
    ownWorkspace: () => root, dbPath: join(root, 'watches.sqlite'), lifetime: abort.signal, loadAccess: access,
    workspaces: { async *follow() { yield { type: 'baseline', value: { archivedSessionIds: [], items: [
      { workspaceId: 'a', path: root, title: '成员', sessionIds: ['own', 'other', 'elevated'] },
      { workspaceId: 'b', path: root + '/other', title: 'SIMDM', sessionIds: ['other'] },
    ] } }; } },
    sessions: {
      list: async () => ({ items: [mislabeled, elevated, own] }),
      prompt: async value => prompts.push(value.sessionId),
      state: async () => ({ pendingInput: ['approval'] }),
    },
    agents: { get: () => ({ session: {} }), turnBoundaryOf: () => ({ openTurnStartSeq: 12, lastTurn: 2 }) },
  });
  t.after(async () => {
    abort.abort();
    await controller.close();
    personal.close();
    await rm(root, { recursive: true, force: true });
  });
  const send = (actor, workspace, key) => call(controller, '/owner/actions',
    { id: id(key), operation: 'send', workspace, text: '继续' }, actor);
  assert.equal((await send(member, 'SIMDM', 'a')).body.status, 'workspace-missing');
  assert.equal((await send(member, '我的工作区', 'b')).body.status, 'sent');
  assert.equal((await send(owner, 'SIMDM', 'c')).body.status, 'sent');
  assert.deepEqual(prompts, ['own', 'other']);
  assert.equal((await call(controller, '/owner/actions',
    { id: id('d'), operation: 'watch', workspace: '我的工作区' }, member)).body.status, 'watching');
  assert.equal((await call(controller, '/owner/notifications', undefined, member)).code, 403);
  assert.equal((await call(controller, '/owner/notifications')).body.notices[0].recipient, member.sender);
  state[grantKey].enabled = false;
  assert.equal((await send(member, '我的工作区', 'e')).code, 403);
  assert.deepEqual((await call(controller, '/owner/notifications')).body.notices, []);
});

test('watches one selected turn through approval and completion; sends to a named existing session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qqbot-owner-watch-'));
  const abort = new AbortController();
  const live = { alpha: { lastTurn: 7, openTurnStartSeq: 50 }, beta: { lastTurn: 21, openTurnStartSeq: 210 } };
  const calls = [];
  let pending = [];
  let records = [];
  const workspace = { workspaceId: 'simdm', title: 'SIMDM', sessionIds: ['alpha', 'beta'] };
  const services = {
    dbPath: join(root, 'watch.sqlite'), lifetime: abort.signal,
    loadAccess: async () => createAccess({ owner: owner.sender }),
    workspaces: { async *follow() { yield { type: 'baseline', value: { items: [workspace], archivedSessionIds: [] } }; } },
    agents: { get: id => ({ session: { id } }), turnBoundaryOf: session => live[session.id] },
    sessions: {
      async list() {
        return { items: ['alpha', 'beta'].map((sessionId, i) => ({
          sessionId, updatedAt: 2 - i, running: true, blank: false,
          projections: { values: { title: i ? '回归检查' : '关卡调试' } },
        })) };
      },
      async state() { return { pendingInput: pending, running: true }; },
      async events() { return { records, cursor: 90, hasMore: false }; },
      async prompt(input) { calls.push(input); return { accepted: true }; },
    },
  };
  let controller = createOwnerSessions(services);
  const start = body => call(controller, '/owner/actions', body);
  const choice = (selection, number) => call(controller, '/owner/choose', { id: id('b'), selection, number });
  const notices = async () => (await call(controller, '/owner/notifications')).body.notices;
  try {
    const blocked = await call(controller, '/owner/actions', { id: id('a'), operation: 'watch', workspace: 'SIMDM' },
      { scope: 'group', sender: owner.sender, group: 'qq-group' });
    assert.equal(blocked.code, 403);
    records = [event('assistant/message', 80, { message: { content: [{ type: 'text', text: '正在跑第 4 次跨房间战斗' }] } })];
    const listed = await start({ id: id('e'), operation: 'list', workspace: 'SIMDM' });
    assert.equal(listed.body.status, 'list');
    assert.equal(listed.body.runningOnly, true);
    assert.deepEqual(listed.body.targets.map(item => item.title), ['关卡调试', '回归检查']);
    assert.match(listed.body.targets[0].excerpt, /第 4 次跨房间战斗/);
    const groupListed = await call(controller, '/owner/actions',
      { id: id('f'), operation: 'list', workspace: 'SIMDM' },
      { scope: 'group', sender: owner.sender, group: 'qq-group' });
    assert.equal(groupListed.body.status, 'list');
    records = [];
    const requested = await start({ id: id('a'), operation: 'watch', workspace: 'simdm' });
    assert.equal(requested.body.status, 'choose');
    assert.deepEqual(requested.body.choices.map(x => x.title), ['关卡调试', '回归检查']);
    assert.equal((await choice(requested.body.code, 1)).body.status, 'watching');
    assert.deepEqual(await notices(), []);
    pending = ['approval'];
    const [approval] = await notices();
    assert.deepEqual({ ...approval }, { id: `${id('a')}-approval`, kind: 'approval', workspace: 'SIMDM', title: '关卡调试' });
    await call(controller, '/owner/ack', { id: approval.id });
    assert.deepEqual(await notices(), []);
    await controller.close();
    controller = createOwnerSessions(services);
    assert.deepEqual(await notices(), []);
    pending = [];
    live.alpha = { lastTurn: 8, openTurnStartSeq: 74 };
    records = [
      event('assistant/message', 65, { message: { content: ['private body'] } }),
      event('turn/end', 73, { turn: 7, reason: { kind: 'completed' } }),
      event('turn/end', 90, { turn: 8, reason: { kind: 'error' } }),
    ];
    const [completed] = await notices();
    assert.equal(completed.kind, 'done');
    assert.doesNotMatch(JSON.stringify(completed), /private body/);
    await call(controller, '/owner/ack', { id: completed.id });
    assert.deepEqual(await notices(), []);

    const outgoing = { id: id('c'), operation: 'send', workspace: 'SIMDM', session: '回归检查', text: '先检查日志' };
    assert.equal((await start(outgoing)).body.status, 'sent');
    assert.equal((await start(outgoing)).body.status, 'sent');
    assert.deepEqual(calls, [{
      sessionId: 'beta', mode: 'queue', content: [{ type: 'text', text: '先检查日志' }], requestId: `qqbot-owner-${id('c')}`,
    }]);
    assert.equal((await start({ id: id('d'), operation: 'watch', workspace: 'SIMDM', session: '回归检查' })).body.status, 'watching');
    live.beta = { lastTurn: 21, openTurnStartSeq: null };
    records = [event('turn/end', 230, { turn: 21, reason: { kind: 'error', error: 'secret' } })];
    const [failed] = await notices();
    assert.equal(failed.kind, 'failed');
    assert.doesNotMatch(JSON.stringify(failed), /secret/);
  } finally {
    abort.abort();
    await controller.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('owner natural commands and private-only notification text', async () => {
  assert.deepEqual(parseOwnerAction('小易，盯一下 SIMDM 里正在跑的任务，结束了叫我'), { operation: 'watch', workspace: 'SIMDM' });
  assert.deepEqual(parseOwnerAction('小易，给 SIMDM 工作区的「回归检查」发消息：先看日志'),
    { operation: 'send', workspace: 'SIMDM', session: '回归检查', text: '先看日志' });
  assert.deepEqual(parseOwnerAction('你看一下当前在推进的任务对话'), { operation: 'list', workspace: '' });
  assert.deepEqual(parseOwnerAction('小易，帮我看一下 DSH 的 SIMDM 的工作区，还在继续推进工作吗'),
    { operation: 'list', workspace: 'SIMDM' });
  assert.deepEqual(parseOwnerAction('小易，帮我在 DSH 里看一下，SIMDM 的工作区还在推进吗'),
    { operation: 'list', workspace: 'SIMDM' });
  assert.equal(parseOwnerAction('这个任务什么时候完成'), undefined);
  const delivered = [];
  let acknowledged = false;
  const stop = startOwnerWatchNotifier({
    bot: { async sendText(target, text) { delivered.push({ target, text }); } },
    intervalMs: 10, loadAccess: () => ({ owner: owner.sender }),
    async bridge(method, path, actor) {
      assert.deepEqual(actor, owner);
      if (path === '/owner/ack') { acknowledged = true; return { code: 200, body: {} }; }
      return { code: 200, body: { notices: acknowledged ? [] : [{ id: 'a', kind: 'approval', workspace: 'SIMDM', title: '关卡调试', text: 'secret' }] } };
    },
  });
  try {
    for (let i = 0; !acknowledged && i < 50; i++) await delay(10);
    assert.equal(acknowledged, true);
    assert.deepEqual(delivered, [{ target: { scope: 'c2c', targetId: 'owner' }, text: 'DSH「SIMDM」·「关卡调试」正在等你审批，请打开 DSH 桌面处理。' }]);
  } finally { stop(); }
});

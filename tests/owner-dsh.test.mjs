import assert from 'node:assert/strict';
import { EventEmitter, on } from 'node:events';
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { apply } from '../plugins/owner-dsh/index.js';
import { createOwnerDshMiddleware } from '../plugins/owner-dsh/qq.js';
import { workspaceFiles } from '../plugins/owner-dsh/member-files.mjs';
import { createAccess } from '../plugins/owner-dsh/access.mjs';

test('owner DM is tied to one desktop turn and returns once to that DM', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'owner-dsh-'));
  const socket = join(root, 'test.sock');
  const context = new EventEmitter();
  const log = new EventEmitter();
  const owner = 'owner-openid';
  const sessionId = 'session-test';
  let requests = 0;
  const sessions = {
    async create(input) {
      assert.equal(input.workspaceId, 'workspace-test');
      return { sessionId, agentPreset: input.agentPreset };
    },
    async rename(input) { assert.match(input.title, /^小易委派 [a-f0-9]{8}$/); },
    async *observeEvent({ address }, signal) {
      assert.equal(address.sessionId, sessionId);
      const stream = on(log, 'event', { signal });
      try {
        yield { type: 'ready' };
        for await (const [type, data] of stream) yield { type: 'event', event: { type, data } };
      } finally { await stream.return(); }
    },
    async prompt(input) {
      requests++;
      assert.equal(input.sessionId, sessionId);
      const turn = requests;
      log.emit('event', 'turn/start', { turn });
      if (turn === 2) log.emit('event', 'user/message', { source: { kind: 'user', rpcId: 'desk' } });
      log.emit('event', 'user/message', { source: { kind: 'user', rpcId: input.requestId } });
      log.emit('event', 'assistant/message', {
        turn, message: { content: [{ type: 'thinking', text: 'private' }, { type: 'text', text: '测试完成' }] },
      });
      log.emit('event', 'turn/end', { turn, reason: { kind: 'completed' } });
    },
  };
  context.get = name => ({
    sessionController: sessions,
    workspaceController: {
      create: async () => ({ workspace: { workspaceId: 'workspace-test' } }),
    },
    tools: { guard: () => () => {}, register: () => () => {} },
  })[name];
  context.effect = fn => fn();
  context.provide = () => {};
  try {
    const access = { owner, members: [{ name: '群友', principal: 'member', groups: { 'test-group': 'member', 'other-group': 'member' } }] };
    await apply(context, { socket, workspace: root, access });
    const outgoing = [];
    const middleware = createOwnerDshMiddleware({
      async sendText(target, content) { outgoing.push({ target, content }); },
    }, { socket, loadAccess: () => access, pollMs: 10 });
    const message = { kind: 'c2c', senderId: owner, messageId: 'm1', content: '小易，让我的 DSH 跑测试' };
    const target = { scope: 'c2c', targetId: owner, msgId: 'm1' };
    const next = async () => {};
    await middleware({ message: { ...message, kind: 'group' }, replyTarget: target }, next);
    await middleware({ message: { ...message, senderId: 'stranger' }, replyTarget: target }, next);
    await middleware({ message, replyTarget: { ...target, targetId: 'stranger' } }, next);
    assert.equal(outgoing.length, 0);
    await Promise.all([middleware({ message, replyTarget: target }, next), middleware({ message, replyTarget: target }, next)]);
    for (let attempts = 0; attempts < 100 && outgoing.length < 2; attempts++) await delay(10);
    assert.equal(requests, 1);
    assert.equal(outgoing.length, 2);
    assert.ok(outgoing.every(item => item.target.targetId === owner && item.target.msgId === 'm1'));
    assert.match(outgoing[1].content, /已完成\n\n测试完成$/);
    const newTarget = { ...target, msgId: 'm2' };
    await middleware({ message: { ...message, messageId: 'm2' }, replyTarget: newTarget }, next);
    for (let attempts = 0; attempts < 100 && outgoing.length < 4; attempts++) await delay(10);
    assert.equal(requests, 2);
    assert.equal(outgoing.length, 4);
    assert.equal(outgoing[3].target.msgId, 'm2');
    assert.match(outgoing[3].content, /桌面输入/);
    assert.doesNotMatch(outgoing[3].content, /测试完成|private/);
    let flowedToChat = false;
    const group = { ...message, kind: 'group', groupOpenid: 'test-group', messageId: 'm3' };
    const groupTarget = { scope: 'group', targetId: group.groupOpenid, msgId: group.messageId };
    await middleware({ message: { ...group, content: '之前聊到群技能 DSH 要怎么用' }, replyTarget: groupTarget },
      async () => { flowedToChat = true; });
    assert.equal(flowedToChat, true);
    await middleware({
      message: { ...group, content: '测试。小易，群技能 DSH 只回复「群技能测试通过」' },
      replyTarget: groupTarget,
    }, next);
    for (let attempts = 0; attempts < 100 && outgoing.length < 6; attempts++) await delay(10);
    assert.equal(requests, 3);
    assert.equal(outgoing.length, 6);
    assert.deepEqual(outgoing[4].target, groupTarget);
    assert.match(outgoing[4].content, /任务号.+结果回私聊/);
    assert.deepEqual(outgoing[5].target, { scope: 'c2c', targetId: owner });
    assert.match(outgoing[5].content, /已完成\n\n测试完成$/);
    const member = { ...group, senderId: 'member', messageId: 'm4', content: '/dsh 运行测试' };
    const send = (message, content) => middleware({
      message: { ...message, content },
      replyTarget: { scope: 'group', targetId: message.groupOpenid, msgId: message.messageId },
    }, next);
    await send(member, member.content);
    for (let attempts = 0; attempts < 100 && outgoing.length < 8; attempts++) await delay(10);
    assert.equal(requests, 4);
    assert.equal(outgoing.length, 8);
    const job = outgoing[6].content.match(/[a-f0-9]{24}/)[0];
    assert.ok(outgoing.slice(6).every(item => item.target.scope === 'group'));
    assert.doesNotMatch(outgoing[7].content, /测试完成/);
    await send(member, `/dsh status ${job}`);
    assert.doesNotMatch(outgoing[8].content, /测试完成/);
    await send({ ...member, groupOpenid: 'other-group' }, `/dsh result ${job}`);
    assert.match(outgoing[9].content, /找不到/);
    await send(member, `/dsh result ${job}`);
    assert.match(outgoing[10].content, /已完成\n\n测试完成$/);
  } finally {
    context.emit('dispose');
    await rm(root, { recursive: true, force: true });
  }
});

test('group identity and workspace overrides require exact authority', () => {
  const owner = 'owner-dm';
  const actor = { scope: 'group', sender: 'group-owner', group: 'alpha-group' };
  assert.equal(createAccess({ owner }).identify(actor), undefined);
  const config = {
    owner,
    ownerGroupOpenids: { 'alpha-group': 'group-owner' },
    members: [
      { name: '甲', dmOpenid: 'alpha-dm', groups: { 'alpha-group': 'a-sender' } },
      { name: '乙', dmOpenid: 'beta-dm', groups: { 'alpha-group': 'b-sender' } },
    ],
  };
  const access = createAccess(config);
  const master = access.identify(actor);
  const alice = access.identify({ ...actor, sender: 'a-sender' });
  const bob = access.identify({ ...actor, sender: 'b-sender' });
  assert.equal(access.identify({ ...actor, group: 'other-group' }), undefined);
  assert.equal(access.identify({ scope: 'c2c', sender: 'a-sender' }), undefined);
  assert.equal(access.identify({ scope: 'c2c', sender: 'alpha-dm' }), alice);
  assert.equal(access.workspace(master), master);
  assert.equal(access.workspace(master, '甲'), alice);
  assert.equal(access.workspace(alice), alice);
  assert.equal(access.workspace(bob), bob);
  assert.equal(access.workspace(alice, '乙'), undefined);
  assert.equal(access.workspace(bob, 'owner'), undefined);
  assert.throws(() => createAccess({ ...config, members: [...config.members, config.members[0]] }));
});

test('member file operations reject traversal, symlinks and shared inodes', { skip: process.platform === 'win32' }, async () => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'owner-dsh-files-')));
  const root = join(scratch, 'first');
  const other = join(scratch, 'second');
  const signal = new AbortController().signal;
  try {
    await mkdir(root);
    await mkdir(other);
    const foreign = join(other, 'secret.txt');
    await writeFile(foreign, 'foreign');
    await symlink(other, join(root, 'other-link'));
    await symlink(foreign, join(root, 'file-link'));
    await link(foreign, join(root, 'shared.txt'));
    await assert.rejects(workspaceFiles(root, { action: 'read', path: '../second/secret.txt' }, signal));
    await assert.rejects(workspaceFiles(root, { action: 'read', path: 'other-link/secret.txt' }, signal));
    await assert.rejects(workspaceFiles(root, { action: 'read', path: 'file-link' }, signal));
    await assert.rejects(workspaceFiles(root, { action: 'read', path: 'shared.txt' }, signal));
    await assert.rejects(workspaceFiles(root, { action: 'write', path: 'shared.txt', text: 'changed' }, signal));
    await workspaceFiles(root, { action: 'mkdir', path: 'notes' }, signal);
    await workspaceFiles(root, { action: 'write', path: 'notes/own.txt', text: 'allowed' }, signal);
    assert.equal(await workspaceFiles(root, { action: 'read', path: 'notes/own.txt' }, signal), 'allowed');
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

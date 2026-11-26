import assert from 'node:assert/strict';
import { EventEmitter, on } from 'node:events';
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { apply } from '../plugins/owner-dsh/index.js';
import {
  classifyTaskIntent, createOwnerDshMiddleware, mentionsExecutionLane, parseNaturalDsh,
} from '../plugins/owner-dsh/qq.js';
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
    assert.match(outgoing[4].content, /接单|排队|开始执行/);
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

test('execution-lane keywords are sent to model intent parsing', () => {
  assert.equal(mentionsExecutionLane('小易，我的 dsh 上有任务在跑吗？'), true);
  assert.equal(mentionsExecutionLane('请让 Codex 检查最近改动'), true);
  assert.equal(mentionsExecutionLane('帮我看看这张图'), false);
});

test('natural owner commands accept "你用 DSH" and extract a workspace hint', () => {
  assert.deepEqual(
    parseNaturalDsh('小易，你用 DSH，在 simdm 工作区开一个新任务，跑十次实机测试，主要看跨房间战斗是否有问题，私聊给我报告', 'group'),
    {
      task: '在 simdm 工作区开一个新任务，跑十次实机测试，主要看跨房间战斗是否有问题，私聊给我报告',
      workspace: 'simdm',
    },
  );
  assert.deepEqual(
    parseNaturalDsh('小易，帮我用 DSH 给 SIMDM 工作区发个任务，提交并推送到 GIT', 'group'),
    { task: '提交并推送到 GIT', workspace: 'SIMDM' },
  );
  assert.deepEqual(
    parseNaturalDsh('小易，帮我把 DSH 的机器人工作区，当前的修改分批提交并推送到 git', 'group'),
    { task: '当前的修改分批提交并推送到 git', workspace: '机器人' },
  );
  assert.deepEqual(
    parseNaturalDsh('小易，让我的 DSH 跑测试', 'c2c'),
    { task: '跑测试', workspace: undefined },
  );
  assert.deepEqual(
    parseNaturalDsh('测试。小易，群技能 DSH 只回复「群技能测试通过」', 'group'),
    { task: '只回复「群技能测试通过」', workspace: undefined },
  );
  // 问能力、闲聊、查任务都不是新任务，不能抢在分类器/ownerAction 前面。
  assert.equal(parseNaturalDsh('小易，你用 DSH 是做什么的？', 'group'), undefined);
  assert.equal(parseNaturalDsh('小易，你用 DSH 能做什么', 'group'), undefined);
  assert.equal(parseNaturalDsh('之前聊到群技能 DSH 要怎么用', 'group'), undefined);
  assert.equal(parseNaturalDsh('小易，查一下我的 dsh 是否有任务', 'c2c'), undefined);
  assert.equal(parseNaturalDsh('小易，我的 dsh 上有任务在跑吗？', 'c2c'), undefined);
});

test('classifier can use the captured model selection outside a Cordis context', async () => {
  let calls = 0;
  const input = '小易，帮我把这件事交给 DSH 做一下';
  const llm = { async *stream(request) {
    calls++;
    assert.deepEqual({ provider: request.provider, model: request.model }, { provider: 'test', model: 'test' });
    yield { type: 'text-delta', text: JSON.stringify({
      isTask: true, isPpt: false, backend: 'dsh', parallel: false, task: input,
    }) };
  } };
  // 生产中间件拿到的是消息上下文，没有 .get()；selection 必须由创建中间件时捕获。
  const result = await classifyTaskIntent({ message: {}, replyTarget: {} }, llm, input,
    { provider: 'test', model: 'test' });
  assert.equal(calls, 1);
  assert.equal(result.isTask, true);
  assert.equal(result.task, input);
});

test('task-conversation query lists DSH sessions instead of falling back to chat', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'owner-dsh-list-'));
  const socket = join(root, 'b.sock');
  const owner = 'owner-openid';
  const actionBodies = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    if (req.method === 'POST' && req.url === '/owner/actions') {
      actionBodies.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        status: 'list',
        targets: [{ workspace: 'SIMDM', title: '跨房间战斗回归', running: true, excerpt: '正在跑第 4 次' }],
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  try {
    const sent = [];
    let renderedInput = '';
    const llm = { async *stream(request) {
      renderedInput = request.messages?.[0]?.content?.[0]?.text ?? '';
      yield { type: 'text-delta', text: '喵，当前在跑的是「跨房间战斗回归」，正在第 4 次。' };
    } };
    const middleware = createOwnerDshMiddleware({
      async sendText(target, content) { sent.push({ target, content }); },
    }, {
      socket, loadAccess: () => ({ owner }), pollMs: 10, llm,
      getDefaultSelection: () => ({ provider: 'test', model: 'test' }),
      config: { groupPrompt: '你是小易，说话带喵。' },
    });
    const ask = async (content, messageId) => {
      let flowedToChat = false;
      await middleware({
        message: { kind: 'group', senderId: owner, groupOpenid: 'g-list', messageId, content },
        replyTarget: { scope: 'group', targetId: 'g-list', msgId: messageId },
      }, async () => { flowedToChat = true; });
      return flowedToChat;
    };
    assert.equal(await ask('你看一下当前在推进的任务对话', 'm-list-1'), false);
    assert.equal(actionBodies[0].operation, 'list');
    assert.equal(actionBodies[0].workspace, '');
    assert.equal(sent[0].content, '喵，当前在跑的是「跨房间战斗回归」，正在第 4 次。');
    assert.match(renderedInput, /当前在推进的任务对话/);
    assert.match(renderedInput, /跨房间战斗回归/);
    assert.equal(await ask('小易，帮我看一下 DSH 的 SIMDM 的工作区，还在继续推进工作吗', 'm-list-2'), false);
    assert.equal(actionBodies[1].operation, 'list');
    assert.equal(actionBodies[1].workspace, 'SIMDM');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('natural "你用 DSH" request reaches the bridge without the classifier', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'owner-dsh-nat-'));
  const socket = join(root, 'b.sock');
  const owner = 'owner-openid';
  const requests = [];
  let job;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    if (req.method === 'PUT' && req.url?.startsWith('/jobs/')) {
      const id = req.url.slice('/jobs/'.length);
      requests.push({ id, body });
      job = { id, status: 'running' };
      res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify(job));
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/jobs/')) {
      const id = req.url.slice('/jobs/'.length);
      job = { id, status: 'done', result: '已收到跨房间战斗测试任务' };
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(job));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  try {
    const sent = [];
    let classifierCalls = 0;
    const middleware = createOwnerDshMiddleware({
      async sendText(target, content) { sent.push({ target, content }); },
    }, {
      socket,
      loadAccess: () => ({ owner }),
      pollMs: 10,
      llm: { async *stream(request) {
        const system = String(request.system ?? '');
        if (system.includes('判断这条已明确发给机器人')) { classifierCalls++; throw new Error('classifier must not run'); }
        yield { type: 'text-delta', text: system.includes('任务结果') ? '喵，任务已完成，已收到跨房间战斗测试任务。' : '喵，收到啦，已经开始执行。' };
      } },
      getDefaultSelection: () => ({ provider: 'test', model: 'test' }),
    });
    const text = '小易，你用 DSH，在 simdm 工作区开一个新任务，跑十次实机测试，主要看跨房间战斗是否有问题，私聊给我报告';
    const message = { kind: 'group', senderId: owner, groupOpenid: 'group-1', messageId: 'm-natural', content: text };
    let flowedToChat = false;
    await middleware({
      message,
      replyTarget: { scope: 'group', targetId: message.groupOpenid, msgId: message.messageId },
    }, async () => { flowedToChat = true; });
    assert.equal(flowedToChat, false);
    for (let attempts = 0; attempts < 100 && requests.length === 0; attempts++) await delay(10);
    assert.equal(classifierCalls, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.workspace, 'simdm');
    assert.equal(requests[0].body.backend, 'dsh');
    assert.match(requests[0].body.text, /跨房间战斗/);
    for (let attempts = 0; attempts < 100 && !sent.some(item => /已完成/.test(item.content)); attempts++) await delay(10);
    assert.ok(sent.some(item => item.target.scope === 'group' && /接单|排队|开始执行/.test(item.content)));
    assert.ok(sent.some(item => item.target.scope === 'c2c'
      && item.target.targetId === owner && /已完成/.test(item.content)));
    const taskText = '小易，帮我用 DSH 给 SIMDM 工作区发个任务，提交并推送到 GIT';
    await middleware({
      message: { kind: 'group', senderId: owner, groupOpenid: 'group-1', messageId: 'm-delegate', content: taskText },
      replyTarget: { scope: 'group', targetId: 'group-1', msgId: 'm-delegate' },
    }, async () => { flowedToChat = true; });
    assert.equal(flowedToChat, false);
    for (let attempts = 0; attempts < 100 && requests.length < 2; attempts++) await delay(10);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].body.workspace, 'SIMDM');
    assert.equal(requests[1].body.backend, 'dsh');
    assert.equal(requests[1].body.text, '提交并推送到 GIT');
    assert.equal(classifierCalls, 0);
    const robotText = '小易，帮我把 DSH 的机器人工作区，当前的修改分批提交并推送到 git';
    await middleware({
      message: { kind: 'group', senderId: owner, groupOpenid: 'group-1', messageId: 'm-robot', content: robotText },
      replyTarget: { scope: 'group', targetId: 'group-1', msgId: 'm-robot' },
    }, async () => { flowedToChat = true; });
    assert.equal(flowedToChat, false);
    for (let attempts = 0; attempts < 100 && requests.length < 3; attempts++) await delay(10);
    assert.equal(requests.length, 3);
    assert.equal(requests[2].body.workspace, '机器人');
    assert.equal(requests[2].body.backend, 'dsh');
    assert.equal(requests[2].body.text, '当前的修改分批提交并推送到 git');
    assert.equal(classifierCalls, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('model intent turns a natural DSH queue query into an owner watch action', async () => {
  const input = '小易，查一下我的 dsh 是否有任务';
  const llm = { async *stream() {
    yield { type: 'text-delta', text: JSON.stringify({
      isTask: false, isPpt: false, backend: 'auto', parallel: false,
      task: input, ownerAction: { operation: 'watch', workspace: '我的工作区' },
    }) };
  } };
  const ctx = { get(name) {
    return name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'test', model: 'test' }) } : undefined;
  } };
  assert.deepEqual(await classifyTaskIntent(ctx, llm, input), {
    isTask: false, isPpt: false, backend: 'auto', parallel: false, task: input,
    ownerAction: { operation: 'watch', workspace: '我的工作区' },
  });
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

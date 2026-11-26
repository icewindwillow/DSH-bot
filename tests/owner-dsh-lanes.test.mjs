import assert from 'node:assert/strict';
import { EventEmitter, on } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  appendDeliverables,
  codexArguments,
  collectDeliverables,
  combineLaneResults,
  ownerLaneWorkspace,
  taskDirectories,
} from '../plugins/owner-dsh/index.js';
import { apply } from '../plugins/owner-dsh/index.js';
import { buildTaskRequest, createOwnerDshMiddleware } from '../plugins/owner-dsh/qq.js';

test('each task gets isolated Codex and DSH directories under the selected workspace', () => {
  const lanes = taskDirectories('/tmp/owner-workspace', 'abcdef0123456789abcdef01');
  assert.equal(lanes.base, '/tmp/owner-workspace/task-abcdef01');
  assert.equal(lanes.codex, '/tmp/owner-workspace/task-abcdef01/codex');
  assert.equal(lanes.dsh, '/tmp/owner-workspace/task-abcdef01/dsh');
});

test('owner workspace selection runs DSH in the workspace root; unnamed tasks stay isolated', () => {
  const lanes = taskDirectories('/tmp/SimDM', 'abcdef0123456789abcdef01');
  assert.deepEqual(ownerLaneWorkspace({ owner: true, workspacePath: '/tmp/SimDM' }, '/tmp/SimDM', lanes), {
    root: true,
    dsh: '/tmp/SimDM',
    attachments: lanes.dsh,
  });
  assert.deepEqual(ownerLaneWorkspace({ owner: true }, '/tmp/owner-workspace', lanes), {
    root: false,
    dsh: lanes.dsh,
    attachments: lanes.dsh,
  });
  assert.deepEqual(ownerLaneWorkspace({ owner: false }, '/tmp/member-workspace', lanes), {
    root: false,
    dsh: '/tmp/member-workspace',
    attachments: '/tmp/member-workspace',
  });
});

test('Codex runs writable, outside git, with only the requested model hint', () => {
  const args = codexArguments('/tmp/task/codex', '做一个 PPTX', 'gpt-5.6-sol');
  assert.deepEqual(args.slice(0, 6), [
    '-C', '/tmp/task/codex', 'exec', '--sandbox', 'workspace-write', '--skip-git-repo-check',
  ]);
  assert.deepEqual(args.slice(6, 8), ['--model', 'gpt-5.6-sol']);
  assert.equal(args.at(-1), '做一个 PPTX');
  assert.equal(codexArguments('/tmp/task/codex', '做一个 PPTX').includes('--model'), false);
  const withLast = codexArguments('/tmp/task/codex', '做一个 PPTX', undefined, '/tmp/task/codex/last.txt');
  assert.deepEqual(withLast.slice(6, 8), ['--output-last-message', '/tmp/task/codex/last.txt']);
});

test('model hints are sent to the lane that owns them', () => {
  assert.deepEqual(buildTaskRequest('做 PPT', undefined, { backend: 'codex', model: 'gpt-5.6-sol' }), {
    text: '做 PPT', workspace: undefined, backend: 'codex', model: 'gpt-5.6-sol',
  });
  assert.deepEqual(buildTaskRequest('做 PPT', '/tmp/ws', {
    backend: 'dsh', provider: 'opencode-go', model: 'glm-5.3',
  }), {
    text: '做 PPT', workspace: '/tmp/ws', backend: 'dsh',
    dshModel: { provider: 'opencode-go', model: 'glm-5.3' },
  });
  assert.deepEqual(buildTaskRequest('做 PPT', undefined, { backend: 'both', model: 'gpt-5.6-sol' }), {
    text: '做 PPT', workspace: undefined, backend: 'both', model: 'gpt-5.6-sol',
  });
  assert.deepEqual(buildTaskRequest('做 PPT', undefined, {
    backend: 'both', provider: 'opencode-go', model: 'deepseek-v4.1-flash',
  }), {
    text: '做 PPT', workspace: undefined, backend: 'both',
    dshModel: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
  });
  assert.deepEqual(buildTaskRequest('做 PPT', undefined, { backend: 'dsh' }), {
    text: '做 PPT', workspace: undefined, backend: 'dsh',
  });
});

test('dual-lane results keep Codex and DSH failures separate', () => {
  const text = combineLaneResults(
    { status: 'done', result: 'Codex 成品' },
    { status: 'failed', error: 'DSH 失败' },
  );
  assert.match(text, /【Codex】\nCodex 成品/);
  assert.match(text, /【DSH】\n失败：DSH 失败/);
  assert.equal(
    appendDeliverables('已完成', ['/tmp/a.pptx']),
    '已完成\n\n文件已附加：\n- a.pptx',
  );
});

test('deliverable scan only returns report artifacts from the lane directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owner-dsh-lanes-'));
  try {
    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(join(root, 'deck.pptx'), 'pptx');
    await writeFile(join(root, 'nested', 'notes.md'), 'md');
    await writeFile(join(root, 'page.html'), 'html');
    await writeFile(join(root, 'ignore.txt'), 'txt');
    await writeFile(join(root, '.hidden.pptx'), 'hidden');
    const files = await collectDeliverables([root]);
    assert.deepEqual(files.sort(), [
      join(root, 'deck.pptx'),
      join(root, 'nested', 'notes.md'),
      join(root, 'page.html'),
    ].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('owner workspace selection runs the DSH lane in the repository root', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'owner-dsh-root-'));
  const simdm = join(root, 'SimDM');
  await mkdir(simdm);
  const socket = join(root, 'test.sock');
  const owner = 'owner-root';
  const context = new EventEmitter();
  const log = new EventEmitter();
  let createdPath = '';
  let createdPreset = '';
  let dshText = '';
  let requests = 0;
  const sessions = {
    async create(input) {
      createdPreset = input.agentPreset;
      return { sessionId: 'session-root', agentPreset: input.agentPreset };
    },
    async rename() {},
    async *observeEvent(_address, signal) {
      const stream = on(log, 'event', { signal });
      try {
        yield { type: 'ready' };
        for await (const [type, data] of stream) yield { type: 'event', event: { type, data } };
      } finally { await stream.return?.(); }
    },
    async prompt(input) {
      dshText = input.content?.[0]?.text ?? '';
      requests++;
      const turn = requests;
      log.emit('event', 'turn/start', { turn });
      log.emit('event', 'user/message', { source: { kind: 'user', rpcId: input.requestId } });
      log.emit('event', 'assistant/message', {
        turn, message: { content: [{ type: 'text', text: '实机测试完成：10/10' }] },
      });
      log.emit('event', 'turn/end', { turn, reason: { kind: 'completed' } });
    },
  };
  const workspaces = {
    async create({ path }) {
      createdPath = path;
      return { workspace: { workspaceId: 'workspace-simdm' }, created: false };
    },
    async rename() {},
    follow() {
      return (async function* () {
        yield { type: 'baseline', value: { items: [{ workspaceId: 'workspace-simdm', title: 'SimDM', path: simdm }] } };
      })();
    },
  };
  context.get = name => ({
    sessionController: sessions,
    workspaceController: workspaces,
    tools: { guard: () => () => {}, register: () => () => {} },
  })[name];
  context.effect = fn => fn();
  context.provide = () => {};
  try {
    await apply(context, { socket, workspace: root, access: { owner }, agentPreset: 'owner-preset' });
    const sent = [];
    const middleware = createOwnerDshMiddleware({
      async sendText(target, content) { sent.push({ target, content }); },
    }, { socket, loadAccess: () => ({ owner }), pollMs: 10 });
    const message = {
      kind: 'group', senderId: owner, groupOpenid: 'group-root', messageId: 'm-root',
      content: '/dsh --workspace SimDM 跑十次实机测试，检查跨房间战斗',
    };
    await middleware({
      message,
      replyTarget: { scope: 'group', targetId: message.groupOpenid, msgId: message.messageId },
    }, async () => {});
    for (let attempts = 0; attempts < 200 && !sent.some(item => /已完成/.test(item.content)); attempts++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(createdPath, simdm);
    assert.equal(createdPreset, 'owner-preset');
    assert.match(dshText, /当前工作区是「SimDM」的根目录/);
    assert.ok(!dshText.includes('所有成品写入当前工作区。'));
    const result = sent.find(item => /已完成/.test(item.content));
    assert.ok(result, 'root-mode result is sent');
    assert.match(result.content, /实机测试完成：10\/10/);
  } finally {
    context.emit('dispose');
    await rm(root, { recursive: true, force: true });
  }
});

test('dual-lane job runs Codex and DSH together, keeps their files separate, and returns both', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'owner-dsh-both-'));
  const socket = join(root, 'test.sock');
  const owner = 'owner-both';
  const context = new EventEmitter();
  const log = new EventEmitter();
  let workspacePath = root;
  let codexText = '';
  let dshText = '';
  let requests = 0;
  const sessions = {
    async create() { return { sessionId: 'session-both', agentPreset: undefined }; },
    async rename() {},
    async *observeEvent(_address, signal) {
      const stream = on(log, 'event', { signal });
      try {
        yield { type: 'ready' };
        for await (const [type, data] of stream) yield { type: 'event', event: { type, data } };
      } finally { await stream.return?.(); }
    },
    async prompt(input) {
      dshText = input.content?.[0]?.text ?? '';
      const rel = /task-[a-f0-9]{8}\/dsh/.exec(dshText)?.[0];
      await writeFile(rel ? join(workspacePath, rel, 'dsh-result.md') : join(workspacePath, 'dsh-result.md'), 'DSH 成品');
      requests++;
      const turn = requests;
      log.emit('event', 'turn/start', { turn });
      log.emit('event', 'user/message', { source: { kind: 'user', rpcId: input.requestId } });
      log.emit('event', 'assistant/message', {
        turn, message: { content: [{ type: 'text', text: 'DSH 成品' }] },
      });
      log.emit('event', 'turn/end', { turn, reason: { kind: 'completed' } });
    },
  };
  const workspaces = {
    async create({ path }) { workspacePath = path; return { workspace: { workspaceId: 'workspace-both' }, created: false }; },
    async rename() {},
  };
  context.get = name => ({
    sessionController: sessions,
    workspaceController: workspaces,
    tools: { guard: () => () => {}, register: () => () => {} },
  })[name];
  context.effect = fn => fn();
  context.provide = () => {};
  try {
    await apply(context, {
      socket,
      workspace: root,
      access: { owner },
      codexRunner: async ({ directory, text }) => {
        codexText = text;
        await writeFile(join(directory, 'codex-result.md'), 'Codex 成品');
        return 'Codex 成品';
      },
    });
    const sent = [];
    const files = [];
    const middleware = createOwnerDshMiddleware({
      async sendText(target, content) { sent.push({ target, content }); },
      async sendFile(target, source) { files.push({ target, source }); },
    }, { socket, loadAccess: () => ({ owner }), pollMs: 10 });
    const message = {
      kind: 'c2c', senderId: owner, messageId: 'm-both',
      content: '/dsh 让 Codex 和 DSH 同时做一份测试报告',
    };
    await middleware({
      message,
      replyTarget: { scope: 'c2c', targetId: owner, msgId: message.messageId },
    }, async () => {});
    for (let attempts = 0; attempts < 200 && !sent.some(item => item.content.includes('【Codex】')); attempts++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const result = sent.find(item => item.content.includes('【Codex】'));
    assert.ok(result, 'both-lane result is sent');
    assert.match(result.content, /【Codex】\nCodex 成品/);
    assert.match(result.content, /【DSH】\nDSH 成品/);
    assert.match(codexText, /Codex 独立车道/);
    assert.match(dshText, /DSH 独立车道/);
    assert.equal(files.length, 2);
    assert.ok(files.some(item => item.source.localPath.endsWith('codex-result.md')));
    assert.ok(files.some(item => item.source.localPath.endsWith('dsh-result.md')));
  } finally {
    context.emit('dispose');
    await rm(root, { recursive: true, force: true });
  }
});

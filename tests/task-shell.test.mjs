import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTaskBackend } from '../plugins/owner-dsh/task-shell.mjs';

test('local task shell routes Codex intents and keeps explicit DSH requests visible', () => {
  assert.deepEqual(selectTaskBackend('让 Codex 审查 SimDM 最近改动'), { backend: 'codex' });
  assert.deepEqual(selectTaskBackend('做一个课堂 PPTX'), { backend: 'codex' });
  assert.deepEqual(selectTaskBackend('在 DSH 的 SimDM 区继续工作'), { backend: 'dsh' });
  assert.deepEqual(selectTaskBackend('【DSH-PPT 统一需求】制作完整 PPTX'), { backend: 'dsh' });
});

test('explicit DSH wins over PPT and review keywords', () => {
  assert.deepEqual(selectTaskBackend('在 DSH 的 SimDM 区，做一个 PPT'), { backend: 'dsh' });
  assert.deepEqual(selectTaskBackend('用我的 DSH 工作：做一个 PPT'), { backend: 'dsh' });
  assert.deepEqual(selectTaskBackend('用 DeepSeek 做一份 PPT'), { backend: 'dsh' });
  assert.deepEqual(selectTaskBackend('让DSH做PPT'), { backend: 'dsh' });
  assert.deepEqual(selectTaskBackend('让 DSH 审查代码'), { backend: 'dsh' });
});

test('both lanes are selected only for an explicit parallel request', () => {
  assert.deepEqual(selectTaskBackend('用 Codex 和 DSH 同时做一份 PPT'), { backend: 'both' });
  assert.deepEqual(selectTaskBackend('DSH 和 Codex 各自做一份 PPT'), { backend: 'both' });
  assert.deepEqual(selectTaskBackend('Codex 和 DSH 并行制作两个版本'), { backend: 'both' });
  assert.deepEqual(selectTaskBackend('用 GPT-5.6 SOL 和 DeepSeek 4.1 Flash 同时做 PPT'), { backend: 'both' });
  assert.deepEqual(selectTaskBackend('不要同时做，先让 Codex 做'), { backend: 'codex' });
});

test('classifier intent is respected and can carry a model hint', () => {
  assert.deepEqual(selectTaskBackend('做一份 PPT', { intent: { backend: 'dsh' } }), { backend: 'dsh' });
  assert.deepEqual(selectTaskBackend('做一份 PPT', {
    intent: { backend: 'dsh', provider: 'opencode-go', model: 'glm-5.3' },
  }), { backend: 'dsh', provider: 'opencode-go', model: 'glm-5.3' });
  assert.deepEqual(selectTaskBackend('做一份 PPT', { intent: { backend: 'both' } }), { backend: 'both' });
  assert.deepEqual(selectTaskBackend('做一份 PPT', {
    intent: { backend: 'codex', model: 'gpt-5.6-sol' },
  }), { backend: 'codex', model: 'gpt-5.6-sol' });
});

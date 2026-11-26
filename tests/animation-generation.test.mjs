import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const helper = readFileSync(join(ROOT, 'qqbot-patches', 'animation-generation-helper.js'), 'utf8');
const register = readFileSync(join(ROOT, 'qqbot-patches', 'animation-generation-tool.js'), 'utf8');
const inbound = readFileSync(join(ROOT, 'qqbot-patches', 'animation-generation-inbound.js'), 'utf8');
const patcher = readFileSync(join(ROOT, 'patch-qqbot.mjs'), 'utf8');

test('animation generation exposes a multi-turn CODEX-CLI tool', () => {
  assert.match(helper, /name: 'animation_generation'/);
  assert.match(helper, /enum: \['start', 'answer', 'approve', 'cancel'\]/);
  assert.match(helper, /SOURCE_LABELS = \{.*hybrid: '允许模型组合多种制作手段'/);
  assert.match(helper, /const args = \['exec', '--ephemeral', '--skip-git-repo-check', '--approve-for-me'/);
  assert.match(helper, /bundledCodex/);
  assert.match(helper, /WORKSPACE_RETENTION_MS = 7 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(helper, /recentImages/);
  assert.match(helper, /personName/);
  assert.match(helper, /animationPersonPhotos/);
  assert.match(helper, /trustedImages/);
  assert.match(helper, /animation\.mp4/);
  assert.match(helper, /bot\.sendVideo\(target/);
  assert.match(helper, /flatMap\(file => \['-i', file\]\)/);
  assert.match(inbound, /__qqbotAnimationImagePaths/);
  assert.match(inbound, /__qqbotAnimationImagePathsAt/);
});

test('animation generation validates bounded output and records the current sender', () => {
  assert.match(helper, /MAX_SECONDS = 60/);
  assert.match(helper, /MAX_BYTES = 200 \* 1024 \* 1024/);
  assert.match(helper, /MAX_REFERENCE_IMAGES = 2/);
  assert.match(helper, /validateProductionArtifacts/);
  assert.match(helper, /storyboard-frames/);
  assert.match(helper, /MVP 固定使用 Remotion/);
  assert.match(helper, /HyperFrames|Remotion/);
  assert.match(helper, /AbortSignal\.timeout\(20 \* 60 \* 1000\)/);
  assert.match(inbound, /__qqbotAnimationSenderId/);
  assert.match(register, /setupAnimationGeneration\(ctx, bot, manager, logger\)/);
  assert.match(patcher, /name: 'animation-generation-helper'/);
  assert.match(patcher, /name: 'animation-generation-inbound'/);
});

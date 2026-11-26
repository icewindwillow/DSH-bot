import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const snippet = readFileSync(join(ROOT, 'qqbot-patches', 'animation-generation-helper.js'), 'utf8')
    .replace(/^\/\* >>>.*$/m, '')
    .replace(/^\/\* <<<.*$/m, '');

function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-anim-person-'));
    const profile = join(dir, 'profile');
    const media = join(profile, 'media');
    mkdirSync(media, { recursive: true });
    const photo = join(media, 'keeper.jpg');
    writeFileSync(photo, Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]));
    const people = {
        people: [{
            name: '守秘人',
            openids: ['S1'],
            groups: ['G1'],
            profile: { photos: [{ path: photo }], photo: { path: photo } },
        }],
    };
    const cli = join(dir, 'fake-codex.sh');
    writeFileSync(cli, `#!/bin/sh
printf '%s\\n' "$@" > argv.txt
mkdir -p storyboard-frames assets
for i in 1 2 3 4; do printf 'x' > "storyboard-frames/f$i.png"; done
printf '# storyboard\\n' > storyboard.md
printf '{"render_engine":"remotion"}\\n' > motion-plan.json
printf 'x' > assets/char.png
`);
    chmodSync(cli, 0o755);
    process.env.QQBOT_PROFILE_DIR = profile;
    process.env.QQBOT_ANIMATION_CODEX_CLI = cli;

    let tool;
    const ctx = { get: name => name === 'tools' ? { register: value => { tool = value; } } : undefined, on: () => {} };
    const record = {
        replyTarget: { scope: 'group', targetId: 'G1', senderId: 'S1' },
        __qqbotAnimationImagePaths: [],
        __qqbotAnimationImagePathsAt: 0,
    };
    const manager = { findByAgent: () => record };
    const bot = { sendImage: async () => ({ message: { id: 'm1' } }) };
    const logger = { info: () => {}, warn: () => {} };
    const setup = new Function('readProfileDocument', `${snippet}\nreturn setupAnimationGeneration;`)(() => people);
    setup(ctx, bot, manager, logger);
    return { tool, exec: { agent: {} }, photo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function runToStoryboard(tool, exec, { description, personName, reference } = {}) {
    const steps = [];
    let result = await tool.execute({ action: 'start', description, ...(personName ? { personName } : {}) }, exec);
    steps.push(result);
    for (const answer of ['混合', '3', '640x360', '24', '无声']) {
        if (result.status !== 'needs_input') break;
        result = await tool.execute({ action: 'answer', answer }, exec);
        steps.push(result);
    }
    if (result.status === 'needs_input' && result.field === 'reference' && reference) {
        result = await tool.execute({ action: 'answer', answer: reference }, exec);
        steps.push(result);
    }
    return { result, steps };
}

test('描述里点名人物时直接用档案照片，不再问参考图', async t => {
    const f = fixture();
    t.after(f.cleanup);
    const { result, steps } = await runToStoryboard(f.tool, f.exec, { description: '给守秘人做一个 3 秒的动画' });
    assert.equal(result.status, 'needs_approval');
    assert.equal(steps.some(step => step.field === 'reference'), false);
    const argv = readFileSync(join(result.workspace, 'argv.txt'), 'utf8');
    assert.match(argv, /-i\n[^\n]*input\/01-keeper\.jpg/);
});

test('参考图问题回答人物名时从档案取图', async t => {
    const f = fixture();
    t.after(f.cleanup);
    const { result } = await runToStoryboard(f.tool, f.exec, { description: '做一个 3 秒的动画', reference: '用守秘人的照片' });
    assert.equal(result.status, 'needs_approval');
    const argv = readFileSync(join(result.workspace, 'argv.txt'), 'utf8');
    assert.match(argv, /-i\n[^\n]*input\/01-keeper\.jpg/);
});

test('明确说不用图片时按档案描述直接开始', async t => {
    const f = fixture();
    t.after(f.cleanup);
    const { result } = await runToStoryboard(f.tool, f.exec, { description: '做一个 3 秒的抽象动画', reference: '不用图片' });
    assert.equal(result.status, 'needs_approval');
    const argv = readFileSync(join(result.workspace, 'argv.txt'), 'utf8');
    assert.equal(argv.split('\n').includes('-i'), false);
});

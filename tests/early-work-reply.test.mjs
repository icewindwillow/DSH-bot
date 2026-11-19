import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../qqbot-patches/early-work-reply.js', import.meta.url), 'utf8');
const groupId = 'test-group';

function fixture(sendText, enabled = true) {
    const middleware = [];
    const bot = { use: hook => middleware.push(hook), sendText };
    const globals = { __qqbotMention: { addressed: msg => msg.addressed } };
    const load = new Function('bot', 'config', 'logger', 'gateProfileDir', 'readProfileDocument',
        'concurrencyGuard', 'globalThis', 'process', source + '\nreturn declinesWholeGame;');
    const declinesWholeGame = load(bot, {}, {}, '/test', () => ({}), options => options, globals, { env: { QQBOT_COMPLEX_WORK: enabled ? 'on' : 'off' } });
    const ctx = (content, addressed = true) => ({
        message: { kind: 'group', groupOpenid: groupId, content, addressed },
        replyTarget: { scope: 'group', targetId: groupId, msgId: 'incoming' },
    });
    return { firstReply: middleware[0], queueOptions: middleware[1], declinesWholeGame, ctx };
}

const example = '先分析这个自创卡牌原型的规则，整理需求文档，再用 C# 实现核心逻辑';

test('复杂工作直到入站核准前都不会先承诺，且同一会话逐条排队', async () => {
    const calls = [];
    const { ctx, firstReply, queueOptions } = fixture((_target, text) => calls.push(text));
    const incoming = ctx(example);
    await firstReply(incoming, () => calls.push('run'));
    assert.deepEqual(calls, ['run']);
    assert.equal(queueOptions.strategy, 'queue');
});

test('整款游戏当场拒绝，普通讨论与未 @ 消息照常通过', async () => {
    const sent = [];
    const { ctx, firstReply, declinesWholeGame } = fixture(async (_target, text) => sent.push(text));
    let calls = 0;
    const next = () => { calls += 1; };
    await firstReply(ctx('给我做一整款游戏'), next);
    assert.match(sent[0], /做不了/);
    assert.equal(calls, 0);
    await firstReply(ctx(example, false), next);
    await firstReply(ctx('卡牌道具应该怎么设计？'), next);
    assert.equal(calls, 2);
    assert.equal(sent.length, 1);
    assert.equal(declinesWholeGame('分析一下这段接口'), false);
    assert.equal(declinesWholeGame('先梳理 API 权限，然后输出技术方案'), false);
});

test('整款游戏拒绝首句发送失败仍进入普通回复', async () => {
    const failed = fixture(async () => { throw new Error('network'); });
    const message = failed.ctx('给我做一整款游戏');
    let continued = false;
    await failed.firstReply(message, () => { continued = true; });
    assert.equal(continued, true);
});

test('默认关闭时保留上游队列和普通回复', async () => {
    const sent = [];
    const { ctx, firstReply, queueOptions } = fixture((_target, text) => sent.push(text), false);
    await firstReply(ctx('给我做一整款游戏'), () => sent.push('normal'));
    assert.deepEqual(sent, ['normal']);
    assert.equal(queueOptions.strategy, 'merge');
});

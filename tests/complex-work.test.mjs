import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setupComplexWork } from '../qqbot-patches/complex-work-helper.js';
import { readProfileDocument, withQqbotProfileDocuments } from '../qqbot-patches/profile-document-reader.js';

test('complex work counts starts by person, with per-persona limits and Beijing midnight reset', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-19T15:59:59Z') });
    const profile = mkdtempSync(join(tmpdir(), 'qqbot-complex-work-'));
    t.after(() => rmSync(profile, { recursive: true, force: true }));
    const hooks = new Map();
    const records = new Map();
    let tool;
    let guard;
    const tools = {
        register(definition) { tool = definition; },
        guard(check) { guard = check; return () => {}; },
    };
    setupComplexWork({
        get: () => tools,
        on: (name, hook) => hooks.set(name, hook),
    }, {
        findByAgent: agent => records.get(agent),
        findBySessionId: () => undefined,
    }, { warn: message => assert.fail(message) }, { readProfileDocument, withQqbotProfileDocuments }, profile);
    t.after(() => hooks.get('dispose')());

    withQqbotProfileDocuments(profile, db => {
        db.update('people', () => ({ people: [
            { openids: ['a', 'a-private'], social: { affinity: 60 } },
            { openids: ['low'], social: { affinity: 49.99 } },
            { openids: ['high'], social: { affinity: 60.01 } },
        ] }));
        db.update('personas', () => ({
            personas: { custom: { modules: [], complexWork: { minAffinity: 70, limitedThrough: 80, dailyLimit: 1 } } },
        }));
    });

    function receive(senderId, messageId, groupOpenid = 'group-1') {
        const kind = groupOpenid ? 'group' : 'c2c';
        const peerId = groupOpenid || senderId;
        const agent = {};
        const record = { scope: kind, peerId };
        const message = { id: 'agent-' + messageId, source: { kind: 'user' } };
        records.set(agent, record);
        globalThis.__qqbotComplexWork.bind(record, { kind, groupOpenid, senderId, messageId }, message);
        hooks.get('agent/inbox/claimed')({ agent, message });
        const signal = new AbortController().signal;
        return {
            start: async () => (await tool.execute({}, { agent, signal })).status,
            check: (name, args) => guard({ name, arguments: args, agent }),
            prompt: async () => (await hooks.get('system-prompt/assemble')({}, { agent }, async () => ({
                contexts: [{ name: 'memory', text: '角色记忆' }],
            }))).contexts.map(section => section.text).join('\n'),
            finish: () => globalThis.__qqbotComplexWork.release(record, message),
        };
    }

    const a = receive('a', 'one');
    assert.match(await a.prompt(), /可以考虑接单/);
    assert.match(await a.prompt(), /确实记得当前这个人曾对你恶言相向/);
    assert.match(a.check('write'), /尚未登记/);
    assert.match(a.check('subagent'), /尚未登记/);
    assert.equal(a.check('web_search'), undefined);
    assert.equal(a.check('str_replace_editor', { command: 'view' }), undefined);
    assert.equal(await a.start(), 'started');
    assert.equal(await a.start(), 'started');
    assert.equal(a.check('write'), undefined);
    a.finish();
    assert.match(a.check('write'), /尚未登记/);
    assert.equal(await receive('a', 'one').start(), 'started', 'redelivered event is not charged twice');
    assert.equal(await receive('a-private', 'two', '').start(), 'started');
    assert.equal(await receive('a', 'three', 'group-2').start(), 'started');

    const exhausted = receive('a-private', 'four', '');
    assert.match(await exhausted.prompt(), /次数今天已用完/);
    assert.equal(await exhausted.start(), 'exhausted');
    assert.match(exhausted.check('bash'), /次数今天已用完/);
    assert.equal(await receive('low', 'low').start(), 'low_affinity');
    assert.equal(await receive('high', 'custom', 'custom').start(), 'low_affinity');
    for (let index = 0; index < 4; index++) assert.equal(await receive('high', 'high-' + index).start(), 'started');
    assert.equal(await receive('unknown', 'new').start(), 'started', 'unknown sender uses the existing starting affinity of 50');
    assert.equal(readProfileDocument(profile, 'complex-work-usage').date, '2026-11-19');
    t.mock.timers.tick(1000);
    assert.equal(await receive('a', 'next-day').start(), 'started');
    assert.equal(readProfileDocument(profile, 'complex-work-usage').date, '2026-11-20');
});

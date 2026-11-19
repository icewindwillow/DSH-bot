import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mutateQqbotPeople, readProfileDocument } from '../plugins/qqbot-core/profile-documents.js';

const server = fileURLToPath(new URL('../bot-config-panel/server.mjs', import.meta.url));
const runtime = readFileSync(new URL('../qqbot-patches/self-memory-helper.js', import.meta.url), 'utf8');

test('manual memory scopes follow active persona modules; legacy memories only switch on explicit save', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'qqbot-memory-scope-'));
  const env = { QQBOT_PROFILE_DIR: profile, QQBOT_MEMORY_DB: join(profile, 'db', 'ltm.db'), XIANGXIN_API_KEY: 'test-only' };
  const savedEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const doc = { modules: { stories: '叙事模块正文', chat: '聊天模块正文' }, personas: { default: { modules: ['stories'] }, '*': ['chat'], g1: { modules: ['stories'] } } };
  const personaFile = join(profile, 'qqbot-personas.json');
  const legacyPersonas = JSON.stringify(doc);
  writeFileSync(personaFile, legacyPersonas);
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const child = spawn(process.execPath, [server, String(port)], {
    cwd: profile, env: { ...env, HOME: profile, QQBOT_LEGACY_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const root = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Panel startup timed out')), 5000);
      let logs = '';
      child.stderr.on('data', (chunk) => { logs += chunk; });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Panel exited ${code}: ${logs}`)); });
      child.stdout.on('data', (chunk) => {
        const matched = String(chunk).match(/机器人控制台已启动: (http:\/\/127\.0\.0\.1:\d+)/);
        if (matched) { clearTimeout(timer); resolve(matched[1]); }
      });
    });
    const cookie = (await fetch(root)).headers.get('set-cookie').split(';')[0];
    async function request(path = '', method = 'GET', data, expected = 200) {
      const response = await fetch(`${root}/api/memory-library${path}`, {
        method, headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(data),
        signal: AbortSignal.timeout(3000),
      });
      const body = await response.json();
      assert.equal(response.status, expected, JSON.stringify(body));
      return body;
    }
    const overview = async () => (await (await fetch(`${root}/api/overview`, { headers: { cookie } })).json());
    const savePersonas = (data, baseVersion) => fetch(`${root}/api/personas`, {
      method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ data, baseVersion }),
    });
    const initial = await overview();
    assert.deepEqual(initial.personas, doc);
    let version = initial.personaVersion;
    async function commitPersonas() {
      const response = await savePersonas(doc, version);
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      version = body.version;
    }
    const rows = async () => (await request()).memories;
    const profiles = (await request('/personas')).profiles;
    const storiesPersona = profiles.find(({ id }) => id === JSON.stringify([['stories'], ''])).id;
    const chatPersona = profiles.find(({ id }) => id === JSON.stringify([['chat'], ''])).id;
    assert.equal(profiles.length, 2);
    assert.deepEqual(await rows(), []);
    const first = await request('', 'POST', { topic: '灯塔初见', text: '记忆正文', tags: 'pm:42 叙事' });
    assert.deepEqual((await rows()).map(({ scopeType, personaIds, tags }) => ({ scopeType, personaIds, tags })),
      [{ scopeType: 'personas', personaIds: [], tags: '叙事' }]);
    const judged = [];
    const mockJudge = async (_, { body }) => {
      judged.push(JSON.parse(body));
      return { ok: false };
    };
    new Function('readProfileDocument', 'fetch', runtime)(readProfileDocument, mockJudge);
    const memory = globalThis.__qqbotSelfMemory;
    assert.deepEqual(memory.list('g1'), []);
    await request('/scope', 'PUT', { id: first.id, personaIds: ['missing'] }, 409);
    await request('/scope', 'PUT', { id: 999, personaIds: [] }, 404);
    await request('/scope', 'PUT', { id: first.id, personaIds: [storiesPersona] });
    assert.deepEqual((await rows())[0].personaIds, [storiesPersona]);
    assert.equal(memory.list('g1')[0].topic, '灯塔初见');
    assert.deepEqual(memory.list('g2'), [], 'wildcard persona lacks stories despite default containing stories');
    await memory.prefetch('g1', '灯塔初见');
    assert.match(await memory.recallLine('g1'), /灯塔初见/);
    await request('', 'PUT', { id: first.id, topic: '灯塔新记', text: '已改正文' });
    assert.deepEqual((await rows())[0].personaIds, [storiesPersona], 'editing content does not replace scope');
    assert.equal(await memory.recallLine('g1'), '', 'old cached content is not injected');
    await memory.prefetch('g1', '灯塔新记');
    assert.match(await memory.recallLine('g1'), /已改正文/);
    doc.personas.g1.modules = ['chat'];
    await commitPersonas();
    assert.equal(await memory.recallLine('g1'), '', 'changes to active persona apply to cached recalls');
    delete doc.personas['*'];
    await commitPersonas();
    assert.equal(memory.list('g2')[0].topic, '灯塔新记', 'default persona is used with no explicit or wildcard entry');
    await memory.prefetch('g2', '灯塔新记');
    await request('/scope', 'PUT', { id: first.id, personaIds: [] });
    assert.equal(await memory.recallLine('g2'), '');
    assert.equal((await rows())[0].text, '已改正文');

    const stale = await savePersonas(JSON.parse(legacyPersonas), initial.personaVersion);
    assert.equal(stale.status, 409);
    assert.equal(readFileSync(personaFile, 'utf8'), legacyPersonas);

    const db = new DatabaseSync(env.QQBOT_MEMORY_DB);
    try {
      db.exec(`insert into bot_memory_library (id,topic,text,created_at,updated_at) values (88,'旧版群记忆','仅原群',1,1);
        insert into bot_memory_groups values (88,'old-group');
        insert into self_memories (topic,summary,tags,created_at,updated_at) values ('旧版群记忆','仅原群','pm:88',1,1),('原有私人记忆','照旧保留','',1,1);`);
    } finally { db.close(); }
    assert.equal((await rows()).find(({ id }) => id === 88).scopeType, 'legacy-groups');
    assert.deepEqual(memory.list('old-group').map(({ topic }) => topic), ['旧版群记忆', '原有私人记忆']);
    assert.deepEqual(memory.list('g1').map(({ topic }) => topic), ['原有私人记忆']);
    await request('', 'PUT', { id: 88, topic: '旧版群记忆', text: '改正文但保留旧范围' });
    assert.equal(memory.list('old-group')[0].summary, '改正文但保留旧范围');
    await request('/scope', 'PUT', { id: 88, personaIds: [chatPersona] });
    assert.deepEqual((await rows()).find(({ id }) => id === 88).groups, []);
    assert.deepEqual(memory.list('old-group').map(({ topic }) => topic), ['原有私人记忆']);
    assert.deepEqual(memory.list('g1').map(({ topic }) => topic), ['旧版群记忆', '原有私人记忆']);
    await memory.prefetch('g1', '旧版群记忆');
    await request('?id=88', 'DELETE');
    assert.equal(await memory.recallLine('g1'), '');
    assert.deepEqual(memory.list('g1').map(({ topic }) => topic), ['原有私人记忆']);

    const protectedMemory = { topic: '童年的白猫', text: '她小时候养过一只白猫', tags: '自己的东西', minAffinity: 70, minFamiliarity: 60 };
    await request('', 'POST', { ...protectedMemory, minAffinity: 101 }, 400);
    const { id: catId } = await request('', 'POST', protectedMemory);
    await request('/scope', 'PUT', { id: catId, personaIds: [chatPersona] });
    const setPeople = (affinity, familiarity) => mutateQqbotPeople(profile, store => {
      store.people = [
        { name: '阿白', openids: ['reader'], social: { affinity, familiarity } },
        { name: '阿白', openids: ['another'], social: { affinity: 80, familiarity: 70 } },
      ];
    });
    setPeople(75, 59);
    await memory.prefetch('g1', protectedMemory.topic, 'reader');
    assert(!Object.hasOwn(judged.at(-1).questions.命中.criteria, protectedMemory.topic));
    assert.equal(await memory.recallLine('g1', undefined, 'reader'), '');
    setPeople(69, 65);
    await memory.prefetch('g1', protectedMemory.topic, 'reader');
    assert.equal(await memory.recallLine('g1', undefined, 'reader'), '');
    setPeople(70, 60);
    await memory.prefetch('g1', protectedMemory.topic, 'reader');
    assert.match(await memory.recallLine('g1', undefined, 'reader'), /小时候养过一只白猫/);
    assert.equal(await memory.recallLine('g1'), '');
    assert.equal(await memory.recallLine('g1', undefined, 'another'), '');
    setPeople(70, 59);
    assert.equal(await memory.recallLine('g1', undefined, 'reader'), '');
    setPeople(70, 60);
    await request('', 'PUT', { id: catId, ...protectedMemory, minAffinity: 71, minFamiliarity: undefined });
    const { minAffinity, minFamiliarity } = (await rows()).find(item => item.id === catId);
    assert.equal(minAffinity, 71);
    assert.equal(minFamiliarity, 60, 'older clients can edit without clearing a threshold');
    assert.equal(await memory.recallLine('g1', undefined, 'reader'), '', 'a changed threshold filters an existing cache hit');
    await request('', 'PUT', { id: catId, ...protectedMemory, minAffinity: 0, minFamiliarity: 0 });
    await memory.prefetch('g1', protectedMemory.topic);
    assert.match(await memory.recallLine('g1'), /小时候养过一只白猫/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    delete globalThis.__qqbotSelfMemory;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(profile, { recursive: true, force: true });
  }
});

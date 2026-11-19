import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { mutateQqbotPeople, readProfileDocument, withQqbotProfileDocuments } from '../qqbot-patches/profile-document-reader.js';

const server = fileURLToPath(new URL('../bot-config-panel/server.mjs', import.meta.url));

test('group archive preserves the people editor’s transaction and version', { timeout: 10_000 }, async () => {
  const profile = mkdtempSync(join(tmpdir(), 'qqbot-panel-档案 '));
  const file = join(profile, 'qqbot-people.json');
  const data = name => ({ people: [{ name, openids: ['sender-a'] }] });
  const legacy = JSON.stringify(data('初版'));
  writeFileSync(file, legacy);
  const port = await new Promise((resolve, reject) => {
    const lock = createServer();
    lock.once('error', reject);
    lock.listen(0, '127.0.0.1', () => {
      const chosen = lock.address().port;
      lock.close(error => error ? reject(error) : resolve(chosen));
    });
  });
  const child = spawn(process.execPath, [server, String(port)], {
    cwd: profile,
    env: { HOME: profile, QQBOT_PROFILE_DIR: profile, QQBOT_CONTROL_PORT: '0', QQBOT_LEGACY_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stderr.on('data', (chunk) => { logs += chunk; });
  try {
    const root = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Panel startup timed out: ${logs}`)), 3500);
      const fail = (code) => { clearTimeout(timeout); reject(new Error(`Panel exited (${code}): ${logs}`)); };
      child.once('exit', fail);
      child.stdout.on('data', (chunk) => {
        logs += chunk;
        const url = logs.match(/已启动: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
        if (url) { clearTimeout(timeout); child.off('exit', fail); resolve(url); }
      });
    });
    const page = await fetch(root, { signal: AbortSignal.timeout(1500) });
    const cookie = (page.headers.getSetCookie?.()[0] ?? page.headers.get('set-cookie') ?? '').split(';')[0];
    assert.match(cookie, /^dsh_bot_session=[0-9a-f]+$/);
    await page.text();
    const request = (body) => fetch(`${root}/api/people`, {
      headers: { cookie, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(5000),
      ...(body && { method: 'PUT', body: JSON.stringify(body) }),
    });
    const base = await (await request()).json();
    assert.deepEqual(base.data, data('初版'));
    assert.match(base.version, /^[a-f0-9]{64}$/);

    withQqbotProfileDocuments(profile, db => db.update('interest-activity', () => ({ at: 9 })));
    assert.equal((await (await request()).json()).version, base.version);
    mutateQqbotPeople(profile, doc => { doc.people[0].name = '机器人更新'; });
    const conflict = await request({ data: data('旧页面覆盖'), baseVersion: base.version });
    assert.equal(conflict.status, 409, await conflict.text());
    assert.deepEqual(readProfileDocument(profile, 'people'), data('机器人更新'));
    const latest = await (await request()).json();
    assert.notEqual(latest.version, base.version);
    const writes = await Promise.all([
      request({ data: data('面板甲'), baseVersion: latest.version }),
      request({ data: data('面板乙'), baseVersion: latest.version }),
    ]);
    assert.deepEqual(writes.map(res => res.status).sort(), [200, 409]);
    const saved = await writes.find(res => res.ok).json();
    const savedPeople = await (await request()).json();
    assert.equal(savedPeople.version, saved.version);
    const name = savedPeople.data.people[0].name;
    const roleFile = join(profile, 'qqbot-role-skills.json');
    const legacyRole = JSON.stringify({ skills: [{ id: 'fixture', name: '测试风格' }] });
    writeFileSync(roleFile, legacyRole);
    const modulePut = await fetch(`${root}/api/modules`, {
      method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name, modules: {
        collectImages: { enabled: true, categories: ['风景'] },
        style: { enabled: true, skill: 'fixture' }, voiceGen: { enabled: true },
      } }),
    });
    const granted = await modulePut.json();
    assert.equal(modulePut.status, 200, JSON.stringify(granted));
    assert.equal(granted.modules.style.skill, 'fixture');
    assert.equal(granted.modules.voiceGen.enabled, true);
    assert.deepEqual(readProfileDocument(profile, 'media-allow').people[0].openids, ['sender-a']);
    assert.equal(readProfileDocument(profile, 'person-modules').people[name].style.enabled, true);
    assert.equal(readProfileDocument(profile, 'role-skills').skills[0].audiences[0].person, name);
    assert.equal(readFileSync(roleFile, 'utf8'), legacyRole);
    assert.equal(readFileSync(file, 'utf8'), legacy);
    withQqbotProfileDocuments(profile, db => db.remove('people'));
    assert.deepEqual((await (await request()).json()).data.people, []);

    const groupId = 'new-group';
    const groupPath = `${root}/api/groups`;
    const headers = { cookie, 'content-type': 'application/json' };
    const archive = (groupOpenid, name) => fetch(`${groupPath}/archive`, {
      method: 'POST', headers, body: JSON.stringify({ groupOpenid, name }),
    });
    const observation = (event, gid, name, id) =>
      `2026-11-19T00:00:00.000Z ${gid} event=${event} exempt=false wake=false window=false sender=${name}(${id})`;
    writeFileSync(join(profile, 'qqbot-seen-groups.log'), [
      observation('GROUP_MESSAGE_CREATE', groupId, '已认识', 'linked-id'),
      observation('GROUP_MESSAGE_CREATE', groupId, '全局', 'global-id'),
      observation('GROUP_AT_MESSAGE_CREATE', groupId, '旧昵称', 'new-id'),
      observation('GROUP_MESSAGE_CREATE', groupId, '群友（新）(备注)', 'new-id'),
      observation('GROUP_MESSAGE_CREATE', groupId, '?', 'new-id'),
      observation('GROUP_MESSAGE_CREATE', groupId, '?', 'unknown-name'),
      observation('GROUP_MESSAGE_CREATE', groupId, '?', '?'),
      observation('GROUP_ADD_ROBOT', 'other-group', '邀请者', 'other-id'),
    ].join('\n'));
    mutateQqbotPeople(profile, doc => {
      doc.people.push(
        { name: '已认识', openids: ['linked-id'], groups: ['old-group'], profile: { identity: '已有资料' } },
        { name: '全局', openids: ['global-id'] },
        { name: '群友（新）(备注)', openids: ['different-id'], groups: ['old-group'] },
      );
    });
    const discovered = async () => (await (await fetch(`${groupPath}?discover=1`, { headers })).json()).discovered;
    assert.deepEqual(await discovered(), [{ id: groupId, observed: 4 }]);
    assert.equal((await archive('other-group')).status, 404);
    const first = await archive(groupId, '喵喵开发群');
    const archived = await first.json();
    assert.equal(first.status, 200, JSON.stringify(archived));
    assert.deepEqual(archived.group, { id: groupId, name: '喵喵开发群' });
    assert.deepEqual([archived.groupCreated, archived.observed, archived.created, archived.linked], [true, 4, 2, 1]);
    assert.deepEqual(await discovered(), []);
    const byId = new Map(archived.data.people.map(person => [person.openids[0], person]));
    assert.deepEqual(byId.get('linked-id').groups, ['old-group', groupId]);
    assert.equal(byId.get('linked-id').profile.identity, '已有资料');
    assert.equal(byId.get('global-id').groups, undefined);
    assert.equal(byId.get('new-id').name, '群友（新）(备注)');
    assert.match(byId.get('unknown-name').name, /^成员 /);
    assert.equal((await (await request()).json()).version, archived.version);
    const repeat = await (await archive(groupId, '另一个名字')).json();
    assert.deepEqual([repeat.group, repeat.groupCreated, repeat.created, repeat.linked, repeat.version],
      [archived.group, false, 0, 0, archived.version]);

  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    rmSync(profile, { recursive: true, force: true });
  }
});

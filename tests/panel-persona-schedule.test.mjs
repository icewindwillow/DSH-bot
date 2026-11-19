import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readProfileDocument } from '../plugins/qqbot-core/profile-documents.js';
import { personaSchedulePrompt } from '../bot-config-panel/public/app/shared/persona-schedule.js';

const server = fileURLToPath(new URL('../bot-config-panel/server.mjs', import.meta.url));

test('time table is authenticated, empty by default, versioned and previewed using the runtime formatter', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'qqbot-panel-schedule-'));
  const portProbe = createServer().listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const root = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [server, String(port)], {
    cwd: profile, env: { ...process.env, HOME: profile, QQBOT_PROFILE_DIR: profile, QQBOT_LEGACY_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Panel startup timed out')), 5000);
      let logs = '';
      child.stderr.on('data', chunk => { logs += chunk; });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Panel exited ${code}: ${logs}`)); });
      child.stdout.on('data', chunk => {
        if (String(chunk).includes('机器人控制台已启动')) { clearTimeout(timer); resolve(); }
      });
    });
    assert.equal((await fetch(`${root}/api/persona-schedule`)).status, 401);
    const page = await fetch(root);
    const cookie = page.headers.get('set-cookie').split(';')[0];
    assert.match(await page.text(), /id="tabPersona".*id="tabSchedule"[\s\S]*id="paneSchedule"/);
    async function request(path, expected, data) {
      const response = await fetch(`${root}/api/${path}`, {
        method: data ? 'PUT' : 'GET', headers: { cookie, 'content-type': 'application/json' }, body: data ? JSON.stringify(data) : undefined,
      });
      const body = await response.json();
      assert.equal(response.status, expected, JSON.stringify(body));
      return body;
    }
    const empty = await request('persona-schedule', 200);
    assert.deepEqual(empty.data, { entries: [] });
    assert.equal(empty.scheduleRevision, 2);
    assert.equal(empty.current, null);
    assert.equal(empty.preview, '');
    assert.equal(existsSync(join(profile, 'qqbot-documents.sqlite')), false, 'reading an empty week must not seed or write');

    const entry = { id: 'whole-week', days: [0, 1, 2, 3, 4, 5, 6], start: 0, end: 1440, title: '刷视频', hint: '小声说我偷偷回你。', sleep: false, probability: 100 };
    const data = { entries: [{ ...entry, mood: 'early-rise', meal: 'breakfast' }, { ...entry, id: 'overlap', title: '午睡', hint: '', probability: 0, sleep: true }] };
    await request('persona-schedule', 400, { baseVersion: empty.version, data: { entries: [{ ...entry, probability: 101 }] } });
    const saved = await request('persona-schedule', 200, { baseVersion: empty.version, data });
    assert.equal(saved.restartRequired, false);
    assert.deepEqual(saved.current, { id: entry.id, title: entry.title, probability: 100, sleep: false });
    assert.equal(saved.preview, personaSchedulePrompt(data.entries[0], saved.time));
    assert.match(saved.preview, /这一顿早饭吃的是/);
    assert.notEqual(saved.version, empty.version);
    assert.deepEqual(readProfileDocument(profile, 'persona-schedule'), data);
    await request('persona-schedule', 409, { baseVersion: empty.version, data: { entries: [] } });
    assert.deepEqual((await request('persona-schedule', 200)).data, data);

    const asleep = await request('persona-schedule', 200, {
      baseVersion: saved.version, data: { entries: [{ ...data.entries[1], probability: 100 }] },
    });
    assert.equal(asleep.current.sleep, true);
    assert.equal(asleep.preview, '', 'sleep is a reply gate rather than a persona prompt');

    const overview = await request('overview', 200);
    const personas = { modules: { a: '人格' }, personas: { default: { modules: ['a'], useSchedule: 'yes' } } };
    await request('personas', 400, { baseVersion: overview.personaVersion, data: personas });
    personas.personas.default.useSchedule = true;
    await request('personas', 200, { baseVersion: overview.personaVersion, data: personas });
    assert.deepEqual(readProfileDocument(profile, 'personas'), personas);
  } finally {
    const exited = child.exitCode === null ? once(child, 'exit') : null;
    child.kill();
    await exited;
    rmSync(profile, { recursive: true, force: true });
  }
});

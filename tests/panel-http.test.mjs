import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE_GENERATION_DEFAULTS } from '../bot-config-panel/image-generation.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SERVER = join(ROOT, 'bot-config-panel', 'server.mjs');
const KEYS = ['OPENAI_API_KEY', 'SILICONFLOW_API_KEY', 'DEEPSEEK_API_KEY', 'XIANGXIN_API_KEY', 'OPENCODE_GO_API_KEY', 'QQBOT_APPID', 'QQBOT_SECRET'];
const basePatch = '- id: agent-default-model\n  config:\n    provider: legacy-only\n    model: synthetic-legacy\n';
const overlay = `# Synthetic test data, no real credentials.
- id: llm-pi-ai
  config:
    providers:
      openai:
        apiKeyEnv: OPENAI_API_KEY
        models:
          - id: gpt-4.1
          - id: gpt-5.4-mini
      deepseek:
        apiKeyEnv: DEEPSEEK_API_KEY
        models:
          - id: deepseek-chat
- id: agent-default-model
  config:
    provider: openai
    model: gpt-4.1
`;

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
function request(port, path = '/', { method = 'GET', cookie, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path, method, agent: false, headers: {
      ...(cookie ? { cookie } : {}), ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }), ...headers,
    } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch { /* The initial HTML page is intentionally not JSON. */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('Local panel request timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}
async function withPanel(options, run) {
  const prefix = join(realpathSync(tmpdir()), 'dsh-panel-http-');
  const root = mkdtempSync(prefix);
  let child;
  let logs = '';
  try {
    const home = join(root, '隔离 HOME 空格');
    const dshHome = join(home, '独立 DSH home');
    const profileName = `panel_test_${root.slice(prefix.length).replace(/[^a-zA-Z0-9]/g, '')}`;
    const profile = options.defaultProfile ? join(dshHome, 'profiles', profileName) : join(root, '私有 profile 空格');
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(join(profile, 'cordis.patch.yml'), basePatch, { mode: 0o600 });
    if (options.overlay !== false) writeFileSync(join(profile, 'dsh-bot.patch.yml'), overlay, { mode: 0o600 });
    const marker = join(root, 'bot-must-not-start');
    const fakeDsh = join(root, 'synthetic-dsh.mjs');
    writeFileSync(fakeDsh, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'unexpected');`, { mode: 0o600 });
    const port = await freePort();
    // Explicit minimal environment: never forward user keys, proxies, NODE_OPTIONS or real DSH paths.
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, USERPROFILE: home, NODE_OPTIONS: '',
      DSH_HOME: dshHome, QQBOT_PROFILE_NAME: profileName,
      QQBOT_DSH_BIN: fakeDsh, QQBOT_CONTROL_PORT: '0', QQBOT_LEGACY_PORT: '0',
      ...(options.defaultProfile ? {} : { QQBOT_PROFILE_DIR: profile }),
      ...(options.env ?? {}),
    };
    child = spawn(process.execPath, [SERVER, String(port)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Panel startup timeout: ${logs}`)), 8000);
      const cleanup = () => { clearTimeout(timeout); child.off('exit', onExit); child.off('error', onError); };
      const onExit = (code) => { cleanup(); reject(new Error(`Panel exited before listening (${code}): ${logs}`)); };
      const onError = (error) => { cleanup(); reject(error); };
      child.on('exit', onExit); child.on('error', onError);
      child.stdout.on('data', (chunk) => {
        logs += chunk.toString();
        if (logs.includes(`http://127.0.0.1:${port}`)) { cleanup(); resolve(); }
      });
      child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
    });
    const page = await request(port);
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.equal(page.headers['cache-control'], 'no-store');
    const setCookie = page.headers['set-cookie']?.[0];
    assert.match(setCookie, /^dsh_bot_session=[0-9a-f]+;/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const cookie = setCookie.split(';')[0];
    await run({ root, profile, home, dshHome, profileName, port, cookie, marker, get logs() { return logs; } });
    assert.equal(existsSync(marker), false, 'the integration test must never start a bot');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await exited; } finally { clearTimeout(timeout); }
    }
    const target = realpathSync(root);
    assert.equal(target, root);
    assert.ok(target.startsWith(prefix) && target.slice(prefix.length) && !target.slice(prefix.length).includes(sep));
    rmSync(target, { recursive: true, force: true });
  }
}
function assertStatusOnly(response, secrets = []) {
  assert.equal(response.headers['cache-control'], 'no-store');
  for (const secret of secrets) assert.equal(response.text.includes(secret), false, 'HTTP response must never echo a credential');
  if (response.json?.keys) {
    assert.deepEqual(Object.keys(response.json.keys).sort(), KEYS.slice().sort());
    for (const value of Object.values(response.json.keys)) {
      assert.deepEqual(Object.keys(value).sort(), ['configured', 'source']);
      assert.equal(typeof value.configured, 'boolean');
      assert.ok(['local', 'environment', 'missing'].includes(value.source));
    }
  }
}

test('real panel HTTP: presence-only credential save, 600, blank preservation and local deletion', { timeout: 20000 }, async () => {
  await withPanel({ env: { OPENAI_API_KEY: 'synthetic-inherited-secret' } }, async (context) => {
    const { port, cookie, profile } = context;
    const secretFile = join(profile, '.bot-secrets.json');
    const initial = await request(port, '/api/credentials', { cookie });
    assert.equal(initial.status, 200);
    assertStatusOnly(initial, ['synthetic-inherited-secret']);
    assert.deepEqual(initial.json.keys.OPENAI_API_KEY, { configured: true, source: 'environment' });
    assert.deepEqual(initial.json.keys.DEEPSEEK_API_KEY, { configured: false, source: 'missing' });
    assert.equal(existsSync(secretFile), false);
    const secrets = ['synthetic-openai-local-ABC123', 'synthetic-deepseek-local-XYZ987'];
    const saved = await request(port, '/api/credentials', { method: 'PUT', cookie, body: { values: { OPENAI_API_KEY: secrets[0], DEEPSEEK_API_KEY: secrets[1] }, remove: [] } });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.restartRequired, true);
    assertStatusOnly(saved, [...secrets, 'synthetic-inherited-secret', 'ABC123', 'XYZ987']);
    assert.deepEqual(saved.json.keys.OPENAI_API_KEY, { configured: true, source: 'environment' });
    assert.deepEqual(saved.json.keys.DEEPSEEK_API_KEY, { configured: true, source: 'local' });
    assert.equal(statSync(secretFile).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(secretFile, 'utf8')), { OPENAI_API_KEY: secrets[0], DEEPSEEK_API_KEY: secrets[1] });
    const readSaved = await request(port, '/api/credentials', { cookie });
    assert.equal(readSaved.status, 200);
    assertStatusOnly(readSaved, [...secrets, 'synthetic-inherited-secret', 'ABC123', 'XYZ987']);
    assert.deepEqual(readSaved.json.keys.DEEPSEEK_API_KEY, { configured: true, source: 'local' });
    const blank = await request(port, '/api/credentials', { method: 'PUT', cookie, body: { values: { OPENAI_API_KEY: '', DEEPSEEK_API_KEY: ' \t ' } } });
    assert.equal(blank.status, 200);
    assertStatusOnly(blank, secrets);
    assert.equal(JSON.parse(readFileSync(secretFile, 'utf8')).DEEPSEEK_API_KEY, secrets[1]);
    const removed = await request(port, '/api/credentials', { method: 'PUT', cookie, body: { remove: ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY'] } });
    assert.equal(removed.status, 200);
    assertStatusOnly(removed, secrets);
    assert.deepEqual(removed.json.keys.OPENAI_API_KEY, { configured: true, source: 'environment' });
    assert.deepEqual(removed.json.keys.DEEPSEEK_API_KEY, { configured: false, source: 'missing' });
    assert.deepEqual(JSON.parse(readFileSync(secretFile, 'utf8')), {});
    assert.equal(statSync(secretFile).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(profile).filter((name) => name.startsWith('.bot-secrets')), ['.bot-secrets.json']);
    const final = await request(port, '/api/credentials', { cookie });
    assertStatusOnly(final, [...secrets, 'synthetic-inherited-secret']);
    for (const secret of [...secrets, 'synthetic-inherited-secret']) assert.equal(context.logs.includes(secret), false);
  });
});

test('real panel HTTP: rejects unauthorized, cross-origin, bad Host, oversized body; restart stays disabled', { timeout: 20000 }, async () => {
  await withPanel({}, async ({ port, cookie, profile, marker }) => {
    const attempted = 'synthetic-rejected-secret';
    const cases = [
      { cookie: undefined, expected: 401 },
      { cookie: 'dsh_bot_session=incorrect', expected: 401 },
      { cookie, headers: { origin: 'https://attacker.invalid' }, expected: 403 },
      { cookie, headers: { origin: `http://127.0.0.1:${port + 1}` }, expected: 403 },
      { cookie, headers: { 'sec-fetch-site': 'cross-site' }, expected: 403 },
      { cookie, headers: { 'sec-fetch-site': 'same-site' }, expected: 403 },
      { cookie, headers: { host: `localhost:${port}` }, expected: 403 },
      { cookie, headers: { host: `attacker.invalid:${port}` }, expected: 403 },
    ];
    for (const item of cases) {
      for (const method of ['GET', 'PUT']) {
        const response = await request(port, '/api/credentials', { ...item, method, ...(method === 'PUT' ? { body: { values: { OPENAI_API_KEY: attempted } } } : {}) });
        assert.equal(response.status, item.expected);
        assertStatusOnly(response, [attempted]);
      }
    }
    assert.equal(existsSync(join(profile, '.bot-secrets.json')), false);
    const originOK = await request(port, '/api/credentials', { cookie, headers: { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' } });
    assert.equal(originOK.status, 200);
    const oversized = await request(port, '/api/credentials', { cookie, method: 'PUT', body: { values: { OPENAI_API_KEY: 'x'.repeat(1024 * 1024 + 1) } } });
    assert.ok([400, 413].includes(oversized.status));
    assertStatusOnly(oversized);
    assert.equal(existsSync(join(profile, '.bot-secrets.json')), false);
    for (const body of ['{"values":', { values: { NOT_ALLOWED: attempted } }, { other: attempted }]) {
      const response = await request(port, '/api/credentials', { cookie, method: 'PUT', body });
      assert.equal(response.status, 400);
      assertStatusOnly(response, [attempted]);
    }
    const restarted = await request(port, '/api/bot/restart', { cookie, method: 'POST', body: {} });
    assert.equal(restarted.status, 500);
    assert.equal(restarted.json.ok, false);
    assert.match(restarted.json.error, /默认关闭/);
    assert.equal(existsSync(marker), false);
    assert.equal((await request(port, '/api/credentials', { cookie })).status, 200, 'server remains healthy after oversized/malformed requests');
  });
});

test('real panel HTTP: DSH_HOME/profile name and spaced Chinese paths; overlay wins over legacy patch', { timeout: 20000 }, async () => {
  await withPanel({ defaultProfile: true }, async ({ port, cookie, profile, home, dshHome, profileName }) => {
    const response = await request(port, '/api/overview', { cookie });
    assert.equal(response.status, 200, response.text);
    assert.equal(profile, join(dshHome, 'profiles', profileName));
    assert.ok(profile.startsWith(home) && profile.includes(' ') && /[\u4e00-\u9fff]/u.test(profile));
    assert.equal(response.json.paths.patch, join(profile, 'dsh-bot.patch.yml'));
    assert.equal(response.json.paths.workdir, join(profile, 'workspace'));
    assert.equal(response.json.model.provider, 'openai');
    assert.equal(response.json.model.model, 'gpt-4.1');
    assert.deepEqual(response.json.providers, ['openai', 'deepseek']);
    assert.deepEqual(response.json.route.models.map((model) => model.id), ['gpt-4.1', 'gpt-5.4-mini']);
    assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), basePatch);
    // Synthetic plugin state must follow DSH_HOME, not a real user's global catalog.
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-our-free-model': 'synthetic-local-fixture' } }));
    const freeDir = join(dshHome, 'our-free-model');
    mkdirSync(freeDir, { recursive: true });
    writeFileSync(join(freeDir, 'catalog.json'), JSON.stringify({ entries: ['synthetic-free-model'] }));
    writeFileSync(join(freeDir, 'settings.json'), JSON.stringify({ combos: [{ id: 'combo:synthetic-free', name: 'Synthetic free combo' }] }));
    const freeOverview = await request(port, '/api/overview', { cookie });
    assert.equal(freeOverview.status, 200);
    assert.deepEqual(freeOverview.json.providers, ['openai', 'deepseek', 'our-free-model']);
    const selected = await request(port, '/api/model', { cookie, method: 'PUT', body: {
      provider: 'our-free-model', model: 'combo:synthetic-free', reasoningEffort: '', routeReasoning: '',
    } });
    assert.equal(selected.status, 200, selected.text);
    const reread = await request(port, '/api/overview', { cookie });
    assert.equal(reread.json.model.provider, 'our-free-model');
    assert.equal(reread.json.model.model, 'combo:synthetic-free');
    assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), basePatch);
  });
});

test('real panel HTTP: image settings default off, credential saves do not enable, strict save dynamically rereads', { timeout: 20000 }, async () => {
  await withPanel({ defaultProfile: true }, async ({ port, cookie, profile }) => {
    const imageFile = join(profile, 'qqbot-image-generation.json');
    const before = await request(port, '/api/image-generation', { cookie });
    assert.equal(before.status, 200);
    assert.equal(before.headers['cache-control'], 'no-store');
    assert.deepEqual(before.json, { ok: true, settings: IMAGE_GENERATION_DEFAULTS });
    assert.equal(existsSync(imageFile), false, 'GET must not seed configuration');
    const blank = await request(port, '/api/credentials', { cookie, method: 'PUT', body: { values: { OPENAI_API_KEY: '' } } });
    assert.equal(blank.status, 200);
    assert.equal((await request(port, '/api/image-generation', { cookie })).json.settings.enabled, false);
    assert.equal(existsSync(imageFile), false, 'blank Key may not auto-enable or create image settings');
    const localKey = 'synthetic-image-test-local-key';
    const key = await request(port, '/api/credentials', { cookie, method: 'PUT', body: { values: { OPENAI_API_KEY: localKey } } });
    assert.equal(key.status, 200);
    assertStatusOnly(key, [localKey]);
    assert.equal((await request(port, '/api/image-generation', { cookie })).json.settings.enabled, false, 'saving a nonblank Key also may not opt into paid generation');
    for (const model of ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-1.5', 'gpt-image-1-mini']) {
      const settings = { ...IMAGE_GENERATION_DEFAULTS, enabled: true, model, size: '1024x1536', quality: 'high', cooldownSeconds: 60, maxPerHour: 1, timeoutSeconds: 30 };
      const saved = await request(port, '/api/image-generation', { cookie, method: 'PUT', body: settings });
      assert.equal(saved.status, 200, saved.text);
      assert.deepEqual(saved.json, { ok: true, settings, restartRequired: false });
      assert.equal(saved.text.includes(localKey), false);
      assert.equal(statSync(imageFile).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(readFileSync(imageFile, 'utf8')), settings);
      assert.deepEqual((await request(port, '/api/image-generation', { cookie })).json.settings, settings);
    }
    // Prove reads are dynamic and do not require restarting the panel.
    writeFileSync(imageFile, JSON.stringify(IMAGE_GENERATION_DEFAULTS));
    assert.deepEqual((await request(port, '/api/image-generation', { cookie })).json.settings, IMAGE_GENERATION_DEFAULTS);
    assert.deepEqual(readdirSync(profile).filter((name) => name.includes('image-generation')), ['qqbot-image-generation.json']);
  });
});

test('real panel HTTP: image API fences, invalid/oversized payloads and corrupt files never leak input', { timeout: 20000 }, async () => {
  await withPanel({}, async ({ port, cookie, profile }) => {
    const file = join(profile, 'qqbot-image-generation.json');
    const cases = [
      { cookie: undefined, expected: 401 }, { cookie: 'dsh_bot_session=wrong', expected: 401 },
      { cookie, headers: { origin: 'https://attacker.invalid' }, expected: 403 },
      { cookie, headers: { origin: `http://127.0.0.1:${port + 1}` }, expected: 403 },
      { cookie, headers: { 'sec-fetch-site': 'cross-site' }, expected: 403 },
      { cookie, headers: { 'sec-fetch-site': 'same-site' }, expected: 403 },
      { cookie, headers: { host: `localhost:${port}` }, expected: 403 },
      { cookie, headers: { host: `attacker.invalid:${port}` }, expected: 403 },
    ];
    for (const item of cases) {
      for (const method of ['GET', 'PUT']) {
        const response = await request(port, '/api/image-generation', { ...item, method, ...(method === 'PUT' ? { body: { ...IMAGE_GENERATION_DEFAULTS, enabled: true } } : {}) });
        assert.equal(response.status, item.expected);
      }
    }
    assert.equal(existsSync(file), false);
    const marker = 'synthetic-image-sensitive-file-content';
    const invalid = [
      {}, null, [], { settings: IMAGE_GENERATION_DEFAULTS }, { ...IMAGE_GENERATION_DEFAULTS, enabled: 'true' },
      { ...IMAGE_GENERATION_DEFAULTS, cooldownSeconds: 59 }, { ...IMAGE_GENERATION_DEFAULTS, maxPerHour: 11 },
      { ...IMAGE_GENERATION_DEFAULTS, timeoutSeconds: 301 }, { ...IMAGE_GENERATION_DEFAULTS, quality: 'auto' },
      { ...IMAGE_GENERATION_DEFAULTS, model: 'gpt-image-1' }, { ...IMAGE_GENERATION_DEFAULTS, model: 'dall-e-3' },
      { ...IMAGE_GENERATION_DEFAULTS, baseURL: `https://${marker}.invalid` },
      { ...IMAGE_GENERATION_DEFAULTS, prompt: marker }, { ...IMAGE_GENERATION_DEFAULTS, n: 2 },
      `{\"model\":\"${marker}\"`, { ...IMAGE_GENERATION_DEFAULTS, model: marker.repeat(40000) },
    ];
    for (const body of invalid) {
      const response = await request(port, '/api/image-generation', { cookie, method: 'PUT', body });
      assert.equal(response.status, 400);
      assert.equal(response.json.ok, false);
      assert.equal(response.text.includes(marker), false);
      assert.equal(existsSync(file), false);
    }
    writeFileSync(file, `{\"${marker}\":`);
    const corrupted = await request(port, '/api/image-generation', { cookie });
    assert.equal(corrupted.status, 500);
    assert.equal(corrupted.text.includes(marker), false);
    assert.equal(readFileSync(file, 'utf8'), `{\"${marker}\":`, 'GET must not repair or overwrite corrupt settings');
    writeFileSync(file, 'x'.repeat(16 * 1024 + 1));
    const oversized = await request(port, '/api/image-generation', { cookie });
    assert.equal(oversized.status, 500);
    assert.equal(oversized.json.ok, false);
    assert.equal((await request(port, '/api/credentials', { cookie })).status, 200, 'panel remains healthy');
  });
});

test('real panel HTTP: explicit profile directory and legacy patch fallback', { timeout: 20000 }, async () => {
  await withPanel({ overlay: false }, async ({ port, cookie, profile }) => {
    const response = await request(port, '/api/overview', { cookie });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.paths.patch, join(profile, 'cordis.patch.yml'));
    assert.equal(response.json.model.provider, 'legacy-only');
    assert.equal(response.json.model.model, 'synthetic-legacy');
    assert.equal(existsSync(join(profile, 'dsh-bot.patch.yml')), false);
  });
});

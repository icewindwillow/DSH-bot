import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, lstatSync,
  symlinkSync, linkSync, mkdirSync, readdirSync, chmodSync,
} from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import {
  CREDENTIAL_KEYS, credentialStatus, updateCredentials, loadCredentialEnvironment,
} from '../bot-config-panel/credentials.mjs';

// Only synthetic credentials in isolated temporary directories. Never use the user's profile or env.
function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-credentials-test-'));
  t.after(() => {
    assert.ok(root.startsWith(join(realpathSync(tmpdir()), 'dsh-credentials-test-')));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, profile: join(root, 'profile'), file: join(root, 'profile', '.bot-secrets.json') };
}
const missing = () => ({ keys: Object.fromEntries(CREDENTIAL_KEYS.map((key) => [key, { configured: false, source: 'missing' }])) });

test('module import performs no credential I/O', async () => {
  // Load source before instrumentation so Node's module loader itself is not mistaken for credential I/O.
  const source = readFileSync(new URL('../bot-config-panel/credentials.mjs', import.meta.url), 'utf8');
  const names = ['lstatSync', 'openSync', 'readSync', 'mkdirSync', 'writeFileSync'];
  const originals = Object.fromEntries(names.map((name) => [name, fs[name]]));
  try {
    for (const name of names) fs[name] = () => { throw new Error('Unexpected import-time I/O'); };
    syncBuiltinESMExports();
    const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    assert.equal(typeof module.credentialStatus, 'function');
  } finally {
    for (const name of names) fs[name] = originals[name];
    syncBuiltinESMExports();
  }
});

test('missing profile reports fixed allowlist, reads do not create files', (t) => {
  const { root, profile } = fixture(t);
  assert.deepEqual(credentialStatus(profile, {}), missing());
  assert.deepEqual(loadCredentialEnvironment(profile, { OTHER: 'synthetic' }), { OTHER: 'synthetic' });
  assert.deepEqual(readdirSync(root), []);
  assert.deepEqual(CREDENTIAL_KEYS, ['OPENAI_API_KEY', 'SILICONFLOW_API_KEY', 'DEEPSEEK_API_KEY', 'XIANGXIN_API_KEY', 'OPENCODE_GO_API_KEY', 'QQBOT_APPID', 'QQBOT_SECRET']);
});

test('creates directory 700 and atomic private file 600; status contains no secrets', (t) => {
  const { profile, file } = fixture(t);
  const status = updateCredentials(profile, { values: { OPENAI_API_KEY: ' synthetic-openai-secret ', QQBOT_APPID: 'synthetic-appid', QQBOT_SECRET: 'synthetic-qq-secret' } }, {});
  assert.deepEqual(status.keys.OPENAI_API_KEY, { configured: true, source: 'local' });
  assert.deepEqual(status.keys.QQBOT_APPID, { configured: true, source: 'local' });
  assert.equal(lstatSync(profile).mode & 0o777, 0o700);
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).OPENAI_API_KEY, 'synthetic-openai-secret');
  assert.equal(JSON.stringify(status).includes('synthetic'), false);
  assert.equal(JSON.stringify(status).includes('secret'), false);
  assert.deepEqual(readdirSync(profile), ['.bot-secrets.json']);
  const ino = lstatSync(file).ino;
  chmodSync(file, 0o644);
  updateCredentials(profile, { values: { DEEPSEEK_API_KEY: 'synthetic-deepseek-secret' } }, {});
  assert.notEqual(lstatSync(file).ino, ino, 'rename replaces the inode rather than writing in place');
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(profile), ['.bot-secrets.json']);
});

test('inherited nonblank env wins, whitespace env falls back, loading never mutates env', (t) => {
  const { profile } = fixture(t);
  updateCredentials(profile, { values: { OPENAI_API_KEY: 'synthetic-local', DEEPSEEK_API_KEY: 'synthetic-deepseek', XIANGXIN_API_KEY: 'synthetic-xiangxin' } }, {});
  const env = Object.freeze({ OPENAI_API_KEY: 'synthetic-inherited', DEEPSEEK_API_KEY: '  ', OTHER: 'keep-me' });
  const merged = loadCredentialEnvironment(profile, env);
  assert.notEqual(merged, env);
  assert.deepEqual(merged, { OPENAI_API_KEY: 'synthetic-inherited', DEEPSEEK_API_KEY: 'synthetic-deepseek', XIANGXIN_API_KEY: 'synthetic-xiangxin', OTHER: 'keep-me' });
  assert.equal(env.DEEPSEEK_API_KEY, '  ');
  assert.deepEqual(credentialStatus(profile, env).keys.OPENAI_API_KEY, { configured: true, source: 'environment' });
  assert.deepEqual(credentialStatus(profile, env).keys.DEEPSEEK_API_KEY, { configured: true, source: 'local' });
});

test('blank retains local, explicit remove deletes local only, remove does not mutate inherited env', (t) => {
  const { profile, file } = fixture(t);
  const env = Object.freeze({ OPENAI_API_KEY: 'synthetic-inherited' });
  updateCredentials(profile, { values: { OPENAI_API_KEY: 'synthetic-local' } }, env);
  updateCredentials(profile, { values: { OPENAI_API_KEY: ' \t\n ' } }, env);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).OPENAI_API_KEY, 'synthetic-local');
  const status = updateCredentials(profile, { values: { OPENAI_API_KEY: '' }, remove: ['OPENAI_API_KEY'] }, env);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {});
  assert.deepEqual(status.keys.OPENAI_API_KEY, { configured: true, source: 'environment' });
  assert.equal(env.OPENAI_API_KEY, 'synthetic-inherited');
  assert.deepEqual(credentialStatus(profile, {}), missing());
});

test('rejects unknown fields, invalid shapes, unsupported QQ aliases and control characters without writing', (t) => {
  const { profile, file } = fixture(t);
  updateCredentials(profile, { values: { OPENAI_API_KEY: 'synthetic-original' } }, {});
  const before = readFileSync(file, 'utf8');
  const cases = [null, [], 'string', { other: true }, { values: null }, { values: [] }, { values: { PATH: 'bad' } },
    { values: { QQBOT_APP_ID: 'bad' } }, { values: { QQBOT_CLIENT_SECRET: 'bad' } },
    { values: { OPENAI_API_KEY: 123 } }, { values: { OPENAI_API_KEY: 'a\nb' } },
    { values: { OPENAI_API_KEY: '\0' } }, { remove: 'OPENAI_API_KEY' }, { remove: [null] },
    { remove: ['PATH'] }, { remove: ['OPENAI_API_KEY', 'OPENAI_API_KEY'] },
    { values: { OPENAI_API_KEY: 'synthetic-new' }, remove: ['OPENAI_API_KEY'] },
    JSON.parse('{"values":{"__proto__":"bad"}}'), JSON.parse('{"__proto__":{}}')];
  for (const body of cases) {
    assert.throws(() => updateCredentials(profile, body, {}), (error) => error.statusCode === 400);
    assert.equal(readFileSync(file, 'utf8'), before);
  }
});

test('rejects oversized values and files; malformed file errors do not echo input', (t) => {
  const { profile, file } = fixture(t);
  assert.throws(() => updateCredentials(profile, { values: { OPENAI_API_KEY: 's'.repeat(8193) } }, {}), { statusCode: 413 });
  mkdirSync(profile, { mode: 0o700 });
  writeFileSync(file, 'x'.repeat(65537), { mode: 0o600 });
  for (const fn of [() => credentialStatus(profile, {}), () => loadCredentialEnvironment(profile, {}), () => updateCredentials(profile, {}, {})])
    assert.throws(fn, { statusCode: 413 });
  writeFileSync(file, '{synthetic-sensitive-malformed-content');
  assert.throws(() => credentialStatus(profile, {}), (error) => !error.message.includes('synthetic-sensitive'));
  for (const content of ['null', '[]', '{"PATH":"synthetic-sensitive"}', '{"OPENAI_API_KEY":12}']) {
    writeFileSync(file, content);
    assert.throws(() => credentialStatus(profile, {}));
  }
});

test('credential UI uses same-origin status API and never echoes saved or failed secret values', async () => {
  const html = readFileSync(new URL('../bot-config-panel/public/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('id="paneCredentials"'));
  assert.ok(html.includes('id="tabCredentials"'));
  // Public examples remain generic; never put real identifiers into negative assertions.
  assert.ok(html.includes('placeholder="输入主人名字，回车添加"'));
  assert.ok(html.includes('placeholder="输入群名称"'));
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  new vm.Script(script); // Parse all browser code without executing the rest of the application.
  const start = script.indexOf('const credentialFields = [');
  const end = script.indexOf('// ─────────────────────────── 人格', start);
  assert.ok(start > 0 && end > start);
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', checked: false, disabled: false, style: {}, textContent: '', innerHTML: '', className: '' });
    return elements.get(id);
  };
  const requests = [];
  let fail = false;
  const status = missing();
  status.keys.OPENAI_API_KEY = { configured: true, source: 'local', value: 'synthetic-must-not-echo' };
  const sandbox = {
    $: element, esc: (value) => String(value), confirm: () => true, toast: () => {},
    api: async (path, options) => {
      requests.push({ path, options });
      if (fail) throw new Error('synthetic-failed-secret-must-not-echo');
      return status;
    },
  };
  vm.runInNewContext(`${script.slice(start, end)}\nglobalThis.ui = {loadCredentials, saveCredentials, credentialInput, credentialRemove};`, sandbox);
  assert.match(element('apiCredentialFields').innerHTML, /type="password"/);
  assert.match(element('qqCredentialFields').innerHTML, /type="text" id="credential-QQBOT_APPID"/);
  await sandbox.ui.loadCredentials();
  assert.equal(requests[0].path, '/api/credentials');
  assert.equal(requests[0].options.cache, 'no-store');
  assert.equal(element('credential-OPENAI_API_KEY').value, '');
  assert.equal(element('credential-status-OPENAI_API_KEY').textContent.includes('synthetic'), false);
  sandbox.ui.credentialInput('OPENAI_API_KEY').value = 'synthetic-new-secret';
  sandbox.ui.credentialInput('OPENAI_API_KEY').oninput();
  sandbox.ui.credentialRemove('DEEPSEEK_API_KEY').checked = true;
  sandbox.ui.credentialRemove('DEEPSEEK_API_KEY').onchange();
  const save = sandbox.ui.saveCredentials({ preventDefault() {} });
  assert.equal(element('credential-OPENAI_API_KEY').value, '', 'clear before network completion');
  await save;
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), { values: { OPENAI_API_KEY: 'synthetic-new-secret' }, remove: ['DEEPSEEK_API_KEY'] });
  fail = true;
  sandbox.ui.credentialInput('OPENAI_API_KEY').value = 'synthetic-failed-secret-must-not-echo';
  sandbox.ui.credentialInput('OPENAI_API_KEY').oninput();
  await sandbox.ui.saveCredentials({ preventDefault() {} });
  for (const el of elements.values()) {
    assert.equal(el.textContent.includes('synthetic'), false);
    assert.equal(el.innerHTML.includes('synthetic'), false);
  }
  assert.equal(element('credential-OPENAI_API_KEY').value, '');
});

test('rejects symbolic links, dangling links, directories and hardlinks without touching targets', (t) => {
  const { root, profile, file } = fixture(t);
  mkdirSync(profile, { mode: 0o700 });
  const target = join(root, 'target.json');
  writeFileSync(target, '{"OPENAI_API_KEY":"synthetic-target"}', { mode: 0o600 });
  const original = readFileSync(target, 'utf8');
  const check = () => {
    for (const fn of [() => credentialStatus(profile, {}), () => loadCredentialEnvironment(profile, {}), () => updateCredentials(profile, { remove: ['OPENAI_API_KEY'] }, {})])
      assert.throws(fn, { code: 'ERR_CREDENTIALS_UNSAFE' });
    assert.equal(readFileSync(target, 'utf8'), original);
  };
  symlinkSync(target, file); check();
  assert.equal(lstatSync(file).isSymbolicLink(), true);
  // Each deletion is an exact known path created by this test in its isolated fixture.
  rmSync(file);
  symlinkSync(join(root, 'not-present'), file); check(); rmSync(file);
  mkdirSync(file); check(); rmSync(file, { recursive: true });
  linkSync(target, file); check(); rmSync(file);
  const alias = join(root, 'profile-alias');
  symlinkSync(profile, alias);
  assert.throws(() => credentialStatus(alias, {}), { code: 'ERR_CREDENTIALS_UNSAFE' });
  assert.throws(() => updateCredentials(alias, {}, {}), { code: 'ERR_CREDENTIALS_UNSAFE' });
  assert.throws(() => credentialStatus(join(alias, 'nested-profile'), {}), { code: 'ERR_CREDENTIALS_UNSAFE' });
  assert.throws(() => updateCredentials(join(alias, 'nested-profile'), {}, {}), { code: 'ERR_CREDENTIALS_UNSAFE' });
});

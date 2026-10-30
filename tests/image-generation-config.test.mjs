import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, lstatSync,
  symlinkSync, linkSync, mkdirSync, readdirSync, chmodSync,
} from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import vm from 'node:vm';
import {
  IMAGE_GENERATION_DEFAULTS, validateImageGenerationSettings,
  readImageGenerationSettings, writeImageGenerationSettings,
} from '../bot-config-panel/image-generation.mjs';

const DEFAULTS = {
  enabled: false, model: 'gpt-image-2', size: '1024x1024', quality: 'low',
  cooldownSeconds: 120, maxPerHour: 3, timeoutSeconds: 180,
};
const MODELS = ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-1.5', 'gpt-image-1-mini'];
const settings = (overrides = {}) => ({ ...DEFAULTS, ...overrides });
function fixture(t) {
  const prefix = join(realpathSync(tmpdir()), 'dsh-image-settings-');
  const root = mkdtempSync(prefix);
  t.after(() => {
    const absolute = realpathSync(root);
    assert.equal(absolute, root);
    assert.ok(absolute.startsWith(prefix) && absolute.slice(prefix.length) && !absolute.slice(prefix.length).includes(sep));
    rmSync(absolute, { recursive: true, force: true });
  });
  const profile = join(root, 'private profile');
  return { root, profile, file: join(profile, 'qqbot-image-generation.json') };
}

test('image settings import has no I/O; exact frozen defaults and public template agree', async () => {
  assert.deepEqual(IMAGE_GENERATION_DEFAULTS, DEFAULTS);
  assert.equal(Object.isFrozen(IMAGE_GENERATION_DEFAULTS), true);
  assert.deepEqual(JSON.parse(readFileSync(new URL('../examples/profile/qqbot-image-generation.json', import.meta.url), 'utf8')), DEFAULTS);
  const source = readFileSync(new URL('../bot-config-panel/image-generation.mjs', import.meta.url), 'utf8');
  const names = ['lstatSync', 'openSync', 'readSync', 'mkdirSync', 'writeFileSync'];
  const originals = Object.fromEntries(names.map((name) => [name, fs[name]]));
  const originalFetch = globalThis.fetch;
  try {
    for (const name of names) fs[name] = () => { throw new Error('Unexpected import-time I/O'); };
    globalThis.fetch = () => { throw new Error('Image settings must never request a remote endpoint'); };
    syncBuiltinESMExports();
    const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    assert.deepEqual(module.IMAGE_GENERATION_DEFAULTS, DEFAULTS);
  } finally {
    for (const name of names) fs[name] = originals[name];
    globalThis.fetch = originalFetch;
    syncBuiltinESMExports();
  }
});

test('image settings missing-file reads return fresh disabled defaults without creating directories', (t) => {
  const { profile, file } = fixture(t);
  const first = readImageGenerationSettings(profile);
  assert.deepEqual(first, DEFAULTS);
  first.enabled = true;
  assert.deepEqual(readImageGenerationSettings(profile), DEFAULTS);
  assert.equal(fs.existsSync(profile), false);
  mkdirSync(profile);
  assert.deepEqual(readImageGenerationSettings(profile), DEFAULTS);
  assert.equal(fs.existsSync(file), false);
});

test('image settings validate every allowed model/size/quality and integer boundary without coercion', () => {
  for (const model of MODELS)
    for (const size of ['1024x1024', '1536x1024', '1024x1536'])
      for (const quality of ['low', 'medium', 'high']) {
        const value = settings({ enabled: true, model, size, quality });
        assert.deepEqual(validateImageGenerationSettings(value), value);
      }
  for (const [field, min, max] of [['cooldownSeconds', 60, 3600], ['maxPerHour', 1, 10], ['timeoutSeconds', 30, 300]]) {
    for (const value of [min, max]) assert.equal(validateImageGenerationSettings(settings({ [field]: value }))[field], value);
    for (const value of [min - 1, max + 1, min + 0.5, String(min), null, true, NaN, Infinity])
      assert.throws(() => validateImageGenerationSettings(settings({ [field]: value })), { code: 'ERR_IMAGE_GENERATION_INVALID' });
  }
  const bare = Object.assign(Object.create(null), DEFAULTS);
  assert.deepEqual(validateImageGenerationSettings(bare), DEFAULTS);
});

test('image settings reject partial/unknown fields, retired models, arbitrary URLs, symbols and accessors', () => {
  const partial = settings(); delete partial.quality;
  const inherited = Object.create(DEFAULTS);
  const symbol = settings(); symbol[Symbol('extra')] = 'synthetic-sensitive-input';
  const accessor = settings();
  Object.defineProperty(accessor, 'model', { get() { throw new Error('Must not execute getter'); }, enumerable: true });
  for (const value of [null, [], 'synthetic-sensitive-input', partial, inherited, symbol, accessor,
    settings({ extra: 'synthetic-sensitive-input' }), settings({ endpoint: 'https://synthetic-sensitive-input.invalid' }),
    ...['gpt-image-1', 'dall-e-2', 'dall-e-3', 'auto', '', 'synthetic-sensitive-input'].map((model) => settings({ model })),
    settings({ size: 'auto' }), settings({ quality: 'auto' }), settings({ enabled: 'false' }), settings({ enabled: 1 }),
  ]) {
    assert.throws(() => validateImageGenerationSettings(value), (error) => {
      assert.equal(error.code, 'ERR_IMAGE_GENERATION_INVALID');
      assert.equal(error.message.includes('synthetic-sensitive-input'), false);
      return true;
    });
  }
});

test('image settings atomic private writes round-trip, replace inode, keep 600 and do not use credentials', (t) => {
  const { profile, file } = fixture(t);
  const value = settings({ enabled: true, model: 'gpt-image-2.5-flare', size: '1536x1024', quality: 'medium' });
  const result = writeImageGenerationSettings(profile, value);
  assert.deepEqual(result, value);
  assert.notEqual(result, value);
  assert.equal(lstatSync(profile).mode & 0o777, 0o700);
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  const before = lstatSync(file).ino;
  chmodSync(file, 0o644);
  writeImageGenerationSettings(profile, DEFAULTS);
  assert.notEqual(lstatSync(file).ino, before);
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readImageGenerationSettings(profile), DEFAULTS);
  assert.deepEqual(readdirSync(profile), ['qqbot-image-generation.json']);
});

test('image settings invalid writes have no side effects; rename failure preserves original and removes temp', (t) => {
  const { profile, file } = fixture(t);
  assert.throws(() => writeImageGenerationSettings(profile, { enabled: true }));
  assert.equal(fs.existsSync(profile), false);
  writeImageGenerationSettings(profile, DEFAULTS);
  const original = readFileSync(file, 'utf8');
  const rename = fs.renameSync;
  try {
    fs.renameSync = () => { throw new Error('synthetic-sensitive-file-content'); };
    syncBuiltinESMExports();
    assert.throws(() => writeImageGenerationSettings(profile, settings({ enabled: true })), (error) => {
      assert.equal(error.message.includes('synthetic-sensitive-file-content'), false);
      assert.equal(error.code, 'ERR_IMAGE_GENERATION_WRITE');
      return true;
    });
  } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.deepEqual(readdirSync(profile), ['qqbot-image-generation.json']);
});

test('image settings bounded reads reject malformed/oversized files without echo; exact 16KiB valid file reads', (t) => {
  const { profile, file } = fixture(t);
  mkdirSync(profile);
  for (const content of ['{"synthetic-sensitive-file-content":', 'null', '[]', JSON.stringify(settings({ model: 'synthetic-sensitive-file-content' }))]) {
    writeFileSync(file, content);
    assert.throws(() => readImageGenerationSettings(profile), (error) => !error.message.includes('synthetic-sensitive-file-content'));
  }
  const valid = JSON.stringify(DEFAULTS);
  writeFileSync(file, valid.padEnd(16 * 1024, ' '));
  assert.deepEqual(readImageGenerationSettings(profile), DEFAULTS);
  writeFileSync(file, valid.padEnd(16 * 1024 + 1, ' '));
  for (const action of [() => readImageGenerationSettings(profile), () => writeImageGenerationSettings(profile, DEFAULTS)])
    assert.throws(action, { code: 'ERR_IMAGE_GENERATION_TOO_LARGE' });
  assert.equal(lstatSync(file).size, 16 * 1024 + 1);
});

test('image settings reject linked ancestors, dangling links, target links/hardlinks and directories', (t) => {
  const { root, profile, file } = fixture(t);
  mkdirSync(profile);
  const target = join(root, 'synthetic-target.json');
  writeFileSync(target, JSON.stringify(settings({ enabled: true })));
  const original = readFileSync(target, 'utf8');
  const check = () => {
    for (const action of [() => readImageGenerationSettings(profile), () => writeImageGenerationSettings(profile, DEFAULTS)])
      assert.throws(action, { code: 'ERR_IMAGE_GENERATION_UNSAFE' });
    assert.equal(readFileSync(target, 'utf8'), original);
  };
  // Every removal below is the exact path created in this isolated fixture.
  symlinkSync(target, file); check(); rmSync(file);
  symlinkSync(join(root, 'absent'), file); check(); rmSync(file);
  linkSync(target, file); check(); rmSync(file);
  mkdirSync(file); check(); rmSync(file, { recursive: true });
  const alias = join(root, 'linked-ancestor');
  symlinkSync(profile, alias);
  for (const path of [alias, join(alias, 'missing', 'nested')])
    for (const action of [() => readImageGenerationSettings(path), () => writeImageGenerationSettings(path, DEFAULTS)])
      assert.throws(action, { code: 'ERR_IMAGE_GENERATION_UNSAFE' });
  const dangling = join(root, 'dangling-ancestor');
  symlinkSync(join(root, 'missing-parent'), dangling);
  assert.throws(() => readImageGenerationSettings(join(dangling, 'nested')), { code: 'ERR_IMAGE_GENERATION_UNSAFE' });
  assert.throws(() => writeImageGenerationSettings(join(dangling, 'nested'), DEFAULTS), { code: 'ERR_IMAGE_GENERATION_UNSAFE' });
});

test('image settings UI isolated block loads/saves settings only, validates limits and confirms paid opt-in', async () => {
  const html = readFileSync(new URL('../bot-config-panel/public/index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  new vm.Script(script);
  const start = script.indexOf('// ── 生图设置：');
  const end = script.indexOf('// ── 生图设置结束 ──', start);
  assert.ok(start > script.indexOf('// ─────────────────────────── 人格') && end > start);
  const controls = new Map();
  const element = (id) => {
    if (!controls.has(id)) controls.set(id, { value: '', checked: false, disabled: false, textContent: '', className: '' });
    return controls.get(id);
  };
  const calls = [];
  let saved = settings();
  let fail = false;
  let accepted = false;
  let confirmations = 0;
  const sandbox = {
    $: element, confirm: () => { confirmations++; return accepted; },
    api: async (path, options) => {
      calls.push({ path, options });
      if (fail) throw new Error('synthetic-sensitive-error-must-not-echo');
      if (options.method === 'PUT') saved = JSON.parse(options.body);
      return { ok: true, settings: { ...saved } };
    },
  };
  vm.runInNewContext(`${script.slice(start, end)}\nglobalThis.ui = {loadImageGenerationSettings, saveImageGenerationSettings};`, sandbox);
  assert.equal(element('btnSaveImageGeneration').disabled, true);
  assert.equal(calls.length, 0, 'rendering must not make remote or paid calls');
  await sandbox.ui.loadImageGenerationSettings();
  assert.equal(calls[0].path, '/api/image-generation');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(element('imageEnabled').checked, false);
  element('imageEnabled').checked = true;
  element('imageEnabled').onchange();
  await sandbox.ui.saveImageGenerationSettings({ preventDefault() {} });
  assert.equal(confirmations, 1);
  assert.equal(calls.length, 1, 'cancelled opt-in must not save or generate');
  accepted = true;
  await sandbox.ui.saveImageGenerationSettings({ preventDefault() {} });
  assert.equal(calls.at(-1).options.method, 'PUT');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), settings({ enabled: true }));
  assert.equal(element('btnSaveImageGeneration').disabled, true);
  element('imageCooldown').value = '59'; element('imageCooldown').oninput();
  const before = calls.length;
  await sandbox.ui.saveImageGenerationSettings({ preventDefault() {} });
  assert.equal(calls.length, before, 'invalid cooldown must not be submitted');
  element('imageCooldown').value = '120'; element('imageCooldown').oninput();
  fail = true;
  await sandbox.ui.saveImageGenerationSettings({ preventDefault() {} });
  assert.equal(element('btnSaveImageGeneration').disabled, true, 'uncertain save requires reread');
  for (const el of controls.values()) assert.equal(el.textContent.includes('synthetic-sensitive'), false);
  assert.ok(calls.every(({ path }) => path === '/api/image-generation'));
  for (const model of MODELS) assert.ok(html.includes(`<option value="${model}">`));
  for (const warning of ['可能按 OpenAI 官方规则计费', '本轮新 prompt', '不附带群历史', '不自动重试', '每次单张', '新填或更换 OpenAI Key 仍需重启', '不经过自定义聊天网关']) assert.ok(html.includes(warning), warning);
});

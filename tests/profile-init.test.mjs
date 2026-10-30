import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, readdirSync,
  lstatSync, existsSync, symlinkSync, readlinkSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, '');
const INIT = join(ROOT, 'scripts', 'init-profile.mjs');
const SOURCE = join(ROOT, 'examples', 'profile');
const names = readdirSync(SOURCE).filter((name) => name === 'dsh-bot.patch.yml' || /^qqbot-.*\.json$/.test(name)).sort();

function fixture(run) {
  const prefix = join(realpathSync(tmpdir()), 'dsh-profile-init-');
  const root = mkdtempSync(prefix);
  try {
    const home = join(root, '隔离 HOME 空格');
    mkdirSync(home, { mode: 0o700 });
    const dshHome = join(home, '独立 DSH 配置');
    const profileName = 'synthetic_profile_42';
    const profile = join(dshHome, 'profiles', profileName);
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, USERPROFILE: home, NODE_OPTIONS: '',
      DSH_HOME: dshHome, QQBOT_PROFILE_NAME: profileName,
    };
    const init = (args = [], overrides = {}) => spawnSync(process.execPath, [INIT, ...args], {
      cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000,
    });
    return run({ root, home, dshHome, profileName, profile, env, init });
  } finally {
    const target = realpathSync(root);
    assert.equal(target, root);
    assert.ok(target.startsWith(prefix) && target.slice(prefix.length) && !target.slice(prefix.length).includes(sep));
    rmSync(target, { recursive: true, force: true });
  }
}
function snapshot(file) {
  const stat = lstatSync(file);
  return { content: readFileSync(file, 'utf8'), ino: stat.ino, mode: stat.mode, mtimeMs: stat.mtimeMs, size: stat.size };
}
function assertSuccess(result) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.signal, null);
}
function assertRejected(result) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Initialization stopped:/);
}

test('init real CLI defaults to dry-run and does not create profile, workspace or secrets', () => fixture(({ root, home, dshHome, profile, profileName, init }) => {
  const before = readdirSync(root);
  const result = init();
  assertSuccess(result);
  assert.match(result.stdout, /Dry-run only/);
  assert.ok(result.stdout.includes(`Profile: ${profileName}`));
  assert.ok(result.stdout.includes(profile));
  assert.ok(names.length > 0);
  for (const name of names) assert.ok(result.stdout.includes(`+ create ${name}`));
  assert.equal(existsSync(profile), false);
  assert.equal(existsSync(dshHome), false);
  assert.deepEqual(readdirSync(root), before);
  assert.deepEqual(readdirSync(home), []);
}));

test('init --apply seeds only public templates in a 700 private Chinese/spaced path', () => fixture(({ profile, init }) => {
  assert.ok(profile.includes(' ') && /[\u4e00-\u9fff]/u.test(profile));
  const result = init(['--apply']);
  assertSuccess(result);
  assert.match(result.stdout, /No credentials copied; no bot started/);
  assert.equal(lstatSync(profile).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(profile, 'workspace')).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(profile).sort(), [...names, 'workspace'].sort());
  for (const name of names) {
    const target = join(profile, name);
    assert.equal(lstatSync(target).mode & 0o777, 0o600);
    assert.deepEqual(readFileSync(target), readFileSync(join(SOURCE, name)));
    if (name.endsWith('.json')) assert.doesNotThrow(() => JSON.parse(readFileSync(target, 'utf8')));
  }
  assert.equal(existsSync(join(profile, '.bot-secrets.json')), false);
  assert.equal(existsSync(join(profile, 'package.json')), false, 'init must not install DSH bundles or spawn npm');
  assert.deepEqual(readdirSync(join(profile, 'workspace')), []);
}));

test('init preserves every existing file byte-for-byte, mode, inode and mtime; repeated apply is idempotent', () => fixture(({ profile, init }) => {
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const originals = {
    'dsh-bot.patch.yml': '# synthetic custom overlay must stay\n',
    'cordis.patch.yml': '# synthetic existing DSH config must stay\n',
    'qqbot-groups.json': '{"custom":"synthetic-private-existing"}\n',
    '.bot-secrets.json': '{"OPENAI_API_KEY":"synthetic-never-read-or-copy"}\n',
    'package.json': '{"dependencies":{"synthetic-local-plugin":"1.0.0"}}\n',
    '.control-token': 'synthetic-local-token',
  };
  const before = {};
  for (const [name, content] of Object.entries(originals)) {
    writeFileSync(join(profile, name), content, { mode: 0o600 });
    before[name] = snapshot(join(profile, name));
  }
  const dry = init();
  assertSuccess(dry);
  for (const [name, state] of Object.entries(before)) assert.deepEqual(snapshot(join(profile, name)), state);
  assert.equal(existsSync(join(profile, 'workspace')), false);
  assert.deepEqual(readdirSync(profile).sort(), Object.keys(originals).sort());
  const applied = init(['--apply']);
  assertSuccess(applied);
  for (const [name, state] of Object.entries(before)) assert.deepEqual(snapshot(join(profile, name)), state);
  for (const name of names) if (!Object.hasOwn(originals, name)) assert.deepEqual(readFileSync(join(profile, name)), readFileSync(join(SOURCE, name)));
  const allBefore = Object.fromEntries(readdirSync(profile).filter((name) => lstatSync(join(profile, name)).isFile()).map((name) => [name, snapshot(join(profile, name))]));
  const repeated = init(['--apply']);
  assertSuccess(repeated);
  assert.match(repeated.stdout, /Created 0 templates/);
  for (const [name, state] of Object.entries(allBefore)) assert.deepEqual(snapshot(join(profile, name)), state);
  for (const result of [dry, applied, repeated]) assert.equal(`${result.stdout}${result.stderr}`.includes('synthetic-never-read-or-copy'), false);
}));

test('init honors explicit profile/workspace overrides without touching DSH_HOME default location', () => fixture(({ root, dshHome, profile, init }) => {
  const explicit = join(root, '指定 profile 中文 空格');
  const workdir = join(root, '指定 workspace 中文 空格');
  const result = init(['--apply'], { QQBOT_PROFILE_DIR: explicit, QQBOT_WORKDIR: workdir });
  assertSuccess(result);
  assert.ok(result.stdout.includes(explicit));
  assert.equal(existsSync(profile), false);
  assert.equal(existsSync(dshHome), false);
  assert.deepEqual(readdirSync(explicit).sort(), names);
  assert.deepEqual(readdirSync(workdir), []);
  assert.equal(lstatSync(explicit).mode & 0o777, 0o700);
  assert.equal(lstatSync(workdir).mode & 0o777, 0o700);
}));

test('init rejects private profiles/workspaces in repository, invalid profile names and unknown arguments', () => fixture(({ profile, init }) => {
  // Dry-run checks avoid any chance of modifying the real source tree if this regression occurs.
  assertRejected(init([], { QQBOT_PROFILE_DIR: ROOT }));
  assertRejected(init([], { QQBOT_PROFILE_DIR: join(ROOT, 'synthetic-forbidden-profile') }));
  assertRejected(init([], { QQBOT_WORKDIR: ROOT }));
  assertRejected(init([], { QQBOT_PROFILE_NAME: '../escape' }));
  assertRejected(init([], { QQBOT_PROFILE_NAME: 'spaces are invalid' }));
  assertRejected(init(['--unexpected']));
  assert.equal(existsSync(profile), false);
  const help = init(['--help']);
  assertSuccess(help);
  assert.match(help.stdout, /Dry-run by default/);
  assert.equal(existsSync(profile), false);
}));

test('init rejects symlink profile, ancestor and template destinations without modifying targets', () => fixture(({ root, profile, init }) => {
  const real = join(root, 'real-private-directory');
  mkdirSync(real, { mode: 0o700 });
  const alias = join(root, 'linked-profile');
  symlinkSync(real, alias);
  for (const args of [[], ['--apply']]) {
    assertRejected(init(args, { QQBOT_PROFILE_DIR: alias }));
    assertRejected(init(args, { QQBOT_PROFILE_DIR: join(alias, 'nested-profile') }));
  }
  assert.deepEqual(readdirSync(real), []);
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const sourceTarget = join(real, 'keep-original.json');
  writeFileSync(sourceTarget, '{"synthetic":"keep-original"}', { mode: 0o600 });
  const destination = join(profile, names.find((name) => name.endsWith('.json')));
  symlinkSync(sourceTarget, destination);
  const original = snapshot(sourceTarget);
  assertRejected(init(['--apply']));
  assert.deepEqual(snapshot(sourceTarget), original);
  assert.equal(readlinkSync(destination), sourceTarget);
  assert.deepEqual(readdirSync(profile), [destination.slice(profile.length + 1)]);
}));

test('init rejects dangling symlink template before creating any partial templates or workspace', () => fixture(({ root, profile, init }) => {
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const missingTarget = join(root, 'must-remain-missing');
  const name = names.at(-1);
  const destination = join(profile, name);
  symlinkSync(missingTarget, destination);
  assertRejected(init());
  assertRejected(init(['--apply']));
  assert.equal(readlinkSync(destination), missingTarget);
  assert.equal(existsSync(missingTarget), false);
  assert.deepEqual(readdirSync(profile), [name]);
}));

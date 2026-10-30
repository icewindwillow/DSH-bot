import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, existsSync, statSync, symlinkSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const block = (name, body) => `/* >>> dsh-qqbot-patch:${name} >>> */\n${body}\n/* <<< dsh-qqbot-patch:${name} <<< */\n`;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-deploy-test-'));
  t.after(() => { assert.ok(dir.startsWith(join(tmpdir(), 'qqbot-deploy-test-'))); rmSync(dir, { recursive: true, force: true }); });
  const profile = join(dir, 'profile');
  const dist = join(profile, 'node_modules/@tencent-connect/dsh-qqbot/dist');
  const snippets = join(dir, 'qqbot-patches');
  mkdirSync(snippets, { recursive: true }); mkdirSync(dist, { recursive: true });
  const script = join(dir, 'patch-qqbot.mjs');
  writeFileSync(script, readFileSync(join(root, 'patch-qqbot.mjs')));
  const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); return file; };
  const mw = put(join(dist, 'gateway/middleware-setup.js'), 'function setup() {\n    bot.use(errorHandler());\n}\n');
  const session = put(join(dist, 'session/session-manager.js'), 'export const original = 1;\n');
  put(join(snippets, 'error-log.js'), block('error-log', '    bot.use(errorHandler({ patched: true }));'));
  put(join(snippets, 'group-prompt-helper.js'), block('group-prompt-helper', 'export function readGroupPromptOverride() { return 1; }'));
  put(join(snippets, 'model-aware-search-inject.js'), block('model-aware-search-inject', "export const inject = ['agents', 'web'];"));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, QQBOT_PROFILE_DIR: profile }, encoding: 'utf8', timeout: 15000,
  });
  return { dir, profile, dist, snippets, script, mw, session, put, run };
}
function snapshot(dir, prefix = '') {
  const out = {};
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name), rel = prefix + name;
    if (statSync(file).isDirectory()) Object.assign(out, snapshot(file, rel + '/'));
    else out[rel] = readFileSync(file).toString('base64');
  }
  return out;
}
function ok(result) { assert.equal(result.status, 0, result.stderr + result.stdout); }
function bad(result, pattern) {
  assert.notEqual(result.status, 0, result.stdout);
  if (pattern) assert.match(result.stderr, pattern);
}
const both = '--only=error-log,group-prompt-helper';
function manifests(f) {
  const base = join(f.profile, '.qqbot-patch-backups');
  return readdirSync(base).filter((id) => existsSync(join(base, id, 'manifest.json'))).sort().map((id) => ({
    dir: join(base, id), doc: JSON.parse(readFileSync(join(base, id, 'manifest.json'), 'utf8')),
  }));
}

test('preflight aggregates failures and never writes any target, backup, or user data', async (t) => {
  for (const type of ['missing-target', 'missing-snippet', 'missing-anchor', 'duplicate-anchor', 'broken-marker', 'reversed-marker', 'duplicate-marker', 'unknown-only', 'syntax']) {
    await t.test(type, (t) => {
      const f = fixture(t);
      let args = [both];
      if (type === 'missing-target') args = ['--only=error-log,model-aware-search-inject'];
      if (type === 'missing-snippet') rmSync(join(f.snippets, 'group-prompt-helper.js'));
      if (type === 'missing-anchor') f.put(f.mw, 'export const noAnchor = 1;\n');
      if (type === 'duplicate-anchor') f.put(f.mw, 'function setup(){\n    bot.use(errorHandler());\n    bot.use(errorHandler());\n}\n');
      if (type === 'broken-marker') f.put(f.session, '/* >>> dsh-qqbot-patch:group-prompt-helper >>> */\n');
      if (type === 'reversed-marker') f.put(f.session, '/* <<< dsh-qqbot-patch:group-prompt-helper <<< */\n/* >>> dsh-qqbot-patch:group-prompt-helper >>> */\n');
      if (type === 'duplicate-marker') f.put(f.session, block('group-prompt-helper', '') + block('group-prompt-helper', ''));
      if (type === 'unknown-only') args = ['--only=error-log,not-registered'];
      if (type === 'syntax') f.put(join(f.snippets, 'group-prompt-helper.js'), block('group-prompt-helper', 'export function broken( {'));
      const before = snapshot(f.profile);
      bad(f.run(...args)); assert.deepEqual(snapshot(f.profile), before);
    });
  }
});

test('apply backs up exact bytes, real paths and hashes; repeat apply is byte-idempotent; revert restores originals', (t) => {
  const f = fixture(t);
  const originals = snapshot(f.profile);
  ok(f.run(both));
  const [{ dir, doc }] = manifests(f);
  assert.equal(doc.files.length, 2);
  for (const entry of doc.files) {
    assert.equal(entry.file, realpathSync(entry.file));
    assert.equal(digest(readFileSync(join(dir, entry.backup))), entry.before);
    assert.equal(digest(readFileSync(entry.file)), entry.after);
  }
  const after = snapshot(f.profile);
  ok(f.run(both)); assert.deepEqual(snapshot(f.profile), after);
  ok(f.run('--check', both)); assert.deepEqual(snapshot(f.profile), after);
  ok(f.run('--revert'));
  for (const [rel, bytes] of Object.entries(originals)) assert.equal(readFileSync(join(f.profile, rel)).toString('base64'), bytes);
  assert.equal(existsSync(join(f.profile, 'skills')), false);
  assert.equal(existsSync(join(f.profile, 'qqbot-groups.json')), false);
  assert.equal(existsSync(join(f.profile, 'qqbot-people.json')), false);
});

test('--check detects missing/outdated/partial snippets and is always read-only', (t) => {
  const f = fixture(t);
  const before = snapshot(f.profile); bad(f.run('--check', both)); assert.deepEqual(snapshot(f.profile), before);
  ok(f.run(both));
  f.put(f.mw, readFileSync(f.mw, 'utf8').replace('patched: true', 'patched: false'));
  const edited = snapshot(f.profile); bad(f.run('--check', both)); assert.deepEqual(snapshot(f.profile), edited);
});

test('--plan preflights without deployment or creating user files', (t) => {
  const f = fixture(t), before = snapshot(f.profile);
  ok(f.run('--plan', both)); assert.deepEqual(snapshot(f.profile), before);
});

test('revert refuses later edits in any target before touching any other file', (t) => {
  const f = fixture(t); ok(f.run(both));
  f.put(f.session, readFileSync(f.session, 'utf8') + '\n// later local edit\n');
  const edited = snapshot(f.profile); bad(f.run('--revert'), /local edits|changed|overwrite/i);
  assert.deepEqual(snapshot(f.profile), edited);
});

test('revert rejects corrupted backup bytes and never uses marker deletion as fallback', (t) => {
  const f = fixture(t); ok(f.run(both));
  const [{ dir, doc }] = manifests(f); f.put(join(dir, doc.files[0].backup), 'corrupt original');
  const before = snapshot(f.profile); bad(f.run('--revert')); assert.deepEqual(snapshot(f.profile), before);
  const legacy = fixture(t); legacy.put(legacy.mw, block('error-log', 'const legacy = 1;'));
  const old = snapshot(legacy.profile); bad(legacy.run('--revert')); assert.deepEqual(snapshot(legacy.profile), old);
});

test('--only is exact, requires no package.json and cannot partially revert a transaction', (t) => {
  const f = fixture(t); ok(f.run('--only=error-log'));
  assert.equal(readFileSync(f.session, 'utf8'), 'export const original = 1;\n');
  assert.equal(manifests(f)[0].doc.files.length, 1);
  const before = snapshot(f.profile); bad(f.run('--revert', '--only=error-log')); assert.deepEqual(snapshot(f.profile), before);
});

test('symlink package targets are backed up/restored at real paths without replacing symlinks', (t) => {
  const f = fixture(t), original = readFileSync(f.mw), actual = join(f.dir, 'actual.mjs');
  f.put(actual, original); rmSync(f.mw); symlinkSync(actual, f.mw);
  ok(f.run('--only=error-log')); assert.equal(manifests(f)[0].doc.files[0].file, realpathSync(actual));
  ok(f.run('--revert')); assert.deepEqual(readFileSync(actual), original); assert.equal(realpathSync(f.mw), realpathSync(actual));
});

test('mid-commit rename failure restores previously committed targets', (t) => {
  const f = fixture(t), before = { mw: readFileSync(f.mw), session: readFileSync(f.session) };
  const loader = f.put(join(f.dir, 'fault.mjs'), `import fs from 'node:fs';\nimport { syncBuiltinESMExports } from 'node:module';\nconst rename = fs.renameSync; let failed = false;\nfs.renameSync = function(a,b) { if (!failed && b === ${JSON.stringify(realpathSync(f.session))}) { failed = true; throw new Error('synthetic commit failure'); } return rename(a,b); };\nsyncBuiltinESMExports();\n`);
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(loader).href, f.script, both], {
    env: { ...process.env, QQBOT_PROFILE_DIR: f.profile }, encoding: 'utf8', timeout: 15000,
  });
  bad(result, /synthetic commit failure/);
  assert.deepEqual(readFileSync(f.mw), before.mw); assert.deepEqual(readFileSync(f.session), before.session);
  assert.equal(existsSync(join(f.profile, '.qqbot-patch.lock')), false);
});

test('unselected damaged markers also prevent all writes', (t) => {
  const f = fixture(t);
  f.put(f.mw, readFileSync(f.mw, 'utf8') + '/* >>> dsh-qqbot-patch:unselected >>> */\n');
  const before = snapshot(f.profile);
  bad(f.run('--only=error-log'), /marker/); assert.deepEqual(snapshot(f.profile), before);
});

test('latest valid backup skips malformed manifests; repeated transaction reverts walk exact originals', (t) => {
  const f = fixture(t), original = readFileSync(f.mw);
  ok(f.run('--only=error-log')); const first = readFileSync(f.mw);
  f.put(join(f.snippets, 'error-log.js'), block('error-log', '    bot.use(errorHandler({ patched: 2 }));'));
  ok(f.run('--only=error-log'));
  f.put(join(f.profile, '.qqbot-patch-backups/zzzz-incomplete/manifest.json'), '{bad JSON');
  ok(f.run('--revert')); assert.deepEqual(readFileSync(f.mw), first);
  ok(f.run('--revert')); assert.deepEqual(readFileSync(f.mw), original);
});

test('prepared backups still require exact after hash and cannot overwrite before-state files', (t) => {
  const f = fixture(t), original = readFileSync(f.mw);
  ok(f.run('--only=error-log'));
  const [{ dir, doc }] = manifests(f); doc.status = 'prepared';
  f.put(join(dir, 'manifest.json'), JSON.stringify(doc)); f.put(f.mw, original);
  const before = snapshot(f.profile); bad(f.run('--revert'), /overwrite|local edits/);
  assert.deepEqual(snapshot(f.profile), before);
});

test('nested dependent patches remain stable when parent and child are checked or reapplied', (t) => {
  const f = fixture(t);
  // Exercise the published parent snippet, so stale reply-gate anchors cannot hide in fixtures.
  f.put(join(f.snippets, 'group-mention.js'), readFileSync(join(root, 'qqbot-patches/group-mention.js')));
  f.put(join(f.snippets, 'reply-gate.js'), block('reply-gate', '    bot.use(newGate());'));
  f.put(f.mw, 'function setup(){\n    // 5. 群聊 @bot 门控\n    bot.use(mentionGate({\n        requireMentionInGroup: config.requireMention,\n    }));\n}\n');
  const only = '--only=group-mention,reply-gate';
  ok(f.run(only)); const after = snapshot(f.profile);
  ok(f.run('--check', only)); ok(f.run(only)); assert.deepEqual(snapshot(f.profile), after);
  ok(f.run('--only=group-mention')); assert.deepEqual(snapshot(f.profile), after);
});

test('published interaction/person-card/events/vector chain deploys in dependency order, not --only argument order', (t) => {
  const f = fixture(t);
  const bootstrap = f.put(join(f.dist, 'gateway/bootstrap.js'), 'function setup(){\n    setupDiary(ctx, logger);\n}\n');
  const original = readFileSync(bootstrap);
  for (const name of ['interaction', 'person-card', 'events', 'vector']) {
    f.put(join(f.snippets, name + '.js'), readFileSync(join(root, 'qqbot-patches', name + '.js')));
  }
  const only = '--only=vector,events,person-card,interaction';
  ok(f.run('--plan', only)); assert.deepEqual(readFileSync(bootstrap), original);
  ok(f.run(only)); const deployed = snapshot(f.profile);
  ok(f.run('--check', only)); ok(f.run(only)); assert.deepEqual(snapshot(f.profile), deployed);
  ok(f.run('--revert')); assert.deepEqual(readFileSync(bootstrap), original);
});

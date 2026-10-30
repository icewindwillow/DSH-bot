#!/usr/bin/env node
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ROOT } from './config.mjs';
const prefix = join(realpathSync(tmpdir()), 'dsh-bot-unit-');
const home = mkdtempSync(prefix);
try {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^DSH_|^QQBOT_|^OUR_FREE_/i.test(key)) delete env[key];
  Object.assign(env, { HOME: home, USERPROFILE: home, DSH_HOME: join(home, '.dsh'),
    QQBOT_PROFILE_DIR: join(home, '.dsh', 'profiles', 'qqbot'), QQBOT_PROFILE_NAME: 'qqbot',
    QQBOT_DIARY: 'off', QQBOT_DIARY_PUBLISH: 'off', QQBOT_VECTOR: 'off', QQBOT_CONTROL_PORT: '0' });
  const files = readdirSync(join(ROOT, 'tests')).filter(n => n.endsWith('.test.mjs')).sort().map(n => join(ROOT, 'tests', n));
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(join(ROOT, 'scripts', 'offline-guard.mjs')).href, '--test', ...files], {
    env, cwd: ROOT, stdio: 'inherit',
  });
  if (result.error) throw new Error('Unit test process failed to start');
  process.exitCode = result.status ?? 1;
} finally {
  // Resolve and verify the exact directory this process created before deleting.
  const target = realpathSync(home);
  if (target === home && target.startsWith(prefix) && target.slice(prefix.length) && !target.slice(prefix.length).includes(sep))
    rmSync(target, { recursive: true });
}

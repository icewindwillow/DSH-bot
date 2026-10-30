#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, normalizedEnvironment } from './config.mjs';
try {
  const result = spawnSync(process.execPath, [join(ROOT, 'patch-qqbot.mjs'), ...process.argv.slice(2)], {
    cwd: ROOT, env: normalizedEnvironment(), stdio: 'inherit',
  });
  if (result.error) throw new Error('Unable to run patch CLI');
  process.exitCode = result.status ?? 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }

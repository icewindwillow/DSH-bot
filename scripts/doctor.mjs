#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { credentialStatus } from '../bot-config-panel/credentials.mjs';
import { settings, commandForDsh, normalizedEnvironment, assertNoSymlinks } from './config.mjs';

let failures = 0;
const report = (ok, text) => { console.log(`${ok ? '✓' : '!'} ${text}`); if (!ok) failures++; };
try {
  const s = settings();
  assertNoSymlinks(s.profileDir);
  console.log(`Node ${process.version} | ${process.platform}/${process.arch}\nProfile ${s.profileName}\nPrivate profile: ${s.profileDir}`);
  report(Number(process.versions.node.split('.')[0]) >= 24, 'Node.js 24+ (node:sqlite required)');
  const { command, prefix } = commandForDsh();
  const result = spawnSync(command, [...prefix, '--version'], { env: normalizedEnvironment(), encoding: 'utf8', timeout: 15000 });
  report(!result.error && result.status === 0, `DSH command ${result.status === 0 ? 'available' : 'missing; set QQBOT_DSH_BIN or install dsh'}`);
  // Version output can originate from arbitrary executables: do not print raw stdout/stderr.
  const version = /\b\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?\b/.exec(result.stdout ?? '')?.[0];
  if (version) console.log(`  Observed DSH version: ${version}; documented baseline: 0.2.1-rc.3`);
  for (const [pkg, baseline] of [['@tencent-connect/dsh-qqbot', '0.5.2'], ['@tr1v3r/dsh-ltm', '0.3.4']]) {
    const path = join(s.profileDir, 'node_modules', ...pkg.split('/'), 'package.json');
    let installed;
    try { installed = JSON.parse(readFileSync(path, 'utf8')).version; } catch { /* missing */ }
    report(installed === baseline, `${pkg}: ${installed || 'not installed'} (baseline ${baseline})`);
  }
  report(existsSync(s.overlay), 'dsh-bot.patch.yml overlay initialized');
  report(existsSync(join(s.profileDir, 'qqbot-command-owners.json')), 'Command owner allowlist initialized (empty means no slash-command access)');
  const { keys } = credentialStatus(s.profileDir);
  for (const [name, state] of Object.entries(keys)) console.log(`  ${name}: ${state.configured ? 'configured' : 'missing'} (${state.source})`);
  console.log('\nOptional: Our Free Model must be installed from its official release, not a similarly named npm package.');
  console.log('Optional keys may be missing when their features are not enabled. No credential values are displayed, no memory contents are read, and no external API is called.');
  console.log('Next: npm run patch:plan (may reveal version/anchor incompatibilities without modifying the profile).');
} catch { report(false, 'Doctor stopped: check profile paths, file permissions and private configuration format. No secret values are displayed.'); }
process.exitCode = failures ? 1 : 0;

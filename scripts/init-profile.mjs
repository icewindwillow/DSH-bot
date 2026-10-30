#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, settings, assertNoSymlinks } from './config.mjs';

try {
  const args = process.argv.slice(2);
  if (args.some(a => !['--apply', '--help'].includes(a))) throw new Error('Supported arguments: --apply, --help');
  if (args.includes('--help')) {
    console.log('npm run init [-- --apply]\nDry-run by default. Seeds only missing public templates; never overwrites existing files.');
  } else {
    const { profileDir, profileName, workdir } = settings();
    assertNoSymlinks(profileDir);
    const source = join(ROOT, 'examples', 'profile');
    const names = readdirSync(source).filter(n => n === 'dsh-bot.patch.yml' || /^qqbot-.*\.json$/.test(n)).sort();
    const missing = names.filter(n => !existsSync(join(profileDir, n)));
    for (const n of names) {
      const target = join(profileDir, n);
      let entry;
      try { entry = lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (entry && (!entry.isFile() || entry.isSymbolicLink()))
        throw new Error(`Refusing a non-regular existing destination: ${n}`);
      if (n.endsWith('.json')) JSON.parse(readFileSync(join(source, n), 'utf8'));
    }
    console.log(`Profile: ${profileName}\nPrivate directory: ${profileDir}`);
    for (const n of names) console.log(`${missing.includes(n) ? '+ create' : '= keep  '} ${n}`);
    if (!args.includes('--apply')) console.log('\nDry-run only; use npm run init -- --apply to create missing templates.');
    else {
      mkdirSync(profileDir, { recursive: true, mode: 0o700 });
      assertNoSymlinks(workdir);
      mkdirSync(workdir, { recursive: true, mode: 0o700 });
      for (const n of missing) writeFileSync(join(profileDir, n), readFileSync(join(source, n)), { flag: 'wx', mode: 0o600 });
      console.log(`\nCreated ${missing.length} templates. Existing files were not changed. No credentials copied; no bot started.`);
      console.log('Next: install the documented DSH bundles, run npm run patch:plan, configure QQ and model credentials in npm run panel.');
    }
  }
} catch (error) {
  console.error(`Initialization stopped: ${error.message}`);
  process.exitCode = 1;
}

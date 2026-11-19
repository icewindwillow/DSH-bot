#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT } from './config.mjs';

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

const [directory, tag] = process.argv.slice(2);
try {
  if (!directory || process.argv.length > 4)
    throw new Error('Usage: npm run package:release -- <output-directory> [vX.Y.Z]');
  const commit = git('rev-parse', 'HEAD^{commit}');
  const { version } = JSON.parse(git('show', commit + ':package.json'));
  const lock = JSON.parse(git('show', commit + ':package-lock.json'));
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
      || lock.version !== version || lock.packages?.['']?.version !== version)
    throw new Error('package.json and package-lock.json must share a stable X.Y.Z version');
  if (tag !== undefined && tag !== 'v' + version)
    throw new Error('The release tag must equal v' + version);
  if (tag !== undefined && git('rev-parse', '--verify', 'refs/tags/' + tag + '^{commit}') !== commit)
    throw new Error('The release tag must resolve to the checked-out commit');

  const output = resolve(directory);
  const root = 'dsh-bot-' + version;
  const name = root + '.tar.gz';
  const archive = execFileSync('git', ['archive', '--format=tar.gz', '--prefix=' + root + '/', commit], { cwd: ROOT });
  const digest = createHash('sha256').update(archive).digest('hex');
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, name), archive);
  writeFileSync(join(output, name + '.sha256'), digest + '  ' + name + '\n');
  console.log('Packaged ' + commit + ' as ' + join(output, name));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

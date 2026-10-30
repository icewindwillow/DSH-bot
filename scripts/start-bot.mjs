#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadCredentialEnvironment } from '../bot-config-panel/credentials.mjs';
import { ROOT, settings, assertNoSymlinks, commandForDsh, normalizedEnvironment } from './config.mjs';

let lock;
let lockFd;
let child;
function cleanup() {
  if (lockFd !== undefined) {
    closeSync(lockFd); lockFd = undefined;
    try { unlinkSync(lock); } catch { /* already removed */ }
  }
}
try {
  if (process.argv.includes('--help')) {
    console.log('npm run bot\nStarts the configured DSH profile in the foreground, with private credentials and the dsh-bot overlay.');
  } else {
    if (process.argv.length > 2) throw new Error('No arguments supported; select the profile with QQBOT_PROFILE_NAME / QQBOT_PROFILE_DIR.');
    const s = settings();
    if (resolve(join(s.dshHome, 'profiles', s.profileName)) !== s.profileDir)
      throw new Error('QQBOT_PROFILE_DIR must equal DSH_HOME/profiles/QQBOT_PROFILE_NAME for DSH to load the intended profile.');
    assertNoSymlinks(s.profileDir);
    if (!existsSync(join(s.profileDir, 'package.json')) || !existsSync(s.overlay))
      throw new Error('Missing DSH profile or overlay. Follow the installation guide, then npm run init -- --apply.');
    let env = normalizedEnvironment(loadCredentialEnvironment(s.profileDir));
    env = { QQBOT_DIARY: 'off', QQBOT_DIARY_PUBLISH: 'off', QQBOT_VECTOR: 'off', QQBOT_MEMORY_WRITE: 'off', ...env };
    const check = spawnSync(process.execPath, [join(ROOT, 'patch-qqbot.mjs'), '--check'], { env, stdio: 'inherit' });
    if (check.error || check.status !== 0) throw new Error('Patches are missing/outdated. Stop the bot, inspect npm run patch:plan, then apply.');
    const { command, prefix } = commandForDsh(env);
    const probe = spawnSync(command, [...prefix, '--version'], { env, stdio: 'pipe', timeout: 15000 });
    if (probe.error || probe.status !== 0) throw new Error('DSH executable is unavailable. Set QQBOT_DSH_BIN or install dsh in PATH.');
    assertNoSymlinks(s.workdir);
    mkdirSync(s.workdir, { recursive: true, mode: 0o700 });
    lock = join(s.profileDir, '.dsh-bot.lock');
    try { lockFd = openSync(lock, 'wx', 0o600); }
    catch { throw new Error('A startup lock already exists. Do not start a second bot. Confirm all old processes exited before manually removing a stale lock.'); }
    writeFileSync(lockFd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n');
    const tokenPath = join(s.profileDir, '.control-token');
    if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
    const st = lstatSync(tokenPath);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 128 || (process.platform !== 'win32' && (st.mode & 0o077)))
      throw new Error('Unsafe local control-token file. Check its ownership, type and private permissions.');
    const token = readFileSync(tokenPath, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local control token; no bot was started.');
    env.QQBOT_CONTROL_TOKEN = token;
    console.log(`Starting profile ${s.profileName} in its private workspace. Ctrl+C stops this foreground instance.`);
    child = spawn(command, [...prefix, '--profile', s.profileName, '--patch', s.overlay], {
      cwd: s.workdir, env, stdio: 'inherit',
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child?.kill(signal));
    child.once('error', () => { cleanup(); console.error('DSH failed to start. Check the executable and private profile.'); process.exitCode = 1; });
    child.once('exit', (code, signal) => { cleanup(); process.exitCode = code ?? (signal ? 1 : 0); });
  }
} catch (error) {
  cleanup(); console.error(`Bot not started: ${error.message}`); process.exitCode = 1;
}

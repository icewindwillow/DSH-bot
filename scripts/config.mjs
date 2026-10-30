import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export function settings(env = process.env) {
  const profileName = env.QQBOT_PROFILE_NAME || 'qqbot';
  if (!/^[A-Za-z0-9_-]+$/.test(profileName)) throw new Error('QQBOT_PROFILE_NAME must contain only letters, numbers, _ or -');
  const dshHome = resolve(env.DSH_HOME || join(homedir(), '.dsh'));
  const profileDir = resolve(env.QQBOT_PROFILE_DIR || join(dshHome, 'profiles', profileName));
  if (profileDir === ROOT || profileDir.startsWith(ROOT + sep))
    throw new Error('Private profiles must live outside this Git repository. Set QQBOT_PROFILE_DIR to a private directory.');
  const workdir = resolve(env.QQBOT_WORKDIR || join(profileDir, 'workspace'));
  if (workdir === ROOT || workdir.startsWith(ROOT + sep))
    throw new Error('Bot workspaces must live outside this source repository.');
  return { profileName, profileDir, dshHome, workdir, overlay: join(profileDir, 'dsh-bot.patch.yml') };
}
export function assertNoSymlinks(path) {
  let cursor = resolve(path);
  for (;;) {
    let st;
    try { st = lstatSync(cursor); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (st?.isSymbolicLink()) throw new Error('Refusing a symlink in a private path');
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}
export function canonicalExisting(path) {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}
export function commandForDsh(env = process.env) {
  const bin = env.QQBOT_DSH_BIN || 'dsh';
  return /\.[cm]?js$/.test(bin)
    ? { command: process.execPath, prefix: [resolve(bin)] }
    : { command: bin, prefix: [] };
}
export function normalizedEnvironment(env = process.env) {
  const s = settings(env);
  return { ...env, DSH_HOME: s.dshHome, QQBOT_PROFILE_NAME: s.profileName,
    QQBOT_PROFILE_DIR: s.profileDir, QQBOT_WORKDIR: s.workdir };
}

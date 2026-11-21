import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const memberPreset = 'qqbot-member';
export const workspaceTool = 'qqbot_workspace_files';
const maxBytes = 64 * 1024;

export function memberWorkspacePath(root, principal) {
  return join(root, `member-${createHash('sha256').update(principal).digest('hex')}`);
}

function scopedDirectory(agent, membersRoot, ownerWorkspace) {
  const cwd = agent?.session?.header?.cwd;
  if (typeof cwd !== 'string') return;
  if (cwd === ownerWorkspace) return cwd;
  const path = relative(membersRoot, cwd);
  if (!/^member-[a-f0-9]{64}$/.test(path) || dirname(cwd) !== membersRoot) return;
  return cwd;
}

async function directory(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || (await realpath(path)) !== path) throw new Error('Workspace directory is unavailable');
}

export async function workspaceFiles(root, { action, path = '', text }, signal) {
  signal.throwIfAborted();
  if (typeof path !== 'string' || path.length > 240) throw new Error('Invalid workspace path');
  const parts = path ? path.split('/') : [];
  if (parts.some(part => !part || part.startsWith('.') || /[\\\u0000-\u001f]/.test(part))) {
    throw new Error('Use a relative, non-hidden path inside this workspace');
  }
  if (!['list', 'read', 'write', 'mkdir'].includes(action) || (action !== 'list' && !parts.length)) {
    throw new Error('Invalid workspace file operation');
  }
  await directory(root);
  const target = join(root, ...parts);
  const parent = dirname(target);
  if (target !== root) await directory(parent);
  signal.throwIfAborted();

  if (action === 'list') {
    await directory(target);
    return (await readdir(target, { withFileTypes: true }))
      .filter(entry => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isFile()))
      .map(entry => entry.name + (entry.isDirectory() ? '/' : '')).sort().slice(0, 100).join('\n');
  }
  if (action === 'mkdir') {
    await mkdir(target, { mode: 0o700 });
    return `Created ${path}/`;
  }
  if (action === 'read') {
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error('This tool reads regular, unlinked text files up to 64 KiB');
      const buffer = Buffer.allocUnsafe(maxBytes + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > maxBytes || buffer.subarray(0, bytesRead).includes(0)) throw new Error('Expected a text file up to 64 KiB');
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } finally { await file.close(); }
  }
  if (typeof text !== 'string' || Buffer.byteLength(text) > maxBytes) throw new Error('Provide text up to 64 KiB');
  const existing = await lstat(target).catch(error => {
    if (error.code === 'ENOENT') return;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.nlink !== 1)) throw new Error('Expected a regular workspace file');
  const temporary = join(parent, `.${basename(target)}.${randomUUID()}`);
  try {
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600, signal });
    signal.throwIfAborted();
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(() => {}); }
  return `Saved ${path}`;
}

export function registerMemberTools(ctx, membersRoot, ownerWorkspace) {
  const tools = ctx.get('tools');
  ctx.effect(() => tools.guard(exec => {
    const cwd = exec.agent?.session?.header?.cwd;
    if (typeof cwd !== 'string') return;
    if ((cwd === membersRoot || cwd.startsWith(membersRoot + '/')) && exec.name !== workspaceTool) {
      return 'This member workspace only exposes its scoped file tool.';
    }
  }));
  ctx.effect(() => tools.register({
    name: workspaceTool,
    description: 'List, read, write, or create a directory in your assigned workspace. Paths are relative. Files are UTF-8 text.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'write', 'mkdir'] },
        path: { type: 'string' }, text: { type: 'string' },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const root = scopedDirectory(exec.agent, membersRoot, ownerWorkspace);
      if (!root) throw new Error('This session has no member workspace');
      return workspaceFiles(root, args, exec.signal);
    },
  }, { when: ({ agent }) => !!scopedDirectory(agent, membersRoot, ownerWorkspace) }));
  ctx.provide('ownerDshMemberTools', true);
}

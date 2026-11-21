// Apply the small ingress adapter only inside a designated isolated QQ package.
import { lstat, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const [testRoot, packageDir] = process.argv.slice(2);
if (!isAbsolute(testRoot ?? '') || !isAbsolute(packageDir ?? '')) {
  throw new Error('Usage: node attach-test-qq.mjs ABSOLUTE_TEST_ROOT ABSOLUTE_QQ_PACKAGE_DIR');
}
const root = await realpath(testRoot);
const pkg = await realpath(packageDir);
const marker = await lstat(join(root, '.owner-dsh-test'));
const local = relative(root, pkg);
if (root === '/' || root === homedir() || !marker.isFile() ||
    ((await lstat(root)).mode & 0o077) || !local || local === '..' ||
    local.startsWith('../') || isAbsolute(local) ||
    pkg.startsWith(resolve(homedir(), '.dsh') + '/')) {
  throw new Error('The QQ package must be inside a private, explicitly marked test root');
}
const meta = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
if (meta.name !== '@tencent-connect/dsh-qqbot' || meta.version !== '0.5.2') throw new Error('Expected dsh-qqbot 0.5.2');
const path = join(pkg, 'dist/gateway/middleware-setup.js');
if (!(await lstat(path)).isFile() || dirname(await realpath(path)) !== dirname(path)) throw new Error('Expected a local middleware file');
const source = await readFile(path, 'utf8');
const tag = '/* owner-dsh-test-entry */';
if (source.includes(tag)) process.exit(0);
const anchor = '    bot.use(slash.middleware);';
if (source.split(anchor).length !== 2) throw new Error('Expected exactly one QQ slash middleware anchor');
const adapter = JSON.stringify(new URL('./qq.js', pathToFileURL(process.argv[1])).href);
const temporary = `${path}.${randomUUID()}`;
await writeFile(temporary, `import { createOwnerDshMiddleware } from ${adapter};\n` +
  source.replace(anchor, `    ${tag}\n    bot.use(createOwnerDshMiddleware(bot, { logger }));\n${anchor}`), { flag: 'wx' });
try { await rename(temporary, path); }
finally { await unlink(temporary).catch(() => {}); }

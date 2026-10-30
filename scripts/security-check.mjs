#!/usr/bin/env node
// Heuristic publication guard, not a proof that arbitrary text contains no personal information.
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.mjs';

const allowedRoots = new Set(['.github', 'docs', 'examples', 'scripts', 'tests', 'qqbot-patches', 'bot-config-panel', 'plugins']);
const allowedFiles = new Set(['.gitignore', '.gitattributes', 'package.json', 'package-lock.json', 'patch-qqbot.mjs', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'LICENSE']);
const rules = [
  ['OpenAI-style literal key', /\bsk-[A-Za-z0-9_-]{16,}\b/],
  ['GitHub access token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['Private key block', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['Author-specific home path', /\/Users\/[A-Za-z0-9._-]+\//],
  ['Possible real QQ identifier', /\b[A-F0-9]{24,40}\b/],
  ['Credential embedded in URL', /https?:\/\/[^\s/@:]+:[^\s/@]+@/],
];
const problems = [];
try {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8' });
  const names = [...new Set(listed.split('\0').filter(Boolean))];
  for (const name of names) {
    const top = name.split('/')[0];
    if (!allowedFiles.has(name) && !allowedRoots.has(top)) problems.push([name, 'Path is not on the publication allowlist']);
    if (/\.(?:log|db|sqlite(?:3)?|jsonl|tgz)(?:$|[-.])|(?:^|\/)(?:\.env(?!\.example$)|\.bot-secrets\.json|\.control-token|who|sessions|node_modules|media|images|\.qqbot-patch-backups)(?:\/|$)|\.bak(?:-|$)/.test(name))
      problems.push([name, 'Private/runtime artifact must never be committed']);
    const path = join(ROOT, name);
    let st;
    try { st = lstatSync(path); } catch { problems.push([name, 'Listed path is missing']); continue; }
    if (!st.isFile()) { problems.push([name, 'Only regular source files may be published']); continue; }
    if (st.size > 1024 * 1024) { problems.push([name, 'Unexpected file larger than 1 MiB']); continue; }
    const text = readFileSync(path, 'utf8');
    if (text.includes('\0')) problems.push([name, 'Binary artifact is not allowed in the source release']);
    // Explicit fake URL-auth cases exercise SSRF protection; do not exempt arbitrary test credentials.
    const scanned = name.startsWith('tests/') ? text.replace(/https:\/\/user:(?:pass|password)@example\.com\//g, 'https://example.com/') : text;
    for (const [rule, expression] of rules) if (expression.test(scanned)) problems.push([name, rule]);
    if (/^qqbot-patches\/.*\.json$/.test(name)) {
      const data = JSON.parse(text);
      if (name.endsWith('/role-skills.json') && (!Array.isArray(data.skills) || data.skills.length)) problems.push([name, 'Public role registry must be empty']);
      if (name.endsWith('/media-allow.json') && (!Array.isArray(data.people) || data.people.length)) problems.push([name, 'Public media allowlist must be empty']);
      if (['person-feedback.json', 'person-modules.json'].some(n => name.endsWith('/' + n)) && Object.keys(data.people ?? {}).length)
        problems.push([name, 'Public person bindings must be empty']);
    }
  }
  if (problems.length) {
    console.error('Publication check FAILED (matched values are deliberately not printed):');
    for (const [name, rule] of problems) console.error(`- ${name}: ${rule}`);
    process.exitCode = 1;
  } else console.log(`Publication check passed for ${names.length} source files. Manual privacy review is still required.`);
} catch { console.error('Publication check could not complete. Check Git availability and source file formats.'); process.exitCode = 1; }

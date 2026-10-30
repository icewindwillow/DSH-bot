#!/usr/bin/env node
/**
 * 动作描写处理离线测试：默认直接删掉括号动作。
 * 用法：node tests/action-limiter.test.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const src = readFileSync(join(ROOT, 'qqbot-patches', 'action-limiter.js'), 'utf8')
  .replace(/^\/\* >>>.*$/m, '')
  .replace(/^\/\* <<<.*$/m, '');
const factory = new Function(`${src}\nreturn { limitActionDescriptions };`);

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { fail++; console.error(`  ✗ ${name}\n    ${err.message}`); }
};
const eq = (actual, expected, label) => {
  if (actual !== expected) throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
};

console.log('动作描写处理测试');

check('默认删掉耳朵动作，保留正文', () => {
  const { limitActionDescriptions } = factory();
  eq(limitActionDescriptions('（耳朵抖一下）你回来啦', 'g1'), '你回来啦', '开头动作');
  eq(limitActionDescriptions('你回来啦（尾巴卷起来）', 'g1'), '你回来啦', '结尾动作');
});

check('多个动作一起删', () => {
  const { limitActionDescriptions } = factory();
  eq(limitActionDescriptions('（耳朵抖一下）（尾巴卷起来）好呀', 'g1'), '好呀', '多个');
});

check('纯动作会被清空（由出站层跳过发送）', () => {
  const { limitActionDescriptions } = factory();
  eq(limitActionDescriptions('（耳朵抖一下）', 'g1'), '', '纯动作');
});

check('普通括号不误删', () => {
  const { limitActionDescriptions } = factory();
  eq(limitActionDescriptions('（笑）好呀', 'g1'), '（笑）好呀', '非动作');
});

check('QQBOT_ACTION_DESCRIPTIONS=limit 才回到旧节流', () => {
  process.env.QQBOT_ACTION_DESCRIPTIONS = 'limit';
  const { limitActionDescriptions } = factory();
  eq(limitActionDescriptions('（耳朵抖一下）第一条', 'g2'), '（耳朵抖一下）第一条', '第一条保留');
  eq(limitActionDescriptions('（耳朵抖一下）第二条', 'g2'), '第二条', '第二条删掉');
  delete process.env.QQBOT_ACTION_DESCRIPTIONS;
});

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

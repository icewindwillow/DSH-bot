import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const snippet = readFileSync(join(ROOT, 'qqbot-patches', 'duplicate-reply-guard-helper.js'), 'utf8')
    .replace(/^\/\* >>>[^\n]*\n/, '')
    .replace(/\/\* <<<[^\n]*\n?$/, '');
const { qqbotIsDuplicateReply } = new Function(`${snippet}; return { qqbotIsDuplicateReply };`)();

let pass = 0;
let fail = 0;
function check(name, fn) {
    try {
        fn();
        pass += 1;
        console.log(`✔ ${name}`);
    }
    catch (err) {
        fail += 1;
        console.log(`✘ ${name}: ${err instanceof Error ? err.message : err}`);
    }
}

const first = '那就是双倍经验条，一次加 4 格。是我记成睡觉得 buff 了，下次我记住：帐篷只补双倍经验，跟地铺不是一回事。';
const second = '那就是双倍经验条，一次加 4 格。是我把它记成睡觉的加成了，现在记清楚了：帐篷只补双倍经验，跟地铺不是一回事。';

check('同一轮复述答案（真实事故原文）判为重复', () => {
    if (qqbotIsDuplicateReply('s1', first) !== false)
        throw new Error('第一条不该判重');
    if (qqbotIsDuplicateReply('s1', second) !== true)
        throw new Error('第二条应判重');
});

check('正常的「先应一声、再给结果」不算重复', () => {
    if (qqbotIsDuplicateReply('s2', '等我翻一下记录，马上回来') !== false)
        throw new Error('第一条不该判重');
    if (qqbotIsDuplicateReply('s2', '查到了，帐篷只补双倍经验，地铺是另一套，两回事。') !== false)
        throw new Error('补答被误杀');
});

check('不同会话互不影响', () => {
    qqbotIsDuplicateReply('s3', first);
    if (qqbotIsDuplicateReply('s4', second) !== false)
        throw new Error('跨会话误判');
});

check('短句完全重复也判重（真实事故：那就好，我还怕自己在瞎猜呢。）', () => {
    if (qqbotIsDuplicateReply('s5', '那就好，我还怕自己在瞎猜呢。') !== false)
        throw new Error('第一条不该判重');
    if (qqbotIsDuplicateReply('s5', '那就好，我还怕自己在瞎猜呢。') !== true)
        throw new Error('短句重复没拦住');
});

check('短但不同的连续两句不判重', () => {
    qqbotIsDuplicateReply('s7', '那就好');
    if (qqbotIsDuplicateReply('s7', '我先去忙了') !== false)
        throw new Error('误杀短句');
});

check('明显不同的长回答不判重', () => {
    qqbotIsDuplicateReply('s6', '今天外面下雨了，出门记得带伞，别又淋成落汤鸡。');
    if (qqbotIsDuplicateReply('s6', '你上次说的那家店我去过了，味道还行，就是排队有点久。') !== false)
        throw new Error('不同内容被误杀');
});

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = mkdtempSync(join(tmpdir(), 'qqbot-self-memory-'));
process.env.HOME = home;
process.env.QQBOT_MEMORY_DB = join(home, 'ltm.db');
process.env.XIANGXIN_API_KEY = 'test-key';

let failNetwork = false;
let probabilities = {};
let lastBody;
globalThis.fetch = async (_url, init) => {
    lastBody = JSON.parse(init.body);
    if (failNetwork)
        throw new Error('network down');
    return { ok: true, json: async () => ({ answers: { 命中: { probabilities } } }) };
};

const snippet = readFileSync(join(ROOT, 'qqbot-patches', 'self-memory-helper.js'), 'utf8')
    .replace(/^\/\* >>>[^\n]*\n/, '')
    .replace(/\/\* <<<[^\n]*\n?$/, '');
new Function(snippet)();
const memory = globalThis.__qqbotSelfMemory;

let pass = 0;
let fail = 0;
async function check(name, fn) {
    try {
        await fn();
        pass += 1;
        console.log(`✔ ${name}`);
    }
    catch (err) {
        fail += 1;
        console.log(`✘ ${name}: ${err instanceof Error ? err.message : err}`);
    }
}

const GID = 'GROUP_A';

await check('写入私人记忆，topic 唯一，重复写入是更新', () => {
    const first = memory.save({ topic: '吃三文鱼拉肚子', summary: '吃三文鱼吃猛了，拉了一整天', detail: '之后看到三文鱼有点发怵', tags: '三文鱼 拉肚子' });
    if (!first.ok)
        throw new Error(first.message);
    const second = memory.save({ topic: '吃三文鱼拉肚子', summary: '吃三文鱼吃猛了，拉了一整天（改）' });
    if (!second.ok)
        throw new Error(second.message);
    const rows = memory.list();
    if (rows.length !== 1)
        throw new Error(`重复插入 ${rows.length} 条`);
    if (!rows[0].summary.includes('（改）'))
        throw new Error('没更新');
    if (memory.stats().total !== 1)
        throw new Error('stats 不对');
});

await check('没命中时不注入任何东西（没有常驻记忆规则）', async () => {
    if ((await memory.recallLine('GROUP_EMPTY')) !== '')
        throw new Error('空缓存也注入了');
});

await check('话题和她的经历相关时才注入，并明确「别主动提」', async () => {
    probabilities = { 吃三文鱼拉肚子: 0.82 };
    await memory.prefetch(GID, '你上次吃三文鱼是不是吃坏了肚子');
    const line = await memory.recallLine(GID);
    if (!line.includes('吃三文鱼拉肚子'))
        throw new Error('没注入命中的记忆');
    if (!line.includes('别主动提'))
        throw new Error('缺少「不要到处说」的约束');
    if (!line.includes('不是群友说的事'))
        throw new Error('没区分自己和群友');
});

await check('普通闲聊不注入', async () => {
    probabilities = { 吃三文鱼拉肚子: 0.03 };
    await memory.prefetch('GROUP_B', '今天中午吃什么好呢');
    if ((await memory.recallLine('GROUP_B')) !== '')
        throw new Error('不相关也注入了');
});

await check('追问看不出主语时保留上一条命中', async () => {
    probabilities = { 吃三文鱼拉肚子: 0.02 };
    await memory.prefetch(GID, '那你后来没事吧');
    if (!(await memory.recallLine(GID)).includes('吃三文鱼拉肚子'))
        throw new Error('追问把上下文清空了');
});

await check('象信挂了不清空已有命中', async () => {
    failNetwork = true;
    try {
        await memory.prefetch(GID, '最近还好吗');
        if (!(await memory.recallLine(GID)).includes('吃三文鱼拉肚子'))
            throw new Error('象信挂掉时把缓存清了');
    }
    finally {
        failNetwork = false;
    }
});

await check('输入里直接出现 topic 时精确命中，不调象信', async () => {
    lastBody = undefined;
    await memory.prefetch('GROUP_C', '吃三文鱼拉肚子');
    const line = await memory.recallLine('GROUP_C');
    if (!line.includes('吃三文鱼拉肚子'))
        throw new Error('精确命中失败');
    if (lastBody)
        throw new Error('不该调象信');
});

await check('象信用的是 topic 列表，且带「都不是」兜底', async () => {
    probabilities = { 吃三文鱼拉肚子: 0.9 };
    lastBody = undefined;
    await memory.prefetch('GROUP_D', '三文鱼现在还敢吃吗');
    const criteria = lastBody?.questions?.命中?.criteria ?? {};
    if (!criteria['吃三文鱼拉肚子'] || !criteria['都不是'])
        throw new Error('选项没带全');
    if (!String(lastBody.questions.命中.instructions).includes('都不是'))
        throw new Error('缺少不相关兜底指令');
});

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

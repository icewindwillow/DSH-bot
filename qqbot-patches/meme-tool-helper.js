/* >>> dsh-qqbot-patch:meme-tool-helper >>> */
/**
 * 梗库工具：meme_search / meme_save。
 * 逻辑在 meme-helper.js（session-manager 侧），这里只做工具注册和当前群解析。
 */
function setupMemeTools(ctx, logger) {
    let tools;
    try {
        tools = ctx.get('tools');
    }
    catch {
        tools = undefined;
    }
    if (!tools) {
        console.log('[im-qqbot] tools 不可用，梗库工具未启用');
        return;
    }

    const currentGid = () => String(globalThis.__qqbotCurrentGid ?? globalThis.__qqbotLastGid ?? '').trim() || undefined;

    tools.register({
        name: 'meme_search',
        description: [
            '按意思从群梗库/黑话库里找词条。',
            '群里出现你不确定的人名、外号、黑话、游戏或影视梗时，先查这里，别急着联网搜索；即使你觉得自己知道，也先查一下确认，避免记错版本或设定。',
            'query 直接用群里的原话或你理解的意思；查到就按库里的解释接话，不要重复解释这个词。',
        ].join(''),
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                query: { type: 'string', description: '要查的词或整句话，例如「妙手小张是谁」' },
                limit: { type: 'number', description: '返回条数，默认 3，最多 5' },
            },
            required: ['query'],
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    results: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                term: { type: 'string' },
                                summary: { type: 'string' },
                                detail: { type: 'string' },
                                aliases: { type: 'string' },
                                source: { type: 'string' },
                                score: { type: 'number' },
                            },
                            required: ['term', 'summary'],
                        },
                    },
                },
                required: ['results'],
            },
            render: (_args, value) => {
                if (!value.results || value.results.length === 0)
                    return [{ type: 'text', text: '梗库里没有查到。可以联网搜一次确认，再用 meme_save 记下来。' }];
                return [{
                    type: 'text',
                    text: value.results.map((item) => {
                        const parts = [`${item.term}：${item.summary}`];
                        if (item.aliases)
                            parts.push(`别名：${item.aliases}`);
                        if (item.detail)
                            parts.push(`背景：${item.detail}`);
                        if (item.source)
                            parts.push(`出处：${item.source}`);
                        return parts.join('\n');
                    }).join('\n\n'),
                }];
            },
        },
        isConcurrencySafe: true,
        async execute(args) {
            const query = String(args?.query ?? '').trim();
            if (query === '')
                throw new Error('query 不能为空');
            const fn = globalThis.__qqbotMeme?.search;
            if (typeof fn !== 'function')
                return { results: [] };
            const limit = Math.max(1, Math.min(5, Number(args?.limit ?? 3)));
            const hits = await fn(query, { gid: currentGid(), limit });
            if (hits.length > 0)
                console.log(`[im-qqbot] 梗库命中: ${query.slice(0, 30)} → ${hits.map((hit) => hit.term).join('、')}`);
            return {
                results: hits.map((hit) => ({
                    term: String(hit.term ?? ''),
                    summary: String(hit.summary ?? ''),
                    detail: String(hit.detail ?? ''),
                    aliases: String(hit.aliases ?? ''),
                    source: String(hit.source ?? ''),
                    score: Number(hit.score ?? 0),
                })),
            };
        },
    });

    tools.register({
        name: 'meme_save',
        description: [
            '把一个梗、黑话、外号或游戏/影视人物记进梗库，以后直接查，不用每次联网。',
            '联网搜过并确认含义后调用；群里有人把某个梗解释清楚了，也可以直接调用，不用再搜。',
            'term 是词条名；summary 用一句话说清是什么（尽量不超过 40 字）；detail 写背景、出处、群内怎么用；aliases 是空格分隔的别名。',
            'scope=group（默认）只在本群可见；公共的游戏/影视/网络梗用 scope=global，所有群都能用。',
            '不要记录普通词语、一次性玩笑、个人隐私或只对某个人有意义的称呼。',
        ].join(''),
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                term: { type: 'string', description: '词条名，例如「妙手小张」' },
                summary: { type: 'string', description: '一句话解释，例如「《影之刃零》里云游收奇珍的商人 NPC」' },
                detail: { type: 'string', description: '背景、出处、群内用法（可选）' },
                aliases: { type: 'string', description: '别名，空格分隔（可选）' },
                scope: { type: 'string', description: 'group（默认，本群）或 global（公共梗）' },
                source: { type: 'string', description: '来源链接或「群聊」（可选）' },
                tags: { type: 'string', description: '标签，空格分隔（可选）' },
            },
            required: ['term', 'summary'],
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean' },
                    message: { type: 'string' },
                    term: { type: 'string' },
                    scope: { type: 'string' },
                },
                required: ['ok', 'message'],
            },
            render: (_args, value) => [{ type: 'text', text: value.message }],
        },
        isConcurrencySafe: true,
        execute(args) {
            const fn = globalThis.__qqbotMeme?.save;
            if (typeof fn !== 'function')
                return { ok: false, message: '梗库模块还没加载，这条先没记。' };
            const result = fn(args, currentGid());
            if (result.ok)
                console.log(`[im-qqbot] 梗库写入(${result.scope}): ${result.message}`);
            return result;
        },
    });

    console.log('[im-qqbot] 梗库工具已注册（meme_search / meme_save）');
}
/* <<< dsh-qqbot-patch:meme-tool-helper <<< */

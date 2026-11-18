/* >>> dsh-qqbot-patch:note-tool-helper >>> */
/**
 * 长条目工具：note_search / note_save。
 * 逻辑在 note-helper.js（session-manager 侧），这里只做工具注册和当前群解析。
 */
function setupNoteTools(ctx, logger) {
    let tools;
    try {
        tools = ctx.get('tools');
    }
    catch {
        tools = undefined;
    }
    if (!tools) {
        console.log('[im-qqbot] tools 不可用，长条目工具未启用');
        return;
    }

    const currentGid = () => String(globalThis.__qqbotCurrentGid ?? globalThis.__qqbotLastGid ?? '').trim() || undefined;
    // 当前说话人：用来判断能不能写公共库（主人 / 管理员才行）
    const currentSender = () => {
        const id = String(globalThis.__qqbotLastTarget?.senderId ?? '').trim();
        return id === '' ? undefined : { id };
    };

    tools.register({
        name: 'note_search',
        description: [
            '按意思查找以前存下来的长内容：加点方案、配置清单、攻略、教程、代码以外的长文。',
            '对方说「上次那个方案」「之前发的那份清单」「你之前写的那套」这类模糊指代，而长期记忆里只有一句话八卦时，查这里。',
            'query 用对方的原话或你理解的意思；命中后会拿到全文。',
        ].join(''),
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                query: { type: 'string', description: '要查的方案/清单，例如「近战生存猎加点方案」' },
                limit: { type: 'number', description: '返回条数，默认 2，最多 3' },
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
                                title: { type: 'string' },
                                summary: { type: 'string' },
                                body: { type: 'string' },
                                tags: { type: 'string' },
                                source: { type: 'string' },
                                score: { type: 'number' },
                            },
                            required: ['title', 'body'],
                        },
                    },
                },
                required: ['results'],
            },
            render: (_args, value) => {
                if (!value.results || value.results.length === 0)
                    return [{ type: 'text', text: '没找到存过的长条目。' }];
                return [{ type: 'text', text: value.results.map((item) => `【${item.title}】\n${item.body}`).join('\n\n') }];
            },
        },
        isConcurrencySafe: true,
        async execute(args) {
            const query = String(args?.query ?? '').trim();
            if (query === '')
                throw new Error('query 不能为空');
            const fn = globalThis.__qqbotNote?.search;
            if (typeof fn !== 'function')
                return { results: [] };
            const limit = Math.max(1, Math.min(3, Number(args?.limit ?? 2)));
            const hits = await fn(query, { gid: currentGid(), limit });
            if (hits.length > 0)
                console.log(`[im-qqbot] 长条目命中: ${query.slice(0, 30)} → ${hits.map((hit) => hit.title).join('、')}`);
            return {
                results: hits.map((hit) => ({
                    title: String(hit.title ?? ''),
                    summary: String(hit.summary ?? ''),
                    body: String(hit.body ?? ''),
                    tags: String(hit.tags ?? ''),
                    source: String(hit.source ?? ''),
                    score: Number(hit.score ?? 0),
                })),
            };
        },
    });

    tools.register({
        name: 'note_save',
        description: [
            '把内容整份存下来，以后用 note_search 按意思取回：备忘、加点/配装方案、配置清单、攻略、教程、多段表格。',
            '别人明确让你「记一下」「记住」的，就照原话收下，多短都记，不要拿字数筛掉；群里发了长文或方案、你自己整理出一份要留着的长答案，也用这个。',
            '正文原样保留，不要自己删减；summary 用一句话概括，tags 写关键词方便以后检索。',
            'scope=group（默认）只在本群可见；通用的游戏/技术方案用 scope=global（公共库只有主人或管理员能写）。',
        ].join(''),
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                title: { type: 'string', description: '标题，例如「近战生存猎 51 点加点方案」' },
                body: { type: 'string', description: '完整正文（Markdown 可用）' },
                summary: { type: 'string', description: '一句话概括（可选，默认截取正文）' },
                tags: { type: 'string', description: '关键词，空格分隔（可选）' },
                scope: { type: 'string', description: 'group（默认，本群）或 global（通用内容）' },
                source: { type: 'string', description: '来源，例如「群聊」「工作区 近战生存猎-逐级加点方案.md」（可选）' },
            },
            required: ['title', 'body'],
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean' },
                    message: { type: 'string' },
                    title: { type: 'string' },
                    scope: { type: 'string' },
                },
                required: ['ok', 'message'],
            },
            render: (_args, value) => [{ type: 'text', text: value.message }],
        },
        isConcurrencySafe: true,
        execute(args) {
            const fn = globalThis.__qqbotNote?.save;
            if (typeof fn !== 'function')
                return { ok: false, message: '长条目模块还没加载，这条先没存。' };
            const result = fn(args, currentGid(), currentSender());
            if (result.ok)
                console.log(`[im-qqbot] 长条目写入(${result.scope}): ${result.message}`);
            return result;
        },
    });

    tools.register({
        name: 'note_update',
        description: [
            '改已经存下来的长条目里的某一项（迭代它），不要重新 note_save 整份。',
            '先 note_search 拿到全文；query 用用户原话说明改哪一项，change 写替换后的完整那一行/那一段（不是只写改动处，否则同一行其他内容会被覆盖）。',
            '如果返回 needConfirm=true，说明判断不确定：把 question 和 candidates 原样问用户，不要自己猜；用户选了以后带 noteId + block 再调一次。',
            '如果 needConfirm 但没给 candidates，是在确认整行覆盖：把 question 问用户，用户点头后带 confirm=true 再调一次。',
            'mode=replace 改一项；append 在末尾补一条；delete 删掉匹配到的那一行。',
        ].join(''),
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                query: { type: 'string', description: '要改哪一项，用用户原话，例如「终盘里的偏斜点数」' },
                change: { type: 'string', description: 'replace：替换后的完整那一行/那一段；append：要追加的内容；delete：留空' },
                mode: { type: 'string', description: 'replace（默认）/ append / delete' },
                title: { type: 'string', description: '明确知道标题时直接给（可选）' },
                noteId: { type: 'number', description: 'needConfirm 返回的条目 id，用户确认后带上（可选）' },
                block: { type: 'number', description: 'needConfirm 返回的行号，用户确认后带上（可选）' },
                confirm: { type: 'boolean', description: '整行覆盖确认；用户点头后传 true（可选）' },
            },
            required: ['query'],
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean' },
                    needConfirm: { type: 'boolean' },
                    message: { type: 'string' },
                    question: { type: 'string' },
                    title: { type: 'string' },
                    noteId: { type: 'number' },
                    old: { type: 'string' },
                    updated: { type: 'string' },
                    candidates: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                kind: { type: 'string' },
                                noteId: { type: 'number' },
                                block: { type: 'number' },
                                title: { type: 'string' },
                                preview: { type: 'string' },
                                score: { type: 'number' },
                            },
                            required: ['kind'],
                        },
                    },
                },
                required: ['ok', 'needConfirm', 'message'],
            },
            render: (_args, value) => {
                if (value.needConfirm) {
                    const head = value.question || value.message;
                    const list = (value.candidates ?? [])
                        .map((item, i) => `${i + 1}. ${item.kind === 'note' ? item.title : `${item.block}. ${item.preview}`}`);
                    return [{ type: 'text', text: [head, ...list].join('\n') }];
                }
                return [{ type: 'text', text: value.message }];
            },
        },
        isConcurrencySafe: false,
        async execute(args) {
            const fn = globalThis.__qqbotNote?.update;
            if (typeof fn !== 'function')
                return { ok: false, needConfirm: false, message: '长条目模块还没加载。' };
            const result = await fn(args, currentGid());
            if (result.ok)
                console.log(`[im-qqbot] 长条目更新: ${result.message}`);
            else if (result.needConfirm)
                console.log(`[im-qqbot] 长条目更新待确认: ${result.question}`);
            return result;
        },
    });

    console.log('[im-qqbot] 长条目工具已注册（note_search / note_save / note_update）');
}
/* <<< dsh-qqbot-patch:note-tool-helper <<< */

/* >>> dsh-qqbot-patch:vector-helper >>> */
/**
 * 语义检索（向量召回）—— 给长期记忆加一层 embedding，解决「关键词对不上就搜不到」。
 *
 * - 模型：Xenova/bge-small-zh-v1.5（本地 ONNX，512 维，中文；首次启动前预下载到 ~/.dsh/transformers-cache）
 * - 存储：ltm.db 里新建 memory_vectors(memory_id, dim, vec BLOB, updated_at)，不改原表
 * - 索引：每 5 分钟把还没向量的记忆补上（每批 64 条），启动 40 秒后先跑一批
 * - 检索：查询向量 vs 候选向量做余弦；候选先按 scope 过滤，几百到几千条都是毫秒级
 * - 工具：memory_recall(query, limit, scope?) —— 模糊描述找旧事时用它
 *
 * 开关：QQBOT_VECTOR=off；QQBOT_VECTOR_MODEL 可换模型；QQBOT_VECTOR_BATCH 每批条数。
 */
function setupVector(ctx, logger) {
    if (globalThis.__qqbotVector)
        return;
    if (String(process.env.QQBOT_VECTOR ?? 'off').toLowerCase() === 'off')
        return;
    const fs = process.getBuiltinModule?.('node:fs');
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    if (!fs || !sqlite) {
        console.log('[im-qqbot] 向量召回: fs/sqlite 不可用，跳过');
        return;
    }
    const dbPath = process.env.QQBOT_MEMORY_DB ?? `${process.env.HOME ?? ''}/.dsh/memory/ltm.db`;
    const MODEL = process.env.QQBOT_VECTOR_MODEL ?? 'Xenova/bge-small-zh-v1.5';
    const BATCH = Math.max(8, Number(process.env.QQBOT_VECTOR_BATCH ?? 64));
    const CACHE = `${process.env.HOME ?? ''}/.dsh/transformers-cache`;

    let extractorPromise;
    const getExtractor = () => {
        extractorPromise ??= (async () => {
            const mod = await import('@huggingface/transformers');
            try {
                mod.env.cacheDir = CACHE;
                mod.env.allowLocalModels = true;
            }
            catch {
                // 老版本没有这些开关
            }
            return mod.pipeline('feature-extraction', MODEL, { dtype: 'q8' });
        })();
        return extractorPromise;
    };

    const embed = async (texts) => {
        const extractor = await getExtractor();
        const out = await extractor(texts, { pooling: 'mean', normalize: true });
        const dim = out.dims[1];
        const data = out.data;
        const vectors = [];
        for (let i = 0; i < texts.length; i += 1)
            vectors.push(Float32Array.from(data.subarray(i * dim, (i + 1) * dim)));
        return { dim, vectors };
    };

    const ensureTable = () => {
        const db = new sqlite.DatabaseSync(dbPath);
        try {
            db.exec('create table if not exists memory_vectors (memory_id integer primary key, dim integer not null, vec blob not null, updated_at integer not null)');
        }
        finally {
            db.close();
        }
    };

    /** 补索引：返回本次处理条数 */
    const indexBatch = async (limit = BATCH) => {
        ensureTable();
        const db = new sqlite.DatabaseSync(dbPath);
        let rows;
        try {
            rows = db.prepare('select m.id, m.text from memories m left join memory_vectors v on v.memory_id = m.id where v.memory_id is null order by m.id desc limit ?')
                .all(limit);
        }
        finally {
            db.close();
        }
        if (rows.length === 0)
            return 0;
        const { dim, vectors } = await embed(rows.map((row) => String(row.text ?? '').slice(0, 500)));
        const write = new sqlite.DatabaseSync(dbPath);
        try {
            const insert = write.prepare('insert or replace into memory_vectors (memory_id, dim, vec, updated_at) values (?, ?, ?, ?)');
            const now = Date.now();
            write.exec('begin');
            rows.forEach((row, index) => {
                const buf = Buffer.alloc(dim * 4);
                for (let i = 0; i < dim; i += 1)
                    buf.writeFloatLE(vectors[index][i], i * 4);
                insert.run(row.id, dim, buf, now);
            });
            write.exec('commit');
        }
        catch (err) {
            try { write.exec('rollback'); } catch { /* 忽略 */ }
            throw err;
        }
        finally {
            write.close();
        }
        return rows.length;
    };

    const search = async (query, { scopes, limit = 5 } = {}) => {
        const { dim, vectors } = await embed([String(query ?? '').slice(0, 300)]);
        const q = vectors[0];
        const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
        try {
            const params = [dim];
            let where = '';
            if (Array.isArray(scopes) && scopes.length > 0) {
                where = ` and m.scope in (${scopes.map(() => '?').join(',')})`;
                params.push(...scopes);
            }
            const rows = db.prepare(`select m.id, m.text, m.tags, m.scope, m.pinned, m.created_at, m.updated_at, v.vec, v.dim from memories m join memory_vectors v on v.memory_id = m.id where v.dim = ?${where}`)
                .all(...params);
            const scored = [];
            for (const row of rows) {
                const raw = row.vec;
                const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
                const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                let dot = 0;
                for (let i = 0; i < dim; i += 1)
                    dot += q[i] * view.getFloat32(i * 4, true);
                const tags = String(row.tags ?? '');
                const impMatch = tags.match(/imp:([\d.]+)/);
                const imp = impMatch ? Math.min(2, Number(impMatch[1]) || 0) : 0.8;
                const atMs = Number(row.updated_at || row.created_at || 0);
                const recency = atMs > 0 ? Math.exp(-Math.max(0, Date.now() - atMs) / 86400000 / 14) : 0.5;
                // 语义相似度为主，重要性和新鲜度只做小幅加成（最多 +0.08）
                const boost = 0.08 * ((0.6 + imp) / 2.6) * (0.35 + 0.65 * recency);
                scored.push({
                    id: row.id,
                    text: String(row.text ?? ''),
                    tags,
                    scope: String(row.scope ?? ''),
                    pinned: Number(row.pinned ?? 0) === 1,
                    at: new Date(atMs).toISOString(),
                    score: dot + boost,
                });
            }
            scored.sort((a, b) => b.score - a.score);
            return scored.slice(0, limit);
        }
        finally {
            db.close();
        }
    };

    const status = () => {
        ensureTable();
        const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
        try {
            const total = db.prepare('select count(*) c from memories').get().c;
            const indexed = db.prepare('select count(*) c from memory_vectors').get().c;
            return { total, indexed, model: MODEL };
        }
        finally {
            db.close();
        }
    };

    // ── 工具：memory_recall ──
    let tools;
    try {
        tools = ctx.get('tools');
    }
    catch {
        tools = undefined;
    }
    if (tools) {
        tools.register({
            name: 'memory_recall',
            description: [
                '按意思（而不是关键词）检索长期记忆。',
                '当对方说「上次那个事」「之前说的那个」而你用 memory_search 搜不到时，用这个。',
                'query 用一句自然语言描述你想找的事；scope 可限定某个群（默认当前群）。',
            ].join(''),
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    query: { type: 'string', description: '自然语言描述，例如「他说压力很大那次」' },
                    limit: { type: 'number', description: '返回条数，默认 5，最多 10' },
                    scope: { type: 'string', description: '限定群 scope（可选，默认当前群）' },
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
                                    at: { type: 'string' },
                                    text: { type: 'string' },
                                },
                                required: ['at', 'text'],
                            },
                        },
                    },
                    required: ['results'],
                },
                render: (_args, value) => {
                    if (!value.results || value.results.length === 0)
                        return [{ type: 'text', text: '没有找到相关的记忆。' }];
                    return [{ type: 'text', text: value.results.map((r) => `- ${r.at.slice(0, 10)} ${r.text}`).join('\n') }];
                },
            },
            isConcurrencySafe: true,
            async execute(args) {
                const query = String(args?.query ?? '').trim();
                if (query === '')
                    throw new Error('query 不能为空');
                const limit = Math.max(1, Math.min(10, Number(args?.limit ?? 5)));
                const gid = globalThis.__qqbotCurrentGid;
                const scopes = args?.scope ? [String(args.scope)] : (gid ? [`qq:group:${gid}`] : undefined);
                const hits = await search(query, { scopes, limit });
                return {
                    results: hits.map((hit) => ({
                        at: hit.at,
                        text: hit.text.length > 200 ? `${hit.text.slice(0, 200)}…` : hit.text,
                    })),
                };
            },
        });
        console.log('[im-qqbot] 语义检索工具已注册（memory_recall）');
    }

    // ── 索引任务：启动 40 秒后先跑一批，之后每 5 分钟 ──
    let running = false;
    const tick = async () => {
        if (running)
            return;
        running = true;
        try {
            let total = 0;
            for (let i = 0; i < 4; i += 1) {
                const n = await indexBatch(BATCH);
                total += n;
                if (n < BATCH)
                    break;
            }
            if (total > 0)
                console.log(`[im-qqbot] 向量索引: +${total} 条`);
        }
        catch (err) {
            console.log(`[im-qqbot] 向量索引失败: ${err instanceof Error ? err.message : String(err)}`);
        }
        finally {
            running = false;
        }
    };
    const bootTimer = setTimeout(() => { void tick(); }, 40e3);
    if (typeof bootTimer.unref === 'function')
        bootTimer.unref();
    const timer = setInterval(() => { void tick(); }, 5 * 60 * 1000);
    if (typeof timer.unref === 'function')
        timer.unref();

    globalThis.__qqbotVector = { search, indexBatch, status, tick };
    console.log(`[im-qqbot] 语义检索已启用（${MODEL}，每 5 分钟补索引）`);
}
/* <<< dsh-qqbot-patch:vector-helper <<< */

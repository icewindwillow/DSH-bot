/* >>> dsh-qqbot-patch:bot-control-helper >>> */
/**
 * 机器人本地面板控制接口（只监听 127.0.0.1）
 *
 * 面板进程拿不到机器人内存里的 SessionManager，所以由机器人自己开一个小 HTTP：
 *   GET  /health
 *   POST /session/new      { groupOpenid }  → 清空该群当前会话（长期记忆/档案不动）
 *   POST /session/compact  { groupOpenid }  → 压缩该群上下文
 *   POST /session/status   { groupOpenid }  → 当前是否有活跃会话 / sessionId
 *
 * 端口：QQBOT_CONTROL_PORT，默认 7792；端口被占用只记日志，不影响机器人。
 */
function setupBotControl(ctx, manager, config, logger) {
    const http = process.getBuiltinModule?.('node:http');
    if (!http || !manager)
        return;
    const token = String(process.env.QQBOT_CONTROL_TOKEN ?? '');
    if (token.length < 32) return; // 由仓库启动器生成；未授权的本机 API 默认不启动
    const port = Number(process.env.QQBOT_CONTROL_PORT ?? 7792);
    if (!Number.isInteger(port) || port <= 0)
        return;

    const readBody = (req) => new Promise((resolve) => {
        let raw = '', size = 0, oversized = false;
        req.on('data', (chunk) => { size += chunk.length; if (size > 65536) { oversized = true; raw = ''; } else if (!oversized) raw += chunk; });
        req.on('end', () => {
            try {
                resolve(oversized || raw === '' ? {} : JSON.parse(raw));
            }
            catch {
                resolve({});
            }
        });
        req.on('error', () => resolve({}));
    });
    const send = (res, code, body) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
    };
    const groupIdOf = (body) => String(body?.groupOpenid ?? '').trim();

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
        if (req.headers.host !== `127.0.0.1:${port}` || req.headers.origin || req.headers.authorization !== `Bearer ${token}`)
            return send(res, 403, { ok: false, error: 'forbidden' });
        if (req.method === 'GET' && url.pathname === '/health')
            return send(res, 200, { ok: true, service: 'qqbot-control', port });

        if (req.method === 'POST' && url.pathname === '/session/new') {
            const body = await readBody(req);
            const gid = groupIdOf(body);
            if (gid === '')
                return send(res, 400, { ok: false, error: 'groupOpenid 不能为空' });
            try {
                await manager.remove('group', gid);
                console.log(`[im-qqbot] 控制接口：群 ${gid} 已开新会话`);
                return send(res, 200, { ok: true, action: 'new', groupOpenid: gid });
            }
            catch (err) {
                return send(res, 500, { ok: false, error: String(err?.message ?? err) });
            }
        }

        if (req.method === 'POST' && url.pathname === '/session/compact') {
            const body = await readBody(req);
            const gid = groupIdOf(body);
            if (gid === '')
                return send(res, 400, { ok: false, error: 'groupOpenid 不能为空' });
            try {
                const outcome = await manager.compact('group', gid);
                console.log(`[im-qqbot] 控制接口：群 ${gid} 压缩 ${outcome?.ok ? 'ok' : outcome?.reason ?? '?'}`);
                return send(res, 200, { ok: true, action: 'compact', groupOpenid: gid, outcome });
            }
            catch (err) {
                return send(res, 500, { ok: false, error: String(err?.message ?? err) });
            }
        }

        if (req.method === 'POST' && url.pathname === '/diary/event') {
            try {
                const body = await readBody(req);
                const diary = globalThis.__qqbotDiary;
                if (!diary || typeof diary.event !== 'function')
                    return send(res, 503, { ok: false, error: '日记模块未启用' });
                const text = await diary.event({
                    gid: String(body?.groupOpenid ?? ''),
                    name: String(body?.name ?? '某人'),
                    kind: String(body?.kind ?? '聊得开心'),
                    detail: String(body?.detail ?? ''),
                    lastLine: String(body?.lastLine ?? ''),
                });
                return send(res, 200, { ok: true, written: text !== '', text });
            }
            catch (err) {
                return send(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
            }
        }
        if (req.method === 'GET' && url.pathname === '/events/prompt') {
            try {
                const gid = url.searchParams.get('gid') ?? '';
                const person = url.searchParams.get('person') ?? '';
                const text = globalThis.__qqbotEvents?.promptLine?.(gid, person) ?? '';
                return send(res, 200, { ok: true, text });
            }
            catch (err) {
                return send(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
            }
        }
        if (req.method === 'GET' && url.pathname === '/vector/search') {
            try {
                const vec = globalThis.__qqbotVector;
                if (!vec || typeof vec.search !== 'function')
                    return send(res, 503, { ok: false, error: '语义检索未启用' });
                const q = url.searchParams.get('q') ?? '';
                const gid = url.searchParams.get('gid') ?? '';
                const limit = Math.max(1, Math.min(10, Number(url.searchParams.get('limit') ?? 5)));
                const hits = await vec.search(q, { scopes: gid ? [`qq:group:${gid}`] : undefined, limit });
                return send(res, 200, { ok: true, hits: hits.map((h) => ({ score: Number(h.score.toFixed(3)), at: h.at, text: h.text.slice(0, 160) })) });
            }
            catch (err) {
                return send(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
            }
        }
        if (req.method === 'GET' && url.pathname === '/vector/status') {
            try {
                const vec = globalThis.__qqbotVector;
                if (!vec || typeof vec.status !== 'function')
                    return send(res, 503, { ok: false, error: '语义检索未启用' });
                return send(res, 200, { ok: true, ...vec.status() });
            }
            catch (err) {
                return send(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
            }
        }
        if (req.method === 'POST' && url.pathname === '/vector/index') {
            try {
                const vec = globalThis.__qqbotVector;
                if (!vec || typeof vec.indexBatch !== 'function')
                    return send(res, 503, { ok: false, error: '语义检索未启用' });
                const n = await vec.indexBatch(64);
                return send(res, 200, { ok: true, indexed: n, ...vec.status() });
            }
            catch (err) {
                return send(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
            }
        }
        if (req.method === 'GET' && url.pathname === '/events') {
            try {
                const state = globalThis.__qqbotEvents?.read?.() ?? { events: [] };
                return send(res, 200, { ok: true, events: state.events });
            }
            catch (err) {
                return send(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
            }
        }
        if (req.method === 'POST' && url.pathname === '/events/simulate') {
            try {
                const body = await readBody(req);
                const detect = globalThis.__qqbotEventDetect;
                if (typeof detect !== 'function')
                    return send(res, 503, { ok: false, error: '事件追踪未启用' });
                detect({
                    kind: 'group',
                    groupOpenid: String(body?.gid ?? ''),
                    senderId: String(body?.id ?? 'sim'),
                    senderName: String(body?.name ?? '测试'),
                    content: String(body?.content ?? ''),
                    rawEventType: 'GROUP_MESSAGE_CREATE',
                });
                return send(res, 200, { ok: true, queued: true });
            }
            catch (err) {
                return send(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
            }
        }
        if (req.method === 'POST' && (url.pathname === '/person/cards' || url.pathname === '/profile/recent')) {
            try {
                const job = globalThis.__qqbotPersonCard;
                if (!job || typeof job.runOnce !== 'function')
                    return send(res, 503, { ok: false, error: '人物卡模块未启用' });
                const written = await job.runOnce(true);
                return send(res, 200, { ok: true, written });
            }
            catch (err) {
                return send(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
            }
        }
        if (req.method === 'POST' && url.pathname === '/diary/musing') {
            try {
                const diary = globalThis.__qqbotDiary;
                if (!diary || typeof diary.musing !== 'function')
                    return send(res, 503, { ok: false, error: '日记模块未启用' });
                const text = await diary.musing(true);
                return send(res, 200, { ok: true, written: text !== '', text });
            }
            catch (err) {
                return send(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
            }
        }
        if (req.method === 'POST' && url.pathname === '/diary/run') {
            try {
                const diary = globalThis.__qqbotDiary;
                if (!diary || typeof diary.runOnce !== 'function')
                    return send(res, 503, { ok: false, error: '日记模块未启用' });
                await diary.runOnce(true);
                return send(res, 200, { ok: true, action: 'diary' });
            }
            catch (err) {
                return send(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
            }
        }
        if (req.method === 'POST' && url.pathname === '/session/status') {
            const body = await readBody(req);
            const gid = groupIdOf(body);
            if (gid === '')
                return send(res, 400, { ok: false, error: 'groupOpenid 不能为空' });
            try {
                const key = manager.sessionKey?.('group', gid);
                const record = key ? manager.sessions?.get?.(key) : undefined;
                const sessionId = key && manager.currentSessionId ? manager.currentSessionId(key) : undefined;
                return send(res, 200, { ok: true, groupOpenid: gid, active: !!record, sessionId: sessionId ?? null });
            }
            catch (err) {
                return send(res, 500, { ok: false, error: String(err?.message ?? err) });
            }
        }

        if (req.method === 'POST' && url.pathname === '/media/search') {
            const body = await readBody(req);
            const search = globalThis.__qqbotMediaArchive?.search;
            if (typeof search !== 'function')
                return send(res, 503, { ok: false, error: '媒体库未就绪' });
            try {
                const result = await search(body);
                return send(res, 200, { ok: true, ...result });
            }
            catch (err) {
                return send(res, 500, { ok: false, error: String(err?.message ?? err) });
            }
        }

        return send(res, 404, { ok: false, error: 'not found' });
    });

    server.on('error', (err) => console.warn(`[im-qqbot] 控制接口端口 ${port} 未启用：${err.message}`));
    server.listen(port, '127.0.0.1', () => console.log(`[im-qqbot] 控制接口已启用: http://127.0.0.1:${port}`));
    if (typeof ctx.effect === 'function')
        ctx.effect(() => () => new Promise((resolve) => server.close(() => resolve())));
}
/* <<< dsh-qqbot-patch:bot-control-helper <<< */

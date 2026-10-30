/* >>> dsh-qqbot-patch:auto-compact-helper >>> */
/**
 * 自动压缩：turn/end 时检查最近一次请求的 prompt 体积，超过阈值就摘要压缩。
 *
 * - 阈值 QQBOT_AUTO_COMPACT_TOKENS（默认 60000）
 * - turn/end 时 agent 往往还没回到 idle，所以延迟 3s 再尝试，最多重试 3 次
 * - 同一会话 10 分钟冷却
 */
function setupAutoCompact(ctx, manager, config, logger) {
    const threshold = Number(process.env.QQBOT_AUTO_COMPACT_TOKENS ?? 60000);
    if (!Number.isFinite(threshold) || threshold <= 0)
        return;
    const COOLDOWN_MS = 10 * 60 * 1000;
    const lastCompactAt = new Map();
    // DSH 的同步事件读取被标记为 deprecated，session.events 在新版本里可能不存在，
    // 这里按 snapshotEvents() → events → log 的顺序兜底，别又读成 0。
    const eventsOf = (session) => {
        if (!session)
            return [];
        if (typeof session.snapshotEvents === 'function') {
            try { return session.snapshotEvents(); }
            catch { /* 落到下面的兜底 */ }
        }
        if (Array.isArray(session.events))
            return session.events;
        if (Array.isArray(session.log))
            return session.log.filter((event) => event !== undefined);
        return [];
    };
    const promptSizeOf = (session) => {
        const events = eventsOf(session);
        if (events.length === 0)
            return 0;
        for (let i = events.length - 1; i >= 0; i -= 1) {
            const event = events[i];
            // 事件形状是 { type, seq, time, data }，usage 在 data 里；
            // 老代码读的是 event.usage（永远是 undefined），所以这个函数一直返回 0，
            // 自动压缩从来没触发过（2026-10-27 查到的真正原因）。
            const payload = event?.data ?? event;
            const usage = payload?.usage ?? event?.usage;
            if (event?.type !== 'assistant/message' || !usage)
                continue;
            const u = usage;
            const pick = (...keys) => {
                for (const k of keys) {
                    if (typeof u[k] === 'number')
                        return u[k];
                }
                return 0;
            };
            return pick('input', 'inputTokens') + pick('cacheRead', 'cacheReadTokens') + pick('cacheWrite', 'cacheWriteTokens');
        }
        return 0;
    };
    const attempt = (record, size, tries = 0) => {
        try {
            const key = record.sessionKey;
            if (Date.now() - (lastCompactAt.get(key) ?? 0) < COOLDOWN_MS)
                return;
            const status = record.agent?.status;
            if (status !== 'idle') {
                if (tries < 3)
                    setTimeout(() => attempt(record, size, tries + 1), 3000);
                return;
            }
            lastCompactAt.set(key, Date.now());
            console.log(`[im-qqbot] 自动压缩触发: ${key} prompt≈${size} tokens`);
            void manager.compact(record.scope, record.peerId).then((outcome) => {
                if (outcome?.ok && outcome.shadowed)
                    console.log(`[im-qqbot] 自动压缩完成: ${key} 压缩 ${outcome.shadowed} 条 / ${outcome.tokens ?? 0} tokens`);
                else
                    console.log(`[im-qqbot] 自动压缩跳过: ${key} reason=${outcome?.reason ?? 'noop'}`);
            }).catch((err) => {
                console.log(`[im-qqbot] 自动压缩失败: ${key} ${err instanceof Error ? err.message : String(err)}`);
            });
        }
        catch (err) {
            console.log(`[im-qqbot] 自动压缩异常: ${err instanceof Error ? err.message : String(err)}`);
        }
    };
    const handler = (session, raw) => {
        try {
            if ((raw?.type ?? raw?.event?.type) !== 'turn/end')
                return;
            const record = manager.findBySessionId?.(session?.header?.id);
            if (!record) {
                console.log('[im-qqbot] 自动压缩: turn/end 找不到会话记录');
                return;
            }
            const size = promptSizeOf(record.agent?.session);
            if (size < threshold)
                return;
            console.log(`[im-qqbot] 自动压缩候选: ${record.sessionKey} prompt≈${size} tokens`);
            attempt(record, size);
        }
        catch {
            // 压缩是优化，不影响对话
        }
    };
    ctx.on('session/event', handler);
    // 兜底扫描：实测（2026-10-27）这个 session/event 钩子在当前 DSH 版本上根本收不到
    // turn/end（翻遍日志一条「候选」都没有），于是上下文从 11 万一路涨到 30 万才开始复读卡死。
    // 这里每 60 秒自己扫一遍所有会话，超阈值 + idle 就压，不依赖事件。
    let scans = 0;
    const scan = () => {
        try {
            scans += 1;
            const sessions = manager.sessions;
            if (!sessions || typeof sessions.values !== 'function')
                return;
            const sizes = [];
            for (const record of sessions.values()) {
                const size = promptSizeOf(record.agent?.session);
                sizes.push(`${record.sessionKey}=${size}`);
                if (size < threshold)
                    continue;
                console.log(`[im-qqbot] 自动压缩候选(定时): ${record.sessionKey} prompt≈${size} tokens`);
                attempt(record, size);
            }
            // 有会话就把当前体积打出来（每分钟一行），没有就前三次报一声，方便排障
            if (sizes.length > 0)
                console.log(`[im-qqbot] 自动压缩扫描: ${sizes.join(', ')}`);
            else if (scans <= 3)
                console.log('[im-qqbot] 自动压缩扫描: (暂无活跃会话)');
        }
        catch (err) {
            console.log(`[im-qqbot] 自动压缩扫描异常: ${err instanceof Error ? err.message : String(err)}`);
        }
    };
    const timer = setInterval(scan, 60 * 1000);
    if (typeof timer.unref === 'function')
        timer.unref();
    console.log(`[im-qqbot] 自动压缩已启用（阈值 ${threshold} tokens，冷却 10 分钟，60 秒扫描一次）`);
}
/* <<< dsh-qqbot-patch:auto-compact-helper <<< */

/* >>> dsh-qqbot-patch:ws-logging >>> */
    logger.info(`QQBot SDK initialized (UA: ${userAgent})`);
    // ── 连接事件探针：把 WebSocket 掉线/恢复/错误打到 stdout，便于定位“连接错误” ──
    bot.on('disconnected', (info) => console.log('[im-qqbot-ws] 断开', JSON.stringify(info ?? {}).slice(0, 300)));
    bot.on('resumed', () => console.log('[im-qqbot-ws] 已恢复'));
    bot.on('ready', () => console.log('[im-qqbot-ws] ready'));
    bot.on('error', (err) => console.log('[im-qqbot-ws] 错误', err instanceof Error ? err.message : String(err).slice(0, 300)));
/* <<< dsh-qqbot-patch:ws-logging <<< */

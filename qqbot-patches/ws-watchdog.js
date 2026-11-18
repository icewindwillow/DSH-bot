/* >>> dsh-qqbot-patch:ws-watchdog >>> */
    bot.on('ready', () => {
        console.log(`[im-qqbot] Bot ready! appId=${config.appId}`);
    });
    // ── 连接看门狗 ──
    // 卡在连接阶段（永不 ready）或掉线后不恢复时主动退出进程，交给 launchd 的 KeepAlive 拉起。
    // 背景：SDK 的 bot.start() 在连接阶段可能无限挂起，既不报错也不触发 disconnected，
    // 进程看起来还活着（/health 正常），但一条消息都收不到。
    const wsBootMs = Number(process.env.QQBOT_WS_BOOT_MS ?? 90_000);
    const wsDownMs = Number(process.env.QQBOT_WS_DOWN_MS ?? 180_000);
    const wsState = { ready: false, downSince: 0 };
    const wsBootTimer = setTimeout(() => {
        if (wsState.ready) return;
        console.log(`[im-qqbot-ws] 看门狗：启动 ${Math.round(wsBootMs / 1000)} 秒仍未 ready，退出等待重启`);
        process.exit(1);
    }, wsBootMs);
    wsBootTimer.unref();
    bot.on('ready', () => {
        wsState.ready = true;
        wsState.downSince = 0;
        clearTimeout(wsBootTimer);
    });
    bot.on('resumed', () => {
        wsState.ready = true;
        wsState.downSince = 0;
    });
    try {
        bot.on('disconnected', (event) => {
            if (event?.willReconnect === false) {
                console.log('[im-qqbot-ws] 看门狗：SDK 放弃重连，退出等待重启');
                process.exit(1);
            }
            if (!wsState.downSince) wsState.downSince = Date.now();
        });
    }
    catch { /* 旧版 SDK 没有 disconnected 事件 */ }
    setInterval(() => {
        if (!wsState.downSince || Date.now() - wsState.downSince < wsDownMs) return;
        console.log(`[im-qqbot-ws] 看门狗：掉线超过 ${Math.round(wsDownMs / 1000)} 秒未恢复，退出等待重启`);
        process.exit(1);
    }, 15_000).unref();
/* <<< dsh-qqbot-patch:ws-watchdog <<< */

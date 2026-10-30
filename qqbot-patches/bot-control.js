/* >>> dsh-qqbot-patch:bot-control >>> */
    setupTtsTool(ctx, bot, config, logger);
    // 本地面板用的群操作接口（新会话 / 压缩），只监听 127.0.0.1
    setupBotControl(ctx, manager, config, logger);
/* <<< dsh-qqbot-patch:bot-control <<< */

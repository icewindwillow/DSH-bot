/* >>> dsh-qqbot-patch:reminders >>> */
    // ── 中间件链 ──
    setupMiddlewares(bot, config, manager, logger);
    // 提醒功能：注册 set_reminder / list_reminders / cancel_reminder 三个工具，
    // 并起一个 20 秒轮询的定时器，到点用主动消息发到当初那个会话。
    setupReminders(ctx, bot, manager, config, logger);
/* <<< dsh-qqbot-patch:reminders <<< */

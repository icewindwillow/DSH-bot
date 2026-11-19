/* >>> dsh-qqbot-patch:events >>> */
    setupPersonCard(ctx, logger);
    setupPersonState(ctx, config, logger, manager);
    // 事件追踪（判定复用群记忆，单独维护待跟进状态）
    setupEvents(ctx, bot, config, logger);
/* <<< dsh-qqbot-patch:events <<< */

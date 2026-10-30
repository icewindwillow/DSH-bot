/* >>> dsh-qqbot-patch:mood >>> */
    setupBotControl(ctx, manager, config, logger);
    // 心情状态机（按群 + 全局底色；只影响语气/接话/表情，不改关系）
    setupMood(ctx, bot, config, logger);
/* <<< dsh-qqbot-patch:mood <<< */

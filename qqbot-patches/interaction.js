/* >>> dsh-qqbot-patch:interaction >>> */
    setupDiary(ctx, logger);
    // 互动事件检测（短时间高强度互动 → 事件日记）
    setupInteraction(ctx, bot, config, logger);
    // 群友之间的互动边（谁和谁常搭话/有点摩擦），只做规则提取，不调模型
    setupGroupRelations(ctx, bot, config, logger);
/* <<< dsh-qqbot-patch:interaction <<< */

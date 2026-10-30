/* >>> dsh-qqbot-patch:profile-tools >>> */
    // 上下文超过阈值时自动压缩历史（省 token），配合 sessionIdleTimeout 做闲置回收
    setupAutoCompact(ctx, manager, config, logger);
    // 人物档案自动补全工具（update_person_profile）
    setupProfileTools(ctx, logger);
/* <<< dsh-qqbot-patch:profile-tools <<< */

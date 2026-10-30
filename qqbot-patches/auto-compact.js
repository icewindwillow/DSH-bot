/* >>> dsh-qqbot-patch:auto-compact >>> */
    // 提醒功能：注册 set_reminder / list_reminders / cancel_reminder 三个工具，
    // 并起一个 20 秒轮询的定时器，到点用主动消息发到当初那个会话。
    setupReminders(ctx, bot, manager, config, logger);
    // 上下文超过阈值时自动压缩历史（省 token），配合 sessionIdleTimeout 做闲置回收
    setupAutoCompact(ctx, manager, config, logger);
    // 人物档案自动补全工具（update_person_profile）
    setupProfileTools(ctx, logger);
    // 表情包图库（send_sticker）
    setupStickerTools(ctx, bot, config, logger);
    // 社会关系引擎（五维关系 + record_social_event）
    setupSocialEngine(ctx, logger);
    // 长期记忆门控（象信）
    setupMemoryGate(ctx, config, logger);
    // 每日近况汇总（象信判断是否合并）
    setupMemorySummary(ctx, logger);
    // 值得主动接一句的钩子（象信）
    setupHookJudge(ctx, logger);
    // 主语解析（象信，支持「我弟」这类代称）
    setupSubjectJudge(ctx, logger);
    // 社会事件裁判（异步、小上下文）
    setupSocialJudge(ctx, config, logger);
    // 情绪触发的自动发表情
    setupAutoSticker(ctx, bot, config, logger);
    // 语音合成（Edge TTS）→ QQ 语音
    setupTtsTool(ctx, bot, config, logger);
/* <<< dsh-qqbot-patch:auto-compact <<< */

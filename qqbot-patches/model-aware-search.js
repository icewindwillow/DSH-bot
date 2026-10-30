/* >>> dsh-qqbot-patch:model-aware-search >>> */
    const manager = new SessionManager(ctx, agents, config, logger);
    // 原有 web_search 工具入口不变；每次调用按当前会话的实际模型选原生后端。
    await setupModelAwareSearch(ctx, logger);
/* <<< dsh-qqbot-patch:model-aware-search <<< */

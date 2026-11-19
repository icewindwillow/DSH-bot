/* >>> dsh-qqbot-patch:model-failover >>> */
    // ── 入站：经过中间件链后的消息交给 dsh agent ──
    // free 断联/限流后在本轮重新准备备用模型，后台探活可用后切回。
    const readModelHealth = setupModelFailover(ctx, manager, logger);
    globalThis.__qqbotModelHealth = readModelHealth;
/* <<< dsh-qqbot-patch:model-failover <<< */

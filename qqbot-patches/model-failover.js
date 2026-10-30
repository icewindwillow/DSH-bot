/* >>> dsh-qqbot-patch:model-failover >>> */
    // free 断联一次就切 opencode-go，后台探活可用后切回（失败兜底，不影响主流程）
    setupModelFailover(ctx, config, logger);
/* <<< dsh-qqbot-patch:model-failover <<< */

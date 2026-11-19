/* >>> dsh-qqbot-patch:model-failover-helper >>> */
function setupModelFailover(ctx, manager, logger) {
    if (process.env.QQBOT_MODEL_FAILOVER !== 'on') return () => ({ status: 'disabled' });
    const FREE_PROVIDER = process.env.QQBOT_FREE_PROVIDER ?? 'our-free-model';
    const backup = {
        provider: process.env.QQBOT_FALLBACK_PROVIDER ?? 'opencode-go',
        model: process.env.QQBOT_FALLBACK_MODEL ?? 'deepseek-v4.1-flash',
        reasoningEffort: 'low',
    };
    const BACKUP_MAX_TOKENS = Math.max(256, Number(process.env.QQBOT_FALLBACK_MAX_TOKENS) || 8192);
    const PROBE_COOLDOWN_MS = Math.max(0, Number(process.env.QQBOT_FAILOVER_PROBE_COOLDOWN_MS ?? 30000));
    const PROBE_TIMEOUT_MS = Math.max(1000, Number(process.env.QQBOT_FAILOVER_PROBE_TIMEOUT_MS ?? 6000));
    const FLAP_COOLDOWN_MS = Math.max(0, Number(process.env.QQBOT_FAILOVER_FLAP_COOLDOWN_MS ?? 120000));
    const FAILOVER_CODES = new Set([
        'TRANSPORT', 'TIMEOUT', 'SERVER', 'RATE_LIMIT', 'STREAM_CUT', 'EMPTY_RESPONSE',
        'OVERLOADED', 'QUOTA', 'ACCOUNT_QUOTA', 'EAC_UPSTREAM_FAILED', 'NO_ADAPTER',
    ]);

    let llm;
    try { llm = ctx.get('llm'); } catch { /* The provider service may not be mounted. */ }
    if (!llm || typeof llm.stream !== 'function' || backup.provider === FREE_PROVIDER) {
        logger.warn?.('[im-qqbot] 模型兜底未启用：LLM 服务不可用或主备服务相同');
        return () => ({ status: 'unavailable' });
    }

    // 通道健康是全局的，轮次号只在各自的 agent 内有意义。
    const turns = new WeakMap();
    const primaryLimits = new WeakMap();
    let degraded = false;
    let probePassed = false;
    let probeController;
    let lastProbeAt = -Infinity;
    let lastRecoveredAt = -Infinity;
    let cooldown = PROBE_COOLDOWN_MS;
    let observation = { status: 'unknown' };
    let disposed = false;
    ctx.on('dispose', () => {
        disposed = true;
        probeController?.abort();
    });

    const observe = (status, reason) => {
        observation = { status, reason, observedAtMs: Date.now() };
    };
    const probeFree = async (primary) => {
        if (disposed || probeController || Date.now() - lastProbeAt < cooldown)
            return;
        lastProbeAt = Date.now();
        const controller = new AbortController();
        const beforeProbe = observation;
        probeController = controller;
        const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
        let ok = false;
        try {
            for await (const chunk of llm.stream({
                ...primary,
                system: 'You are a health probe. Reply with one word.',
                messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
                maxTokens: 16,
                signal: controller.signal,
            })) {
                if (chunk.type === 'finish')
                    ok = ['stop', 'completed', 'max-tokens'].includes(chunk.reason?.kind);
            }
        }
        catch { /* A failed probe keeps the circuit on the backup. */ }
        finally {
            clearTimeout(timer);
            probeController = undefined;
        }
        if (disposed || observation !== beforeProbe) return;
        probePassed = ok && !controller.signal.aborted;
        observe(probePassed ? 'probe_passed' : 'degraded', probePassed ? 'primary_probe_passed' : 'primary_probe_failed');
        logger.info?.(`[im-qqbot] 模型兜底：主模型探活${probePassed ? '成功，下个新轮次切回' : '失败，继续使用备用'}`);
    };

    ctx.on('agent/step-model', async ({ agent, turn, signal }, next) => {
        const primary = await next();
        if (signal?.aborted || primary?.provider !== FREE_PROVIDER || !manager.findByAgent(agent))
            return primary;
        let active = turns.get(agent);
        if (active?.turn !== turn) {
            if (degraded && probePassed) {
                degraded = false;
                probePassed = false;
                lastRecoveredAt = Date.now();
                logger.info?.('[im-qqbot] 模型兜底：主模型已恢复');
            }
            active = { turn, useBackup: degraded };
            turns.set(agent, active);
            if (active.useBackup) void probeFree(primary);
        }
        return active.useBackup ? backup : primary;
    });

    ctx.on('agent/request-error', ({ agent, turn, provider, failure, signal }, next) => {
        const active = turns.get(agent);
        if (signal?.aborted || provider !== FREE_PROVIDER || active?.turn !== turn
            || active.useBackup || !FAILOVER_CODES.has(failure?.code))
            return next();

        const flapped = Date.now() - lastRecoveredAt < FLAP_COOLDOWN_MS;
        cooldown = flapped ? Math.max(PROBE_COOLDOWN_MS, FLAP_COOLDOWN_MS) : PROBE_COOLDOWN_MS;
        degraded = true;
        probePassed = false;
        probeController?.abort();
        observe('degraded', failure.code);
        active.useBackup = true;
        logger.warn?.(`[im-qqbot] 模型兜底：主模型失败（${failure.code}），本轮切到 ${backup.provider}/${backup.model}`);
        return { kind: 'retry', reprepare: true };
    }, { prepend: true });

    ctx.on('agent/request', async ({ agent, turn }, next) => {
        const seed = await next();
        const active = turns.get(agent);
        if (active?.turn !== turn) return seed;
        const previous = agent.session.requestHeader()?.config;
        if (seed.provider === FREE_PROVIDER) {
            // 上一条 header 可能是备用模型。恢复主模型的请求上限，让适配器再应用自己的默认值。
            if (previous?.provider !== backup.provider || previous.model !== backup.model)
                return seed;
            const { maxTokens: _backupLimit, ...primaryConfig } = seed;
            const limit = primaryLimits.has(agent) ? primaryLimits.get(agent) : agent.options?.maxTokens;
            return limit === undefined ? primaryConfig : { ...primaryConfig, maxTokens: limit };
        }
        if (!active.useBackup || seed.provider !== backup.provider || seed.model !== backup.model
            || agent.model.current()?.provider !== FREE_PROVIDER)
            return seed;
        if (!primaryLimits.has(agent) || previous?.provider === FREE_PROVIDER)
            primaryLimits.set(agent, seed.maxTokens);
        return { ...seed, maxTokens: Math.min(seed.maxTokens ?? BACKUP_MAX_TOKENS, BACKUP_MAX_TOKENS) };
    });

    logger.info?.(`[im-qqbot] 模型断联兜底已启用（${FREE_PROVIDER} → ${backup.provider}/${backup.model}）`);
    return () => ({
        ...observation,
        preferredRoute: degraded ? 'fallback' : 'primary',
        probeInFlight: !!probeController,
    });
}
/* <<< dsh-qqbot-patch:model-failover-helper <<< */

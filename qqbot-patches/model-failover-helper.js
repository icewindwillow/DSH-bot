/* >>> dsh-qqbot-patch:model-failover-helper >>> */
/**
 * 模型断联兜底（free → opencode-go，探活后切回）
 *
 * - free 路由**一次**连接失败（TRANSPORT）就立即改走 opencode-go 重跑本步，
 *   不再在同一个出口上退避重试（配合 dsh-our-free-model 把 TRANSPORT 移出可重试码）。
 * - 之后每条消息仍先用 opencode-go 回，同时在后台发一个**极小的 ping** 探 free；
 *   探活成功 → 下一轮切回 free。
 * - 探活不带真实对话，不会把主对话的提示词再发一遍，避免重复计费和污染缓存。
 * - 切回 free 时，故障前已缓存的前缀仍然命中；只有故障那一轮的 assistant 回复是新的后缀。
 * - 同一轮里不会来回换 provider（按 turn 锁定），避免缓存反复失效。
 */
function setupModelFailover(ctx, config, logger) {
    // 跨服务商兜底可能额外收费并转发上下文，必须由管理员显式同意。
    if (process.env.QQBOT_MODEL_FAILOVER !== 'on') return;
    const FREE_PROVIDER = process.env.QQBOT_FREE_PROVIDER ?? 'our-free-model';
    const FREE_MODEL = process.env.QQBOT_FREE_MODEL ?? 'kilo-auto/free';
    const BACKUP_PROVIDER = process.env.QQBOT_FALLBACK_PROVIDER ?? 'opencode-go';
    const BACKUP_MODEL = process.env.QQBOT_FALLBACK_MODEL ?? 'deepseek-v4.1-flash';
    const BACKUP_MAX_TOKENS = Math.max(256, Number(process.env.QQBOT_FALLBACK_MAX_TOKENS ?? 8192));
    const RETRY_CODES = new Set(['TRANSPORT', 'TIMEOUT', 'SERVER']);
    const PROBE_COOLDOWN_MS = Math.max(0, Number(process.env.QQBOT_FAILOVER_PROBE_COOLDOWN_MS ?? 30000));
    const PROBE_TIMEOUT_MS = Math.max(1000, Number(process.env.QQBOT_FAILOVER_PROBE_TIMEOUT_MS ?? 6000));
    const FLAP_COOLDOWN_MS = Math.max(0, Number(process.env.QQBOT_FAILOVER_FLAP_COOLDOWN_MS ?? 120000));

    let llm;
    try {
        llm = ctx.get('llm');
    }
    catch {
        llm = undefined;
    }
    if (!llm || typeof llm.stream !== 'function') {
        console.log('[im-qqbot] 模型兜底未启用：ctx.llm 不可用');
        return;
    }

    const states = new WeakMap();
    const stateOf = (agent) => {
        let state = states.get(agent);
        if (!state) {
            state = {
                degraded: false,   // free 当前是否已被判为不可用
                probing: false,
                probeOk: false,
                lastProbeAt: 0,
                pending: undefined, // { turn, step }：刚失败的这一步，重跑时必须走备用
                turn: -1,
                mode: 'free',
                cooldown: PROBE_COOLDOWN_MS,
                lastRecoveredAt: 0,
            };
            states.set(agent, state);
        }
        return state;
    };

    /** 会话自己选的模型（/model 或默认模型）；只在这个路由是 free 时才管 */
    const preferredOf = (agent) => {
        const options = (agent && agent.options) || {};
        return {
            provider: options.provider || FREE_PROVIDER,
            model: options.model || FREE_MODEL,
            reasoningEffort: options.reasoningEffort,
            maxTokens: options.maxTokens,
        };
    };

    const freeConfig = (seed, preferred) => {
        if (seed.provider === preferred.provider && seed.model === preferred.model)
            return seed;   // 正常轮次原样放行，不碰 reasoning / maxTokens
        const config = { ...seed, provider: preferred.provider, model: preferred.model };
        if (preferred.reasoningEffort)
            config.reasoningEffort = preferred.reasoningEffort;
        if (preferred.maxTokens)
            config.maxTokens = preferred.maxTokens;
        return config;
    };

    const backupConfig = (seed) => {
        const config = {
            ...seed,
            provider: BACKUP_PROVIDER,
            model: BACKUP_MODEL,
            maxTokens: Math.min(Number(seed.maxTokens) || BACKUP_MAX_TOKENS, BACKUP_MAX_TOKENS),
        };
        if (!config.reasoningEffort)
            config.reasoningEffort = 'low';
        return config;
    };

    /** 后台探活：最小请求、不落会话、不碰主对话缓存 */
    const probeFree = (state, preferred) => {
        if (state.probing)
            return;
        const now = Date.now();
        if (now - state.lastProbeAt < state.cooldown)
            return;
        state.probing = true;
        state.probeOk = false;
        state.lastProbeAt = now;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
        (async () => {
            let ok = false;
            try {
                const stream = llm.stream({
                    provider: preferred.provider,
                    model: preferred.model,
                    system: 'You are a health probe. Reply with one word.',
                    messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
                    maxTokens: 16,
                    signal: controller.signal,
                });
                for await (const chunk of stream) {
                    if (chunk && chunk.type === 'finish') {
                        const kind = chunk.reason && chunk.reason.kind;
                        ok = kind === 'completed' || kind === 'max-tokens';
                    }
                }
            }
            catch {
                ok = false;
            }
            finally {
                clearTimeout(timer);
                state.probing = false;
            }
            state.probeOk = ok;
            logger.info?.(`[im-qqbot] 模型兜底: free 探活${ok ? '成功，下一轮切回' : `失败，继续走 ${BACKUP_PROVIDER}`}`);
        })();
    };

    // 一次断联就在本步切备用，不等退避重试
    ctx.on('agent/request-error', (payload, next) => {
        const failure = payload.failure;
        if (payload.signal?.aborted)
            return next();
        if (!failure || !RETRY_CODES.has(failure.code) || payload.provider !== FREE_PROVIDER)
            return next();
        const state = stateOf(payload.agent);
        // 刚切回 free 又失败：说明还在抖，探活间隔拉长，避免每轮来回切、把两边的缓存都打散
        const flapped = state.lastRecoveredAt > 0 && Date.now() - state.lastRecoveredAt < FLAP_COOLDOWN_MS;
        state.cooldown = flapped ? Math.max(PROBE_COOLDOWN_MS, FLAP_COOLDOWN_MS) : PROBE_COOLDOWN_MS;
        state.degraded = true;
        state.probeOk = false;
        state.pending = { turn: payload.turn, step: payload.step };
        logger.info?.(`[im-qqbot] 模型兜底: free 连接失败（${failure.code}），本步改走 ${BACKUP_PROVIDER}`);
        return { kind: 'retry' };
    });

    // 失败那一步的重跑：换成 opencode-go；之后的轮次先走备用，同时后台探 free
    ctx.on('agent/request', async (payload, next) => {
        const seed = await next();
        const agent = payload.agent;
        const preferred = preferredOf(agent);
        if (preferred.provider !== FREE_PROVIDER)
            return seed;   // 用户/会话选了别的模型，不插手
        const state = stateOf(agent);

        let retried = false;
        if (state.pending && state.pending.turn === payload.turn && state.pending.step === payload.step) {
            state.pending = undefined;
            state.turn = payload.turn;
            state.mode = 'backup';
            retried = true;
        }

        if (!retried && state.turn !== payload.turn) {
            state.turn = payload.turn;
            if (state.degraded) {
                if (state.probeOk) {
                    state.degraded = false;
                    state.probeOk = false;
                    state.lastRecoveredAt = Date.now();
                    state.mode = 'free';
                    logger.info?.('[im-qqbot] 模型兜底: free 已恢复，切回 free');
                }
                else {
                    state.mode = 'backup';
                    probeFree(state, preferred);
                }
            }
            else {
                state.mode = 'free';
            }
        }

        return state.mode === 'backup' ? backupConfig(seed) : freeConfig(seed, preferred);
    });

    console.log(`[im-qqbot] 模型断联兜底已启用（${FREE_PROVIDER} → ${BACKUP_PROVIDER}/${BACKUP_MODEL}，后台探活切回）`);
}
/* <<< dsh-qqbot-patch:model-failover-helper <<< */

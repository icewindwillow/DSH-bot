/* >>> dsh-qqbot-patch:self-memory-hook >>> */
    // 私人记忆预取：每条群消息先在后台问一次象信「这碰到小易自己的哪段经历」，
    // 命中的缓存起来，轮到她说话时再按需带上（异步、不阻塞、不主动说）。
    // 放在门控之前：别人聊天没叫她时也要攒上下文。
    bot.use(async (ctx, next) => {
        try {
            const msg = ctx?.message;
            if (msg?.kind === 'group' && msg.groupOpenid)
                void globalThis.__qqbotSelfMemory?.prefetch?.(msg.groupOpenid, String(msg.content ?? ''), String(msg.senderId ?? ''));
        }
        catch {
            // 预取失败不影响消息
        }
        return next();
    });
    bot.use(messageFilter({ skipSelfEcho: false }));
/* <<< dsh-qqbot-patch:self-memory-hook <<< */

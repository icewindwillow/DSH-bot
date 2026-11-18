/* >>> dsh-qqbot-patch:meme-hook >>> */
    // 梗库预取：每条群消息先在后台问一次象信「这句在说库里的哪个梗」，
    // 命中的缓存起来，轮到她说话时直接把解释带上（异步、不阻塞、不改消息处理）。
    // 放在门控之前：别人聊天没叫她时也要攒上下文，「小张是谁」这种追问才接得住。
    bot.use(async (ctx, next) => {
        try {
            const msg = ctx?.message;
            if (msg?.kind === 'group' && msg.groupOpenid)
                void globalThis.__qqbotMeme?.prefetch?.(msg.groupOpenid, String(msg.content ?? ''));
        }
        catch {
            // 预取失败不影响消息
        }
        return next();
    });
    bot.use(messageFilter({ skipSelfEcho: false }));
/* <<< dsh-qqbot-patch:meme-hook <<< */

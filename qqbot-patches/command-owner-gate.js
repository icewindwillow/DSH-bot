/* >>> dsh-qqbot-patch:command-owner-gate >>> */
    // 8. 指令白名单：只有主人能触发斜杠指令，其他人发的 /xxx 静默丢弃
    //    （不回复、也不送进模型——否则模型会把 "/compact" 当普通聊天回一句）
    bot.use((ctx, next) => {
        const msg = ctx.message;
        if (!msg)
            return next();
        const cleaned = String(msg.content ?? '').trim().replace(/<@!?[^>]+>\s*/g, '').trim();
        if (!cleaned.startsWith('/'))
            return next();
        if (msg.kind === 'group') {
            const mentioned = msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE'
                || msg.mentions?.some((m) => m.is_you);
            if (!mentioned)
                return next();      // 没 @ 的斜杠文本按普通消息处理
        }
        if (isCommandOwner(msg))
            return next();
        console.log(`[im-qqbot] 非主人的指令已忽略: sender=${msg.senderId ?? '?'} group=${msg.groupOpenid ?? '-'} text=${cleaned.slice(0, 40)}`);
        return;
    });
    // 8. 斜杠命令（在 concurrencyGuard 之前，命令匹配后不排队直接响应）
    const slash = slashCommand({
        // 关闭 autoHelp：help 命令由 qqbot 注册为 /bot-help，
        // 避免 SDK 再自动注册一个无前缀的 /help 造成重复
        autoHelp: false,
        commands: buildCommandList({ manager, config }),
    });
    bot.use(slash.middleware);
/* <<< dsh-qqbot-patch:command-owner-gate <<< */

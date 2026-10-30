/* >>> dsh-qqbot-patch:reminder-target >>> */
    bot.on('message', async (mCtx) => {
        const msg = mCtx.message;
        // 记录最近一条入站消息来自哪个会话，供 set_reminder 决定提醒发到哪里
        globalThis.__qqbotLastTarget = {
            scope: msg.kind === 'group' ? 'group' : 'c2c',
            targetId: msg.groupOpenid ?? msg.senderId,
            msgId: mCtx.replyTarget?.msgId,
            at: Date.now(),
        };
/* <<< dsh-qqbot-patch:reminder-target <<< */

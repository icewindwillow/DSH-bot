/* >>> dsh-qqbot-patch:reminder-target >>> */
    bot.on('message', async (mCtx) => {
        const msg = mCtx.message;
        // 记录最近一条入站消息来自哪个会话，供 set_reminder 决定提醒发到哪里
        globalThis.__qqbotLastTarget = {
            scope: msg.kind === 'group' ? 'group' : 'c2c',
            targetId: msg.groupOpenid ?? msg.senderId,
            msgId: mCtx.replyTarget?.msgId,
            // 语音权限要知道是谁在说话；只记 id，不存消息内容。
            senderId: msg.senderId ?? '',
            kind: msg.kind === 'group' ? 'group' : 'c2c',
            groupOpenid: msg.groupOpenid ?? '',
            at: Date.now(),
        };
/* <<< dsh-qqbot-patch:reminder-target <<< */

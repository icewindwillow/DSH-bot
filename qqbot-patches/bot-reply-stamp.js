/* >>> dsh-qqbot-patch:bot-reply-stamp >>> */
                await this.bot.sendMarkdown(record.replyTarget, chunk);
                (globalThis.__qqbotLastBotReply ??= new Map()).set(record.replyTarget.targetId, Date.now());
                globalThis.__qqbotPersistWindows?.();
/* <<< dsh-qqbot-patch:bot-reply-stamp <<< */

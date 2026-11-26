/* >>> dsh-qqbot-patch:bot-reply-stamp >>> */
                await this.bot.sendMarkdown(record.replyTarget, chunk);
                if (String(process.env.QQBOT_LIVE2D_PET ?? 'on').toLowerCase() !== 'off') {
                    const petUrl = process.env.QQBOT_LIVE2D_PET_URL ?? 'http://127.0.0.1:17821/api/pet/event';
                    void fetch(petUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
                        text: String(chunk ?? ''), motion: 'Talk', scope: record.replyTarget?.scope, targetId: record.replyTarget?.targetId,
                    }), signal: AbortSignal.timeout(700) }).catch(() => {});
                }
                (globalThis.__qqbotLastBotReply ??= new Map()).set(record.replyTarget.targetId, Date.now());
                globalThis.__qqbotPersistWindows?.();
/* <<< dsh-qqbot-patch:bot-reply-stamp <<< */

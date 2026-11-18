/* >>> dsh-qqbot-patch:meme-prompt >>> */
            // 梗库：常驻一条硬规则；本群最近确实聊到过某个梗时，把预取命中的那条解释一起带上
            // （用到才注入，没提到就只有一个空串）
            let memeRecallText = '';
            if (record.scope === 'group') {
                try {
                    memeRecallText = (await globalThis.__qqbotMeme?.recallLine?.(record.peerId)) ?? '';
                }
                catch {
                    memeRecallText = '';
                }
            }
            const memeText = record.scope === 'group'
                ? [memeRecallText, globalThis.__qqbotMeme?.promptLine?.() ?? ''].filter(Boolean).join('\n')
                : '';
            if (memeText !== '')
                extraSections.push({ name: 'qqbot:meme', order: 94, text: memeText });
            const moodLine = record.scope === 'group' ? (globalThis.__qqbotMood?.promptLine?.(record.peerId) ?? '') : '';
/* <<< dsh-qqbot-patch:meme-prompt <<< */

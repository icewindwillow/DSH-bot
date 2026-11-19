/* >>> dsh-qqbot-patch:self-memory-prompt >>> */
            // 私人记忆：不常驻、不主动提；只有本群这段聊天真的碰到她自己的经历时才注入
            let selfMemoryText = '';
            if (record.scope === 'group') {
                try {
                    const recipient = roleSkillReplySpeaker(record.peerId, record);
                    selfMemoryText = (await globalThis.__qqbotSelfMemory?.recallLine?.(record.peerId, undefined, recipient?.id)) ?? '';
                }
                catch {
                    selfMemoryText = '';
                }
            }
            if (selfMemoryText !== '')
                extraSections.push({ name: 'qqbot:self-memory', order: 94, text: selfMemoryText });
            const moodLine = record.scope === 'group' ? (globalThis.__qqbotMood?.promptLine?.(record.peerId) ?? '') : '';
/* <<< dsh-qqbot-patch:self-memory-prompt <<< */

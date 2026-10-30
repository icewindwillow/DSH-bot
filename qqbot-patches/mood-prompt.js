/* >>> dsh-qqbot-patch:mood-prompt >>> */
                extraSections.push({ name: 'qqbot:person-feedback', order: 94, text: personFeedback });
            // 心情：必须放在所有动态段的最后（order 95），保证前缀缓存不被它打乱
            const moodLine = record.scope === 'group' ? (globalThis.__qqbotMood?.promptLine?.(record.peerId) ?? '') : '';
            if (moodLine !== '')
                extraSections.push({ name: 'qqbot:mood', order: 95, text: moodLine });
/* <<< dsh-qqbot-patch:mood-prompt <<< */

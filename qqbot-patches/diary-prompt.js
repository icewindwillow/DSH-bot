/* >>> dsh-qqbot-patch:diary-prompt >>> */
                extraSections.push({ name: 'qqbot:mood', order: 95, text: moodLine });
            // 自传日记：最近两篇手记，排在心情之后（动态段最末，缓存安全）
            const diaryLine = record.scope === 'group' ? (globalThis.__qqbotDiary?.promptLine?.(record.peerId) ?? '') : '';
            if (diaryLine !== '')
                extraSections.push({ name: 'qqbot:diary', order: 96, text: diaryLine });
/* <<< dsh-qqbot-patch:diary-prompt <<< */

/* >>> dsh-qqbot-patch:clock-prompt >>> */
                extraSections.push({ name: 'qqbot:diary', order: 96, text: diaryLine });
            // 当前时间与周表共享同一快照；都留在动态上下文，不打断系统提示和对话历史的缓存。
            const clockParts = beijingScheduleTime();
            if (groupPrompt?.entry?.useSchedule === true) {
                try {
                    const week = validatePersonaSchedule(readProfileDocument(groupPrompt.profileDir, 'persona-schedule'));
                    const text = personaSchedulePrompt(currentPersonaSchedule(week, clockParts), clockParts);
                    if (text) extraSections.push({ name: 'qqbot:persona-schedule', order: 97, text });
                }
                catch {
                    // 周表缺失或损坏时照常回复，仍提供时钟。
                }
            }
            const clockLine = `当前时间：${clockParts.date} ${clockParts.hour}:${clockParts.minute}（北京时间，${clockParts.weekday}）。判断「今天、昨天、刚才、最近」等时间时以此为准。`;
            extraSections.push({ name: 'qqbot:clock', order: 98, text: clockLine });
/* <<< dsh-qqbot-patch:clock-prompt <<< */

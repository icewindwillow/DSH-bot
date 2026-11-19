/* >>> dsh-qqbot-patch:clock-prompt >>> */
                extraSections.push({ name: 'qqbot:diary', order: 96, text: diaryLine });
            // 当前时间：每轮重新计算，排在所有动态段最后，尽量不打断前缀缓存
            const clockParts = Object.fromEntries(new Intl.DateTimeFormat('zh-CN', {
                timeZone: 'Asia/Shanghai', hour12: false,
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', weekday: 'long',
            }).formatToParts(new Date()).map((part) => [part.type, part.value]));
            const clockLine = `当前时间：${clockParts.year}-${clockParts.month}-${clockParts.day} ${clockParts.hour}:${clockParts.minute}（北京时间，${clockParts.weekday}）。判断「今天、昨天、刚才、最近」等时间时以此为准。`;
            extraSections.push({ name: 'qqbot:clock', order: 97, text: clockLine });
/* <<< dsh-qqbot-patch:clock-prompt <<< */

/* >>> dsh-qqbot-patch:people-roster >>> */
            // 群成员档案：拆成「静态档案」+「动态说话人上下文」，让静态前缀能被 prompt cache 命中
            const roster = record.scope === 'group' ? buildPeopleRoster(record.peerId) : '';
            const speakerCtx = record.scope === 'group' ? buildSpeakerContext(record.peerId, record) : '';
            if (!prompt && roster === '' && speakerCtx === '')
                return assembled;
            const extraSections = [];
            if (prompt)
                extraSections.push({ name: 'qqbot:scope-prompt', order: 90, text: prompt });
            if (roster !== '')
                extraSections.push({ name: 'qqbot:people-roster', order: 91, text: roster });
            if (speakerCtx !== '')
                extraSections.push({ name: 'qqbot:speaker-context', order: 92, text: speakerCtx });
            if (process.env.QQBOT_PROMPT_DEBUG === '1') {
                try {
                    appendFileSync(`${process.env.HOME ?? ''}/.dsh/profiles/qqbot/qqbot-prompt-debug.log`, `${new Date().toISOString()} scope=${record.scope} peerId=${record.peerId} prompt=${prompt ? prompt.length : 0} roster=${roster.length} speaker=${speakerCtx.length} role=${typeof roleSkill === 'string' ? roleSkill.length : 0} sections=${extraSections.length}\n`);
                }
                catch {
                    // 调试日志失败不影响对话
                }
            }
            return { ...assembled, sections: [...(assembled.sections ?? []), ...extraSections] };
/* <<< dsh-qqbot-patch:people-roster <<< */

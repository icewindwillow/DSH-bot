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
            // 动态段不能留在 system prompt：system 只要变一个字符，后面的整段对话历史都会失去前缀缓存。
            // 改注入 runtime context（当轮消息之后的快照），system 与历史前缀保持稳定，缓存才能跨轮命中。
            const dynamicNames = new Set([
                'qqbot:speaker-context',
                'qqbot:role-skill',
                'qqbot:person-feedback',
                'qqbot:mood',
                'qqbot:diary',
                'qqbot:clock',
            ]);
            // 长期记忆列表（ltm:recall）同样是动态内容：每写一条新记忆，system 就变一次。
            // 一并挪进 runtime context，避免 DSH 为一次记忆更新重发整份 system prompt。
            const systemSections = assembled.sections ?? [];
            const ltmContexts = systemSections
                .filter((section) => section.name === 'ltm:recall')
                .map((section) => ({ ...section, order: 50, interpolate: false }));
            const staticSections = [
                ...systemSections.filter((section) => section.name !== 'ltm:recall'),
                ...extraSections.filter((section) => !dynamicNames.has(section.name)),
            ];
            const dynamicContexts = extraSections
                .filter((section) => dynamicNames.has(section.name))
                .map((section) => ({ ...section, interpolate: false }));
            return {
                ...assembled,
                sections: staticSections,
                contexts: [...(assembled.contexts ?? []), ...ltmContexts, ...dynamicContexts],
            };
/* <<< dsh-qqbot-patch:people-roster <<< */

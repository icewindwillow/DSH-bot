/* >>> dsh-qqbot-patch:group-prompt >>> */
            // 群聊：优先取 qqbot-groups.json 里该 group_openid 的人设，
            // 其次 prompts["*"]，最后回落到插件 config.groupPrompt；
            // 末尾统一追加 GROUP_RULES（群聊行为守则，所有群共用）。
            // 私聊仍走 config.directPrompt，不追加守则。
            const basePrompt = record.scope === 'group'
                ? (readGroupPromptOverride(record.peerId) ?? this.config.groupPrompt ?? '')
                : this.config.directPrompt;
            const prompt = record.scope === 'group'
                ? `${basePrompt}${GROUP_RULES}`
                : basePrompt;
/* <<< dsh-qqbot-patch:group-prompt <<< */

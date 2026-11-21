/* >>> dsh-qqbot-patch:group-prompt >>> */
            // 群聊：优先取 groups-config 里该 group_openid 的人设，
            // 其次 prompts["*"]，最后回落到插件 config.groupPrompt；
            // 末尾统一追加 GROUP_RULES（群聊行为守则，所有群共用）。
            // 私聊仍走 config.directPrompt，不追加守则。
            const groupPrompt = record.scope === 'group' ? resolveGroupPrompt(record.peerId) : undefined;
            const basePrompt = record.scope === 'group'
                ? (groupPrompt?.text ?? this.config.groupPrompt ?? '')
                : this.config.directPrompt;
            const stickerUsage = record.scope === 'group' ? readStickerUsageBlock(record.peerId) : '';
            // 主人刚开了「允许对话」：这段时间明确告诉她可以回那个机器人的消息，
            // 否则按群聊守则「没叫你就 [SILENT]」会把机会吞掉。
            const allowTargets = record.scope === 'group'
                ? (globalThis.__qqbotObserveBot?.labelsForGroup?.(record.peerId) ?? []).join('、')
                : '';
            const allowChatBlock = record.scope === 'group'
                && globalThis.__qqbotAllowChat?.isActive?.(record.peerId) === true
                ? `【允许对话】主人刚才允许你在这段时间里回复群里的观察对象${allowTargets ? `（${allowTargets}）` : ''}：它说话就正常接一句，不要因为「没叫你」就直接 [SILENT]。时限到了以后恢复原来的规矩。`
                : '';
            const prompt = record.scope === 'group'
                ? `${basePrompt}${GROUP_RULES}${stickerUsage}`
                : basePrompt;
/* <<< dsh-qqbot-patch:group-prompt <<< */

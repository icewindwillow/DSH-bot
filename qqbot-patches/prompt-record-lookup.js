/* >>> dsh-qqbot-patch:prompt-record-lookup >>> */
            // 优先按 agent 实例找记录，退化为按 sessionId 找：
            // agent-loop 里 context.agent 可能不是当初 getOrCreate 存下的同一个实例
            // （子 agent / fork / 包装器），只按实例找会导致整段人设与档案被跳过。
            const record = this.findByAgent(context.agent)
                ?? this.findBySessionId(context.agent?.session?.header?.id ?? '');
            if (process.env.QQBOT_PROMPT_DEBUG === '1') {
                try {
                    appendFileSync(`${process.env.HOME ?? ''}/.dsh/profiles/qqbot/qqbot-prompt-debug.log`, `${new Date().toISOString()} assemble agent=${context.agent ? 'yes' : 'no'} sessionId=${context.agent?.session?.header?.id ?? '?'} record=${record ? `${record.scope}:${record.peerId}` : 'none'}\n`);
                }
                catch {
                    // 调试日志失败不影响对话
                }
            }
/* <<< dsh-qqbot-patch:prompt-record-lookup <<< */

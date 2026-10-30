/* >>> dsh-qqbot-patch:memory-scope >>> */
        this.sessions.set(key, record);
        // 给这个会话登记稳定的记忆 scope，供 dsh-ltm 读取：
        // 每个群 / 每个私聊一套记忆，不依赖 cwd（resume 时 cwd 改不了）。
        (globalThis.__qqbotMemoryScopeBySession ??= {})[sessionId] = `qq:${scope}:${peerId}`;
/* <<< dsh-qqbot-patch:memory-scope <<< */

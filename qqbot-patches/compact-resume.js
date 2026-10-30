/* >>> dsh-qqbot-patch:compact-resume >>> */
            let outcome = await manager.compact(scope, peerId);
            if (!outcome.ok && outcome.reason === 'no-session') {
                // 机器人重启后 manager.sessions 是空的（会话要等一条普通消息才会被恢复），
                // 这时 /compact 只会回「当前无活跃会话」。这里先把会话恢复出来再压。
                try {
                    const msg = cmdCtx.message ?? {};
                    await manager.getOrCreate(scope, peerId, msg.senderId, {
                        scope,
                        targetId: peerId,
                        msgId: msg.messageId,
                    });
                    outcome = await manager.compact(scope, peerId);
                }
                catch (err) {
                    return `恢复会话失败: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
/* <<< dsh-qqbot-patch:compact-resume <<< */

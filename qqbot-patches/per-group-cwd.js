/* >>> dsh-qqbot-patch:per-group-cwd >>> */
                        // 每个群 / 每个私聊用独立工作区目录：
                        // dsh-ltm 的 autoProjectScope 按 session.header.cwd 分片，
                        // 这样每个群自然得到一套独立记忆。
                        cwd: resolveQqbotWorkspaceCwd(this.config, scope, peerId),
/* <<< dsh-qqbot-patch:per-group-cwd <<< */

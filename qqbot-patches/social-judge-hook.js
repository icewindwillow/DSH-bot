/* >>> dsh-qqbot-patch:social-judge-hook >>> */
        await handleInbound(mCtx, manager, config, logger);
        // 图片分享归档：复制到机器人媒体库（QQ 清理临时图也不会丢）
        void globalThis.__qqbotMediaArchive?.archive(mCtx);
        // 异步社会事件裁判：不阻塞回复，失败静默
        void globalThis.__qqbotSocialJudge?.consider(mCtx);
        // 情绪触发的自动表情（同样异步，失败静默）
        void globalThis.__qqbotAutoSticker?.maybe(mCtx);
        // 炫耀/卖关子/分享 的主动接话判断
        void globalThis.__qqbotHookJudge?.consider(mCtx);
        // 这句话在说谁（代称 → 具体人）
        void globalThis.__qqbotSubjectJudge?.consider(mCtx);
/* <<< dsh-qqbot-patch:social-judge-hook <<< */

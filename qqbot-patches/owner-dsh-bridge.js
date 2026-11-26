/* >>> dsh-qqbot-patch:owner-dsh-bridge >>> */
    bot.use(rateLimiter());
    const ownerDshBridgeLoad = (async () => {
        const fs = process.getBuiltinModule('node:fs');
        const path = process.getBuiltinModule('node:path');
        const os = process.getBuiltinModule('node:os');
        const url = process.getBuiltinModule('node:url');
        const bridgeDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'owner-dsh-bridge');
        const options = JSON.parse(fs.readFileSync(path.join(bridgeDir, 'qq.json'), 'utf8'));
        let loadAccess = () => JSON.parse(fs.readFileSync(path.join(bridgeDir, 'qq.json'), 'utf8'));
        if (typeof options.qqProfile === 'string' && path.isAbsolute(options.qqProfile)) {
            const [{ personalAccessForProfile }, { readProfileDocument }] = await Promise.all([
                import(url.pathToFileURL(path.join(bridgeDir, 'personal-profile.mjs')).href),
                import(url.pathToFileURL(path.join(bridgeDir, 'profile-documents.mjs')).href),
            ]);
            const grants = personalAccessForProfile(bridgeDir, options.qqProfile, readProfileDocument);
            loadAccess = grants.load;
        }
        if (typeof options.owner !== 'string' || !options.owner || !path.isAbsolute(options.socket ?? ''))
            throw new Error('Invalid owner bridge configuration');
        const { createOwnerDshMiddleware } = await import(url.pathToFileURL(path.join(bridgeDir, 'qq.mjs')).href);
        console.log('[im-qqbot] DSH 委派、个人技能与现有会话提醒已启用');
        let llm;
        try { llm = ctx.get('llm'); } catch { llm = undefined; }
        let defaultModel;
        try { defaultModel = ctx.get('agentDefaultModel'); } catch { defaultModel = undefined; }
        const getDefaultSelection = () => {
            try { return defaultModel?.currentSelection?.(); } catch { return undefined; }
        };
        return createOwnerDshMiddleware(bot, {
            socket: options.socket, loadAccess, watchNotifications: true, logger, config, llm, getDefaultSelection,
        });
    })().catch(error => {
        if (error?.code !== 'ENOENT') logger.warn?.('Owner DSH private delegation could not start');
        return undefined;
    });
    const ownerDshBridge = Promise.race([
        ownerDshBridgeLoad,
        new Promise(resolve => setTimeout(() => {
            logger.warn?.('Owner DSH bridge startup timed out; QQBot continues without the bridge');
            resolve(undefined);
        }, 5000)),
    ]);
    bot.use(async (state, next) => {
        const delegate = await ownerDshBridge;
        if (!delegate) return next();
        // 桥接排在附件下载之前：先把当前消息和引用消息里的图片落到本地，
        // qq.mjs 才能把 localPath 交给桌面 Host。普通聊天后面的下载会复用 downloadedFiles。
        const msg = state.message;
        if (msg && ((Array.isArray(msg.attachments) && msg.attachments.length > 0) || msg.refMsgIdx)) {
            if (msg.refMsgIdx && !state.state?.quote && Array.isArray(msg.msgElements) && msg.msgElements[0]) {
                const element = msg.msgElements[0];
                const rawAttachments = Array.isArray(element.attachments) ? element.attachments : [];
                if (String(element.content ?? '').trim() || rawAttachments.length > 0) {
                    const attachments = rawAttachments.map(attachment => ({
                        contentType: String(attachment?.content_type ?? attachment?.contentType ?? ''),
                        url: String(attachment?.url ?? ''),
                        filename: String(attachment?.filename ?? ''),
                        asrText: String(attachment?.asr_refer_text ?? ''),
                    }));
                    state.state.quote = {
                        refKey: msg.refMsgIdx,
                        source: 'msg_elements',
                        rawContent: String(element.content ?? ''),
                        attachments,
                        text: String(element.content ?? '').trim() || '[quoted message]',
                    };
                }
            }
            const quoteAttachments = Array.isArray(state.state?.quote?.attachments) ? state.state.quote.attachments : [];
            if ((Array.isArray(msg.attachments) && msg.attachments.length > 0) || quoteAttachments.length > 0) {
                try { await attachmentProcessor(config, logger)(state, async () => {}); } catch { /* 下载失败时交给后面的正常链路 */ }
            }
        }
        return delegate(state, next);
    });
/* <<< dsh-qqbot-patch:owner-dsh-bridge <<< */

/* >>> dsh-qqbot-patch:owner-dsh-bridge >>> */
    bot.use(rateLimiter());
    const ownerDshBridge = (async () => {
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
        return createOwnerDshMiddleware(bot, { socket: options.socket, loadAccess, watchNotifications: true, logger });
    })().catch(error => {
        if (error?.code !== 'ENOENT') logger.warn?.('Owner DSH private delegation could not start');
        return undefined;
    });
    bot.use(async (state, next) => {
        const delegate = await ownerDshBridge;
        return delegate ? delegate(state, next) : next();
    });
/* <<< dsh-qqbot-patch:owner-dsh-bridge <<< */

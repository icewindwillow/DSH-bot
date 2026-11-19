/* >>> dsh-qqbot-patch:early-work-reply >>> */
    const declinesWholeGame = (content) => {
        const text = String(content ?? '').trim();
        if (/^[>「“"\/`]|(?:是什么|怎么做|如何实现|是什么意思)\s*[？?]?$/.test(text))
            return false;
        const clauses = text.split(/[，。；;！!\n]/).map(clause => clause.trim());
        const requestPrefix = /^(?:小易[、：: ]*)?(?:(?:请你?|麻烦你?|能不能|能否|可以|帮我|给我|让你|你先|你再|你来|你|先|再|然后|接着|最后)\s*)*(?:(?:使用|用)\s*[\w#+.]+\s*)?/iu;
        const tasks = clauses.map(clause => clause.replace(requestPrefix, ''));
        return tasks.some(task => /^(?:做|开发|制作|写|复刻|重做)(?:一[个款]|整[个款]|一整[个款]|完整(?:的|版)?)?(?:完整(?:的|版)?\s*)?(?:游戏|杀戮尖塔|GTA\s*6)(?:吧|给我|好吗|[？?])?$/iu.test(task));
    };
    const readWorkVoice = (gid) => {
        const doc = readProfileDocument(gateProfileDir, 'personas');
        const entry = doc.personas?.[gid] ?? doc.personas?.['*'] ?? doc.personas?.default;
        const isWhale = (Array.isArray(entry) ? entry : entry?.modules)?.includes('whale.identity');
        const shortTempered = globalThis.__qqbotMood?.promptLine?.(gid)?.includes('耐心快没了');
        return { isWhale, shortTempered };
    };
    bot.use(async (ctx, next) => {
        const msg = ctx.message;
        const target = ctx.replyTarget;
        if (process.env.QQBOT_COMPLEX_WORK !== 'on' || msg?.kind !== 'group' || target?.scope !== 'group' || target.targetId !== msg.groupOpenid || !target.msgId
            || globalThis.__qqbotMention?.addressed?.(msg) !== true
            || globalThis.__qqbotIsIgnoredSender?.(msg.senderId, msg.senderName))
            return next();
        if (!declinesWholeGame(msg.content))
            return next();
        try {
            const { isWhale, shortTempered } = readWorkVoice(msg.groupOpenid);
            const suffix = isWhale ? '呀。' : '喵。';
            const text = shortTempered ? '整款游戏我做不了，这活我不接。' : `整款游戏我做不了，这活我接不了${suffix}`;
            await bot.sendText(target, text);
            globalThis.__qqbotLastBotReply?.set?.(msg.groupOpenid, Date.now());
            logger.info?.('群聊整款游戏请求已回绝');
        }
        catch {
            logger.warn?.('群聊工作首句发送失败，交给正常回复链路。');
            return next();
        }
    });
    // Keep each task tied to its real sender. Merging can attribute two requests to one person.
    bot.use(concurrencyGuard({
        strategy: process.env.QQBOT_COMPLEX_WORK === 'on' ? 'queue' : 'merge',
        maxQueue: config.maxQueue,
        maxProcessingMs: config.processingTimeoutMs,
    }));
/* <<< dsh-qqbot-patch:early-work-reply <<< */

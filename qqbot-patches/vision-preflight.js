/* >>> dsh-qqbot-patch:vision-preflight >>> */
    // 附件下载必须先于视觉预处理，否则只有 URL 没有本地文件可读。
    bot.use(attachmentProcessor(config, logger));
    // 图片视觉预处理硬闸：图片不能只靠 prompt 提醒模型“自己看”。
    // 先在运行时读图，再把摘要注入当前消息；后续主模型只能基于已读结果回答。
    const visionPreflightCache = new Map();
    const recentVisionByGroup = new Map();
    const visionPreflightMaxAge = 15 * 60 * 1000;
    const imageFiles = (files) => (Array.isArray(files) ? files : [])
        .filter(file => /^image(?:\/|$)/i.test(file?.contentType ?? '') && file?.localPath?.startsWith('/'))
        .slice(0, 4);
    const visionPreflightPaths = ctx => [...new Set(imageFiles(ctx.state?.downloadedFiles).map(file => file.localPath))];
    const visionPreflightDescribe = async (imagePath) => {
        const cached = visionPreflightCache.get(imagePath);
        if (cached && Date.now() - cached.at < 30 * 60 * 1000)
            return cached.value;
        const describe = globalThis.__qqbotVision?.describe;
        if (typeof describe !== 'function')
            return { ok: false, text: '视觉工具未注册，暂时无法确认图片内容。' };
        try {
            const described = await describe(imagePath, { transcribeDiary: true });
            const value = String(described?.what ?? described ?? '').trim();
            if (!value)
                return { ok: false, text: '图片视觉读取没有返回结果，无法确认图片内容。' };
            const result = { ok: true, text: value.slice(0, 3000), transcript: described?.transcript };
            if (visionPreflightCache.size >= 200) visionPreflightCache.delete(visionPreflightCache.keys().next().value);
            visionPreflightCache.set(imagePath, { at: Date.now(), value: result });
            return result;
        }
        catch (err) {
            return { ok: false, text: `图片视觉读取失败（${String(err?.message ?? err).slice(0, 100)}），无法确认图片内容。` };
        }
    };
    bot.use(async (ctx, next) => {
        const msg = ctx.message;
        const diary = globalThis.__qqbotDiary;
        const recallLines = new Set();
        const recall = (evidence) => {
            const line = diary?.recall?.(evidence);
            if (line) recallLines.add(line);
        };
        recall({ text: msg?.content });
        recall({ text: ctx.state?.quote?.text ?? ctx.state?.quote?.entry?.content });
        const appendRecall = () => {
            if (recallLines.size > 0)
                msg.content = `${String(msg.content ?? '').trim()}\n${[...recallLines].join('\n')}`.trim();
        };
        if (process.env.QQBOT_VISION_PREFLIGHT !== 'on' || !msg) {
            if (msg) appendRecall();
            return next();
        }
        const gid = String(msg?.groupOpenid ?? '');
        const senderId = String(msg?.senderId ?? '');
        const paths = visionPreflightPaths(ctx);
        let visionNotes = [];
        let visionPaths = [];
        let visionResults = [];
        if (paths.length > 0) {
            // 当前消息带图：无论是否 @、是否进入兴趣门控，先读每一张图。
            const results = await Promise.all(paths.map((path) => visionPreflightDescribe(path)));
            visionResults = results;
            visionPaths = paths;
            visionNotes = results.map((result, index) => `图${index + 1}：${result.text}`);
            if (recentVisionByGroup.size >= 100) recentVisionByGroup.delete(recentVisionByGroup.keys().next().value);
            if (gid) recentVisionByGroup.set(gid, {
                at: Date.now(), senderId, imagePaths: paths, results,
            });
            console.log(`[im-qqbot] 图片视觉预读: ${results.every((result) => result.ok) ? 'ok' : 'failed'} count=${paths.length}`);
        }
        else {
            // “这个图/这张/刚才那个”等跨消息指代：复用同一群、同一发送人的最近图片，避免让主模型猜来源。
            const text = String(msg?.content ?? '');
            const ref = /(?:这个|这张|那张|刚才|图片|图)/.test(text);
            const recent = recentVisionByGroup.get(gid);
            if (ref && recent && recent.senderId === senderId && Date.now() - recent.at <= visionPreflightMaxAge) {
                visionNotes = recent.results.map((result, index) => `图${index + 1}：${result.text}`);
                visionPaths = recent.imagePaths;
                visionResults = recent.results;
                console.log(`[im-qqbot] 跨消息图片引用: count=${visionPaths.length}`);
            }
            else if (ref) {
                // 当前话题像是在指图片，但没有可绑定的图片对象；把“不可确认”显式交给模型，禁止猜。
                visionNotes = ['未找到可绑定的图片，禁止猜测图片内容、来源或拍摄者；需要时先向用户澄清。'];
            }
        }
        for (const [index, imagePath] of visionPaths.entries())
            recall({ imagePath, transcript: visionResults[index]?.transcript });
        const quoteImages = imageFiles(ctx.state?.downloadedQuoteFiles);
        if (diary?.recall && quoteImages.length > 0) {
            await Promise.all(quoteImages.map(async ({ localPath }) => {
                const result = await visionPreflightDescribe(localPath);
                recall({ imagePath: localPath, transcript: result.transcript });
            }));
        }
        if (visionNotes.length > 0) {
            msg.content = `${String(msg.content ?? '').trim()}\n[图片视觉预读结果\n${visionNotes.join('\n')}\n]`.trim();
            msg.__qqbotVisionPreflight = { ok: visionNotes.every((note) => !note.includes('失败') && !note.includes('未找到')), notes: visionNotes, imagePaths: visionPaths };
        }
        appendRecall();
        return next();
    });
/* <<< dsh-qqbot-patch:vision-preflight <<< */

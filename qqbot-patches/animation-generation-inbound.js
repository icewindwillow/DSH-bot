/* >>> dsh-qqbot-patch:animation-generation-inbound >>> */
    record.__qqbotAnimationSenderId = typeof msg?.senderId === 'string' ? msg.senderId : '';
    // Preserve image references for the animation tool: current and quoted attachments
    // have already been downloaded by the middleware chain at this point.
    const animationImages = [];
    const addAnimationImages = (attachments, downloaded) => {
        const byName = new Map((Array.isArray(downloaded) ? downloaded : []).map(file => [String(file?.filename ?? ''), file]));
        for (const attachment of Array.isArray(attachments) ? attachments : []) {
            const type = String(attachment?.content_type ?? attachment?.contentType ?? '').toLowerCase();
            if (!type.startsWith('image/')) continue;
            const file = byName.get(String(attachment?.filename ?? ''));
            const local = file?.localPath ?? attachment?.localPath ?? attachment?.path ?? attachment?.filePath;
            if (typeof local === 'string' && local.startsWith('/') && !animationImages.includes(local)) animationImages.push(local);
        }
    };
    addAnimationImages(msg?.attachments, ctx?.state?.downloadedFiles);
    addAnimationImages(ctx?.state?.quote?.attachments, ctx?.state?.downloadedQuoteFiles);
    // 只在真的有图时更新；没有图的后续消息不会把上一张参考图冲掉。
    if (animationImages.length > 0) {
        record.__qqbotAnimationImagePaths = animationImages.slice(0, 4);
        record.__qqbotAnimationImagePathsAt = Date.now();
    }
    // ⚠️ 这条补丁的锚点就是 `record.agent.followup(message);` 那一行，锚点会被本片段整体替换。
    // 片段里必须显式把投递调用补回来，否则消息只建会话、永远不进 agent（20:21 漏过一次，
    // 结果全群静默一小时，日志里连异常都没有）。
    record.agent.followup(message);
/* <<< dsh-qqbot-patch:animation-generation-inbound <<< */

/* >>> dsh-qqbot-patch:reply-gate >>> */
    bot.use(mentionGate({
        requireMentionInGroup: config.requireMention,
        isImplicitMention: (ctx) => {
            const msg = ctx.message;
            if (msg.kind !== 'group' || !msg.groupOpenid)
                return false;
            return decideGroupImplicit(msg.groupOpenid, msg.content);
        },
    }));
    // 象信回话门控：过完 @/窗口 之后，再问一次「这条到底要不要回」，
    // 不值得就吞掉，避免整段上下文送进 DeepSeek 换来一句 [SILENT]。
    bot.use(async (ctx, next) => {
        if ((process.env.QQBOT_REPLY_GATE ?? 'on') === 'off')
            return next();
        const msg = ctx.message;
        if (!msg || msg.kind !== 'group' || !msg.groupOpenid)
            return next();
        if (msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE')
            return next();
        const content = String(msg.content ?? '').trim();
        if (content === '')
            return next();
        // 只叫了名字、没有别的内容：等 2.5 秒看有没有补充，避免「嗯喵？」回一条、请求又回一条
        try {
            const fs0 = process.getBuiltinModule?.('node:fs');
            const dir0 = process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`;
            const cfg0 = JSON.parse(fs0.readFileSync(`${dir0}/qqbot-groups.json`, 'utf8'));
            const words0 = Array.isArray(cfg0.wakeWords) ? cfg0.wakeWords : [];
            const bare = words0.some((w) => content === w || content === `${w}？` || content === `${w}?`);
            if (bare) {
                const senderId = msg.senderId;
                await new Promise((r) => setTimeout(r, 2500));
                const recent0 = globalThis.__qqbotRecentMessages?.get?.(msg.groupOpenid) ?? [];
                const followUp = recent0.some((m) => m && m.id === senderId && Number(m.at ?? 0) > Date.now() - 2500
                    && String(m.content ?? '').trim() !== content);
                if (followUp)
                    return;   // 有补充，交给那条去触发
            }
        }
        catch {
            // 判断失败就按原流程
        }
        // 「每日首条必接」：这个人今天第一次出现，不管亲疏都放进来，
        // 哪怕只是一个表情包/一张图，也别让象信把它吞掉。
        // 放在「只喊名字等 2.5 秒」之后：先等补充，避免回两条。
        try {
            const dailySpeaker = globalThis.__qqbotSpeakers?.get?.(msg.groupOpenid);
            if (dailySpeaker && dailyFirstPending(msg.groupOpenid, dailySpeaker)) {
                logger.info?.(`[im-qqbot] 每日首条必接放行: ${dailySpeaker.name ?? dailySpeaker.id}`);
                return next();
            }
        }
        catch {
            // 判定失败就走正常门控
        }
        // 斜杠命令不参与回话判断
        if (content.startsWith('/'))
            return next();
        // 刚回过话（3 分钟内）：当作对话延续，直接放行，不再花象信的钱
        const lastBot = globalThis.__qqbotLastBotReply?.get?.(msg.groupOpenid) ?? 0;
        if (Date.now() - lastBot < 3 * 60 * 1000)
            return next();
        // 叫了名字（唤醒词）：一定放行。哪怕只发了「小易」两个字，
        // 象信会判成「没有实质内容」而拦掉，但这是明确在叫她。
        try {
            const fsGate = process.getBuiltinModule?.('node:fs');
            const dir = process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`;
            const cfg = JSON.parse(fsGate.readFileSync(`${dir}/qqbot-groups.json`, 'utf8'));
            const words = Array.isArray(cfg.wakeWords) ? cfg.wakeWords : [];
            if (words.some((w) => typeof w === 'string' && w !== '' && content.includes(w)))
                return next();
        }
        catch {
            // 读配置失败就走正常判断
        }
        // 打招呼：放进来让她回一句（门控那边已经做过 30 分钟节流）
        if (/^(早|早安|早上好|午安|中午好|下午好|晚上好|晚安)/.test(content))
            return next();
        // 发图/视频/文件 = 分享，直接放行（发图本身就是想让人看）
        if (Array.isArray(msg.attachments) && msg.attachments.length > 0)
            return next();
        if (/\[图片\]|\[视频\]|\[文件\]/.test(content))
            return next();
        // 刚发过图、这条在问关于它的问题 → 放行
        const recent = globalThis.__qqbotRecentMessages?.get?.(msg.groupOpenid) ?? [];
        const hadImageRecently = recent.slice(-4).some((m) => /\[图片\]|\[视频\]|\[文件\]/.test(String(m.content ?? ''))
            && Date.now() - Number(m.at ?? 0) < 120000);
        if (hadImageRecently && /啥|什么|怎么|为什么|哪|吗|呢|？|\?/.test(content))
            return next();
        const verdict = await xiangxinShouldReply(msg.groupOpenid, msg);
        if (verdict === undefined)
            return next();
        // 心情会轻微调整「要不要开口」的门槛：低落时更不想接，精神好时更容易接。
        const moodBias = globalThis.__qqbotMood?.gateBias?.(msg.groupOpenid) ?? 1;
        const normal = verdict.toBot >= 0.5 && verdict.meaningful >= 0.3 && verdict.shouldReply >= 0.45 / moodBias;
        // 炫耀/卖关子/分享/说自己状态：值得主动接，即使「不自然」也放进来（人格会决定接不接）
        const hooky = Number(verdict.engage ?? 0) >= 0.55;
        const keep = normal || hooky;
        if (keep)
            return next();
        logger.info?.(`[im-qqbot] 回话门控拦下: ${content.slice(0, 24)} (toBot=${verdict.toBot.toFixed(2)} meaningful=${verdict.meaningful.toFixed(2)} reply=${verdict.shouldReply.toFixed(2)} engage=${Number(verdict.engage ?? 0).toFixed(2)})`);
        return;
    });
/* <<< dsh-qqbot-patch:reply-gate <<< */

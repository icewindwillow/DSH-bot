/* >>> dsh-qqbot-patch:silent-reply >>> */
    async send(record, text, tag) {
        const silentProbe = String(text ?? '').trim();
        // 模型判断「这条不该接」时只回 [SILENT]，此处吞掉，不发给用户。
        // 必须容忍大小写和方括号/全角括号写法：2026-10-27 那次模型写的是小写
        // `[silent]`，旧判断只认大写，于是把后面 30 万字一起发进了群。
        if (/^[\[【(（]{1,2}\s*silent\s*[\]】)）]{1,2}/i.test(silentProbe)) {
            this.logger.debug?.('im-qqbot: 模型选择不接话（[SILENT]），跳过发送');
            return;
        }
        // 复读 / 超长保护：模型偶尔会陷入「Output. Done. End.」这类自循环，
        // 单条能吐几十万字、卡住好几分钟。这里先拦，再截断兜底。
        let worstRepeat = 0;
        {
            const gram = 6;
            const seen = new Map();
            for (let i = 0; i + gram <= silentProbe.length; i += 1) {
                const piece = silentProbe.slice(i, i + gram);
                const count = (seen.get(piece) ?? 0) + 1;
                seen.set(piece, count);
                if (count > worstRepeat) worstRepeat = count;
            }
        }
        // 阈值取 25：正常回复里最极端的「6 7 6 7…」也只重复 9 次，而复读事故是 5508/9394 次
        if (worstRepeat >= 25) {
            this.logger.warn?.(`im-qqbot: 回复疑似复读（同一 6 字片段出现 ${worstRepeat} 次，共 ${silentProbe.length} 字），丢弃不发送`);
            return;
        }
        const REPLY_LIMIT = 3000;
        const body = silentProbe.length > REPLY_LIMIT
            ? `${silentProbe.slice(0, REPLY_LIMIT)}…（太长了，先说到这）`
            : silentProbe;
        if (body !== silentProbe)
            this.logger.warn?.(`im-qqbot: 回复超长（${silentProbe.length} 字），截断到 ${REPLY_LIMIT} 字再发`);
        // 生成期间对方又补了消息/表情包：让象信判断这份草稿是否还值得发
        if (await shouldSupersedeDraft(record, body, this.turnStarts))
            return;
        // 去掉「唔…」「诶…」这类固定开口，模型逐字记住历史口癖，提示词压不住
        const cleaned = stripFillerOpeners(body, record?.replyTarget?.targetId ?? 'default');
        if (cleaned === '') {
            this.logger.debug?.('im-qqbot: 去掉垫词后为空，跳过发送');
            return;
        }
        const limited = limitActionDescriptions(cleaned, record?.replyTarget?.targetId ?? 'default');
        if (limited.trim() === '') {
            this.logger.debug?.('im-qqbot: 去掉动作描写后为空，跳过发送');
            return;
        }
        const chunks = chunkMarkdownText(limited, this.config.textChunkLimit);
/* <<< dsh-qqbot-patch:silent-reply <<< */

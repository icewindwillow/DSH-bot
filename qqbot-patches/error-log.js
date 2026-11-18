/* >>> dsh-qqbot-patch:error-log >>> */
    // 错误兜底：把完整堆栈写进 qqbot-errors.log（原来只回一句英文报错到群里），
    // 群里统一回一句人话，避免把 Maximum call stack size exceeded 这种技术错误发给群友。
    // 模型侧错误（欠费/额度/鉴权/断联）不往群里发，只上报到面板状态。
    bot.use(errorHandler({
        format: (err) => {
            try {
                const fsErr = process.getBuiltinModule?.('node:fs');
                const dirErr = process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`;
                const detail = err && err.stack ? err.stack : String(err);
                fsErr?.appendFileSync(`${dirErr}/qqbot-errors.log`, `${new Date().toISOString()}\n${detail}\n\n`);
            }
            catch {
                // 记日志失败不影响回复
            }
            try {
                if (globalThis.__qqbotIsModelError?.(err) === true) {
                    const code = err?.code ?? err?.cause?.code ?? 'MODEL_ERROR';
                    globalThis.__qqbotReportModelStatus?.(false, {
                        code,
                        message: err?.message ?? String(err),
                        source: 'error-handler',
                    });
                    return '';   // 空字符串 → errorHandler 不发送，模型错误只进面板
                }
            }
            catch {
                // 上报失败时退回人话兜底
            }
            return '呜…我这下卡住了，等我缓一缓再回你';
        },
    }));
/* <<< dsh-qqbot-patch:error-log <<< */

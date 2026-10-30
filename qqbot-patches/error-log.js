/* >>> dsh-qqbot-patch:error-log >>> */
    // 错误兜底：把完整堆栈写进 qqbot-errors.log（原来只回一句英文报错到群里），
    // 群里统一回一句人话，避免把 Maximum call stack size exceeded 这种技术错误发给群友。
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
            return '呜…我这下卡住了，等我缓一缓再回你';
        },
    }));
/* <<< dsh-qqbot-patch:error-log <<< */

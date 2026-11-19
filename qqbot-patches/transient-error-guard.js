/* >>> dsh-qqbot-patch:transient-error-guard >>> */
        if (failure !== undefined && (__qqbotIsModelErrorCode(failure.code) || __qqbotIsModelErrorText(failure.message))) {
            // 模型侧错误（欠费/额度/限流/断联/空响应等）不在群里报，只更新面板状态
            __qqbotReportModelStatus(false, {
                code: failure.code,
                message: failure.message,
                source: 'turn-end',
            });
            this.logger.warn?.(`im-qqbot: 模型错误已静默（${failure.code}），状态已上报面板`);
        }
        else if (failure !== undefined && record.replyTarget?.scope !== 'group' && !SILENT_TURN_ERROR_CODES.has(failure.code) && !TRANSIENT_TURN_ERROR_CODES.has(failure.code)) {
            void this.send(record, `⚠️ 本轮异常结束\n\`${failure.code}\`: ${failure.message}`, 'sendTurnEndError');
        }
        else if (failure !== undefined) {
            this.logger.warn?.(`im-qqbot: 轮次异常已静默 (${failure.code})`);
        }
        else {
            // 正常结束：标记模型已恢复（保留 lastError 供面板回看）
            __qqbotReportModelStatus(true, {});
        }
/* <<< dsh-qqbot-patch:transient-error-guard <<< */

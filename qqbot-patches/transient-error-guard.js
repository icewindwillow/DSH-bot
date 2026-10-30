/* >>> dsh-qqbot-patch:transient-error-guard >>> */
        if (failure !== undefined && !SILENT_TURN_ERROR_CODES.has(failure.code) && !TRANSIENT_TURN_ERROR_CODES.has(failure.code)) {
            void this.send(record, `⚠️ 本轮异常结束\n\`${failure.code}\`: ${failure.message}`, 'sendTurnEndError');
        }
        else if (failure !== undefined) {
            this.logger.warn?.(`im-qqbot: 瞬时错误已静默 (${failure.code}): ${failure.message}`);
        }
/* <<< dsh-qqbot-patch:transient-error-guard <<< */

/* >>> dsh-qqbot-patch:web-fetch-error-guard >>> */
        if (call === undefined)
            return;
        const pageFailure = record.replyTarget?.scope === 'group'
            ? recoverableWebFetchFailure(call, event) : undefined;
        if (pageFailure) {
            this.logger.warn?.(`[im-qqbot] 单页抓取失败，群通知已省略；保留错误上下文供模型换源: web_fetch HTTP ${pageFailure.status} host=${pageFailure.host} request_id=${pageFailure.requestId}`);
            return;
        }
        if (event.error === undefined && !this.config.showToolResults)
            return;
/* <<< dsh-qqbot-patch:web-fetch-error-guard <<< */

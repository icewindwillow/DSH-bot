/* >>> dsh-qqbot-patch:duplicate-reply-guard >>> */
        if (qqbotIsDuplicateReply(sessionId, fullText)) {
            this.logger.warn?.(`im-qqbot: 同一轮重复回复已丢弃（${fullText.length} 字）`);
            this.buffers.delete(sessionId);
            return;
        }
        void this.send(record, fullText, 'sendMarkdown');
/* <<< dsh-qqbot-patch:duplicate-reply-guard <<< */

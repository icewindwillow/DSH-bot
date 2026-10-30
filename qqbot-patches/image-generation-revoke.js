/* >>> dsh-qqbot-patch:image-generation-revoke >>> */
        try {
            await record.agent.whenIdle();
        } finally {
            if (record.__qqbotImageGenerationGrant?.msgId === msg.messageId) record.__qqbotImageGenerationGrant = undefined;
        }
/* <<< dsh-qqbot-patch:image-generation-revoke <<< */

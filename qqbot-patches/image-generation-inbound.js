/* >>> dsh-qqbot-patch:image-generation-inbound >>> */
    // Bind spending permission to the real inbound message, never assembled history or a tool argument.
    globalThis.__qqbotImageGenerationAuthorize?.(record, msg, message);
    globalThis.__qqbotComplexWork?.bind(record, msg, message);
    record.agent.followup(message);
/* <<< dsh-qqbot-patch:image-generation-inbound <<< */

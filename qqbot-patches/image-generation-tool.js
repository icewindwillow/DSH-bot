/* >>> dsh-qqbot-patch:image-generation-tool >>> */
    setupMediaArchive(ctx, bot, manager, config, logger);
    // Independent from the chat provider: one explicitly requested OpenAI image, sent to this session.
    setupOpenAiImageTool(ctx, bot, manager, config, logger);
/* <<< dsh-qqbot-patch:image-generation-tool <<< */

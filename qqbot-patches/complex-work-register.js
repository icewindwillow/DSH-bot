/* >>> dsh-qqbot-patch:complex-work-register >>> */
    const manager = new SessionManager(ctx, agents, config, logger);
    if (process.env.QQBOT_COMPLEX_WORK === 'on')
        setupComplexWork(ctx, manager, logger, { readProfileDocument, withQqbotProfileDocuments });
/* <<< dsh-qqbot-patch:complex-work-register <<< */

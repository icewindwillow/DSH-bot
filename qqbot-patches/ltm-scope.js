/* >>> dsh-qqbot-patch:ltm-scope >>> */
	function activeScope(scope) {
		// 优先用宿主（im-qqbot）登记的按群 scope，避免所有会话共用 cwd 推导出的同一个项目 scope
		const sessionId = scope?.session?.header?.id ?? scope?.header?.id ?? (typeof scope === 'string' ? scope : undefined);
		const overrides = globalThis.__qqbotMemoryScopeBySession;
		const override = sessionId && overrides ? overrides[sessionId] : undefined;
		if (typeof override === 'string' && override !== '')
			return override;
		if (!config.autoProjectScope) return config.defaultScope;
		return resolveProjectScope(cwdFromAgentScope(scope), config.defaultScope).scope;
	}
/* <<< dsh-qqbot-patch:ltm-scope <<< */

/* >>> dsh-qqbot-patch:model-failover-preserve-selection >>> */
			const preferred = this.model.current();
			const request = this.buildRequest(config, preparedCall, assembly.tools, {
				turn,
				step
			}, startsRequestSeries, signal);
			// A temporary step route must not replace the agent's preferred model.
			if (preferred !== void 0 && (preferred.provider !== config.provider || preferred.model !== config.model))
				this.model.select(preferred);
/* <<< dsh-qqbot-patch:model-failover-preserve-selection <<< */

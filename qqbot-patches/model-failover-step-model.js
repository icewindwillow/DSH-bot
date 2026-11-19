/* >>> dsh-qqbot-patch:model-failover-step-model >>> */
		const selection = await this.dispatch.waterfall("agent/step-model", {
			...position,
			signal
		}, () => Promise.resolve(this.model.current()));
		signal.throwIfAborted();
		const claimed = this.inbox.claim(target, position.turn);
/* <<< dsh-qqbot-patch:model-failover-step-model <<< */

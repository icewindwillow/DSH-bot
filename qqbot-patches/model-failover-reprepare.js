/* >>> dsh-qqbot-patch:model-failover-reprepare >>> */
					if (action?.kind !== "retry") throw new LlmError(finish.failure.message, finish.failure.code, finish.failure);
					if (action.reprepare === true) return { kind: "reprepare" };
					continue;
/* <<< dsh-qqbot-patch:model-failover-reprepare <<< */

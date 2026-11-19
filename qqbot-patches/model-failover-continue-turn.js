/* >>> dsh-qqbot-patch:model-failover-continue-turn >>> */
						if (stepEnd?.kind === "reprepare") turnEnds = null;
						else if (turnEnds === null || turnEnds.kind !== "max-tokens") turnEnds = stepEnd;
/* <<< dsh-qqbot-patch:model-failover-continue-turn <<< */

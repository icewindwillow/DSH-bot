/* >>> dsh-qqbot-patch:ltm-guard-write >>> */
		memory_write(args) {
			memoryWriteGuard("memory_write");
/* <<< dsh-qqbot-patch:ltm-guard-write <<< */

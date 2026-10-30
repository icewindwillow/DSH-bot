/* >>> dsh-qqbot-patch:ltm-write-guard >>> */
	function memoryWriteGuard(op) {
		if ((process.env.QQBOT_MEMORY_WRITE ?? 'off') !== 'off')
			return;
		throw new Error(`${op}: 记忆现在由系统自动判定写入（象信门控），不要主动调用 ${op}；回忆请用 memory_search。`);
	}
/* <<< dsh-qqbot-patch:ltm-write-guard <<< */

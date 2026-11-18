/* >>> dsh-qqbot-patch:history-ignored-filter >>> */
/**
 * 群历史缓冲过滤：replyIndex=0 的人（典型是别的机器人）不进她的上下文。
 *
 * historyBuffer 用 recordOnSkip: true 记录所有消息，包括她没回的；
 * 只拦住入站消息不够——小葛的话仍会出现在下一轮的 [Chat history] 里，
 * 于是她回别人时会顺着小葛的话题接下去（2026-11-09 反馈「有时候还在接它的话」）。
 * append 和 list 都过滤：调低指数之前已经缓存进去的旧消息也会被挡住。
 */
export function getHistoryStore() {
    if (!_store) {
        const base = new MemoryHistoryStore();
        const ignored = (entry) => globalThis.__qqbotIsIgnoredSender?.(entry?.senderId, entry?.senderName) === true;
        _store = {
            append(groupKey, entry, limit) {
                // 只是不让她看到，不影响别人之间正常的历史
                if (ignored(entry))
                    return;
                return base.append(groupKey, entry, limit);
            },
            list(groupKey, limit) {
                const rows = base.list(groupKey, limit);
                return Array.isArray(rows) ? rows.filter((entry) => !ignored(entry)) : rows;
            },
            clear(groupKey) {
                return base.clear?.(groupKey);
            },
            size() {
                return base.size?.() ?? 0;
            },
        };
    }
    return _store;
}
/* <<< dsh-qqbot-patch:history-ignored-filter <<< */

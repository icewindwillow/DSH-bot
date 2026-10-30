/* >>> dsh-qqbot-patch:web-fetch-errors >>> */
/**
 * 只识别新版 DeepSeek Fetch API 明确的「这个 URL 取不到」。
 * WEB_PROVIDER_ERROR 还包含鉴权/限流/网络/配置错误，不能按错误码一刀切静默。
 * 只过滤 QQ 出站通知；原始 tool/result（包括 isError）完整留给模型和会话日志。
 */
function recoverableWebFetchFailure(call, event) {
    if (call?.name !== 'web_fetch' || event?.error?.name !== 'WebError'
        || event.error.code !== 'WEB_PROVIDER_ERROR')
        return undefined;
    const message = event.raw?.message;
    if (message?.role !== 'tool' || !Array.isArray(message.content))
        return undefined;
    // 新版持久化格式：message.isError + 平铺 text；兼容旧版嵌套 tool-result。
    const results = message.isError === true ? [message] : message.content
        .filter((block) => block?.type === 'tool-result' && block.isError === true);
    for (const block of results) {
        if (!Array.isArray(block.content))
            continue;
        const text = block.content.filter((part) => part?.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text).join('\n');
        const match = /^(?:Error:\s*)?DeepSeek API error \(HTTP (404)\): failed to fetch URL(?:[\s.(]|$)/i.exec(text);
        if (!match)
            continue;
        // 日志只留站点和 request_id；不打印可能带 token/签名的完整 URL 或参数。
        let host = 'unknown';
        try {
            const args = typeof call.args === 'string' ? JSON.parse(call.args) : call.args;
            host = new URL(args?.url).hostname;
        }
        catch { /* 无效参数不影响通知过滤 */ }
        const requestId = /\brequest_id:\s*([a-f0-9-]{36})\b/i.exec(text)?.[1] ?? 'unknown';
        return { status: match[1], host, requestId };
    }
    return undefined;
}
/* <<< dsh-qqbot-patch:web-fetch-errors <<< */

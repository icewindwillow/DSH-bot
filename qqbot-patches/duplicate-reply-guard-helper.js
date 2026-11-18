/* >>> dsh-qqbot-patch:duplicate-reply-guard-helper >>> */
/**
 * 同一轮重复回复去重。
 *
 * 模型有时会在一个 turn 里输出两段 assistant 文本（工具调用后复述一遍答案、
 * 或上游重试后重新生成），而上游 outbound 对每段都会独立 send 一次，
 * 群里就会看到两条几乎一样的回复。这里按「同 session + 短时间 + 文字高度重合」
 * 判定为重复，只保留第一条；正常的多段补充（比如「等我查下」→「查到了……」）
 * 文字重合度低，不受影响。
 */
const QQ_BOT_DUP_WINDOW_MS = 20000;
const QQ_BOT_DUP_MIN_CHARS = 20;
const QQ_BOT_DUP_MIN_EQUAL_CHARS = 4;
const QQ_BOT_DUP_RATIO = 0.5;
const qqbotReplyDedupe = new Map();

function qqbotReplyClean(text) {
    return String(text ?? '').replace(/[\s\p{P}\p{S}]/gu, '');
}

function qqbotReplyBigrams(text) {
    const clean = qqbotReplyClean(text);
    const set = new Set();
    for (let i = 0; i + 1 < clean.length; i += 1)
        set.add(clean.slice(i, i + 2));
    return set;
}

function qqbotIsDuplicateReply(sessionId, text) {
    const now = Date.now();
    const body = String(text ?? '');
    const prev = qqbotReplyDedupe.get(sessionId);
    qqbotReplyDedupe.set(sessionId, { text: body, at: now });
    // 会话很多时只保留最近的一批，避免长跑之后 map 无限增长
    if (qqbotReplyDedupe.size > 200)
        qqbotReplyDedupe.delete(qqbotReplyDedupe.keys().next().value);
    if (!prev || now - prev.at > QQ_BOT_DUP_WINDOW_MS)
        return false;
    // 短句也可能重复（「那就好，我还怕自己在瞎猜呢。」），去标点后完全相同就直接判重
    const clean = qqbotReplyClean(body);
    if (clean.length >= QQ_BOT_DUP_MIN_EQUAL_CHARS && clean === qqbotReplyClean(prev.text))
        return true;
    if (body.length < QQ_BOT_DUP_MIN_CHARS || prev.text.length < QQ_BOT_DUP_MIN_CHARS)
        return false;
    const a = qqbotReplyBigrams(prev.text);
    const b = qqbotReplyBigrams(body);
    if (a.size === 0 || b.size === 0)
        return false;
    let inter = 0;
    for (const gram of b) {
        if (a.has(gram))
            inter += 1;
    }
    return inter / Math.max(a.size, b.size) >= QQ_BOT_DUP_RATIO;
}
/* <<< dsh-qqbot-patch:duplicate-reply-guard-helper <<< */

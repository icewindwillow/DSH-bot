/* >>> dsh-qqbot-patch:model-status-helper >>> */
/**
 * 模型运行状态上报（供配置面板读取）
 *
 * 模型出错时不再往群里发报错，而是把状态写到 profile 下的 qqbot-model-status.json：
 *   { ok, updatedAt, channel, degraded, lastError: { at, code, message, provider, model, source } }
 * 面板读这个文件即可展示「模型正常 / 异常原因 / 是否兜底」，不依赖机器人进程内存。
 */
function __qqbotModelStatusFile() {
    const dir = process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`;
    return `${dir}/qqbot-model-status.json`;
}

function __qqbotReadModelStatus() {
    try {
        const fs = process.getBuiltinModule?.('node:fs');
        const text = fs?.readFileSync(__qqbotModelStatusFile(), 'utf8');
        return text ? JSON.parse(text) : {};
    }
    catch {
        return {};
    }
}

/** 是否属于「模型侧」错误：欠费、额度、鉴权、限流、断联、空响应等 */
function __qqbotIsModelErrorCode(code) {
    const value = String(code ?? '').trim().toUpperCase();
    if (value === '')
        return false;
    return new Set([
        'QUOTA', 'ACCOUNT_QUOTA', 'INSUFFICIENT_BALANCE', 'BILLING', 'AUTH', 'INVALID_CREDENTIAL',
        'RATE_LIMIT', 'OVERLOADED', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'STREAM_CLOSED', 'STREAM_CUT',
        'EMPTY_RESPONSE', 'CONTEXT_WINDOW_EXCEEDED', 'MODEL_NOT_FOUND', 'UNAVAILABLE',
    ]).has(value);
}

/** 错误文案是否指向模型额度/欠费类问题（部分上游只给 402 文案，不给错误码） */
function __qqbotIsModelErrorText(text) {
    return /insufficient|quota|balance|credits?|billing|欠费|余额/i.test(String(text ?? ''));
}

/** 沿 cause 链判断一个异常是否由模型调用失败引起 */
function __qqbotIsModelError(error) {
    const seen = new Set();
    let node = error;
    while (node && typeof node === 'object' && !seen.has(node)) {
        seen.add(node);
        if (__qqbotIsModelErrorCode(node.code))
            return true;
        if (__qqbotIsModelErrorText(node.message))
            return true;
        node = node.cause;
    }
    return false;
}

/**
 * 上报模型状态。
 * ok=true 只更新「已恢复」，保留 lastError 供面板回看；ok=false 记录本次错误。
 */
function __qqbotReportModelStatus(ok, info = {}) {
    try {
        const fs = process.getBuiltinModule?.('node:fs');
        if (!fs)
            return;
        const previous = globalThis.__qqbotModelStatus ?? __qqbotReadModelStatus();
        // 正常轮次很频繁，1 分钟内已上报过 ok 就不重复落盘
        if (ok === true && previous.ok === true && Date.now() - Date.parse(previous.updatedAt ?? 0) < 60_000)
            return;
        const now = new Date().toISOString();
        const data = {
            ok: ok === true,
            updatedAt: now,
            channel: info.channel ?? previous.channel ?? 'free',
            degraded: info.degraded ?? previous.degraded ?? false,
            lastError: ok === true
                ? (previous.lastError ?? null)
                : {
                    at: now,
                    code: String(info.code ?? 'UNKNOWN'),
                    message: String(info.message ?? '').slice(0, 500),
                    provider: info.provider ?? previous.lastError?.provider ?? null,
                    model: info.model ?? previous.lastError?.model ?? null,
                    source: info.source ?? null,
                },
        };
        globalThis.__qqbotModelStatus = data;
        fs.writeFileSync(__qqbotModelStatusFile(), `${JSON.stringify(data)}\n`, { mode: 0o600 });
    }
    catch {
        // 状态上报失败不能影响正常收发
    }
}

globalThis.__qqbotReportModelStatus = __qqbotReportModelStatus;
globalThis.__qqbotIsModelError = __qqbotIsModelError;
/* <<< dsh-qqbot-patch:model-status-helper <<< */

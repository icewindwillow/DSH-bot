/* >>> dsh-qqbot-patch:reply-gate-helper >>> */
/**
 * 象信回话门控：放进来的消息先问一句「这条要不要机器人回」，
 * 不值得就直接吞掉，不再把整段上下文送进 DeepSeek。
 * 真 @ 永远放行；象信失败时放行（宁可多说，不可漏答）。
 */
async function xiangxinShouldReply(gid, msg) {
    const fs = process.getBuiltinModule?.('node:fs');
    const os = process.getBuiltinModule?.('node:os');
    let key = process.env.XIANGXIN_API_KEY ?? '';
    if (key === '' && fs && os) {
        try {
            const yaml = fs.readFileSync(`${os.homedir()}/.dsh/.credentials.yaml`, 'utf8');
            const m = yaml.match(/XIANGXIN_API_KEY:\s*(\S+)/);
            if (m)
                key = m[1].trim();
        }
        catch {
            key = '';
        }
    }
    if (key === '')
        return undefined;
    const recent = (globalThis.__qqbotRecentMessages?.get?.(gid) ?? [])
        .slice(-6)
        .map((m) => `${m.name ?? '某人'}: ${String(m.content ?? '').slice(0, 80)}`);
    const body = {
        model: 'xiangxin-latest',
        state: {
            机器人名字: '小易',
            最近对话: recent,
            这条消息: `${msg.senderName ?? '某人'}: ${String(msg.content ?? '').slice(0, 200)}`,
            刚发过言的发言人: msg.senderName ?? '',
        },
        questions: {
            to_bot: { type: 'noul', instructions: '`这条消息` 是在对机器人说话、或明显需要机器人回应吗？' },
            meaningful: { type: 'noul', instructions: '`这条消息` 有实质内容吗（不是纯表情、纯语气词、重复刷屏）？' },
            should_reply: { type: 'noul', instructions: '机器人现在开口是否自然、不突兀？（抢话、硬接也算不自然）' },
            engage: { type: 'noul', instructions: '`这条消息` 是否包含值得机器人主动接话的钩子（炫耀、卖关子、晒东西、说自己状态、求助）？' },
        },
    };
    try {
        const res = await fetch('https://api.xiangxinai.cn/v1/systemone', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(4000),
        });
        if (!res.ok)
            return undefined;
        const ans = (await res.json())?.answers;
        return {
            toBot: Number(ans?.to_bot?.noul ?? 0),
            meaningful: Number(ans?.meaningful?.noul ?? 0),
            shouldReply: Number(ans?.should_reply?.noul ?? 0),
            engage: Number(ans?.engage?.noul ?? 0),
        };
    }
    catch {
        return undefined;
    }
}
/* <<< dsh-qqbot-patch:reply-gate-helper <<< */

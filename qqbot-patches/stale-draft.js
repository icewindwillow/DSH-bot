/* >>> dsh-qqbot-patch:stale-draft >>> */
/**
 * 草稿过期检查：机器人正在生成回复时，对方可能又补了好几句/发了表情包。
 * 每一句都回会很吵，所以发送前用象信判断一次：
 *   send_now     → 照常发
 *   rewrite_later→ 丢掉这份草稿，让合并后的下一轮统一回答
 *   stay_silent  → 直接不发
 */
function xiangxinApiKey() {
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
    return key;
}

async function shouldSupersedeDraft(record, draft, turnStarts) {
    try {
        const gid = record?.replyTarget?.targetId;
        if (!gid || record?.replyTarget?.scope !== 'group')
            return false;
        const startedAt = turnStarts?.get?.(gid) ?? 0;
        if (!startedAt)
            return false;
        const recent = globalThis.__qqbotRecentMessages?.get?.(gid) ?? [];
        const fresh = recent.filter((m) => m && Number(m.at ?? 0) > startedAt).slice(-5);
        if (fresh.length === 0)
            return false;
        const key = xiangxinApiKey();
        if (key === '')
            return false;
        const body = {
            model: 'xiangxin-latest',
            state: {
                已经写好的回复: String(draft).slice(0, 300),
                等待回复期间对方又发了: fresh.length + ' 条',
                对方后来又说的话: fresh.map((m) => `${m.name ?? '对方'}: ${String(m.content ?? '').slice(0, 80)}`),
            },
            questions: {
                decision: {
                    type: 'choice',
                    instructions: '`对方后来又说的话` 出现后，`已经写好的回复` 还适合直接发出去吗？',
                    criteria: {
                        send_now: '新消息只是无关的补充或另一件事，原回复仍然成立',
                        rewrite_later: '新消息改变了原回复的前提（例如对方自己回答了、改口了、话题转了），原回复应作废',
                        stay_silent: '新消息是重复/表情包/语气词/刷屏式的补充，不值得再回一条',
                    },
                },
                stale: { type: 'noul', instructions: '这份回复是否已经明显过时或被新消息取代？' },
            },
        };
        const res = await fetch('https://api.xiangxinai.cn/v1/systemone', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(4000),
        });
        if (!res.ok)
            return false;
        const ans = (await res.json())?.answers;
        const decision = ans?.decision;
        const stale = Number(ans?.stale?.noul ?? 0);
        const probs = decision?.probabilities ?? {};
        const dropProb = Number(probs.rewrite_later ?? 0) + Number(probs.stay_silent ?? 0);
        const drop = decision?.choice === 'rewrite_later' || decision?.choice === 'stay_silent'
            || dropProb >= 0.5 || stale >= 0.65;
        if (drop)
            console.log(`[im-qqbot] 草稿过期，放弃发送（${decision?.choice ?? 'stale'} ${Number(decision?.confidence ?? stale).toFixed(2)}）`);
        return drop;
    }
    catch {
        return false;
    }
}
/* <<< dsh-qqbot-patch:stale-draft <<< */

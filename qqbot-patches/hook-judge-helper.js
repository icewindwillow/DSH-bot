/* >>> dsh-qqbot-patch:hook-judge-helper >>> */
/**
 * 「值得主动接一句」判断：别人炫耀 / 卖关子 / 晒东西时，让象信刷一遍，
 * 命中的话把提示塞进当前说话人的动态上下文，由人格类型决定怎么接。
 * 刷表情包、垃圾话一律不管。
 */
const HOOK_TYPES = new Set(['炫耀', '卖关子', '分享']);
const HOOK_PREFILTER = /抽到|出货|满命|打通|第一名|赢了|升职|加薪|上岸|考过|录取|中奖|看我|做了|画了|写了|买了|你猜|猜猜|知道吗|猜你|发现了|找到|给你看|好看吗|厉害吧|牛不牛/;

async function xiangxinHookJudge(content) {
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
    const body = {
        model: 'xiangxin-latest',
        state: { 消息: content },
        questions: {
            hook: {
                type: 'choice',
                instructions: '`消息` 属于哪一类？',
                criteria: {
                    炫耀: '在展示成绩、战利品、新东西，带得意',
                    卖关子: '话说一半、让大家猜、故意不说结果',
                    分享: '发了作品/图/链接/发现，想让人看',
                    求助: '在问问题、求解法',
                    普通闲聊: '普通聊天',
                    垃圾话: '无意义重复、脏话、玩梗刷屏',
                    刷表情: '只是表情包/图片，没有实质内容',
                },
            },
            worth: { type: 'noul', instructions: '机器人值得主动接一句吗？' },
        },
    };
    try {
        const res = await fetch('https://api.xiangxinai.cn/v1/systemone', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok)
            return undefined;
        const ans = (await res.json())?.answers;
        return { type: String(ans?.hook?.choice ?? ''), worth: Number(ans?.worth?.noul ?? 0) };
    }
    catch {
        return undefined;
    }
}

function setupHookJudge(ctx, logger) {
    if ((process.env.QQBOT_HOOK_JUDGE ?? 'on') === 'off')
        return;
    const hooks = new Map();   // gid → { type, content, at, senderId }
    globalThis.__qqbotHooks = hooks;

    const consider = async (mCtx) => {
        try {
            const msg = mCtx?.message;
            if (!msg || msg.kind !== 'group' || !msg.groupOpenid || !msg.senderId)
                return;
            const content = String(msg.content ?? '').trim();
            if (content.length < 3 || content.length > 200)
                return;
            if (!HOOK_PREFILTER.test(content) && !(Array.isArray(msg.attachments) && msg.attachments.length > 0))
                return;
            const ans = await xiangxinHookJudge(content);
            if (!ans || !HOOK_TYPES.has(ans.type) || ans.worth < 0.45)
                return;
            hooks.set(msg.groupOpenid, { type: ans.type, content: content.slice(0, 80), at: Date.now(), senderId: msg.senderId });
            console.log(`[im-qqbot] 钩子(${ans.type} ${ans.worth.toFixed(2)}): ${content.slice(0, 30)}`);
        }
        catch {
            // 判断失败不影响对话
        }
    };
    globalThis.__qqbotHookJudge = { consider };
    console.log('[im-qqbot] 主动接话判断已启用（象信：炫耀/卖关子/分享）');
}
/* <<< dsh-qqbot-patch:hook-judge-helper <<< */

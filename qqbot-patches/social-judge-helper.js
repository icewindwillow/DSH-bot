/* >>> dsh-qqbot-patch:social-judge-helper >>> */
/**
 * 社会事件裁判（异步、迷你上下文）——**只判负向**。
 *
 * 分工：正向事件（夸奖、帮忙、分享、道歉、友好闲聊）交给主模型的 record_social_event，
 * 它读得懂语境，不会把客套当夸奖；裁判只兜负向——恶意攻击、骚扰、刷屏、欺骗、越界，
 * 因为这些恰恰是模型最容易被带着走、或者懒得记的部分。
 *
 * 触发不是「有没有叫机器人名字」，而是**负向信号权重累加**：
 *   每条消息按 store.signal().neg 计分（脏话 3 分，连打感叹/叠字/两字刷屏各 0.15~0.4），
 *   分数按人累加、每条衰减 25%，攒到阈值（默认 2）才真的问一次裁判；判完清零。
 *   → 一句骂人话就能触发；杂音攒着攒着也会触发；正常聊天不会白烧调用。
 *
 * 去重：同一人 60 秒内已经有事件（不管是裁判还是主模型记的）就跳过；
 *      写入走 store.update（文件锁），事件 note 直接引用原话片段。
 * 任何失败都静默（关系更新是锦上添花，不能影响对话）。
 */
const SOCIAL_JUDGE_NEGATIVE = new Set(['hostile_attack', 'harassment', 'spam', 'deception', 'crossing_line']);

async function socialJudgeCall(prompt, timeoutMs = 9000) {
    const fs = process.getBuiltinModule?.('node:fs');
    const os = process.getBuiltinModule?.('node:os');
    if (!fs || !os)
        return undefined;
    let apiKey = process.env.OPENCODE_GO_API_KEY ?? '';
    if (apiKey === '') {
        try {
            const yaml = fs.readFileSync(`${os.homedir()}/.dsh/.credentials.yaml`, 'utf8');
            const m = yaml.match(/OPENCODE_GO_API_KEY:\s*(\S+)/);
            if (m)
                apiKey = m[1].trim();
        }
        catch {
            return undefined;
        }
    }
    if (apiKey === '')
        return undefined;
    const model = process.env.QQBOT_SOCIAL_JUDGE_MODEL ?? 'deepseek-v4.1-flash';
    const body = {
        model,
        messages: [
            { role: 'system', content: '你是社交事件分类器，只判负向事件。只输出一行 JSON，不要解释。' },
            { role: 'user', content: prompt },
        ],
        max_tokens: 120,
        temperature: 0,
    };
    try {
        const res = await fetch('https://opencode.ai/zen/go/v1/chat/completions', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${apiKey}`,
                'x-opencode-session': process.getBuiltinModule('node:crypto').randomUUID(),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok)
            return undefined;
        const json = await res.json();
        const text = json?.choices?.[0]?.message?.content ?? '';
        const match = String(text).match(/\{[\s\S]*\}/);
        if (!match)
            return undefined;
        return JSON.parse(match[0]);
    }
    catch {
        return undefined;
    }
}

/** 象信（xiangxin）结构化判断：一次请求问事件类型 + 敌意 + 玩笑 + 强度（只取负向结果） */
async function xiangxinClassify(dislikes, speaker, content, timeoutMs = 9000) {
    const fs = process.getBuiltinModule?.('node:fs');
    const os = process.getBuiltinModule?.('node:os');
    let apiKey = process.env.XIANGXIN_API_KEY ?? '';
    if (apiKey === '' && fs && os) {
        try {
            const yaml = fs.readFileSync(`${os.homedir()}/.dsh/.credentials.yaml`, 'utf8');
            const m = yaml.match(/XIANGXIN_API_KEY:\s*(\S+)/);
            if (m)
                apiKey = m[1].trim();
        }
        catch {
            // 没有就跳过
        }
    }
    if (apiKey === '')
        return undefined;
    const events = {
        hostile_attack: '恶意辱骂、人身攻击',
        harassment: '纠缠、反复骚扰、明知不喜欢还继续',
        spam: '刷屏、重复无意义内容',
        deception: '说谎、编造信息并造成影响',
        crossing_line: '踩到人设的雷区',
        none: '不是负向事件（善意互动、普通闲聊都算这一类）',
    };
    const body = {
        model: 'xiangxin-latest',
        state: { 人设雷区: dislikes || '被骂、被刷屏、被反复踩雷区', 最近消息: `${speaker}: ${content}` },
        questions: {
            event: { type: 'choice', instructions: '`最近消息` 里这个人的发言属于哪类**负向**社交事件？善意互动、普通闲聊一律选 none。', criteria: events },
            hostile: { type: 'noul', instructions: '这条发言是否带有明确的敌意或侮辱？' },
            playful: { type: 'noul', instructions: '这条发言是否属于不带恶意的玩笑、互损或调侃？' },
            intensity: { type: 'score', instructions: '这条发言的负向情绪强度', criteria: ['平淡，没什么情绪', '有轻微情绪', '情绪明显', '情绪很强，接近爆发'] },
        },
    };
    try {
        const res = await fetch('https://api.xiangxinai.cn/v1/systemone', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok)
            return undefined;
        const json = await res.json();
        const ev = json?.answers?.event;
        if (!ev || ev.choice === 'none' || ev.confidence < 0.45)
            return undefined;
        // 明确判成「只是玩笑」而没判敌意时，不记（正向交给主模型）
        if (json?.answers?.playful?.value === true && json?.answers?.hostile?.value !== true)
            return undefined;
        const strength = Math.max(0.3, Math.min(1.5, 0.4 + Number(json.answers?.intensity?.score ?? 1) * 0.35));
        return { type: ev.choice, strength, via: 'xiangxin' };
    }
    catch {
        return undefined;
    }
}

function setupSocialJudge(ctx, config, logger) {
    if ((process.env.QQBOT_SOCIAL_JUDGE ?? 'on') === 'off')
        return;
    const fs = process.getBuiltinModule?.('node:fs');
    if (!fs || !globalThis.__qqbotSocial)
        return;
    const profileDir = process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`;
    const peoplePath = `${profileDir}/qqbot-people.json`;
    const acc = new Map();          // 负向信号累计（按群:人），触发后清零
    const lastJudgeAt = new Map();
    const hourlyCount = new Map();
    const threshold = Math.max(0.5, Number(process.env.QQBOT_JUDGE_WEIGHT ?? 2) || 2);

    const consider = async (mCtx) => {
        try {
            const msg = mCtx?.message;
            if (!msg || msg.kind !== 'group' || !msg.groupOpenid || !msg.senderId)
                return;
            const gid = msg.groupOpenid;
            const content = String(msg.content ?? '').trim();
            if (content.length < 2)
                return;

            const store = globalThis.__qqbotPeopleStore;
            if (!store)
                return;

            // 负向信号累加（不是「叫没叫机器人」）：骂人一句就够，杂音要攒几条
            const key = `${gid}:${msg.senderId}`;
            const weight = (acc.get(key) ?? 0) * 0.75 + (store.signal ? store.signal(content).neg : 0);
            if (weight < threshold) {
                acc.set(key, weight);
                return;
            }
            acc.set(key, 0);

            const now = Date.now();
            if (now - (lastJudgeAt.get(gid) ?? 0) < 10000)
                return;
            const hourKey = `${gid}:${new Date().getHours()}`;
            if ((hourlyCount.get(hourKey) ?? 0) >= 60)
                return;

            let person;
            try {
                const people = Array.isArray(store.read().people) ? store.read().people : [];
                person = people.find((p) => p && Array.isArray(p.openids) && p.openids.includes(msg.senderId));
            }
            catch {
                return;
            }
            if (!person)
                return;
            const social = globalThis.__qqbotSocial.socialOf(person);
            if (now - Number(social.lastEventAt ?? 0) < 60000)
                return;

            const recent = (globalThis.__qqbotRecentMessages?.get(gid) ?? []).slice(-4, -1)
                .map((m) => `${m.name}: ${String(m.content ?? '').slice(0, 80)}`).join('\n');
            const dislike = String(person?.profile?.dislikes ?? '') || '(无特别雷区)';
            const prompt = [
                '机器人人设的雷区：' + dislike,
                recent ? '最近对话：\n' + recent : '',
                `当前消息（${msg.senderName ?? '某人'}）：${content.slice(0, 200)}`,
                '',
                '只判断这条消息是否构成一次**负向**社交事件（辱骂/骚扰/刷屏/欺骗/越界）。善意互动、普通闲聊一律输出 {"type":"none"}。',
                '有的话输出 JSON：{"type":"<类型>","strength":0.3}',
                '类型只能取：hostile_attack, harassment, spam, deception, crossing_line；strength 0.2–1.5。',
                '反讽、玩笑、拿不准时用 none。',
            ].filter(Boolean).join('\n');

            let result = await xiangxinClassify(dislike, msg.senderName ?? '某人', content);
            if (!result)
                result = await socialJudgeCall(prompt);
            lastJudgeAt.set(gid, Date.now());
            hourlyCount.set(hourKey, (hourlyCount.get(hourKey) ?? 0) + 1);
            if (!result || !SOCIAL_JUDGE_NEGATIVE.has(result.type))
                return;

            const strength = Math.max(0.2, Math.min(2, (Number(result.strength) || 0.5) * Math.min(1.6, 0.7 + weight / 3)));
            const note = `「${content.replace(/\s+/g, ' ').slice(0, 40)}」`;
            let applied = false;
            try {
                store.update((s) => {
                    const people = Array.isArray(s.people) ? s.people : [];
                    const target = people.find((p) => p && Array.isArray(p.openids) && p.openids.includes(msg.senderId));
                    if (!target)
                        return false;
                    const so = globalThis.__qqbotSocial.socialOf(target);
                    // 拿锁后再核一次：这几百毫秒里主模型可能已经记过了
                    if (Date.now() - Number(so.lastEventAt ?? 0) < 60000)
                        return false;
                    globalThis.__qqbotSocial.applySocialEvent(target, result.type, strength, note, gid);
                    so.lastJudgeAt = Date.now();
                    so.lastJudgeType = result.type;
                    applied = true;
                    return true;
                });
            }
            catch {
                return;
            }
            if (applied)
                console.log(`[im-qqbot] 裁判事件(负向): ${person.name} ${result.type}(${strength.toFixed(2)}) ${note} via=${result.via ?? 'fallback'} 权重=${weight.toFixed(1)}`);
        }
        catch {
            // 裁判失败不影响对话
        }
    };

    globalThis.__qqbotSocialJudge = { consider };
    console.log('[im-qqbot] 社会事件裁判已启用（只判负向 + 权重累加 + 原话记账）');
}
/* <<< dsh-qqbot-patch:social-judge-helper <<< */

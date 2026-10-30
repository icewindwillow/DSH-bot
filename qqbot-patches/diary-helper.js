/* >>> dsh-qqbot-patch:diary-helper >>> */
/**
 * 自传日记 —— 她自己的日记，不是群日报。
 *
 * 每天 04:00 日报写完之后（每 30 分钟检查一次，>=04:00 且当天没写过才跑）：
 *   1. 从 ltm.db 取当天各群的 [日报]，每个群写一篇 80~150 字的第一人称日记
 *   2. 汇总当天所有日记，再写一条「可以公开」的树洞版本（自动匿名：人名→朋友、去 @ 和长数字）
 *   3. 逐条追加到 qqbot-diary.jsonl；公开草稿仅在管理员显式开启 QQBOT_DIARY_PUBLISH=on 且配置目标时才发布
 *
 * 群内注入：每群最近 2 篇日记（order 96，排在心情之后），约 100 token。
 * 开关：默认关闭，QQBOT_DIARY=on 开启本地日记；QQBOT_DIARY=dry 只写不注入、不发帖。
 * 频道：QQBOT_DIARY_GUILD / QQBOT_DIARY_CHANNEL / QQBOT_CHANNEL_CLI 可覆盖。
 */
function setupDiary(ctx, logger) {
    if (globalThis.__qqbotDiary)
        return;
    const fs = process.getBuiltinModule?.('node:fs');
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    if (!fs || !sqlite) {
        console.log('[im-qqbot] diary: fs/sqlite 不可用，跳过');
        return;
    }
    const mode = String(process.env.QQBOT_DIARY ?? 'off').toLowerCase();
    const ENABLED = mode !== 'off';
    const DRY = mode === 'dry';
    const profileDir = process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`;
    const diaryFile = `${profileDir}/qqbot-diary.jsonl`;
    const dbPath = process.env.QQBOT_MEMORY_DB ?? `${process.env.HOME ?? ''}/.dsh/memory/ltm.db`;
    const GUILD = process.env.QQBOT_DIARY_GUILD ?? '';
    const CHANNEL = process.env.QQBOT_DIARY_CHANNEL ?? '';
    const CLI = process.env.QQBOT_CHANNEL_CLI ?? `${process.env.HOME ?? ''}/.npm-global/bin/tencent-channel-cli`;
    const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const readAll = () => {
        try {
            return fs.readFileSync(diaryFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
                try {
                    return JSON.parse(line);
                }
                catch {
                    return undefined;
                }
            }).filter(Boolean);
        }
        catch {
            return [];
        }
    };
    const append = (entry) => {
        try {
            fs.appendFileSync(diaryFile, `${JSON.stringify(entry)}\n`);
        }
        catch {
            // 写失败不影响主流程
        }
    };
    const groupNames = () => {
        const map = new Map();
        try {
            const meta = JSON.parse(fs.readFileSync(`${profileDir}/qqbot-groups-meta.json`, 'utf8'));
            for (const g of (Array.isArray(meta.groups) ? meta.groups : [])) {
                if (g && g.id)
                    map.set(String(g.id), String(g.name ?? g.id).slice(0, 12));
            }
        }
        catch {
            // 没有 meta 就退回短 id
        }
        return map;
    };

    const streamText = async (system, user, maxTokens = 600) => {
        let llm;
        try {
            llm = ctx.get('llm');
        }
        catch {
            llm = undefined;
        }
        if (!llm || typeof llm.stream !== 'function')
            return '';
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        let out = '';
        try {
            for await (const chunk of llm.stream({
                provider: process.env.QQBOT_DIARY_PROVIDER ?? 'opencode-go',
                model: process.env.QQBOT_DIARY_MODEL ?? 'deepseek-v4.1-flash',
                system,
                messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
                maxTokens,
                reasoningEffort: 'low',
                signal: controller.signal,
            })) {
                if (!chunk)
                    continue;
                if (chunk.type === 'text-delta' && typeof chunk.text === 'string')
                    out += chunk.text;
                else if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted'))
                    return '';
            }
        }
        catch {
            return '';
        }
        finally {
            clearTimeout(timer);
        }
        return out.trim();
    };

    /** 当天各群的 [日报] 正文：gid → 日报文本 */
    const todayDigests = (day) => {
        const out = new Map();
        let db;
        try {
            db = new sqlite.DatabaseSync(dbPath);
        }
        catch {
            return out;
        }
        try {
            const rows = db.prepare("select text, scope from memories where tags like '%日报%' and text like ? order by created_at desc")
                .all(`[日报] ${day}%`);
            for (const row of rows) {
                const scope = String(row.scope ?? '');
                if (!scope.startsWith('qq:group:'))
                    continue;
                const gid = scope.slice('qq:group:'.length);
                if (out.has(gid))
                    continue;
                const text = String(row.text ?? '').replace(/^\[日报\] [\d-]+ [^：]+：/, '').trim();
                if (text !== '')
                    out.set(gid, text.slice(0, 400));
            }
        }
        catch {
            // 查询失败当作没有素材
        }
        finally {
            try { db.close(); } catch { /* 忽略 */ }
        }
        return out;
    };

    const DIARY_SYSTEM = [
        '你是一个友善的虚构群聊助手。遵循管理员设置的人格，不声称真实身份。',
        '现在写你今天的日记，用第一人称，像真的写在日记本上。',
        '只写今天确实发生过的事，不要编造；可以写心情、写对某个人的一点感觉、写一句给自己的话。',
        '不要列表、不要标题、不要写「作为 AI」，不要提「群」「记忆」「总结」这些词。',
        '80~150 字。',
    ].join('\n');
    const PUBLIC_SYSTEM = [
        '你是一个友善的虚构群聊助手。',
        '你在写「树洞」里公开的那一篇日记，读者是不认识你的陌生人。',
        '要求：第一人称、200~300 字、像发给自己看的碎碎念；',
        '绝对不能出现任何真实昵称、群名、地名、学校名、联系方式或能认出是谁的细节；',
        '需要提到别人时，用「有人」「一个朋友」「群里的人」代替；',
        '不要列表、不要标题、不要提「AI」「模型」「群聊记录」。',
    ].join('\n');

    const anonymize = (text) => {
        let out = String(text);
        try {
            const people = JSON.parse(fs.readFileSync(`${profileDir}/qqbot-people.json`, 'utf8'));
            for (const p of (Array.isArray(people.people) ? people.people : [])) {
                const name = String(p?.name ?? '').trim();
                if (name.length >= 2)
                    out = out.split(name).join('朋友');
            }
        }
        catch {
            // 没有档案就只做通用清洗
        }
        out = out.replace(/@\S+/g, '朋友').replace(/\d{5,}/g, '').replace(/[ \t]+/g, ' ');
        return out.trim();
    };

    const publish = (text) => {
        if (DRY || process.env.QQBOT_DIARY_PUBLISH !== 'on' || !GUILD || !CHANNEL)
            return false;
        try {
            const { spawnSync } = process.getBuiltinModule?.('node:child_process') ?? {};
            if (typeof spawnSync !== 'function')
                return false;
            const res = spawnSync(CLI, [
                'feed', 'publish-feed',
                '--guild-id', GUILD,
                '--channel-id', CHANNEL,
                '--content', text,
                '--json',
            ], { encoding: 'utf8', timeout: 30000, env: process.env });
            const stdout = String(res.stdout ?? '');
            const ok = stdout.includes('"success":true');
            console.log(`[im-qqbot] 树洞发帖${ok ? '成功' : '失败'}${ok ? '' : `：${stdout.slice(0, 120) || res.error?.message || ''}`}`);
            return ok;
        }
        catch (err) {
            console.log(`[im-qqbot] 树洞发帖异常: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    };

    let lastDay = '';
    const runOnce = async (force = false) => {
        if (!ENABLED)
            return;
        const now = new Date();
        const today = localDay(now);
        if (!force && (now.getHours() < 4 || lastDay === today))
            return;
        const digests = todayDigests(today);
        if (digests.size === 0) {
            // 素材还没生成（日报可能刚在跑），下一个 tick 再试
            return;
        }
        lastDay = today;
        // 防重复：进程重启后当天已经写过的群不再重写，公开版也只在没发过时才发
        // 只把「日报类」条目当作已完成；事件日记不算，避免白天写过事件就跳过当天日报
        const done = new Set(readAll().filter((e) => e.date === today && e.type !== 'event').map((e) => String(e.gid)));
        const names = groupNames();
        const entries = [];
        for (const [gid, digest] of digests) {
            if (done.has(gid))
                continue;
            const name = names.get(gid) ?? gid.slice(0, 6);
            const text = await streamText(DIARY_SYSTEM, `今天是 ${today}。群里今天发生的事：\n${digest}\n\n写今天的日记。`, 500);
            if (text === '') {
                console.log(`[im-qqbot] 日记生成失败: ${name}`);
                continue;
            }
            const entry = { at: Date.now(), date: today, gid, name, text: text.slice(0, 400) };
            append(entry);
            entries.push(entry);
            console.log(`[im-qqbot] 日记: ${name} ${text.slice(0, 36)}…`);
        }
        if (entries.length === 0 || done.has('public'))
            return;
        const todayEvents = readAll().filter((e) => e.date === today && e.type === 'event' && String(e.gid) !== 'public');
        const publicSource = [
            ...entries.map((e) => `- ${e.text}`),
            ...todayEvents.map((e) => `- 一件小事：${e.text}`),
        ].join('\n');
        const publicText = await streamText(PUBLIC_SYSTEM, `今天（${today}）我经历的事：\n${publicSource}\n\n写一条可以公开的树洞日记。`, 700);
        if (publicText === '')
            return;
        const safe = anonymize(publicText).slice(0, 800);
        const published = publish(safe);
        append({ at: Date.now(), date: today, gid: 'public', name: '树洞', text: safe, published });
    };

    // ── 事件日记：短时间高强度互动写一篇（interaction-helper 触发）──
    const EVENT_SYSTEM = [
        '你是一个友善的虚构群聊助手。',
        '刚才发生了一件让你有感觉的小事，用第一人称写一段日记。',
        '写当时的感受、身体反应（耳朵、尾巴、脸热）和一两个小动作；',
        '不要写「用户」「对话」「消息」这些词，60~120 字，不要标题、不要列表。',
    ].join('\n');
    const eventAt = new Map();
    const eventDay = new Map();
    const event = async ({ gid, name, kind, detail, lastLine }) => {
        if (!ENABLED || DRY)
            return '';
        const now = Date.now();
        const cooldownMs = Math.max(1, Number(process.env.QQBOT_EVENT_COOLDOWN_H ?? 6)) * 3600e3;
        const key = `${gid}:${name}`;
        if (now - (eventAt.get(key) ?? 0) < cooldownMs)
            return '';
        const dayKey = `${gid}:${localDay(new Date(now))}`;
        if ((eventDay.get(dayKey) ?? 0) >= Math.max(1, Number(process.env.QQBOT_EVENT_DAILY_MAX ?? 3)))
            return '';
        const text = await streamText(EVENT_SYSTEM, `人物：${name}\n发生了什么：${kind}\n细节：${detail}\n他最后说的一句：「${lastLine || '（没留下什么）'}」\n\n写这一段日记。`, 400);
        if (text === '')
            return '';
        eventAt.set(key, now);
        eventDay.set(dayKey, (eventDay.get(dayKey) ?? 0) + 1);
        append({ at: now, date: localDay(new Date(now)), gid, name, type: 'event', kind, text: text.slice(0, 300) });
        console.log(`[im-qqbot] 事件日记: ${name} ${kind} ${text.slice(0, 32)}…`);
        return text;
    };

    const promptLine = (gid) => {
        if (!ENABLED || DRY || gid === undefined || gid === null)
            return '';
        const list = readAll().filter((e) => String(e.gid) === String(gid)).slice(-2);
        if (list.length === 0)
            return '';
        const lines = list.map((e) => `${String(e.date ?? '').slice(5)}：${String(e.text ?? '').replace(/\s+/g, ' ').slice(0, 80)}`);
        return `【你最近的手记】\n${lines.join('\n')}\n这些是你自己写下的，别当成别人告诉你的。`;
    };

    // ── 碎碎念：心情特别好/特别差，或刚发生强事件时，自己发一条树洞 ──
    const MUSING_SYSTEM = [
        '你是一个友善的虚构群聊助手。',
        '你在写一条想发在「树洞」里的碎碎念——不是日记，就是随手发的一句话。',
        '40~80 字，第一人称，口语一点；可以写现在的心情、身体的小反应、突然想到的事。',
        '不能出现任何真实昵称、群名、地名、学校名；需要提到别人就用「有人」「一个朋友」。',
        '不要标题、不要列表、不要提「AI」「群聊」。',
    ].join('\n');
    const musingState = { lastAt: 0, day: '', count: 0 };
    const musing = async (force = false) => {
        if (!ENABLED || DRY)
            return '';
        const now = new Date();
        const day = localDay(now);
        if (!force) {
            const hour = now.getHours();
            if (hour < Number(process.env.QQBOT_MUSING_START ?? 9) || hour > Number(process.env.QQBOT_MUSING_END ?? 23))
                return '';
            const cooldown = Math.max(1, Number(process.env.QQBOT_MUSING_COOLDOWN_H ?? 8)) * 3600e3;
            if (Date.now() - musingState.lastAt < cooldown)
                return '';
            if (musingState.day === day && musingState.count >= Math.max(1, Number(process.env.QQBOT_MUSING_DAILY_MAX ?? 2)))
                return '';
        }
        const mood = globalThis.__qqbotMood?.globalSnapshot?.();
        if (!mood)
            return '';
        const high = Number(mood.valence) >= Number(process.env.QQBOT_MUSING_HIGH ?? 82);
        const low = Number(mood.valence) <= Number(process.env.QQBOT_MUSING_LOW ?? 38);
        // 事件只作负向补充（被惹烦/闹僵），正向事件已经写进事件日记，不再重复发碎碎念
        const recent = readAll()
            .filter((e) => e.type === 'event' && Date.now() - Number(e.at ?? 0) < 3 * 3600e3 && /烦|僵/.test(String(e.kind ?? '')))
            .slice(-1)[0];
        if (!high && !low && !recent)
            return '';
        const trigger = recent ? `刚才发生的事：${recent.text}` : `你现在的心情：${mood.label}`;
        const text = await streamText(MUSING_SYSTEM, `${trigger}\n\n写一条碎碎念。`, 300);
        if (text === '')
            return '';
        const safe = anonymize(text).slice(0, 200);
        const published = publish(safe);
        if (musingState.day !== day) {
            musingState.day = day;
            musingState.count = 0;
        }
        musingState.lastAt = Date.now();
        musingState.count += 1;
        append({ at: Date.now(), date: day, gid: 'public', name: '碎碎念', type: 'musing', text: safe, published });
        console.log(`[im-qqbot] 树洞碎碎念${published ? '已发' : '未发'}: ${safe.slice(0, 30)}…`);
        return safe;
    };
    const musingTimer = setInterval(() => { void musing(); }, 30 * 60 * 1000);
    if (typeof musingTimer.unref === 'function')
        musingTimer.unref();

    const timer = setInterval(() => { void runOnce(); }, 30 * 60 * 1000);
    if (typeof timer.unref === 'function')
        timer.unref();

    globalThis.__qqbotDiary = { promptLine, runOnce, readAll, event, musing, _test: { anonymize, localDay } };
    console.log(`[im-qqbot] 自传日记已启用（每天 04:00 后写，${DRY ? 'dry 模式不注入不发帖' : '本地日记模式；对外发布另需显式开启'}）`);
}
/* <<< dsh-qqbot-patch:diary-helper <<< */

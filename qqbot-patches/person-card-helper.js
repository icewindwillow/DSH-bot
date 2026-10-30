/* >>> dsh-qqbot-patch:person-card-helper >>> */
/**
 * 人物近况卡 —— 把碎片化的近况/偏好压成一张「可以直接用」的记忆卡。
 *
 * 每天 04:10 后跑一次（每 30 分钟检查，>=04:10 且当天没跑过）：
 *   1. 取最近 14 天所有群的 [近况]/[偏好] 记忆，按人名跨群合并
 *   2. 同一人 ≥3 条才生成（每次最多 12 人），模型输出严格 JSON：
 *        { card, recent, facts: { birthday, hobbies[], pets[{name,status}], relations[{who,relation,status}] } }
 *   3. card 存成一条记忆（scope: qq:person:<name>，tags: 近况卡 <name> 人物卡），
 *      旧卡删除（卡片是派生数据）；原始近况**永久保留**，作为底稿
 *   4. facts 合并进档案（生日只填空、爱好并集、宠物/关系合并），recent 写 profile.recent
 *
 * 检索：readPersonMemories 改成「最新 1 张卡 + 本群最近 2 条原始」。
 * 开关：QQBOT_PERSON_CARD=off；QQBOT_PERSON_CARD_MAX（每次最多几人，默认 12）。
 */
function setupPersonCard(ctx, logger) {
    if (globalThis.__qqbotPersonCard)
        return;
    if (String(process.env.QQBOT_PERSON_CARD ?? 'on').toLowerCase() === 'off')
        return;
    const fs = process.getBuiltinModule?.('node:fs');
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    const store = globalThis.__qqbotPeopleStore;
    if (!fs || !sqlite || !store) {
        console.log('[im-qqbot] 人物卡: fs/sqlite/people-store 未就绪，跳过');
        return;
    }
    const dbPath = process.env.QQBOT_MEMORY_DB ?? `${process.env.HOME ?? ''}/.dsh/memory/ltm.db`;
    const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const mmdd = (ms) => {
        const d = new Date(Number(ms));
        return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const MAX_PER_RUN = Math.max(1, Number(process.env.QQBOT_PERSON_CARD_MAX ?? 12));

    const streamText = async (system, user, maxTokens = 900) => {
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
        const timer = setTimeout(() => controller.abort(), 40000);
        let out = '';
        try {
            for await (const chunk of llm.stream({
                provider: process.env.QQBOT_CARD_PROVIDER ?? 'opencode-go',
                model: process.env.QQBOT_CARD_MODEL ?? 'deepseek-v4.1-flash',
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

    const SYSTEM = [
        '你在整理一个人的长期记忆卡。输入是 TA 最近两周在群里说过的近况/偏好片段，以及现有档案。',
        '只允许改写和归类，不允许补充输入里没有的事实；每条尽量带日期（MM-DD）。',
        '输出严格 JSON，不要 markdown、不要解释：',
        '{"card":"分条文本，每行以 - 开头，主题：内容（MM-DD），200~300字",',
        ' "recent":"不超过40字的最近状态",',
        ' "facts":{"birthday":"","hobbies":[],"pets":[{"name":"","status":""}],"relations":[{"who":"","relation":"","status":"","since":"YYYY-MM 或空","ended":false}]}}',
        '没有的字段给空字符串或空数组；不要写「不知道」「未提及」；不要写名字以外的隐私（电话、住址）。',
        '关系如果已经结束（分手、离职、去世、搬家），ended 填 true，status 写清楚发生了什么。',
        '不要把机器人自己（小易）写成关系对象；关系只写 TA 现实里的家人、朋友、同事、伴侣。',
        'relation 用标准称谓（父亲、母亲、外祖父、外祖母、哥哥、姐姐、朋友、同事、伴侣、前任），不要直接重复名字。',
    ].join('\n');

    const parse = (raw) => {
        const text = String(raw ?? '').trim();
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start >= 0 && end > start) {
            try {
                const obj = JSON.parse(text.slice(start, end + 1));
                if (obj && typeof obj === 'object')
                    return obj;
            }
            catch {
                // 落到文本兜底
            }
        }
        const card = text.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
        return card === '' ? undefined : { card, recent: card.slice(0, 40), facts: {} };
    };

    const runOnce = async (force = false) => {
        const now = new Date();
        const today = localDay(now);
        if (!force && (now.getHours() < 4 || now.getMinutes() < 10 || globalThis.__qqbotPersonCardDay === today))
            return 0;
        globalThis.__qqbotPersonCardDay = today;
        const since = Date.now() - 14 * 86400000;
        let rows = [];
        try {
            const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
            try {
                rows = db.prepare("select scope, text, created_at from memories where created_at >= ? and (tags like '%近况%' or tags like '%偏好%') and tags not like '%近况卡%' order by created_at asc")
                    .all(since);
            }
            finally {
                db.close();
            }
        }
        catch {
            return 0;
        }
        const byPerson = new Map();
        for (const row of rows) {
            const match = String(row.text ?? '').match(/\] ([^：]{1,20})：/);
            if (!match)
                continue;
            const name = match[1].trim();
            if (!byPerson.has(name))
                byPerson.set(name, []);
            byPerson.get(name).push(row);
        }
        let peopleState;
        try {
            peopleState = store.read();
        }
        catch {
            return 0;
        }
        const byName = new Map();
        for (const person of (Array.isArray(peopleState.people) ? peopleState.people : []))
            byName.set(String(person.name ?? '').trim(), person);

        let written = 0;
        for (const [name, items] of byPerson) {
            if (written >= MAX_PER_RUN)
                break;
            if (items.length < 3)
                continue;
            const person = byName.get(name);
            if (!person)
                continue;
            const snippets = items.slice(-24).map((row) => {
                const text = String(row.text ?? '')
                    .replace(/^\d{4}-\d{2}-\d{2} /, '')
                    .replace(/^\[[^\]]+\] /, '')
                    .replace(/\s+/g, ' ')
                    .slice(0, 100);
                return `- ${mmdd(row.created_at)} ${text}`;
            });
            const profile = person.profile && typeof person.profile === 'object' ? person.profile : {};
            const stable = [
                person.birthday ? `生日 ${person.birthday}` : '',
                profile.education ? `学历 ${profile.education}` : '',
                profile.identity ? `职业 ${profile.identity}` : '',
                profile.city ? `城市 ${profile.city}` : '',
                Array.isArray(profile.hobbies) && profile.hobbies.length ? `爱好 ${profile.hobbies.join('、')}` : '',
                profile.recent ? `之前的近况 ${profile.recent}` : '',
            ].filter(Boolean).join('；') || '（很少）';
            const raw = await streamText(SYSTEM, `人物：${name}\n现有档案：${stable}\n最近两周的片段：\n${snippets.join('\n')}\n\n生成记忆卡。`);
            const parsed = parse(raw);
            if (!parsed || typeof parsed.card !== 'string' || parsed.card.trim() === '')
                continue;
            const card = parsed.card.trim().slice(0, 1200);
            const recent = String(parsed.recent ?? '').trim().slice(0, 80);
            const facts = parsed.facts && typeof parsed.facts === 'object' ? parsed.facts : {};
            // 1) 写卡片记忆（先删旧卡）
            try {
                const db = new sqlite.DatabaseSync(dbPath);
                try {
                    db.prepare("delete from memories where tags like ?").run(`%近况卡 ${name}%`);
                    const ts = Date.now();
                    db.prepare('insert into memories (text, tags, scope, pinned, created_at, updated_at, last_confirmed_at, revision) values (?, ?, ?, 0, ?, ?, ?, 1)')
                        .run(`[近况卡] ${name}（更新 ${mmdd(ts)}）\n${card}`, `近况卡 ${name} 人物卡`, `qq:person:${name}`, ts, ts, ts);
                }
                finally {
                    db.close();
                }
            }
            catch (err) {
                console.log(`[im-qqbot] 人物卡写入失败: ${name} ${err instanceof Error ? err.message : String(err)}`);
                continue;
            }
            // 2) 合并档案
            try {
                store.update((state) => {
                    const target = (Array.isArray(state.people) ? state.people : []).find((p) => String(p?.name ?? '').trim() === name);
                    if (!target)
                        return false;
                    target.profile = target.profile && typeof target.profile === 'object' ? target.profile : {};
                    const p = target.profile;
                    if (!target.birthday && typeof facts.birthday === 'string' && /^\d{1,2}[-/月]\d{1,2}|\d{4}-\d{2}-\d{2}$/.test(facts.birthday.trim()))
                        target.birthday = facts.birthday.trim().slice(0, 20);
                    const mergeList = (current, incoming, cap) => {
                        const list = Array.isArray(current) ? current.map((v) => String(v)) : [];
                        for (const v of (Array.isArray(incoming) ? incoming : [])) {
                            const value = String(v ?? '').trim().slice(0, 40);
                            if (value !== '' && !list.includes(value))
                                list.push(value);
                        }
                        return list.slice(0, cap);
                    };
                    p.hobbies = mergeList(p.hobbies, facts.hobbies, 16);
                    const pets = (Array.isArray(facts.pets) ? facts.pets : []).map((pet) => {
                        if (!pet || typeof pet !== 'object')
                            return '';
                        const n = String(pet.name ?? '').trim().slice(0, 20);
                        const s = String(pet.status ?? '').trim().slice(0, 40);
                        return n === '' ? '' : (s === '' ? n : `${n}（${s}）`);
                    }).filter(Boolean);
                    p.pets = mergeList(p.pets, pets, 10);
                    const SELF = new Set(['小易', '机器人', '我', '本人']);
                    const todayMonth = new Date().toISOString().slice(0, 7);
                    const relationFacts = (Array.isArray(p.relationFacts) ? p.relationFacts : [])
                        .filter((item) => item && typeof item === 'object' && !SELF.has(String(item.who ?? '')));
                    for (const rel of (Array.isArray(facts.relations) ? facts.relations : [])) {
                        if (!rel || typeof rel !== 'object')
                            continue;
                        const who = String(rel.who ?? '').trim().slice(0, 20);
                        const relation = String(rel.relation ?? '').trim().slice(0, 20);
                        const status = String(rel.status ?? '').trim().slice(0, 40);
                        const since = /^\d{4}-\d{2}$/.test(String(rel.since ?? '').trim()) ? String(rel.since).trim() : '';
                        const ended = rel.ended === true;
                        if (who === '' || relation === '' || SELF.has(who))
                            continue;
                        // 同一个人只保留一条：关系标签变了就更新标签，不新增
                        let entry = relationFacts.find((item) => item.who === who);
                        if (!entry) {
                            entry = { who, relation, status: '', since: since || todayMonth, until: '', updatedAt: todayMonth };
                            relationFacts.push(entry);
                        }
                        if (relation !== '')
                            entry.relation = relation;
                        if (status !== '')
                            entry.status = status;
                        if (since !== '' && entry.since === '')
                            entry.since = since;
                        if (ended)
                            entry.until = todayMonth;
                        entry.updatedAt = todayMonth;
                    }
                    p.relationFacts = relationFacts.slice(-20);
                    // relations 由 facts 重建（同一人一个键），保留面板里手写、但 facts 没覆盖的条目
                    const covered = new Set(relationFacts.map((item) => item.who));
                    const manual = Object.entries(p.relations && typeof p.relations === 'object' && !Array.isArray(p.relations) ? p.relations : {})
                        .filter(([key]) => ![...covered].some((who) => key.startsWith(`${who}（`)))
                        .filter(([key]) => ![...SELF].some((who) => key.startsWith(`${who}（`)));
                    const rebuilt = {};
                    for (const [key, value] of manual)
                        rebuilt[key] = value;
                    for (const item of relationFacts) {
                        if (item.until)
                            continue;
                        rebuilt[`${item.who}（${item.relation}）`] = item.status;
                    }
                    p.relations = rebuilt;
                    if (recent !== '') {
                        p.recent = recent;
                        p.recentAt = new Date().toISOString();
                        p.recentSource = { card: true, items: items.length };
                    }
                    return true;
                });
            }
            catch {
                // 档案锁失败：卡片已经写了，下次再合并
            }
            written += 1;
            console.log(`[im-qqbot] 人物卡: ${name} ${card.replace(/\s+/g, ' ').slice(0, 36)}…`);
        }
        if (written > 0)
            console.log(`[im-qqbot] 人物卡更新: ${written} 人`);
        return written;
    };

    const timer = setInterval(() => { void runOnce(); }, 30 * 60 * 1000);
    if (typeof timer.unref === 'function')
        timer.unref();

    globalThis.__qqbotPersonCard = { runOnce };
    console.log('[im-qqbot] 人物近况卡已启用（每天 04:10 后，跨群合并，原始近况永久保留）');
}
/* <<< dsh-qqbot-patch:person-card-helper <<< */

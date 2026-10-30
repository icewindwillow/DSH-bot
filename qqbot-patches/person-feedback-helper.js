/* >>> dsh-qqbot-patch:person-feedback-helper >>> */
/**
 * 通用反馈体系（person feedback）——对档案里的每个人生效的「怎么接话」策略。
 *
 * 组成：
 *   注册表  ~/.dsh/profiles/qqbot/qqbot-person-feedback.json
 *     defaults：所有人共用的反馈准则 + 象信分类口径
 *     people  ：按人覆盖（summary / interests / styleSkills / judge / rules）
 *   规则    { id, when: { image | share | link | text | always }, prompt }
 *   风格    仍由 role-skills 注入；这里只负责「反馈内容 + 工具流程」
 *
 * 每轮按当前说话人（与本 turn 队首）判断触发：
 *   - 发图       → 提示先 qqbot_describe_image，再 feedback_judge(mode=media)
 *   - 分享作品   → 提示先 feedback_web_search，再 feedback_judge(mode=reputation)
 *   - 文本关键词 → 只注入对应的一段
 * 未配置的人也会拿到「通用准则 + 档案兴趣」，不会漏掉。
 */
const PERSON_FEEDBACK_SHARE_RE = /游戏|电影|电视剧|剧集|动画|动漫|漫画|小说|书|专辑|歌曲|音乐|视频|推荐|安利|玩了|玩了会|看过|看了|在玩|在看|通关|Steam|steam|PS5|ps5|Switch|switch|主机|桌游|跑团|模组|新作|续作|预告|上映|开播|实机演示|实机|B站|bilibili|youtube|豆瓣|https?:\/\//i;
const PERSON_FEEDBACK_DEFAULT_GENERAL = [
    '【通用反馈准则】先看懂，再评价；不敷衍、不硬夸、不编造。',
    '- 发图：准备评论前先 qqbot_describe_image 看清；没看之前绝不说图里有什么。',
    '- 分享作品：先用 feedback_web_search 查口碑；搜不到就问一句，别编评分和剧情。',
    '- 拿不准就用 feedback_judge（象信）判断，不靠猜。',
    '- 评价要具体到一个细节；一次只回一条，2–4 句。',
].join('\n');

function personFeedbackText(value) {
    if (Array.isArray(value))
        return value.map((item) => String(item ?? '')).join('\n').trim();
    return String(value ?? '').trim();
}

function personFeedbackModules() {
    try {
        const parsed = JSON.parse(readFileSync(`${personFeedbackProfileDir()}/qqbot-person-modules.json`, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    }
    catch {
        return {};
    }
}

function personFeedbackModuleOf(name) {
    const modules = personFeedbackModules();
    return modules.people && typeof modules.people === 'object' ? modules.people[name] : undefined;
}

function personFeedbackProfileDir() {
    return process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`;
}

function personFeedbackRegistryPath() {
    return `${personFeedbackProfileDir()}/qqbot-person-feedback.json`;
}

function readPersonFeedbackRegistry() {
    try {
        const parsed = JSON.parse(readFileSync(personFeedbackRegistryPath(), 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    }
    catch {
        return {};
    }
}

function personFeedbackLog(message) {
    try {
        appendFileSync(`${personFeedbackProfileDir()}/qqbot-person-feedback.log`, `${new Date().toISOString()} ${message}\n`);
    }
    catch {
        // 日志失败不影响对话
    }
}

function personFeedbackPeopleList() {
    if (typeof readPeopleList === 'function')
        return readPeopleList();
    try {
        const parsed = JSON.parse(readFileSync(`${personFeedbackProfileDir()}/qqbot-people.json`, 'utf8'));
        return Array.isArray(parsed?.people) ? parsed.people : [];
    }
    catch {
        return [];
    }
}

function personFeedbackFindPerson(list, speaker) {
    if (typeof findPersonForSpeaker === 'function')
        return findPersonForSpeaker(list, speaker);
    if (!speaker)
        return undefined;
    const name = String(speaker.name ?? '').trim();
    return list.find((person) => {
        if (!person || typeof person !== 'object')
            return false;
        if (Array.isArray(person.openids) && speaker.id && person.openids.includes(speaker.id))
            return true;
        return String(person.name ?? '').trim() === name;
    });
}

/** 当前在回谁：优先 replyTarget，其次本 turn 队首，最后才是「本群最近发言者」 */
function personFeedbackSpeaker(gid, record) {
    const byTarget = typeof roleSkillReplySpeaker === 'function' ? roleSkillReplySpeaker(gid, record) : undefined;
    if (byTarget)
        return byTarget;
    const byQueue = typeof roleSkillPendingSpeaker === 'function' ? roleSkillPendingSpeaker(gid) : undefined;
    if (byQueue)
        return byQueue;
    const speakers = globalThis.__qqbotSpeakers;
    return speakers instanceof Map ? speakers.get(gid) : undefined;
}

/** 这个人最近几条消息（只留 5 分钟内、最多 5 条），用来找图 / 判断分享 */
function personFeedbackRecentOf(gid, speaker) {
    const recent = globalThis.__qqbotRecentMessages?.get?.(gid) ?? [];
    const cutoff = Date.now() - 5 * 60 * 1000;
    return recent
        .filter((m) => m && Number(m.at ?? 0) >= cutoff)
        .filter((m) => (speaker.id ? m.id === speaker.id : m.name === speaker.name))
        .slice(-5);
}

function personFeedbackImagePaths(messages) {
    const paths = [];
    for (const msg of messages) {
        const content = String(msg?.content ?? '');
        for (const match of content.matchAll(/Image:\s*(\/[^\s)]+)/g)) {
            const path = match[1];
            if (!paths.includes(path))
                paths.push(path);
        }
    }
    return paths.slice(0, 3);
}

function personFeedbackHasLink(messages) {
    return messages.some((m) => /https?:\/\/|www\./i.test(String(m?.content ?? '')));
}

function personFeedbackLooksShare(messages) {
    return messages.some((m) => PERSON_FEEDBACK_SHARE_RE.test(String(m?.content ?? '')));
}

/** 规则的 when 条件：全部满足才触发；空对象 = 总是触发 */
function personFeedbackRuleMatches(rule, ctx) {
    const when = rule?.when;
    if (!when || typeof when !== 'object')
        return true;
    const keys = Object.keys(when);
    if (keys.length === 0)
        return true;
    for (const key of keys) {
        const expected = when[key];
        if (key === 'image' && Boolean(expected) !== ctx.hasImage)
            return false;
        else if (key === 'share' && Boolean(expected) !== ctx.isShare)
            return false;
        else if (key === 'link' && Boolean(expected) !== ctx.hasLink)
            return false;
        else if (key === 'always') {
            if (expected === false)
                return false;
        }
        else if (key === 'text') {
            try {
                if (!new RegExp(String(expected), 'i').test(ctx.text))
                    return false;
            }
            catch {
                return false;
            }
        }
    }
    return true;
}

function personFeedbackInterests(entry, matched) {
    const fromEntry = Array.isArray(entry?.interests) ? entry.interests : [];
    if (fromEntry.length > 0)
        return fromEntry.map((x) => String(x).trim()).filter(Boolean).slice(0, 6);
    const profile = matched?.profile ?? {};
    const out = [];
    for (const key of ['hobbies', 'skills', 'pets']) {
        const value = profile[key];
        if (Array.isArray(value))
            out.push(...value.map((x) => String(x).trim()));
        else if (typeof value === 'string' && value.trim() !== '')
            out.push(value.trim());
    }
    if (typeof profile.identity === 'string' && profile.identity.trim() !== '')
        out.push(profile.identity.trim());
    return [...new Set(out.filter(Boolean))].slice(0, 6);
}

function personFeedbackSkillLabel(id) {
    try {
        const parsed = JSON.parse(readFileSync(`${personFeedbackProfileDir()}/qqbot-role-skills.json`, 'utf8'));
        const skill = (parsed?.skills ?? []).find((item) => String(item?.id ?? '') === id);
        const name = String(skill?.name ?? '').trim();
        if (name !== '')
            return name;
    }
    catch {
        // 没有注册表就退回 id
    }
    return id;
}

function personFeedbackStyleLine(entry) {
    const skills = Array.isArray(entry?.styleSkills) ? entry.styleSkills.map((s) => String(s).trim()).filter(Boolean) : [];
    if (skills.length === 0)
        return '';
    const labels = skills.map((id) => personFeedbackSkillLabel(id)).join(' / ');
    return `【风格】如果本轮出现【角色爱好·${labels}】，反馈内容也按那个风格说；没出现就正常说。`;
}

function personFeedbackRenderEntry(name, entry, ctx, matched) {
    const lines = [`【反馈策略·${name}】`];
    const summary = String(entry?.summary ?? '').trim();
    if (summary)
        lines.push(summary);
    const interests = personFeedbackInterests(entry, matched);
    if (interests.length > 0)
        lines.push(`- 档案兴趣：${interests.join('、')}（聊到相关的可以多问一句，别装懂）`);
    const styleLine = personFeedbackStyleLine(entry);
    if (styleLine)
        lines.push(styleLine);
    if (entry?.alwaysReply === true && (ctx.images.length > 0 || ctx.isShare))
        lines.push('【优先级】TA 分享图/作品时，即使这条没有 @ 你，也用一句话接住；不确定就短接，别沉默。');
    if (ctx.images.length > 0) {
        lines.push(`【本轮图片】${ctx.images.join('、')}`);
        lines.push('  评论前先用 qqbot_describe_image（image 传上面的路径，prompt 写具体），再决定怎么接；没看之前不要描述图。');
    }
    const triggers = [];
    if (ctx.images.length > 0)
        triggers.push('发图');
    if (ctx.isShare)
        triggers.push('疑似分享作品');
    if (ctx.hasLink)
        triggers.push('链接');
    const rules = Array.isArray(entry?.rules) ? entry.rules : [];
    const hit = rules.filter((rule) => personFeedbackRuleMatches(rule, ctx));
    if (triggers.length > 0)
        lines.push(`【本轮触发】${triggers.join('；')}`);
    if (hit.length > 0) {
        lines.push('【按这个来·硬性】下面这些是本轮的具体要求，按顺序执行；涉及工具时不要跳过，也不要直接编。');
        for (const rule of hit) {
            const prompt = personFeedbackText(rule?.prompt);
            if (prompt)
                lines.push(prompt);
        }
    }
    else if (rules.length > 0) {
        lines.push('本轮没有命中专属规则：按通用准则和档案兴趣自然接，不要硬套。');
    }
    return lines.join('\n');
}

function personFeedbackRenderGeneric(name, matched, ctx) {
    const lines = [`【反馈策略·${name}】`];
    const interests = personFeedbackInterests(undefined, matched);
    if (interests.length > 0)
        lines.push(`- 档案兴趣：${interests.join('、')}（聊到相关的可以多问一句，别装懂）`);
    if (ctx.images.length > 0) {
        lines.push(`【本轮图片】${ctx.images.join('、')}`);
        lines.push('  评论前先用 qqbot_describe_image（image 传上面的路径，prompt 写具体）。');
    }
    if (ctx.isShare || ctx.hasLink) {
        lines.push('【本轮像是分享】先用 feedback_web_search 查一下是什么、口碑如何，再回；搜不到就问，别编。');
    }
    lines.push('其它按通用准则：发图先看、分享先查、拿不准用 feedback_judge。');
    return lines.join('\n');
}

/**
 * 拼这一轮要注入的反馈段（没有就返回空串）。
 * 只对「档案里能对上的人」生效；路人交给群规则。
 */
function buildPersonFeedbackSection(gid, record) {
    if (!gid)
        return '';
    if ((process.env.QQBOT_PERSON_FEEDBACK ?? 'on') === 'off')
        return '';
    const registry = readPersonFeedbackRegistry();
    const defaults = registry.defaults && typeof registry.defaults === 'object' ? registry.defaults : {};
    if (defaults.enabled === false)
        return '';
    const speaker = personFeedbackSpeaker(gid, record);
    if (!speaker || (!speaker.name && !speaker.id))
        return '';
    const matched = personFeedbackFindPerson(personFeedbackPeopleList(), speaker);
    if (!matched)
        return '';
    const name = String(matched.name ?? '').trim();
    if (name === '')
        return '';
    const entry = registry.people?.[name];
    if (entry && entry.enabled === false)
        return '';
    if (Array.isArray(entry?.groups) && entry.groups.length > 0 && !entry.groups.includes(gid))
        return '';

    const messages = personFeedbackRecentOf(gid, speaker);
    const images = personFeedbackImagePaths(messages);
    const text = messages.length > 0 ? String(messages[messages.length - 1]?.content ?? '') : '';
    const hasLink = personFeedbackHasLink(messages);
    const ctx = {
        images,
        text,
        hasImage: images.length > 0,
        // 分享链接通常也是在分享作品（游戏/电影/文章），一并走「先查再回」
        isShare: personFeedbackLooksShare(messages) || hasLink,
        hasLink,
    };

    const lines = [];
    const general = personFeedbackText(defaults.generalPrompt) || PERSON_FEEDBACK_DEFAULT_GENERAL;
    lines.push(general);
    lines.push(entry
        ? personFeedbackRenderEntry(name, entry, ctx, matched)
        : personFeedbackRenderGeneric(name, matched, ctx));

    // 通用主题模块：按人勾选。只补在「没有命中专属硬性规则」的轮次，避免和本地配置的专属流程重复。
    const personModule = personFeedbackModuleOf(name);
    if (personModule?.topics?.enabled === true && (ctx.isShare || ctx.hasLink || images.length > 0)) {
        const current = lines.join('\n');
        if (!current.includes('【按这个来·硬性】')) {
            const topics = Array.isArray(personModule.topics.topics)
                ? personModule.topics.topics.map((topic) => String(topic ?? '').trim()).filter(Boolean)
                : [];
            lines.push([
                '【通用主题模块·先搜再回】',
                `他分享的是他关注的主题${topics.length > 0 ? `（${topics.join('、')}）` : ''}。`,
                '先认出作品/主题；图片先 qqbot_describe_image；再用 feedback_web_search 搜「作品名或标题 口碑 评价」；',
                '再用 feedback_judge(mode=reputation)；最后具体评论 + 问他体验。不剧透、不编、不收进媒体库。',
            ].join('\n'));
        }
    }

    const contexts = globalThis.__qqbotFeedbackContexts ?? (globalThis.__qqbotFeedbackContexts = new Map());
    contexts.set(gid, {
        gid,
        person: name,
        speaker: { id: String(speaker.id ?? ''), name: String(speaker.name ?? '') },
        images,
        isShare: ctx.isShare,
        hasLink: ctx.hasLink,
        text: text.slice(0, 500),
        at: Date.now(),
    });
    if (contexts.size > 30) {
        const cutoff = Date.now() - 30 * 60 * 1000;
        for (const [key, value] of contexts) {
            if (Number(value?.at ?? 0) < cutoff)
                contexts.delete(key);
        }
    }

    const section = lines.filter(Boolean).join('\n');
    const hitCount = entry && Array.isArray(entry.rules)
        ? entry.rules.filter((rule) => personFeedbackRuleMatches(rule, ctx)).length
        : 'generic';
    personFeedbackLog(`inject person=${name} group=${gid} images=${images.length} share=${ctx.isShare ? 1 : 0} rules=${hitCount} len=${section.length}`);
    if (process.env.QQBOT_PROMPT_DEBUG === '1') {
        try {
            appendFileSync(`${personFeedbackProfileDir()}/qqbot-prompt-debug.log`, `${new Date().toISOString()} feedback person=${name} len=${section.length} images=${images.length} share=${ctx.isShare ? 1 : 0}\n`);
        }
        catch {
            // 调试日志失败不影响对话
        }
    }
    return section;
}
/* <<< dsh-qqbot-patch:person-feedback-helper <<< */

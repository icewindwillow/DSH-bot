/* >>> dsh-qqbot-patch:role-skills-helper >>> */
/**
 * 特定角色爱好（role skill）——按「现在是谁在说话」自动启用的角色技能。
 *
 * 结构：
 *   注册表  ~/.dsh/profiles/qqbot/qqbot-role-skills.json
 *     { skills: [{ id, name, category, file, enabled, audiences: [{ person, openids, groups, default }] }] }
 *   技能正文 skills/<id>/SKILL.md（去掉 frontmatter 后注入）
 *   开关    ~/.dsh/profiles/qqbot/qqbot-role-skills-state.json
 *     { "<group>:<openid|name>:<skillId>": { enabled, by, at, reason } }
 *
 * 规则：
 * - 只有当前说话人命中 audiences 且群也命中，才注入；换个人说话自动不注入。
 * - 默认值顺序：显式开关 > audience.default > skill.enabled。
 * - 本人说「正常跟我说话 / 别用强者语」→ 自动关；说「来点强者语」→ 自动开。
 *   别的说法交给模型调用 switch_role_skill 工具。
 *
 * 依赖 session-manager.js 里已有的 readPeopleList / findPersonForSpeaker / namesOfPerson。
 */
const ROLE_SKILL_OFF_RE = /你(?:正常|平常|普通)(?:点|一点)(?!的时候|时|的样子)|(?:正常|平常|普通)(?:点|一点|地|一点地)?(?:跟我|和我|跟咱|同我)?(?:说话|讲话|聊天?)(?!的时候|时|的样子)|说人话|别(?:再)?(?:用|说|整|搞|玩)(?:什么|甚么)?(?:强者语|海虎语)|不要(?:再)?(?:用|说|整|搞|玩)(?:什么|甚么)?(?:强者语|海虎语)|(?:把)?(?:强者语|海虎语)(?:先)?(?:关|停|收|撤|免)|(?:关|停|收|撤)(?:掉|了)?(?:强者语|海虎语|这个技能)/;
const ROLE_SKILL_ON_RE = /(?:说|来|用|整|讲|玩)(?:点|些|两句|一句|一下)?(?:强者语|海虎语)|(?:开|开启|启动|打开|恢复|继续|回来)(?:强者语|海虎语)|(?:强者语|海虎语)(?:模式)?(?:开|开启|启动|打开|回来|继续)/;

function roleSkillProfileDir() {
    return process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`;
}

function roleSkillRegistryPath() {
    return `${roleSkillProfileDir()}/qqbot-role-skills.json`;
}

function roleSkillStatePath() {
    return `${roleSkillProfileDir()}/qqbot-role-skills-state.json`;
}

function readRoleSkillRegistry() {
    try {
        const parsed = JSON.parse(readFileSync(roleSkillRegistryPath(), 'utf8'));
        return Array.isArray(parsed?.skills) ? parsed.skills : [];
    }
    catch {
        return [];
    }
}

function readRoleSkillState() {
    try {
        const parsed = JSON.parse(readFileSync(roleSkillStatePath(), 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}

function writeRoleSkillState(state) {
    try {
        writeFileSync(roleSkillStatePath(), `${JSON.stringify(state, null, 2)}\n`);
        return true;
    }
    catch {
        return false;
    }
}

function roleSkillLog(message) {
    try {
        appendFileSync(`${roleSkillProfileDir()}/qqbot-role-skills.log`, `${new Date().toISOString()} ${message}\n`);
    }
    catch {
        // 日志失败不影响对话
    }
}

/** 同一个人用 openid 做键（昵称会变），拿不到 openid 才退回名字 */
function roleSkillPersonKey(person) {
    const openids = Array.isArray(person?.openids) ? person.openids : [];
    const openid = openids.find((id) => typeof id === 'string' && id.trim() !== '');
    if (openid)
        return `openid:${openid}`;
    return `name:${String(person?.name ?? '').trim()}`;
}

function roleSkillStateKey(gid, person, skill) {
    return `${gid}:${roleSkillPersonKey(person)}:${String(skill?.id ?? '').trim()}`;
}

function roleSkillSpeaker(gid) {
    const speakers = globalThis.__qqbotSpeakers;
    return speakers instanceof Map ? speakers.get(gid) : undefined;
}

/**
 * 最准的信号：本 turn 的 replyTarget.msgId 指向哪条入站消息，就按它的发送者算。
 * QQ 插件在 handleInbound 里用当前消息的 messageId 设置 replyTarget，
 * 批次消息里它就是最后一条（也就是机器人真正在回的那条）。
 */
function roleSkillReplySpeaker(gid, record) {
    const target = record?.replyTarget;
    if (!target || String(target.targetId ?? '') !== String(gid))
        return undefined;
    const msgId = String(target.msgId ?? '');
    if (msgId === '')
        return undefined;
    const bucket = globalThis.__qqbotRecentMessages?.get?.(gid) ?? [];
    for (let i = bucket.length - 1; i >= 0; i -= 1) {
        const item = bucket[i];
        if (item && String(item.msgId ?? '') === msgId)
            return { id: String(item.id ?? ''), name: String(item.name ?? '') };
    }
    return undefined;
}

/**
 * 这一轮实际在回谁：优先 replyTarget，其次「本 turn 第一条待处理消息」。
 *
 * 群聊里消息会排队：turn 组装时 __qqbotSpeakers 可能已经被后一条消息覆盖，
 * 只按它会认错人（例如无恨的话排在前面、别人后来说了一句）。入站队列按
 * turn/end 清理，所以队首就是本 turn 用户消息的开头那条。
 */
function roleSkillPendingSpeaker(gid) {
    // 优先本 turn 开始时拍下的快照（那才是这一轮真正取走的消息），
    // 其次才是 turn 进行中新到的消息。
    const turn = globalThis.__qqbotRoleTurnInbound?.get?.(gid) ?? [];
    const pending = globalThis.__qqbotPendingInbound?.get?.(gid) ?? [];
    const first = turn.length > 0 ? turn[0] : pending.length > 0 ? pending[0] : undefined;
    if (!first)
        return undefined;
    return { id: String(first.id ?? ''), name: String(first.name ?? '') };
}

/** 当前说话人 → 档案里的人（没建档就退化成「名字 + openid」的临时对象） */
function resolveRoleSkillPerson(gid, record) {
    const speaker = roleSkillReplySpeaker(gid, record) ?? roleSkillPendingSpeaker(gid) ?? roleSkillSpeaker(gid);
    if (!speaker || (!speaker.name && !speaker.id))
        return undefined;
    const matched = findPersonForSpeaker(readPeopleList(), speaker);
    if (matched)
        return matched;
    return { name: String(speaker.name ?? ''), openids: speaker.id ? [speaker.id] : [] };
}

/**
 * turn/start：把当前待处理队列整段拍成「本 turn 快照」，并清空 pending。
 * turn 进行中新到的消息会进入新的 pending，留给下一轮——这样既不会把
 * 本轮的消息算到下一轮，也不会丢掉生成期间的新消息。
 */
function markRoleSkillTurnStart(gid, at) {
    if (!gid)
        return;
    const pendingMap = globalThis.__qqbotPendingInbound;
    const snapshot = pendingMap?.get?.(gid) ?? [];
    const turnMap = globalThis.__qqbotRoleTurnInbound ?? (globalThis.__qqbotRoleTurnInbound = new Map());
    turnMap.set(gid, snapshot);
    pendingMap?.delete?.(gid);
}

function finishRoleSkillTurn(gid) {
    if (!gid)
        return;
    globalThis.__qqbotRoleTurnInbound?.delete?.(gid);
}

/** 这个技能有没有对「这个人 + 这个群」开放 */
function roleSkillAudience(skill, gid, person) {
    const audiences = Array.isArray(skill?.audiences) ? skill.audiences : [];
    for (const audience of audiences) {
        if (!audience || typeof audience !== 'object')
            continue;
        const groups = Array.isArray(audience.groups)
            ? audience.groups.filter((g) => typeof g === 'string' && g.trim() !== '')
            : [];
        if (groups.length > 0 && !groups.includes(gid))
            continue;
        if (Array.isArray(audience.openids) && Array.isArray(person?.openids)
            && audience.openids.some((id) => person.openids.includes(id)))
            return audience;
        const wanted = String(audience.person ?? '').trim().toLowerCase();
        if (wanted === '')
            continue;
        const names = namesOfPerson(person).map((n) => n.toLowerCase());
        if (names.includes(wanted))
            return audience;
    }
    return undefined;
}

function roleSkillEnabled(skill, audience, gid, person) {
    const state = readRoleSkillState();
    const entry = state[roleSkillStateKey(gid, person, skill)];
    if (entry && typeof entry.enabled === 'boolean')
        return entry.enabled;
    if (audience && typeof audience.default === 'boolean')
        return audience.default;
    return skill?.enabled !== false;
}

/** 技能正文：读 SKILL.md，去掉 YAML frontmatter（元信息在注册表里） */
function readRoleSkillBody(file) {
    const name = String(file ?? '').trim();
    if (name === '')
        return '';
    const path = name.startsWith('/') ? name : `${roleSkillProfileDir()}/${name}`;
    try {
        return readFileSync(path, 'utf8')
            .replace(/^---\n[\s\S]*?\n---\n/, '')
            .trim();
    }
    catch {
        return '';
    }
}

/**
 * 只认「当前说话人刚发的那一条」里的开关口令，避免旧消息反复触发。
 * @returns {boolean|undefined} 这轮有没有明确要求开/关
 */
function applyRoleSkillPhrases(gid, skill, person) {
    const speaker = roleSkillSpeaker(gid);
    if (!speaker)
        return undefined;
    const recent = globalThis.__qqbotRecentMessages?.get?.(gid) ?? [];
    const last = recent.length > 0 ? recent[recent.length - 1] : undefined;
    if (!last)
        return undefined;
    if (last.id !== speaker.id && last.name !== speaker.name)
        return undefined;
    const text = String(last.content ?? '').trim();
    if (text === '')
        return undefined;
    let next;
    if (ROLE_SKILL_OFF_RE.test(text))
        next = false;
    else if (ROLE_SKILL_ON_RE.test(text))
        next = true;
    else
        return undefined;
    const state = readRoleSkillState();
    const key = roleSkillStateKey(gid, person, skill);
    const prev = state[key]?.enabled;
    if (typeof prev === 'boolean' && prev === next)
        return next;
    state[key] = {
        enabled: next,
        by: 'auto',
        at: new Date().toISOString(),
        reason: text.slice(0, 50),
    };
    writeRoleSkillState(state);
    roleSkillLog(`auto-${next ? 'on' : 'off'} skill=${skill?.id ?? '?'} person=${person?.name ?? '?'} group=${gid}`);
    return next;
}

/** 拼这一轮要注入的角色技能段（没有就返回空串） */
function buildRoleSkillSection(gid, record) {
    if (!gid)
        return '';
    const person = resolveRoleSkillPerson(gid, record);
    if (!person)
        return '';
    const blocks = [];
    for (const skill of readRoleSkillRegistry()) {
        if (!skill || typeof skill !== 'object' || skill.enabled === false)
            continue;
        const audience = roleSkillAudience(skill, gid, person);
        if (!audience)
            continue;
        applyRoleSkillPhrases(gid, skill, person);
        if (!roleSkillEnabled(skill, audience, gid, person))
            continue;
        const body = readRoleSkillBody(skill.file);
        if (body === '')
            continue;
        const label = String(skill.name ?? skill.id ?? '').trim();
        roleSkillLog(`inject skill=${skill.id} person=${person.name} group=${gid} pending=${roleSkillPendingSpeaker(gid)?.name ?? '-'} speaker=${roleSkillSpeaker(gid)?.name ?? '-'}`);
        // 指令放最后：前面是词表/示范，最后这句才是「本轮必须执行」的硬要求
        const directive = String(skill.directive ?? '').trim()
            || `这一轮必须用「${label}」的说话方式回复${person.name}；不要用你平时的口癖开头。`;
        blocks.push(`【角色爱好·${label}（只对${person.name}）】\n${body}\n\n【本轮硬性】${directive}`);
    }
    return blocks.join('\n\n');
}

/** 工具 switch_role_skill 的实现：按当前群 + 指定的人改开关 */
function switchRoleSkill(args) {
    const gid = String(args?.group ?? globalThis.__qqbotLastGid ?? '').trim();
    if (gid === '')
        return { ok: false, message: '不知道当前在哪个群，这次先按说的做，下次再试。' };
    const ref = String(args?.skill ?? '').trim().toLowerCase();
    const skills = readRoleSkillRegistry();
    const skill = skills.find((item) => item
        && (String(item.id ?? '').toLowerCase() === ref || String(item.name ?? '').toLowerCase() === ref));
    if (!skill)
        return { ok: false, message: `没有找到叫「${args?.skill ?? ''}」的角色技能。` };
    const speaker = roleSkillSpeaker(gid);
    const wantedName = String(args?.person ?? speaker?.name ?? '').trim();
    if (wantedName === '')
        return { ok: false, message: '不知道要改谁的这个技能。' };
    // 只允许本人改自己的：别人替他说「把无恨的强者语关了」不算
    const speakerPerson = resolveRoleSkillPerson(gid);
    const speakerNames = speakerPerson ? namesOfPerson(speakerPerson).map((n) => n.toLowerCase()) : [];
    if (speakerNames.length > 0 && !speakerNames.includes(wantedName.toLowerCase()))
        return { ok: false, message: '这个只能由本人自己决定。' };
    const people = readPeopleList();
    const person = people.find((p) => p && (String(p.name ?? '').trim() === wantedName
        || namesOfPerson(p).some((n) => n.toLowerCase() === wantedName.toLowerCase())))
        ?? { name: wantedName, openids: [] };
    const audience = roleSkillAudience(skill, gid, person);
    if (!audience)
        return { ok: false, message: `「${skill.name ?? skill.id}」没有对「${wantedName}」开放。` };
    const enabled = args?.enabled !== false;
    const state = readRoleSkillState();
    state[roleSkillStateKey(gid, person, skill)] = {
        enabled,
        by: 'tool',
        at: new Date().toISOString(),
        reason: String(args?.note ?? '').slice(0, 80),
    };
    if (!writeRoleSkillState(state))
        return { ok: false, message: '开关没写进去；这次先照说的做，下次再试。' };
    roleSkillLog(`tool-${enabled ? 'on' : 'off'} skill=${skill.id} person=${person.name} group=${gid}`);
    return {
        ok: true,
        message: enabled
            ? `已为「${person.name}」打开「${skill.name ?? skill.id}」。`
            : `已为「${person.name}」关掉「${skill.name ?? skill.id}」，之后正常说话。`,
    };
}

// 工具注册在 bootstrap 里，跨模块只能走 globalThis（与 __qqbotSpeakers 同款做法）
globalThis.__qqbotRoleSkillSwitch = switchRoleSkill;
globalThis.__qqbotRoleSkillTurnStart = markRoleSkillTurnStart;
globalThis.__qqbotRoleSkillTurnEnd = finishRoleSkillTurn;
/* <<< dsh-qqbot-patch:role-skills-helper <<< */

/* >>> dsh-qqbot-patch:permissions-helper >>> */
/**
 * 角色权限：主人 / 管理员 / 普通成员。
 *
 * 配置文件 <profile>/qqbot-permissions.json（每次现读，改完不用重启）：
 * {
 *   "roles": {
 *     "owner": { "openids": ["..."], "names": ["叶兰舟"] },
 *     "admin": { "openids": [], "names": [] }
 *   },
 *   "capabilities": {
 *     "admin": ["gate.bypass", "note.write", "note.writeGlobal"],
 *     "member": ["note.write"]
 *   }
 * }
 *
 * 主人默认拥有全部能力（*）。文件不存在、或没写 owner 时，
 * 回退到 qqbot-command-owners.json，保证现有主人不会因为没建新文件就掉权限。
 * 名字匹配会去 qqbot-people.json 里核对 openid 对应的姓名 / 称呼 / 昵称 / 别名，
 * 所以名单里写名字就能跨群生效。两个文件都按 mtime 缓存，改完自动生效。
 *
 * 能力：
 *   gate.bypass       发言直接算叫到机器人（无视唤醒指数 / 回话概率 / 必须 @）
 *   note.write        写长条目（本群）
 *   note.writeGlobal  写公共长条目（所有群可见）
 *   note.delete       删长条目（预留给后续工具）
 *   memory.write      写长期记忆
 *   memory.delete     删长期记忆
 *   command.run       发斜杠指令（仍需 command-owner-gate 放行）
 */
const QQBOT_PERM_CAPS_DEFAULT = {
    admin: ['gate.bypass', 'note.write', 'note.writeGlobal', 'note.delete', 'memory.write', 'memory.delete'],
    member: ['note.write'],
};

function qqbotPermDir() {
    return process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`;
}

function qqbotPermReadJson(name) {
    try {
        const fs = process.getBuiltinModule?.('node:fs');
        if (!fs)
            return undefined;
        return JSON.parse(fs.readFileSync(`${qqbotPermDir()}/${name}`, 'utf8'));
    }
    catch {
        return undefined;
    }
}

function qqbotPermFileStamp(name) {
    try {
        const fs = process.getBuiltinModule?.('node:fs');
        const st = fs.statSync(`${qqbotPermDir()}/${name}`);
        return `${st.mtimeMs}:${st.size}`;
    }
    catch {
        return '';
    }
}

const qqbotPermStrings = (value) => (Array.isArray(value) ? value : [])
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim());

let qqbotPermCacheStamp = '';
let qqbotPermCache;

function qqbotPermConfig() {
    const stamp = qqbotPermFileStamp('qqbot-permissions.json');
    if (qqbotPermCache && stamp === qqbotPermCacheStamp)
        return qqbotPermCache;
    const raw = qqbotPermReadJson('qqbot-permissions.json') ?? {};
    // 没建权限文件时沿用老的指令主人名单，避免升级后主人突然没有权限
    const fallback = qqbotPermReadJson('qqbot-command-owners.json') ?? {};
    const owner = raw?.roles?.owner ?? {};
    const admin = raw?.roles?.admin ?? {};
    const caps = raw?.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities : {};
    const ownerOpenids = qqbotPermStrings(owner.openids);
    const ownerNames = qqbotPermStrings(owner.names);
    const config = {
        owner: {
            openids: ownerOpenids.length > 0 ? ownerOpenids : qqbotPermStrings(fallback.openids),
            names: ownerNames.length > 0 ? ownerNames : qqbotPermStrings(fallback.names),
        },
        admin: {
            openids: qqbotPermStrings(admin.openids),
            names: qqbotPermStrings(admin.names),
        },
        capabilities: {
            owner: ['*'],
            admin: Array.isArray(caps.admin) ? qqbotPermStrings(caps.admin) : [...QQBOT_PERM_CAPS_DEFAULT.admin],
            member: Array.isArray(caps.member) ? qqbotPermStrings(caps.member) : [...QQBOT_PERM_CAPS_DEFAULT.member],
        },
    };
    qqbotPermCacheStamp = stamp;
    qqbotPermCache = config;
    return config;
}

let qqbotPermPeopleStamp = '';
let qqbotPermPeople;

function qqbotPermPeopleList() {
    const stamp = qqbotPermFileStamp('qqbot-people.json');
    if (qqbotPermPeople && stamp === qqbotPermPeopleStamp)
        return qqbotPermPeople;
    const parsed = qqbotPermReadJson('qqbot-people.json');
    qqbotPermPeopleStamp = stamp;
    qqbotPermPeople = Array.isArray(parsed?.people) ? parsed.people : [];
    return qqbotPermPeople;
}

/** 一个人所有可能被叫到的名字（姓名 / 称呼 / 昵称N / 别名），小写 */
function qqbotPermPersonNames(person) {
    const out = [person?.name, person?.addressing];
    for (const key of Object.keys(person ?? {})) {
        if (/^nickname\d+$/.test(key))
            out.push(person[key]);
    }
    if (Array.isArray(person?.aliases))
        out.push(...person.aliases);
    return qqbotPermStrings(out).map((name) => name.toLowerCase());
}

function qqbotPermFindPerson(openid) {
    if (!openid)
        return undefined;
    return qqbotPermPeopleList().find((person) => Array.isArray(person?.openids) && person.openids.includes(openid));
}

function qqbotPermSender(sender) {
    if (typeof sender === 'string')
        return { id: sender.trim(), name: '' };
    return {
        id: String(sender?.id ?? sender?.senderId ?? '').trim(),
        name: String(sender?.name ?? sender?.senderName ?? '').trim(),
    };
}

function qqbotPermMatch(bucket, sender) {
    if (bucket.openids.length === 0 && bucket.names.length === 0)
        return false;
    if (sender.id !== '' && bucket.openids.includes(sender.id))
        return true;
    if (bucket.names.length === 0)
        return false;
    const wanted = new Set(bucket.names.map((name) => name.toLowerCase()));
    if (sender.name !== '' && wanted.has(sender.name.toLowerCase()))
        return true;
    const person = qqbotPermFindPerson(sender.id);
    return person !== undefined && qqbotPermPersonNames(person).some((name) => wanted.has(name));
}

function qqbotPermRole(sender) {
    const who = qqbotPermSender(sender);
    if (who.id === '' && who.name === '')
        return 'member';
    const config = qqbotPermConfig();
    if (qqbotPermMatch(config.owner, who))
        return 'owner';
    if (qqbotPermMatch(config.admin, who))
        return 'admin';
    return 'member';
}

function qqbotPermCan(sender, capability) {
    if (typeof capability !== 'string' || capability === '')
        return false;
    const role = qqbotPermRole(sender);
    const caps = qqbotPermConfig().capabilities[role] ?? [];
    return caps.includes('*') || caps.includes(capability);
}

globalThis.__qqbotPerm = {
    role: qqbotPermRole,
    can: qqbotPermCan,
    config: qqbotPermConfig,
};
/* <<< dsh-qqbot-patch:permissions-helper <<< */

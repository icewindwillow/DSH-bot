/* >>> dsh-qqbot-patch:command-owner-helper >>> */
/**
 * 指令白名单：只有「主人」能触发 /compact /new /model 这些斜杠指令。
 *
 * 配置文件 <profile>/qqbot-command-owners.json（每次现读，改完不用重启）：
 *   { "openids": ["..."], "names": ["示例管理员"] }
 *   - openids：精确匹配发送者 id（群成员 openid / 私聊 user openid）
 *   - names：拿发送者 id 去 qqbot-people.json 里查是不是这个人（跨群不用记 openid）
 *
 * 文件缺失 = 谁都别用（fail-closed），免得配置掉了以后群里谁都能 /new。
 * 指令本身很少，这里不做缓存，直接读文件，省得再引 statSync。
 */
function qqbotProfileDir() {
    return process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`;
}

function readCommandOwners() {
    try {
        const parsed = JSON.parse(readFileSync(`${qqbotProfileDir()}/qqbot-command-owners.json`, 'utf8'));
        return {
            openids: Array.isArray(parsed?.openids) ? parsed.openids.filter((x) => typeof x === 'string' && x !== '') : [],
            names: Array.isArray(parsed?.names) ? parsed.names.filter((x) => typeof x === 'string' && x.trim() !== '') : [],
        };
    }
    catch {
        return { openids: [], names: [] };
    }
}

/** 发送者 openid 在 qqbot-people.json 里对应的名字（查不到就是 undefined） */
function personNameOfOpenid(openid) {
    if (!openid)
        return undefined;
    try {
        const parsed = JSON.parse(readFileSync(`${qqbotProfileDir()}/qqbot-people.json`, 'utf8'));
        for (const person of parsed?.people ?? []) {
            if (typeof person?.name !== 'string')
                continue;
            if ((person?.openids ?? []).includes(openid))
                return person.name;
        }
        return undefined;
    }
    catch {
        return undefined;
    }
}

/** 这条消息的发送者是不是主人 */
function isCommandOwner(message) {
    const owners = readCommandOwners();
    const sender = String(message?.senderId ?? '');
    if (sender === '')
        return false;
    if (owners.openids.includes(sender))
        return true;
    if (owners.names.length === 0)
        return false;
    const name = personNameOfOpenid(sender);
    return name !== undefined && owners.names.includes(name);
}
/* <<< dsh-qqbot-patch:command-owner-helper <<< */

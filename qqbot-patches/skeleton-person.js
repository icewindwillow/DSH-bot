/* >>> dsh-qqbot-patch:skeleton-person >>> */
/**
 * 自动建「骨架档案」：同一个人在同一个群累计发到第 3 条消息时，
 * 若档案里既没有他的 openid、也没有同名条目，就建一条只含
 * name / openids / groups 的空壳，细节交给 update_person_profile 后补。
 *
 * 这样不依赖模型主动调用，也不会为路过的人刷出垃圾条目。
 * 写入统一走 globalThis.__qqbotPeopleStore（文件锁 + 原子 rename），避免和裁判/亲密度互相覆盖。
 */
function ensureSkeletonPerson(gid, senderId, senderName) {
    if (!gid || !senderId || !senderName)
        return;
    // 只跳过空名字；昵称叫「系统」的是真人，不能按名字过滤
    if (String(senderName).trim() === '')
        return;
    const store = globalThis.__qqbotPeopleStore;
    if (!store)
        return;
    const wanted = String(senderName).trim().toLowerCase();
    let created = false;
    try {
        store.update((s) => {
            const people = Array.isArray(s.people) ? s.people : (s.people = []);
            const exists = people.some((p) => {
                if (!p)
                    return false;
                if (Array.isArray(p.openids) && p.openids.includes(senderId))
                    return true;
                const names = [p.name, p.addressing];
                for (const key of Object.keys(p)) {
                    if (key.indexOf('nickname') === 0)
                        names.push(p[key]);
                }
                if (Array.isArray(p.aliases))
                    names.push(...p.aliases);
                return names.some((n) => typeof n === 'string' && n.trim().toLowerCase() === wanted);
            });
            if (exists)
                return false;
            const today = new Date().toISOString().slice(0, 10);
            const createdToday = people.filter((p) => p && p.autoCreated === true && String(p.autoCreatedAt ?? '').slice(0, 10) === today).length;
            if (createdToday >= 10)
                return false;
            people.push({
                name: String(senderName).trim(),
                groups: [gid],
                openids: [senderId],
                profile: {},
                autoCreated: true,
                autoCreatedAt: new Date().toISOString(),
                note: '由系统按发言自动建的空壳档案，细节待补',
            });
            created = true;
            return true;
        });
    }
    catch {
        // 锁等不到 / 写失败就等下次
        return;
    }
    if (created)
        console.log(`[im-qqbot] 自动建骨架档案: ${senderName} @ ${gid.slice(0, 8)}…`);
}
/**
 * 已知档案的人出现在新群：把他加到该群的「生效群」里。
 * 只处理已经有 groups 的人（没有 groups = 全局，本来就所有群可见）；
 * 不会凭一条消息给手动档改很多东西，只补一个群 id。
 */
function ensurePersonInGroup(gid, senderId, senderName) {
    if (!gid || !senderId)
        return;
    const store = globalThis.__qqbotPeopleStore;
    if (!store)
        return;
    const wanted = String(senderName ?? '').trim().toLowerCase();
    let added = false;
    try {
        store.update((s) => {
            const people = Array.isArray(s.people) ? s.people : (s.people = []);
            const person = people.find((p) => p && Array.isArray(p.openids) && p.openids.includes(senderId))
                ?? people.find((p) => {
                    if (!p)
                        return false;
                    const names = [p.name, p.addressing];
                    for (const key of Object.keys(p)) {
                        if (key.indexOf('nickname') === 0)
                            names.push(p[key]);
                    }
                    if (Array.isArray(p.aliases))
                        names.push(...p.aliases);
                    return wanted !== '' && names.some((n) => typeof n === 'string' && n.trim().toLowerCase() === wanted);
                });
            if (!person)
                return false;
            if (!Array.isArray(person.groups) || person.groups.length === 0)
                return false;
            if (person.groups.includes(gid))
                return false;
            person.groups.push(gid);
            added = true;
            return true;
        });
    }
    catch {
        return;
    }
    if (added)
        console.log(`[im-qqbot] 档案补群: ${senderName} @ ${gid.slice(0, 8)}…`);
}
/* <<< dsh-qqbot-patch:skeleton-person <<< */

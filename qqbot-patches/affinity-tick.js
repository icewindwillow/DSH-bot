/* >>> dsh-qqbot-patch:affinity-tick >>> */
/**
 * 关系自然增长（内部规则，**不得**写进任何提示词）
 *
 * 一条群消息按「社交信号权重」累加，攒够阈值才结算一次，而不是只有叫到人名的句子才算：
 *   权重 = 0.3（人在场）+ pos（夸奖/提问/有内容/叫到机器人）+ 0.8（明确对它说）− neg（骂人/刷屏）
 *   攒满 threshold（默认 4）→ 熟悉 +0.6×gain、好感 +0.05×gain（gain = acc/4，上限 2）
 *
 * 效果：骂人的句子几乎不长熟悉度，长句子和有效互动涨得快；不再「谁喊名字谁涨」。
 * social 按人存，跨群合并（累计值按群分开，避免一个群里的废话给另一个群涨分）。
 * 关掉：QQBOT_AFFINITY_TICK=off；改阈值：QQBOT_AFFINITY_WEIGHT（默认 4）。
 * 写入统一走 globalThis.__qqbotPeopleStore（文件锁 + 原子 rename）。
 */
function bumpAffinityFromChat(gid, senderId, senderName, content, directed) {
    if (!gid || !senderId)
        return;
    if ((process.env.QQBOT_AFFINITY_TICK ?? '') === 'off')
        return;
    const store = globalThis.__qqbotPeopleStore;
    if (!store)
        return;

    const sig = store.signal ? store.signal(content) : { pos: 0, neg: 0 };
    const weight = Math.max(0.1, 0.3 + Math.min(2.5, sig.pos) + (directed ? 0.8 : 0) - Math.min(2, sig.neg));
    const threshold = Math.max(1, Number(process.env.QQBOT_AFFINITY_WEIGHT ?? 4) || 4);
    const accs = globalThis.__qqbotAffinityAcc ?? (globalThis.__qqbotAffinityAcc = new Map());
    const key = `${gid}:${senderId}`;
    const acc = (accs.get(key) ?? 0) + weight;
    if (acc < threshold) {
        accs.set(key, acc);
        return;
    }
    accs.set(key, 0);
    const gain = Math.min(2, acc / threshold);

    let line = '';
    try {
        store.update((s) => {
            const people = Array.isArray(s.people) ? s.people : [];
            const person = people.find((p) => p && (Array.isArray(p.openids) && p.openids.includes(senderId)
                || (senderName && typeof p.name === 'string' && p.name.trim() === String(senderName).trim())));
            if (!person)
                return false;
            if (!person.social || typeof person.social !== 'object') {
                person.social = {
                    affinity: Number.isFinite(Number(person.affinity)) ? Number(person.affinity) : 50,
                    familiarity: 30, trust: 50, irritation: 0, banterTolerance: 25,
                    updatedAt: new Date().toISOString(), lastEventAt: Date.now(),
                };
            }
            const social = person.social;
            social.familiarity = Math.min(100, Number(social.familiarity ?? 0) + 0.6 * gain);
            social.affinity = Math.min(100, Number(social.affinity ?? 50) + 0.05 * gain);
            social.lastEventAt = Date.now();
            person.affinity = social.affinity;
            line = `[im-qqbot] 关系自然增长: ${person.name} 熟悉+${(0.6 * gain).toFixed(1)} 好感+${(0.05 * gain).toFixed(2)}（权重 ${acc.toFixed(1)}）`;
            return true;
        });
    }
    catch {
        // 锁等不到就等下一条
        return;
    }
    if (line)
        console.log(line);
}
/* <<< dsh-qqbot-patch:affinity-tick <<< */

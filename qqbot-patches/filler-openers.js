/* >>> dsh-qqbot-patch:filler-openers >>> */
/**
 * 开口多样性：允许「诶？」「那个…」「嗯」这类开场，但**「唔」不要连着用**。
 * 规则：同一个会话最近 5 条里已经出现过「唔」，这一条再以「唔」开头就把它去掉。
 * 其它垫词原样保留——语气可以有，但别千篇一律。
 */
const __fillerOpenerHistory = new Map();   // 会话 → 最近 5 条的开口词

function stripFillerOpeners(input, key = 'default') {
    const text = String(input ?? '');
    const match = text.match(/^\s*(唔+|诶+|欸+|嗯+|呃+|额+|那个|内个)[…\.。·、,，~～\s]*/u);
    if (!match)
        return text;
    const raw = match[1];
    const opener = raw.startsWith('唔') ? '唔' : raw.startsWith('诶') ? '诶' : raw.startsWith('欸') ? '欸'
        : raw.startsWith('嗯') ? '嗯' : raw.startsWith('呃') ? '呃' : raw.startsWith('额') ? '额' : '那个';
    const history = __fillerOpenerHistory.get(key) ?? [];
    // 只有「唔」做重复限制；其它开口词随她用
    const repeated = opener === '唔' && history.includes('唔');
    if (!repeated) {
        history.push(opener);
        __fillerOpenerHistory.set(key, history.slice(-5));
        return text;
    }
    // 去掉这一次的「唔…」，其余不动
    const stripped = text.replace(/^\s*唔+[…\.。·、,，~～\s]*/u, '').replace(/^[，,。、…？！?!~～:：\s]+/u, '');
    __fillerOpenerHistory.set(key, history.slice(-5));
    return stripped === '' ? '' : stripped;
}
/* <<< dsh-qqbot-patch:filler-openers <<< */

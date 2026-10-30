/* >>> dsh-qqbot-patch:action-limiter >>> */
/**
 * 动作描写处理：模型爱在每句后面加（耳朵抖了抖），看多了很出戏。
 * 默认 QQBOT_ACTION_DESCRIPTIONS=strip：所有括号动作直接删掉；
 * 设成 limit 才回到旧规则（最近 2 条出现过才删）。
 */
const __actionHistory = new Map();   // gid → 最近是否出现过动作描写

function limitActionDescriptions(input, key = 'default') {
    const text = String(input ?? '');
    const actionRe = /[（(]([^（）()]{1,24})[）)]/gu;
    const isAction = (inner) => /耳朵|尾巴|猫耳|爪子|抖|卷|竖|耷拉|拍地|摇|蹭/.test(inner);
    const matches = [...text.matchAll(actionRe)].filter((m) => isAction(m[1]));
    if (matches.length === 0)
        return text;
    if ((process.env.QQBOT_ACTION_DESCRIPTIONS ?? 'strip') !== 'limit') {
        const stripped = text.replace(actionRe, (full, inner) => (isAction(inner) ? '' : full));
        return stripped.replace(/[ \t]{2,}/g, ' ').replace(/\s+([，。！？~～])/g, '$1').trim();
    }
    const recent = __actionHistory.get(key) ?? [];
    const usedRecently = recent.slice(-2).some(Boolean);
    __actionHistory.set(key, [...recent, true].slice(-3));
    if (!usedRecently)
        return text;
    // 去掉这次的动作描写，整理多余空格
    let out = text.replace(actionRe, (full, inner) => (isAction(inner) ? '' : full));
    out = out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([，。！？~～])/g, '$1').trim();
    return out;
}
/* <<< dsh-qqbot-patch:action-limiter <<< */

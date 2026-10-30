/* >>> dsh-qqbot-patch:group-prompt-helper >>> */
/**
 * 读取按群人设覆盖：<profile>/qqbot-groups.json 的 prompts 表。
 * 查找顺序：prompts[group_openid] → prompts["*"] → undefined（回落 config.groupPrompt）。
 * 每轮 system-prompt/assemble 都会重读，改 JSON 无需重启。
 */
function readGroupPromptOverride(gid) {
    if (typeof gid !== 'string' || gid === '')
        return undefined;
    const profileDir = process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`;
    // 优先用模块化人格（qqbot-personas.json）：personas[gid] 列出模块 id，按顺序拼接
    try {
        const personas = JSON.parse(readFileSync(`${profileDir}/qqbot-personas.json`, 'utf8'));
        const entry = personas?.personas?.[gid] ?? personas?.personas?.['*'] ?? personas?.personas?.default;
        const ids = Array.isArray(entry) ? entry : entry?.modules;
        if (Array.isArray(ids) && ids.length > 0) {
            const parts = ids
                .map((id) => personas?.modules?.[id])
                .filter((t) => typeof t === 'string' && t.trim() !== '');
            const archetype = entry?.archetype && personas?.archetypes?.[entry.archetype];
            if (typeof archetype === 'string' && archetype.trim() !== '')
                parts.push(archetype);
            const text = parts.join('\n\n');
            if (text !== '')
                return text;
        }
    }
    catch {
        // 没有 personas 文件就回落到旧的按群 prompt
    }
    try {
        const parsed = JSON.parse(readFileSync(`${profileDir}/qqbot-groups.json`, 'utf8'));
        const prompts = parsed?.prompts;
        if (!prompts || typeof prompts !== 'object')
            return undefined;
        const pick = (value) => (typeof value === 'string' && value.trim() !== '' ? value : undefined);
        return pick(prompts[gid]) ?? pick(prompts['*']);
    }
    catch {
        // 文件缺失 / 非法 JSON：交回插件默认人设
        return undefined;
    }
}
/* <<< dsh-qqbot-patch:group-prompt-helper <<< */

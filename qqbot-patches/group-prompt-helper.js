/* >>> dsh-qqbot-patch:group-prompt-helper >>> */
/**
 * 读取按群人设覆盖：<profile>/groups-config 的 prompts 表。
 * 查找顺序：prompts[group_openid] → prompts["*"] → undefined（回落 config.groupPrompt）。
 * 每轮 system-prompt/assemble 都会重读，保存后无需重启。
 */
function resolveGroupPrompt(gid) {
    if (typeof gid !== 'string' || gid === '')
        return undefined;
    const profileDir = process.env.QQBOT_PROFILE_DIR ?? `${process.env.DSH_HOME ?? `${process.env.HOME ?? ''}/.dsh`}/profiles/${process.env.QQBOT_PROFILE_NAME ?? 'qqbot'}`;
    // 优先用模块化人格（personas（SQLite））：personas[gid] 列出模块 id，按顺序拼接
    try {
        const persona = modularGroupPersona(readProfileDocument(profileDir, 'personas'), gid);
        if (persona) return { ...persona, profileDir };
    }
    catch {
        // 没有 personas 文件就回落到旧的按群 prompt
    }
    try {
        const parsed = readProfileDocument(profileDir, 'groups-config');
        const prompts = parsed?.prompts;
        if (!prompts || typeof prompts !== 'object')
            return undefined;
        const pick = (value) => (typeof value === 'string' && value.trim() !== '' ? value : undefined);
        const text = pick(prompts[gid]) ?? pick(prompts['*']);
        return text === undefined ? undefined : { text };
    }
    catch {
        // 文件缺失 / 非法 JSON：交回插件默认人设
        return undefined;
    }
}
function readGroupPromptOverride(gid) {
    return resolveGroupPrompt(gid)?.text;
}
// 其它补丁（如兴趣分享）在别的文件作用域里，也走同一套人格读取
globalThis.__qqbotGroupPromptOverride = readGroupPromptOverride;
/**
 * 常用表情用法（独立组装构件）：按群的偏好表情包读 index.json，
 * 把标了 favorite 的表情和用途拼成一段提示，跟人格一起组装。
 */
function readStickerUsageBlock(gid) {
    const fs = process.getBuiltinModule?.('node:fs');
    if (!fs)
        return '';
    const profileDir = process.env.QQBOT_PROFILE_DIR ?? `${process.env.DSH_HOME ?? `${process.env.HOME ?? ''}/.dsh`}/profiles/${process.env.QQBOT_PROFILE_NAME ?? 'qqbot'}`;
    let pack = '';
    try {
        const prefs = readProfileDocument(profileDir, 'sticker-prefs');
        const key = String(gid ?? '');
        const hasGroup = prefs?.groups && Object.prototype.hasOwnProperty.call(prefs.groups, key);
        const raw = hasGroup ? prefs.groups[key] : prefs?.default;
        pack = typeof raw === 'string' ? raw.trim() : '';
    }
    catch {
        pack = '';
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(pack))
        pack = 'xiaoyi';
    try {
        const index = JSON.parse(fs.readFileSync(`${profileDir}/stickers/${pack}/index.json`, 'utf8'));
        const favs = (index?.files ?? []).filter((f) => f && f.favorite === true);
        if (favs.length === 0)
            return '';
        const lines = favs.map((f) => {
            const note = String(f.hint ?? '').trim();
            const audience = String(f.audience ?? '');
            const tail = audience === 'close'
                ? '（只对熟络以上）'
                : audience === 'close_male'
                    ? '（只对熟络以上男性）'
                    : audience === 'close_female'
                        ? '（只对熟络以上女性）'
                        : '';
            return `- ${String(f.label ?? '').trim()}${note ? `：${note}` : ''}${tail}`;
        });
        return `\n\n【常用表情怎么用（优先用这些）】\n${lines.join('\n')}\n发图时优先用这些；可以直接 send_sticker({ query: "名字" }) 点名，对不上用途再按情绪挑。`;
    }
    catch {
        return '';
    }
}
/* <<< dsh-qqbot-patch:group-prompt-helper <<< */

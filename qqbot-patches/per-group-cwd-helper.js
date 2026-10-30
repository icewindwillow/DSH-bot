/* >>> dsh-qqbot-patch:per-group-cwd-helper >>> */
/**
 * 解析某个 QQ 会话专属的工作区目录：
 *   <profile>/who/groups/<group_openid>   群聊
 *   <profile>/who/dms/<user_openid>      私聊
 * 目录不存在时创建；失败则回落到配置里的 cwd。
 */
function resolveQqbotWorkspaceCwd(config, scope, peerId) {
    const base = config.cwd || process.cwd();
    const root = process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`;
    const kind = scope === 'group' ? 'groups' : 'dms';
    const safeId = String(peerId ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '');
    if (safeId === '')
        return base;
    const dir = `${root}/who/${kind}/${safeId}`;
    try {
        mkdirSync(dir, { recursive: true });
        return dir;
    }
    catch {
        return base;
    }
}
/* <<< dsh-qqbot-patch:per-group-cwd-helper <<< */

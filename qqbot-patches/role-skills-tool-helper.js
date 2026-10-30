/* >>> dsh-qqbot-patch:role-skills-tool-helper >>> */
/**
 * switch_role_skill：让模型在本人用「非标准说法」要求开/关角色爱好时也能改状态。
 * 标准口令（正常跟我说话 / 别用强者语 / 来点强者语）由 role-skills-helper 自动识别，
 * 这里只兜住其它说法。
 */
function setupRoleSkillTools(ctx, logger) {
    let tools;
    try {
        tools = ctx.get('tools');
    }
    catch {
        tools = undefined;
    }
    if (!tools) {
        console.log('[im-qqbot] tools 不可用，角色技能开关未启用');
        return;
    }

    tools.register({
        name: 'switch_role_skill',
        description: [
            '开关「特定角色爱好」技能（例如强者语）。',
            '只有技能对其开放的那个人本人要求时才调用；别人替他提要求一律不调用。',
            'enabled=false 表示以后对这个人不再用这个风格；true 表示恢复。',
            '不传 person 时默认当前说话的人。',
        ].join(''),
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                skill: { type: 'string', description: '技能 id 或名字，例如 qiangzheyu / 强者语' },
                enabled: { type: 'boolean', description: 'true 打开，false 关闭' },
                person: { type: 'string', description: '对谁生效，默认当前说话的人' },
                note: { type: 'string', description: '一句话说明为什么改（可选）' },
            },
            required: ['skill', 'enabled'],
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean' },
                    message: { type: 'string' },
                },
                required: ['ok', 'message'],
            },
            render: (_args, value) => [{ type: 'text', text: value.message }],
        },
        isConcurrencySafe: () => true,
        execute(args) {
            const fn = globalThis.__qqbotRoleSkillSwitch;
            if (typeof fn !== 'function')
                return { ok: false, message: '角色技能模块还没加载，这次先按说的做。' };
            const result = fn(args);
            if (result && result.ok)
                console.log(`[im-qqbot] 角色技能: ${result.message}`);
            return result;
        },
    });
    console.log('[im-qqbot] 角色技能开关已注册（switch_role_skill）');
}
/* <<< dsh-qqbot-patch:role-skills-tool-helper <<< */

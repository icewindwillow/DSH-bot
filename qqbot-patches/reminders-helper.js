/* >>> dsh-qqbot-patch:reminders-helper >>> */
/**
 * 群提醒：把「什么时候提醒我什么」落盘成 JSON，定时器到点用主动消息发出。
 *
 * 说明：
 * - 目标会话取「最近一条入站消息」的 scope/targetId（globalThis.__qqbotLastTarget），
 *   所以提醒会回到当初说话的那个群/私聊。
 * - 群聊主动消息需要群主在手机 QQ 里给机器人开「主动推送」，否则发送会失败（会记录原因）。
 * - 存储：<profile>/qqbot-reminders.json，只保留最近 200 条。
 */
function reminderStorePath() {
    const dir = process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`;
    return `${dir}/qqbot-reminders.json`;
}

function readReminders() {
    try {
        const parsed = JSON.parse(readFileSync(reminderStorePath(), 'utf8'));
        return Array.isArray(parsed.reminders) ? parsed.reminders : [];
    }
    catch {
        return [];
    }
}

function writeReminders(list) {
    try {
        writeFileSync(reminderStorePath(), `${JSON.stringify({ reminders: list.slice(-200) }, null, 2)}\n`);
    }
    catch {
        // 写盘失败不影响对话
    }
}

function formatDue(ts) {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

/** 解析提醒时间：minutes 优先，其次 at（"YYYY-MM-DD HH:mm" 或 "HH:mm"） */
function parseReminderDue(args) {
    const now = Date.now();
    if (typeof args.minutes === 'number' && Number.isFinite(args.minutes)) {
        if (args.minutes <= 0)
            throw new Error('minutes 需要大于 0');
        if (args.minutes > 60 * 24 * 60)
            throw new Error('最长只支持 60 天内');
        return now + Math.round(args.minutes * 60000);
    }
    const raw = typeof args.at === 'string' ? args.at.trim() : '';
    if (raw !== '') {
        const full = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/);
        if (full) {
            const t = new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]), Number(full[4]), Number(full[5]), 0, 0).getTime();
            if (!Number.isFinite(t))
                throw new Error('时间解析失败');
            if (t <= now)
                throw new Error('这个时间已经过去了');
            return t;
        }
        const hm = raw.match(/^(\d{1,2}):(\d{2})$/);
        if (hm) {
            const d = new Date();
            d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
            let t = d.getTime();
            if (t <= now)
                t += 24 * 3600 * 1000;
            return t;
        }
        throw new Error('at 需要 "YYYY-MM-DD HH:mm" 或 "HH:mm" 格式');
    }
    throw new Error('需要给出 minutes（多少分钟后）或 at（几点）');
}

function setupReminders(ctx, bot, manager, config, logger) {
    let tools;
    try {
        tools = ctx.get('tools');
    }
    catch {
        tools = undefined;
    }
    console.log(`[im-qqbot] setupReminders: tools=${tools ? 'ok' : 'missing'}`);
    if (!tools) {
        logger.warn?.('[im-qqbot] tools 服务不可用，提醒功能未启用');
        return;
    }

    const currentTarget = () => {
        const target = globalThis.__qqbotLastTarget;
        if (!target)
            return undefined;
        // 只认最近 10 分钟内的入站消息，避免把提醒发到很久以前的会话
        if (Date.now() - target.at > 10 * 60 * 1000)
            return undefined;
        return target;
    };

    tools.register({
        name: 'set_reminder',
        description: [
            '设置一个提醒，到点后机器人会主动在**当前这个会话**里发一条消息。',
            '相对时间用 minutes（多少分钟后）；绝对时间用 at（"YYYY-MM-DD HH:mm" 或 "HH:mm"，其中 HH:mm 表示今天该时刻，已过则算明天）。',
            '只能设置在收到用户消息后 10 分钟内，且最长 60 天。设置成功后把时间复述给用户确认。',
        ].join(''),
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                text: { type: 'string', description: '提醒内容，例如「起来喝水」' },
                minutes: { type: 'number', description: '多少分钟后提醒' },
                at: { type: 'string', description: '绝对时间："YYYY-MM-DD HH:mm" 或 "HH:mm"' },
            },
            required: ['text'],
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    id: { type: 'string' },
                    text: { type: 'string' },
                    dueAt: { type: 'string' },
                    scope: { type: 'string' },
                },
                required: ['id', 'text', 'dueAt', 'scope'],
            },
            render: (_args, value) => [{
                type: 'text',
                text: `⏰ 已设置：${value.dueAt} 提醒「${value.text}」（id ${value.id}）`,
            }],
        },
        isConcurrencySafe: () => false,
        execute(args) {
            const text = typeof args?.text === 'string' ? args.text.trim() : '';
            if (text === '')
                throw new Error('text 不能为空');
            const target = currentTarget();
            if (!target)
                throw new Error('暂时不知道该发到哪个会话：请在收到消息后 10 分钟内设置提醒');
            const dueAt = parseReminderDue(args);
            const id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
            const list = readReminders();
            list.push({
                id,
                text,
                dueAt,
                scope: target.scope,
                targetId: target.targetId,
                createdAt: new Date().toISOString(),
            });
            writeReminders(list);
            return { id, text, dueAt: formatDue(dueAt), scope: target.scope };
        },
        presentCall: (args) => `设置提醒：${args?.text ?? ''}`,
    });

    tools.register({
        name: 'list_reminders',
        description: '列出当前还没触发的提醒。',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    reminders: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                id: { type: 'string' },
                                text: { type: 'string' },
                                dueAt: { type: 'string' },
                            },
                            required: ['id', 'text', 'dueAt'],
                        },
                    },
                },
                required: ['reminders'],
            },
            render: (_args, value) => [{
                type: 'text',
                text: value.reminders.length === 0
                    ? '目前没有待触发的提醒。'
                    : value.reminders.map((r) => `· ${r.dueAt} — ${r.text}（${r.id}）`).join('\n'),
            }],
        },
        isConcurrencySafe: () => true,
        execute() {
            const pending = readReminders().filter((r) => !r.firedAt);
            return {
                reminders: pending.map((r) => ({ id: r.id, text: r.text, dueAt: formatDue(r.dueAt) })),
            };
        },
    });

    tools.register({
        name: 'cancel_reminder',
        description: '按 id 取消一个还没触发的提醒。',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: { id: { type: 'string', description: '提醒 id' } },
            required: ['id'],
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
        isConcurrencySafe: () => false,
        execute(args) {
            const id = typeof args?.id === 'string' ? args.id.trim() : '';
            const list = readReminders();
            const index = list.findIndex((r) => r.id === id && !r.firedAt);
            if (index === -1)
                return { ok: false, message: `没找到 id 为 ${id} 的待触发提醒。` };
            const [removed] = list.splice(index, 1);
            writeReminders(list);
            return { ok: true, message: `已取消：${formatDue(removed.dueAt)} — ${removed.text}` };
        },
    });

    let running = false;
    const tick = async () => {
        if (running)
            return;
        running = true;
        try {
            const list = readReminders();
            const now = Date.now();
            let changed = false;
            for (const reminder of list) {
                if (reminder.firedAt || reminder.dueAt > now)
                    continue;
                try {
                    await bot.sendMarkdown({ scope: reminder.scope, targetId: reminder.targetId, msgId: undefined }, `⏰ 提醒：${reminder.text}`);
                    reminder.firedAt = new Date().toISOString();
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    reminder.firedAt = new Date().toISOString();
                    reminder.error = message;
                    logger.error?.(`[im-qqbot] 提醒发送失败: ${message}`);
                }
                changed = true;
            }
            if (changed)
                writeReminders(list);
        }
        finally {
            running = false;
        }
    };

    const timer = setInterval(() => { void tick().catch(() => { }); }, 20000);
    timer.unref?.();
    console.log('[im-qqbot] 提醒已启用（20 秒轮询）');
    logger.info?.('[im-qqbot] 提醒已启用（20 秒轮询）');
}
/* <<< dsh-qqbot-patch:reminders-helper <<< */

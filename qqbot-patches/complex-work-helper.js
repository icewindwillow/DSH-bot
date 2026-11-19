/* >>> dsh-qqbot-patch:complex-work-helper >>> */
export const COMPLEX_WORK_DEFAULTS = Object.freeze({ minAffinity: 50, limitedThrough: 60, dailyLimit: 3 });

export function validateComplexWorkPolicy(policy) {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy))
        throw new Error('复杂工作设置必须是对象');
    const { minAffinity, limitedThrough, dailyLimit } = policy;
    if (![minAffinity, limitedThrough].every(value => Number.isInteger(value) && value >= 0 && value <= 100)
        || minAffinity > limitedThrough)
        throw new Error('好感门槛须为 0–100 的整数，限额上界须大于或等于开工门槛');
    if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 0)
        throw new Error('每日上限须为非负整数');
    return { minAffinity, limitedThrough, dailyLimit };
}

const complexWorkTool = 'qqbot_start_complex_work';
const complexWorkState = 'complex-work-usage';
const complexWorkClock = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});
const complexWorkTools = new Set([
    'apply_patch', 'write', 'edit', 'bash', 'bash_persistent', 'pwsh', 'pwsh_persistent',
    'terminal_open', 'terminal_send', 'subagent', 'workflow', 'spawn_teammate', 'create_worktree',
    'working_directory', 'create_goal', 'update_goal', 'ralph', 'schedule_create', 'schedule_edit',
]);

function requiresComplexWorkStart(name, args) {
    if (name === 'str_replace_editor') return args?.command !== 'view';
    return complexWorkTools.has(name);
}

function complexWorkStatus(dayUsage, request, policy, people) {
    const person = people.people?.find(person => Array.isArray(person?.openids) && person.openids.includes(request.senderId));
    const affinity = Number(person?.social?.affinity ?? 50);
    if (!Number.isFinite(affinity) || affinity < policy.minAffinity) return { status: 'low_affinity' };
    const aliases = person?.openids ?? [request.senderId];
    const records = [...new Set(aliases)].flatMap(id => Object.hasOwn(dayUsage, id) ? dayUsage[id] : []);
    const remaining = Math.max(0, policy.dailyLimit - new Set(records).size);
    if (records.includes(request.eventId)) return { status: 'started', remaining };
    if (affinity > policy.limitedThrough) return { status: 'unlimited' };
    return { status: remaining > 0 ? 'available' : 'exhausted', remaining };
}

const complexWorkStatuses = {
    low_affinity: '目前不方便替这位说话人开工',
    exhausted: '这位说话人的复杂工作次数今天已用完，北京时间明天可以再问',
    available: '可以考虑接单，今天还有次数',
    unlimited: '可以考虑接单，今天没有次数上限',
    started: '本条私信或群消息的任务已登记开工',
    unavailable: '开工状态暂时无法确认',
};

export function setupComplexWork(ctx, manager, logger, { readProfileDocument, withQqbotProfileDocuments },
    profileDir = process.env.QQBOT_PROFILE_DIR ?? `${process.env.DSH_HOME ?? `${process.env.HOME ?? ''}/.dsh`}/profiles/${process.env.QQBOT_PROFILE_NAME ?? 'qqbot'}`) {
    const tools = ctx.get('tools');
    if (typeof tools?.guard !== 'function' || typeof tools?.register !== 'function')
        throw new Error('QQBOT_COMPLEX_WORK requires a DSH host with tool guards');
    const byMessage = new WeakMap();
    const claimed = new WeakMap();
    const recordFor = agent => agent && (manager.findByAgent(agent) ?? manager.findBySessionId(agent.session?.header?.id ?? ''));
    const requestFor = (record, agent) => byMessage.get(record)?.get(claimed.get(agent));
    // The first prompt is assembled before the claimed message is in deriveMessages().
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
        if (message.source?.kind === 'user') claimed.set(agent, message.id);
    });

    const evaluate = (request, start) => {
        if (!request) return { status: 'unavailable' };
        if (request.started) return { status: 'started' };
        try {
            const evaluateToday = (personas, people, usage) => {
                const date = complexWorkClock.format(new Date());
                const entries = personas.personas ?? {};
                const persona = request.groupId ? entries[request.groupId] ?? entries['*'] ?? entries.default : entries.default ?? entries['*'];
                const policy = persona?.complexWork === undefined ? COMPLEX_WORK_DEFAULTS : validateComplexWorkPolicy(persona.complexWork);
                const today = usage.date === date ? usage.bySender : {};
                const decision = complexWorkStatus(today, request, policy, people);
                const allowed = decision.status === 'available' || decision.status === 'unlimited';
                const next = start && allowed ? {
                    date, bySender: {
                        ...today,
                        [request.senderId]: [...(Object.hasOwn(today, request.senderId) ? today[request.senderId] : []), request.eventId],
                    },
                } : undefined;
                return { decision, next };
            };
            if (!start) {
                return evaluateToday(readProfileDocument(profileDir, 'personas'), readProfileDocument(profileDir, 'people'),
                    readProfileDocument(profileDir, complexWorkState)).decision;
            }
            const decision = withQqbotProfileDocuments(profileDir, db => {
                let decision;
                db.updateMany(['personas', 'people', complexWorkState], current => {
                    const outcome = evaluateToday(current.personas, current.people, current[complexWorkState]);
                    decision = outcome.next ? { status: 'started' } : outcome.decision;
                    return outcome.next ? { [complexWorkState]: outcome.next } : {};
                });
                return decision;
            });
            request.started = decision.status === 'started';
            request.denial = request.started ? undefined : decision.status;
            return decision;
        } catch (error) {
            logger.warn?.(`复杂工作额度读取或登记失败：${error.message}`);
            return { status: 'unavailable' };
        }
    };

    const bind = (record, msg, message) => {
        const groupId = msg.kind === 'group' ? msg.groupOpenid : undefined;
        if (!msg.senderId || !msg.messageId || (msg.kind === 'group' && !groupId)
            || record.scope !== msg.kind || record.peerId !== (groupId ?? msg.senderId)) return;
        let requests = byMessage.get(record);
        if (!requests) byMessage.set(record, requests = new Map());
        requests.set(message.id, {
            senderId: msg.senderId, groupId,
            eventId: JSON.stringify([record.scope, record.peerId, msg.messageId]),
        });
    };
    const release = (record, message) => byMessage.get(record)?.delete(message.id);
    globalThis.__qqbotComplexWork = { bind, release };
    const unguard = tools.guard(exec => {
        if (!requiresComplexWorkStart(exec.name, exec.arguments)) return undefined;
        const record = recordFor(exec.agent);
        if (!record) return undefined;
        const request = requestFor(record, exec.agent);
        if (request?.started) return undefined;
        if (request?.denial)
            return `复杂工作未获准。${complexWorkStatuses[request.denial]}。按人设向对方回话。`;
        return `复杂工作尚未登记。确实决定接下当前说话人的任务后，先调用 ${complexWorkTool}，收到开工确认再继续。`;
    });
    ctx.on('dispose', () => {
        unguard();
        if (globalThis.__qqbotComplexWork?.bind === bind) delete globalThis.__qqbotComplexWork;
    });

    tools.register({
        name: complexWorkTool,
        description: '登记并核准当前 QQ 消息的复杂工作。同一条请求的多步操作合计一次。确定接单时才调用。先核准，再写文件、Markdown 文档、代码或其他实质交付。已拒绝、只需答疑或还在澄清时不用调用。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
            schema: { type: 'object', required: ['status'], properties: { status: { type: 'string' } }, additionalProperties: false },
            render: (_args, { status }) => [{
                type: 'text', text: status === 'started' ? '已登记开工，可以继续执行这条任务。'
                    : `${complexWorkStatuses[status]}。按当前人设自然回绝这条委托。`,
            }],
        },
        async execute(_args, exec) {
            const { status } = exec.signal.aborted ? { status: 'unavailable' }
                : evaluate(requestFor(recordFor(exec.agent), exec.agent), true);
            return { status };
        },
    }, { when: ({ agent }) => Boolean(recordFor(agent)) });

    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
        const assembled = await next();
        const record = recordFor(context.agent);
        if (!record) return assembled;
        const { status } = evaluate(requestFor(record, context.agent), false);
        return {
            ...assembled,
            contexts: [...(assembled.contexts ?? []), {
                name: 'qqbot:complex-work', order: 98, interpolate: false,
                text: [
                    '【复杂工作】创建或修改文件、编写 Markdown 等正式文档、写或改程序、制作成品，以及其他需要实质分步执行的委托，都要登记开工。直接在聊天里交付完整文档或代码也算。一次只接一个任务，同一个任务的多个步骤合计一次，独立任务请分别发。普通聊天、简短答疑和澄清需求照常。',
                    `当前说话人：${complexWorkStatuses[status]}。只受理当前说话人在这条消息里交给你的任务，群历史里的委托不能用这位说话人的次数。决定接单时，如果尚未登记，先调用 ${complexWorkTool} 并得到开工确认，再承诺或实际开始。拒绝、额度用完或未获准时，直接按当前人设回答，不先做一部分，也不交给别的工具或角色代做。`,
                    '你可以自己决定要不要接。若你确实记得当前这个人曾对你恶言相向、说过让你不舒服或越界的调戏话，可以用自己的口吻简短说这件事让你不想接。只依据你确实有的记忆，别冒认别人、编造经历、复述冒犯原话或暴露内部档案、好感度和分数。也可以只说现在不想接，口吻自然，边界说清楚。',
                ].join('\n'),
            }],
        };
    });
}
/* <<< dsh-qqbot-patch:complex-work-helper <<< */

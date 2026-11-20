/* >>> dsh-qqbot-patch:persona-sleep-helper >>> */
export function setupPersonaSleep(ctx, bot, config, logger) {
    const profile = process.env.QQBOT_PROFILE_DIR ?? `${process.env.DSH_HOME ?? `${process.env.HOME ?? ''}/.dsh`}/profiles/${process.env.QQBOT_PROFILE_NAME ?? 'qqbot'}`;
    const callsType = 'persona-schedule-calls';
    const ttl = 7 * 86400000;
    const idOK = id => typeof id === 'string' && /^[A-Za-z0-9_-]{4,128}$/.test(id);
    let cached;
    let mealDay;
    const recordedMeals = new Set();
    function snapshot(now) {
        if (cached && now >= cached.at && now - cached.at < 1000
            && Math.floor(now / 60000) === Math.floor(cached.at / 60000)) return cached;
        const week = validatePersonaSchedule(readProfileDocument(profile, 'persona-schedule'));
        const time = beijingScheduleTime(new Date(now));
        const event = currentPersonaSchedule(week, time);
        cached = { at: now, week, time, event,
            personas: event?.sleep || event?.mood || event?.meal ? readProfileDocument(profile, 'personas') : undefined };
        return cached;
    }
    function scheduleForGroup(gid, now) {
        try {
            const current = snapshot(now);
            if (modularGroupPersona(current.personas, gid)?.entry?.useSchedule === true) return current.event;
        } catch { /* A broken schedule leaves chat and mood on their defaults. */ }
    }
    const sleeping = gid => scheduleForGroup(gid, Date.now())?.sleep === true;
    function rememberFinishedMeals({ week, time }) {
        const remember = globalThis.__qqbotSelfMemory?.rememberMeal;
        if (!remember) return;
        if (mealDay !== time.date) {
            mealDay = time.date;
            recordedMeals.clear();
        }
        // Include a meal that started yesterday and finished after midnight.
        const midnight = Date.parse(`${time.date}T00:00:00+08:00`);
        for (const entry of week.entries) {
            if (!entry.meal || entry.probability === 0) continue;
            const overnight = entry.end < entry.start;
            const yesterday = overnight && entry.days.includes((time.dayIndex + 6) % 7)
                && entry.end <= time.minuteOfDay;
            const today = !overnight && entry.days.includes(time.dayIndex) && entry.end <= time.minuteOfDay;
            if (!yesterday && !today) continue;
            const start = midnight + (entry.start - (yesterday ? 1440 : 0)) * 60000;
            const key = `${start}:${entry.id}`;
            if (recordedMeals.has(key)) continue;
            const startTime = beijingScheduleTime(new Date(start));
            if (holidayOverridesRange(week, startTime.date, entry.start, entry.end)
                || currentPersonaSchedule(week, startTime)?.id !== entry.id
                || remember(personaScheduleMeal(entry, startTime), start)) recordedMeals.add(key);
        }
    }
    function updateCalls(change) {
        return withQqbotProfileDocuments(profile, db => db.update(callsType, state => {
            const rows = Array.isArray(state.pending) ? state.pending : [];
            const pending = change(rows);
            return pending === undefined ? undefined : { pending };
        }));
    }
    function addressed(msg) {
        if (msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE' || globalThis.__qqbotMention?.addressed?.(msg)) return true;
        const words = readProfileDocument(profile, 'groups-config')?.wakeWords;
        const text = String(msg.content ?? '').toLowerCase();
        const valid = Array.isArray(words) ? words.filter(word => typeof word === 'string' && word.trim()) : [];
        return (valid.length ? valid : ['小易']).some(word => text.includes(word.trim().toLowerCase()));
    }
    globalThis.__qqbotPersonaSleep = {
        sleeping,
        scheduledMood: (gid, now) => scheduleForGroup(gid, now)?.mood,
        scheduledMeal: (gid, now) => {
            const entry = scheduleForGroup(gid, now);
            return entry?.meal ? personaScheduleMeal(entry, snapshot(now).time) : undefined;
        },
    };
    bot.use(async (state, next) => {
        const msg = state.message;
        // This gate is before agent, sticker short-circuit and other ordinary reply handlers.
        // Leave operator commands to their existing authorization middleware.
        if (msg?.kind !== 'group' || !idOK(msg.groupOpenid) || /^\s*\//.test(String(msg.content ?? '')) || !sleeping(msg.groupOpenid)) return next();
        try {
            globalThis.__qqbotMention?.setAppId?.(config.appId);
            if (idOK(msg.senderId) && msg.senderId !== config.appId && addressed(msg)) {
                const now = Date.now();
                updateCalls(rows => {
                    const active = rows.filter(row => now - row.at < ttl);
                    const duplicate = active.findIndex(row => row.gid === msg.groupOpenid && row.sender === msg.senderId);
                    if (duplicate >= 0) return undefined;
                    if (active.length >= 256 || active.filter(row => row.gid === msg.groupOpenid).length >= 64) return undefined;
                    return [...active, { gid: msg.groupOpenid, sender: msg.senderId, at: now }];
                });
            }
        } catch { logger.warn?.('[im-qqbot] persona_sleep_call_store_failed'); }
    });

    let ready = false;
    const readyOn = () => { ready = true; };
    const readyOff = () => { ready = false; };
    bot.on('ready', readyOn);
    bot.on('resumed', readyOn);
    bot.on('disconnected', readyOff);
    const queue = qqbotQueueForContext(ctx, { concurrency: 1, capacity: 0 });
    const timer = setInterval(() => {
        if (!ready) return;
        queue.enqueue({ key: 'persona-sleep-wake', timeoutMs: 20000, run: async (signal) => {
            try {
                const now = Date.now();
                if (signal.aborted) return;
                const current = snapshot(now);
                rememberFinishedMeals(current);
                if (current.event?.sleep) return;
                const rows = readProfileDocument(profile, callsType).pending;
                if (!Array.isArray(rows) || !rows.length) return;
                const personas = readProfileDocument(profile, 'personas');
                for (const row of rows.slice(0, 8)) {
                    if (signal.aborted || !ready || snapshot(Date.now()).event?.sleep) break;
                    let claimed = false;
                    // Claim before contacting QQ, to avoid duplicate @s on restart / ambiguous sends.
                    updateCalls(pending => {
                        const index = pending.findIndex(p => p.gid === row.gid && p.sender === row.sender && p.at === row.at);
                        if (index < 0) return undefined;
                        claimed = true;
                        return pending.filter((_p, i) => i !== index);
                    });
                    if (!claimed || now - row.at >= ttl || !idOK(row.gid) || !idOK(row.sender)
                        || modularGroupPersona(personas, row.gid)?.entry?.useSchedule !== true) continue;
                    try {
                        const greeting = globalThis.__qqbotMood?.wakeGreeting?.(row.gid) ?? '我醒啦～刚才睡着了，你找我呀？';
                        await bot.sendMarkdown({ scope: 'group', targetId: row.gid, msgId: undefined },
                            `<qqbot-at-user id="${row.sender}" /> ${greeting}`);
                    } catch { logger.warn?.('[im-qqbot] persona_sleep_wake_send_failed'); }
                }
            } catch { logger.warn?.('[im-qqbot] persona_sleep_wake_tick_failed'); }
        } });
    }, 5000);
    timer.unref?.();
    ctx.effect?.(() => () => {
        clearInterval(timer); queue.close();
        bot.off?.('ready', readyOn); bot.off?.('resumed', readyOn); bot.off?.('disconnected', readyOff);
    });
}
/* <<< dsh-qqbot-patch:persona-sleep-helper <<< */

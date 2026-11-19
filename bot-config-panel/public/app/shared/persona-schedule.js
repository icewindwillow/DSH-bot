/* >>> dsh-qqbot-patch:persona-schedule-helper >>> */
// Dependency-free so the panel and the installed QQ session use exactly the same calendar.
export const SCHEDULE_WEEKDAYS = Object.freeze(['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日']);
const scheduleClock = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'long',
});

export function beijingScheduleTime(date = new Date()) {
    const { year, month, day, hour, minute, weekday } = Object.fromEntries(
        scheduleClock.formatToParts(date).map(({ type, value }) => [type, value]),
    );
    return { date: `${year}-${month}-${day}`, hour, minute, weekday,
        dayIndex: SCHEDULE_WEEKDAYS.indexOf(weekday), minuteOfDay: Number(hour) * 60 + Number(minute) };
}

export function formatScheduleMinute(minute) {
    return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

// Day indexes are Monday=0 to Sunday=6. Split wraps for the grid, collision checks and matching.
export function scheduleSegments(entry) {
    return entry.days.flatMap(day => {
        if (entry.end > entry.start) return [{ day, start: entry.start, end: entry.end }];
        const segments = [{ day, start: entry.start, end: 1440 }];
        if (entry.end > 0) segments.push({ day: (day + 1) % 7, start: 0, end: entry.end });
        return segments;
    });
}

export function validatePersonaSchedule(doc) {
    if (!Array.isArray(doc?.entries) || doc.entries.length > 168) throw new Error('周表必须包含安排列表，最多 168 条。');
    const ids = new Set();
    const entries = doc.entries.map(entry => {
        if (!entry || typeof entry.id !== 'string' || !/^[\w-]{1,64}$/.test(entry.id) || ids.has(entry.id))
            throw new Error('安排标识无效或重复。');
        ids.add(entry.id);
        const title = typeof entry.title === 'string' ? entry.title.trim() : '';
        const hint = typeof entry.hint === 'string' ? entry.hint.trim() : '';
        if (!title || title.length > 48 || /[\r\n]/.test(title)) throw new Error('请输入 1–48 字的单行安排名称。');
        const { probability = 100, sleep = false } = entry;
        if (!Number.isInteger(probability) || probability < 0 || probability > 100) throw new Error(`「${title}」的发生概率须为 0–100 的整数。`);
        if (typeof sleep !== 'boolean') throw new Error(`「${title}」的睡眠标记无效。`);
        const { mood } = entry;
        if (mood !== undefined && (mood !== 'early-rise' || sleep)) throw new Error(`「${title}」的情绪设置无效。`);
        const { meal } = entry;
        if (meal !== undefined && (typeof meal !== 'string' || !Object.hasOwn(SCHEDULE_MEALS, meal) || sleep)) throw new Error(`「${title}」的三餐设置无效。`);
        if ((!sleep && !hint) || hint.length > 800) throw new Error(`「${title}」需要回话提示（最多 800 字，睡眠可留空）。`);
        const { days, start, end } = entry;
        if (!Array.isArray(days) || !days.length || days.some(day => !Number.isInteger(day) || day < 0 || day >= 7)
            || new Set(days).size !== days.length) throw new Error(`请为「${title}」选择有效的星期。`);
        if (!Number.isInteger(start) || start < 0 || start >= 1440 || !Number.isInteger(end) || end < 0 || end > 1440 || start === end)
            throw new Error(`「${title}」的起止时间无效，开始和结束不能相同。`);
        return { id: entry.id, days: [...days].sort((a, b) => a - b), start, end, title, hint, probability, sleep,
            ...(mood ? { mood } : {}), ...(meal ? { meal } : {}) };
    });
    return { entries };
}

// Use the occurrence date + ID as a stable random seed. The panel and every gateway
// see the same outcome after an idle period or a restart without re-rolling on messages.
const scheduleEpochDay = Date.UTC(2026, 0, 5) / 86400000; // Monday in the synthetic Beijing calendar
const scheduleMinutePerDay = 1440;
function scheduleRandom(key) {
    let hash = 2166136261;
    for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x7feb352d);
    hash ^= hash >>> 15;
    hash = Math.imul(hash, 0x846ca68b);
    return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
}

export const SCHEDULE_MEALS = { breakfast: '早饭', lunch: '午饭', dinner: '晚饭' };
const regularMeals = {
    breakfast: ['茶叶蛋和豆浆', '菜包和小米粥', '馒头配咸菜', '吐司和牛奶', '鸡蛋饼'],
    lunch: ['番茄炒蛋盖饭', '青菜肉丝面', '食堂的两荤一素', '鸡腿饭', '白米饭配咸菜和炒青菜'],
    dinner: ['馄饨', '鸡蛋炒饭', '冬瓜丸子汤配米饭', '小碗牛肉面', '蒸蛋和清炒小白菜配米饭'],
};
const goodMeals = {
    breakfast: ['刚出锅的小笼包配热豆浆', '酥脆的葱油饼配豆腐脑', '热乎乎的鲜虾云吞'],
    lunch: ['锅气很足的糖醋里脊盖饭', '炖得软烂的番茄牛腩饭', '外酥里嫩的炸鸡腿配米饭'],
    dinner: ['汤特别鲜的酸菜鱼', '刚出炉的烤肉和拌饭', '底煎得脆脆的鲜肉锅贴'],
};

export function personaScheduleMeal(entry, time) {
    if (!entry?.meal || !time) return undefined;
    const day = Date.parse(`${time.date}T00:00:00Z`) - (time.minuteOfDay < entry.start ? 86400000 : 0);
    const date = new Date(day).toISOString().slice(0, 10);
    const key = `meal:${date}:${entry.meal}`;
    const roll = scheduleRandom(`${key}:quality`);
    const hotpot = entry.meal === 'dinner' && roll < 0.03;
    const good = roll < 0.15;
    const pool = good ? goodMeals[entry.meal] : regularMeals[entry.meal];
    const dish = hotpot ? '火锅（番茄和微辣鸳鸯锅，涮了肥牛和土豆片）' : pool[Math.floor(scheduleRandom(`${key}:dish`) * pool.length)];
    const reaction = hotpot ? '正好吃到最喜欢的火锅，特别开心' : good ? '这顿比平时好吃，吃得挺开心'
        : roll > 0.83 ? '味道有点普通，吃得没什么兴致' : '家常口味，吃饱就好';
    return { date, type: entry.meal, label: SCHEDULE_MEALS[entry.meal], dish, reaction,
        valence: hotpot ? 17 : good ? 10 : roll > 0.83 ? -4 : 0,
        energy: hotpot ? 9 : good ? 5 : roll > 0.83 ? -2 : 0 };
}

const scheduleSimulations = new Map();
export function currentPersonaSchedule(doc, time) {
    if (!doc.entries.length) return undefined;
    const day = Date.parse(`${time.date}T00:00:00Z`) / 86400000;
    if (!Number.isFinite(day)) return undefined;
    const minute = day * scheduleMinutePerDay + time.minuteOfDay;
    const fingerprint = JSON.stringify(doc.entries.map(({ id, days, start, end, probability }) => [id, days, start, end, probability ?? 100]));
    let state = scheduleSimulations.get(fingerprint);
    if (!state || minute < state.minute) {
        const weekly = Array.from({ length: 7 }, () => []);
        doc.entries.forEach((entry, index) => {
            if ((entry.probability ?? 100) > 0) for (const weekday of entry.days) weekly[weekday].push({ id: entry.id, start: entry.start, end: entry.end, probability: entry.probability ?? 100, index });
        });
        for (const entries of weekly) entries.sort((a, b) => a.start - b.start);
        const weekday = ((day - scheduleEpochDay) % 7 + 7) % 7;
        state = { weekly, day: Math.min(scheduleEpochDay, day - weekday - 7), index: 0, minute: -Infinity, active: null, end: -Infinity };
    }
    scheduleSimulations.delete(fingerprint);
    scheduleSimulations.set(fingerprint, state);
    if (scheduleSimulations.size > 2) scheduleSimulations.delete(scheduleSimulations.keys().next().value);
    state.minute = minute;
    for (; state.day <= day; state.day++, state.index = 0) {
        const events = state.weekly[((state.day - scheduleEpochDay) % 7 + 7) % 7];
        const base = state.day * scheduleMinutePerDay;
        while (state.index < events.length) {
            const start = events[state.index].start;
            const at = base + start;
            if (at > minute) break;
            let winner, rank = Infinity;
            do {
                const entry = events[state.index++];
                if (at < state.end) continue;
                const seed = `${state.day}:${entry.id}`;
                if (scheduleRandom(`${seed}:start`) * 100 >= (entry.probability ?? 100)) continue;
                const priority = scheduleRandom(`${seed}:tie`);
                if (priority < rank || (priority === rank && entry.id < winner.id)) { winner = entry; rank = priority; }
            } while (events[state.index]?.start === start);
            if (winner) {
                state.active = winner.index;
                state.end = base + winner.end + (winner.end < winner.start ? scheduleMinutePerDay : 0);
            }
        }
        if (state.day === day) break;
    }
    return minute < state.end ? doc.entries[state.active] : undefined;
}

export function modularGroupPersona(doc, gid) {
    const entry = doc?.personas?.[gid] ?? doc?.personas?.['*'] ?? doc?.personas?.default;
    const ids = Array.isArray(entry) ? entry : entry?.modules;
    if (!Array.isArray(ids) || !ids.length) return undefined;
    const parts = ids.map(id => doc?.modules?.[id]).filter(text => typeof text === 'string' && text.trim());
    const archetype = entry?.archetype && doc?.archetypes?.[entry.archetype];
    if (typeof archetype === 'string' && archetype.trim()) parts.push(archetype);
    if (parts.length) return { entry, text: parts.join('\n\n') };
}

export function personaSchedulePrompt(entry, time) {
    if (!entry || entry.sleep) return '';
    const meal = personaScheduleMeal(entry, time);
    const mealLine = meal ? `\n这一顿${meal.label}吃的是${meal.dish}，${meal.reaction}。聊到这顿饭时用这个结果。` : '';
    return `【你的虚拟时间表 · 当前安排】${entry.title}\n回话提示：${entry.hint}${mealLine}\n这是此刻的虚拟生活状态，只影响答话的语气和顺口带出的细节。可以主动提一句近况，不用等人问；示例不是固定台词，同一段对话不必反复提。认真问题照常答，不用为安排推迟、拒绝或主动发消息。`;
}
/* <<< dsh-qqbot-patch:persona-schedule-helper <<< */

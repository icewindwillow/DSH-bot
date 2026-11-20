import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readProfileDocument, withQqbotProfileDocuments } from '../plugins/qqbot-core/profile-documents.js';
import { beijingScheduleTime, currentPersonaSchedule, holidayOverridesRange, modularGroupPersona, personaScheduleMeal, validatePersonaSchedule } from '../bot-config-panel/public/app/shared/persona-schedule.js';

const source = readFileSync(new URL('../qqbot-patches/persona-sleep-helper.js', import.meta.url), 'utf8').replace('export function', 'function');
const moodSource = readFileSync(new URL('../qqbot-patches/mood-helper.js', import.meta.url), 'utf8');
const fakeSetup = new Function('process', 'Date', 'readProfileDocument', 'withQqbotProfileDocuments', 'validatePersonaSchedule',
  'currentPersonaSchedule', 'holidayOverridesRange', 'beijingScheduleTime', 'modularGroupPersona', 'personaScheduleMeal', 'qqbotQueueForContext', 'setInterval', 'clearInterval',
  `${source}\nreturn setupPersonaSleep;`);
const fakeMood = new Function('process', 'Date', 'readProfileDocument', 'withQqbotProfileDocuments', 'setInterval', 'console',
  `${moodSource}\nreturn setupMood;`);

test('sleep blocks group replies; addressed callers are persisted, deduped and individually tagged after waking', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'qqbot-persona-sleep-'));
  let now = Date.parse('2026-11-16T04:15:00Z'); // Monday 12:15 in Beijing
  class FixedDate extends Date { static now() { return now; } }
  const write = (type, doc) => withQqbotProfileDocuments(profile, db => db.update(type, () => doc));
  write('personas', { modules: { chat: '示例人格' }, personas: { default: { modules: ['chat'], useSchedule: true }, GROUP_OFF: ['chat'] } });
  write('groups-config', { wakeWords: ['小易'] });
  write('persona-schedule', { entries: [
    { id: 'nap', days: [0], start: 720, end: 780, title: '午睡', sleep: true, probability: 100 },
    { id: 'game', days: [0], start: 750, end: 810, title: '游戏', hint: '打游戏', probability: 100 },
    { id: 'early-rise', days: [0], start: 780, end: 825, title: '早课', hint: '在收拾书包。', mood: 'early-rise' },
    { id: 'dinner', days: [0], start: 1080, end: 1125, title: '晚饭', hint: '吃饭。', meal: 'dinner' },
  ] });
  const deliveries = [], errors = [];
  const oldMention = globalThis.__qqbotMention;
  const oldSleep = globalThis.__qqbotPersonaSleep;
  const oldMood = globalThis.__qqbotMood;
  const oldMemory = globalThis.__qqbotSelfMemory;
  const memories = [];
  globalThis.__qqbotSelfMemory = { rememberMeal(meal) { memories.push(meal); return true; } };
  delete globalThis.__qqbotMood;
  globalThis.__qqbotMention = { addressed: msg => msg.realAt === true };
  let stop = () => {};
  function boot() {
    const bot = new EventEmitter();
    let middleware, tick, task, cleanup;
    bot.use = fn => { middleware = fn; };
    bot.sendMarkdown = async (target, text) => { deliveries.push({ target, text }); };
    const setup = fakeSetup({ env: { QQBOT_PROFILE_DIR: profile } }, FixedDate, readProfileDocument, withQqbotProfileDocuments,
      validatePersonaSchedule, currentPersonaSchedule, holidayOverridesRange, beijingScheduleTime, modularGroupPersona, personaScheduleMeal,
      () => ({ enqueue(item) { task = item.run(new AbortController().signal); }, close() {} }),
      fn => { tick = fn; return {}; }, () => {});
    setup({ effect: effect => { cleanup = effect(); } }, bot, { appId: 'BOT01' }, { warn: msg => errors.push(msg) });
    stop = cleanup;
    return {
      ready: () => bot.emit('ready'), run: async () => { tick(); await task; },
      async dispatch(fields) {
        let passed = false;
        await middleware({ message: { kind: 'group', groupOpenid: 'GROUP_ONE', senderId: 'SENDER_A', content: '闲聊', ...fields } }, () => { passed = true; });
        return passed;
      },
    };
  }
  const pending = () => readProfileDocument(profile, 'persona-schedule-calls').pending;
  try {
    fakeMood({ ...process, env: { QQBOT_PROFILE_DIR: profile }, getBuiltinModule: process.getBuiltinModule },
      FixedDate, readProfileDocument, withQqbotProfileDocuments, () => ({}), { log() {} })({ get: () => undefined });
    const mood = globalThis.__qqbotMood;
    let robot = boot();
    robot.ready();
    assert.equal(await robot.dispatch({}), false, 'sleep also blocks ordinary chatter');
    assert.equal(await robot.dispatch({ kind: 'c2c', content: '小易' }), true);
    assert.equal(await robot.dispatch({ groupOpenid: 'GROUP_OFF', content: '小易' }), true);
    assert.equal(await robot.dispatch({ content: '/help' }), true);
    assert.equal(await robot.dispatch({ rawEventType: 'GROUP_AT_MESSAGE_CREATE', content: '这是不会落盘的内容' }), false);
    assert.equal(await robot.dispatch({ content: '小易，醒醒' }), false);
    assert.equal(await robot.dispatch({ senderId: 'SENDER_B', realAt: true }), false);
    assert.deepEqual(pending(), [{ gid: 'GROUP_ONE', sender: 'SENDER_A', at: now }, { gid: 'GROUP_ONE', sender: 'SENDER_B', at: now }]);
    now += 15 * 60000; // The 12:30 activity does not interrupt sleep.
    await robot.run();
    assert.equal(deliveries.length, 0);
    assert.equal(mood.promptLine('GROUP_ONE'), '');
    stop();
    robot = boot();
    now = Date.parse('2026-11-16T05:00:00Z');
    await robot.run();
    assert.equal(deliveries.length, 0, 'wait for websocket ready');
    robot.ready();
    assert.equal(await robot.dispatch({ content: '小易' }), true);
    const wakingMood = mood.snapshot('GROUP_ONE');
    assert.equal(wakingMood.label, '起床气');
    assert.deepEqual(mood.snapshot('GROUP_ONE'), wakingMood);
    assert.match(mood.promptLine('GROUP_ONE'), /困得有点气鼓鼓/);
    assert.equal(mood.promptLine('GROUP_OFF'), '');
    await robot.run(); await robot.run();
    assert.deepEqual(deliveries.map(({ target, text }) => [target.scope, target.targetId, text.match(/id="([A-Z_]+)"/)[1]]), [
      ['group', 'GROUP_ONE', 'SENDER_A'], ['group', 'GROUP_ONE', 'SENDER_B'],
    ]);
    assert.ok(deliveries.every(({ text }) => text.includes('刚被闹钟吵醒')));
    now += 45 * 60000;
    assert.equal(mood.snapshot('GROUP_ONE'), undefined, 'schedule effect expires without creating a mood row');
    now = Date.parse('2026-12-14T10:10:00Z'); // The stable dinner draw is a good meal.
    const meal = globalThis.__qqbotPersonaSleep.scheduledMeal('GROUP_ONE', now);
    assert.equal(meal.type, 'dinner');
    assert.ok(meal.valence > 0);
    assert.equal(globalThis.__qqbotPersonaSleep.scheduledMeal('GROUP_OFF', now), undefined);
    mood.pulse('GROUP_ONE', 1, 1, '测试');
    const baseMood = readProfileDocument(profile, 'mood').groups.GROUP_ONE;
    assert.equal(mood.snapshot('GROUP_ONE').valence, baseMood.valence + meal.valence);
    assert.equal(mood.snapshot('GROUP_ONE').energy, baseMood.energy + meal.energy);
    await robot.run();
    assert.deepEqual(memories, [], 'a meal in progress must not be remembered yet');
    now += 35 * 60000;
    await robot.run(); await robot.run();
    assert.deepEqual(memories, [meal], 'record the same meal once even without messages');
    assert.equal(mood.snapshot('GROUP_ONE').meal, undefined, 'the mood effect ends with the meal');
    const schedule = readProfileDocument(profile, 'persona-schedule');
    write('persona-schedule', { ...schedule, holidays: [{
      id: 'winter-festival', date: '2026-12-21', name: '冬日节', activities: [
        { id: 'chat', date: '2026-12-21', title: '节日活动', hint: '和朋友过节。', start: 735, end: 750 },
      ],
    }] });
    now = Date.parse('2026-12-21T04:14:00Z');
    assert.equal(await robot.dispatch({}), false);
    now += 60000;
    assert.equal(await robot.dispatch({}), true, 'the activity overrides the sleep gate');
    now += 15 * 60000;
    assert.equal(await robot.dispatch({}), false, 'the sleep gate resumes when the activity ends');
    assert.deepEqual(pending(), []);
    assert.deepEqual(errors, []);
  } finally {
    stop();
    globalThis.__qqbotMention = oldMention;
    globalThis.__qqbotPersonaSleep = oldSleep;
    globalThis.__qqbotMood = oldMood;
    globalThis.__qqbotSelfMemory = oldMemory;
    rmSync(profile, { recursive: true, force: true });
  }
});

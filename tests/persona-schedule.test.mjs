import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  beijingScheduleTime, currentPersonaSchedule, personaScheduleMeal, personaSchedulePrompt, scheduleSegments, validatePersonaSchedule,
} from '../bot-config-panel/public/app/shared/persona-schedule.js';

import { xiaoyiScheduleExample } from '../bot-config-panel/public/app/shared/xiaoyi-schedule-example.js';

const entry = (values = {}) => ({ id: 'late', title: '刷视频', days: [6], start: 1380, end: 60, hint: '熬夜刷视频。', ...values });
const at = iso => beijingScheduleTime(new Date(iso));

test('a dated activity overrides the weekly event across Beijing New Year and then restores it', () => {
  const weekly = entry({ days: [0, 1, 2, 3, 4, 5, 6], start: 0, end: 1440, sleep: true });
  const party = { id: 'countdown', date: '2026-12-31', start: 1380, end: 30, title: '跨年倒数', hint: '和朋友一起倒数。' };
  const holiday = { id: 'new-year', date: '2027-01-01', name: '元旦', activities: [party] };
  const doc = validatePersonaSchedule({ entries: [weekly], holidays: [holiday] });
  const match = iso => currentPersonaSchedule(doc, at(iso));
  assert.equal(match('2026-12-31T14:59:59Z').sleep, true);
  assert.equal(match('2026-12-31T15:00:00Z').id, 'countdown');
  assert.equal(match('2026-12-31T16:29:59Z').holidayName, '元旦');
  assert.equal(match('2026-12-31T16:30:00Z').sleep, true);
  assert.equal(match('2027-12-31T15:00:00Z').id, 'late');

  const next = { ...party, id: 'greeting', date: '2027-01-01', start: 30, end: 60 };
  assert.doesNotThrow(() => validatePersonaSchedule({ entries: [], holidays: [{ ...holiday, activities: [party, next] }] }));
  assert.throws(() => validatePersonaSchedule({ entries: [], holidays: [
    holiday, { ...holiday, id: 'another-holiday', activities: [{ ...next, start: 29 }] },
  ] }), /时间重叠/);
  assert.throws(() => validatePersonaSchedule({ entries: [], holidays: [{ ...holiday, date: '2026-02-29' }] }), /有效的日期/);
});

test('Beijing time: midnight is 00:00; repeating intervals wrap Sunday into Monday', () => {
  const week = validatePersonaSchedule({ entries: [entry({ days: [6, 2] })] });
  assert.deepEqual(week.entries[0].days, [2, 6]);
  assert.deepEqual(scheduleSegments(week.entries[0]), [
    { day: 2, start: 1380, end: 1440 }, { day: 3, start: 0, end: 60 },
    { day: 6, start: 1380, end: 1440 }, { day: 0, start: 0, end: 60 },
  ]);
  const match = iso => currentPersonaSchedule(week, at(iso))?.id;
  assert.equal(match('2026-11-15T14:59:59Z'), undefined);
  assert.equal(match('2026-11-15T15:00:00Z'), 'late');
  assert.deepEqual(at('2026-11-15T16:00:00Z'), {
    date: '2026-11-16', hour: '00', minute: '00', weekday: '星期一', dayIndex: 0, minuteOfDay: 0,
  });
  assert.equal(match('2026-11-15T16:59:59Z'), 'late');
  assert.equal(match('2026-11-15T17:00:00Z'), undefined);
  assert.equal(match('2026-11-18T15:30:00Z'), 'late');
  assert.equal(match('2026-11-19T15:30:00Z'), undefined);
  assert.match(personaSchedulePrompt(currentPersonaSchedule(week, at('2026-11-15T16:12Z'))), /当前安排】刷视频\n回话提示：熬夜刷视频。/);
  assert.equal(personaSchedulePrompt(undefined), '');
});

test('validates probability, sleep, IDs and minute boundaries', () => {
  const morning = entry({ id: 'class', days: [0], start: 59, end: 105, title: '准备上课' });
  const validate = (...entries) => validatePersonaSchedule({ entries });
  assert.equal(currentPersonaSchedule(validate(entry(), morning), at('2026-11-15T17:01:00Z')), undefined, 'the earlier overnight event wins; no late start');
  assert.throws(() => validate(entry(), entry({ start: 5 })), /标识/);
  assert.throws(() => validate(entry({ days: [1, 1] })), /星期/);
  for (const values of [{ start: 1440 }, { end: 1441 }, { start: -1 }, { end: 1380 }, { end: '60' }]) {
    assert.throws(() => validate(entry(values)), /起止时间/);
  }
  assert.throws(() => validate(entry({ hint: ' ' })), /回话提示/);
  for (const probability of [-1, 101, 50.1, '50']) assert.throws(() => validate(entry({ probability })), /发生概率/);
  assert.throws(() => validate(entry({ sleep: 'true' })), /睡眠/);
  assert.throws(() => validate(entry({ mood: 'unknown' })), /情绪/);
  assert.throws(() => validate(entry({ sleep: true, mood: 'early-rise' })), /情绪/);
  assert.equal(personaSchedulePrompt(validate(entry({ sleep: true, hint: '' })).entries[0]), '');
  const adjacent = validate(entry(), { ...morning, start: 60 });
  assert.equal(currentPersonaSchedule(adjacent, at('2026-11-15T17:00:00Z')).id, 'class');
  for (const end of [0, 1440]) {
    assert.deepEqual(scheduleSegments(validate(entry({ end })).entries[0]), [{ day: 6, start: 1380, end: 1440 }]);
  }
});


test('probability rolls once per occurrence and an ongoing event cannot be interrupted or rescheduled', () => {
  const nap = entry({ id: 'nap', days: [0], start: 720, end: 780, probability: 50, sleep: true });
  const game = entry({ id: 'game', days: [0], start: 750, end: 810, probability: 100 });
  const week = validatePersonaSchedule({ entries: [nap, game] });
  const possible = new Set();
  const base = Date.parse('2026-11-16T04:00:00Z'); // Monday noon in Beijing
  for (let n = 0; n < 30; n++) {
    const start = base + n * 7 * 86400000;
    const match = (m, doc = week) => currentPersonaSchedule(doc, beijingScheduleTime(new Date(start + m * 60000)))?.id;
    const napStarted = match(0) === 'nap';
    possible.add(napStarted);
    assert.equal(match(1), napStarted ? 'nap' : undefined);
    assert.equal(match(30), napStarted ? 'nap' : 'game');
    assert.equal(match(59), napStarted ? 'nap' : 'game');
    assert.equal(match(60), napStarted ? undefined : 'game');
    assert.equal(match(90), undefined);
    assert.equal(match(30, { entries: [week.entries[1], week.entries[0]] }), napStarted ? 'nap' : 'game');
  }
  assert.equal(possible.size, 2, 'a partial probability must produce both outcomes');
});

test('same-time candidates select one winner; zero chance never starts', () => {
  const entries = [entry({ id: 'one' }), entry({ id: 'two' }), entry({ id: 'zero', probability: 0 })];
  const now = at('2026-11-15T15:01:00Z');
  const actual = currentPersonaSchedule(validatePersonaSchedule({ entries }), now)?.id;
  assert.ok(['one', 'two'].includes(actual));
  assert.equal(currentPersonaSchedule(validatePersonaSchedule({ entries: [...entries].reverse() }), now)?.id, actual);
});

test('Xiaoyi sample: school, night sleep and overlapping alternatives match the intended routine', () => {
  const week = validatePersonaSchedule(xiaoyiScheduleExample);
  const match = (day, hour, min = 0, weeks = 0) => currentPersonaSchedule(week,
    beijingScheduleTime(new Date(Date.UTC(2026, 10, 16 + day + weeks * 7, hour - 8, min))));
  const id = (...args) => match(...args)?.id?.replace(/^xiaoyi-/, '');
  assert.equal(id(1, 7, 14), 'sleep-tuesday');
  assert.equal(id(1, 7, 15), 'tuesday-drowsy');
  assert.equal(id(1, 8), 'tuesday-materials');
  assert.equal(id(2, 7, 14), 'sleep-tuesday');
  for (const day of [1, 2]) {
    assert.equal(match(day, 7, 15).mood, 'early-rise');
    assert.equal(match(day, 7, 59).mood, 'early-rise');
    assert.equal(match(day, 8).mood, undefined);
  }
  assert.equal(id(2, 8), 'wednesday-history');
  assert.equal(id(0, 10), undefined);
  assert.equal(id(0, 13, 30), 'monday-design');
  assert.equal(id(0, 15, 10), 'monday-drape');
  assert.equal(id(3, 10), 'thursday-english');
  assert.equal(id(3, 11, 45), 'lunch');
  assert.equal(id(3, 13, 30), 'friday-pe');
  assert.equal(id(3, 15, 10), 'friday-tired');
  assert.equal(match(3, 15, 10).sleep, false);
  assert.equal(id(3, 15, 30), 'thursday-studio');
  assert.equal(id(3, 18), 'dinner');
  assert.equal(id(4, 11, 45), 'lunch');
  assert.equal(id(5, 10, 30), 'doll-sewing');
  assert.equal(id(5, 15), 'doll-photos');
  assert.equal(id(6, 19, 30), 'sketch');
  assert.equal(id(5, 0, 30), 'sleep-weekend');
  assert.equal(id(0, 0, 0), undefined);
  const lunches = new Set(), nights = new Set();
  for (let n = 0; n < 24; n++) {
    const nap = id(1, 12, 40, n);
    const lunch = id(1, 12, 50, n);
    assert.equal(lunch, nap === 'nap' ? 'nap' : 'lunch-hangout');
    lunches.add(lunch);
    const night = id(0, 22, 35, n);
    assert.equal(night, id(0, 22, 30, n) === 'game' ? 'game' : 'video');
    nights.add(night);
  }
  assert.deepEqual(lunches, new Set(['nap', 'lunch-hangout']));
  assert.deepEqual(nights, new Set(['game', 'video']));
});

test('each day has three meals, with a stable menu and occasional favorite food', () => {
  const week = validatePersonaSchedule(xiaoyiScheduleExample);
  const dinners = [];
  for (let day = 0; day < 140; day++) {
    const meals = [[8, 15], [9, 20], [11, 50], [12, 15], [18, 10]].map(([hour, minute]) => {
      const early = day % 7 === 1 || day % 7 === 2;
      const time = beijingScheduleTime(new Date(Date.UTC(2026, 10, 16 + day, (early && hour === 8 ? 7 : hour) - 8, early && hour === 8 ? 20 : minute)));
      const mealEntry = currentPersonaSchedule(week, time);
      const meal = personaScheduleMeal(mealEntry, time);
      if (meal) assert.ok(personaSchedulePrompt(mealEntry, time).includes(meal.dish));
      return meal;
    }).filter(Boolean);
    assert.deepEqual([...new Set(meals.map(meal => meal.type))], ['breakfast', 'lunch', 'dinner']);
    dinners.push(meals.at(-1));
  }
  assert.ok(dinners.some(meal => meal.dish.includes('火锅') && meal.valence > 10));
  assert.ok(dinners.filter(meal => meal.valence <= 0).length > 100);
  assert.ok(dinners.some(meal => meal.valence < 0));
});

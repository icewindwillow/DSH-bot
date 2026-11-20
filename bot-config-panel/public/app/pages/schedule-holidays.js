import { $, esc } from '../shared/runtime.js';
import {
  beijingScheduleTime, formatScheduleMinute, parseScheduleTime, scheduleSegments, validateScheduleHolidays,
} from '../shared/persona-schedule.js';

let year, schedule;
let editingHoliday, editingActivity;
let currentActivity;

function yearHolidays() {
  return (schedule?.holidays ?? [])
    .filter(holiday => holiday.date.startsWith(String(year)))
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, 'zh-CN'));
}

export function renderHolidaySchedule(draft) {
  schedule = draft;
  const list = $('holidayList');
  const sameYear = list.dataset.year === String(year);
  if (draft) list.dataset.year = String(year);
  const open = new Set([...list.querySelectorAll('details[open]')].map(card => card.dataset.holidayId));
  const today = beijingScheduleTime().date;
  const holidays = yearHolidays();
  const first = holidays.find(holiday => (holiday.through || holiday.date) >= today) ?? holidays.at(-1);
  $('holidayYear').value = year;
  $('holidayPreviousYear').disabled = year <= 1000;
  $('holidayNextYear').disabled = year >= 9999;
  list.innerHTML = holidays.map(holiday => {
    const date = holiday.date.slice(5).replace('-', '月') + '日';
    const vacation = holiday.from ? `<span class="muted">放假 ${holiday.from} 至 ${holiday.through}</span>` : '';
    const activities = [...holiday.activities].sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start);
    return `<details class="holiday-card" data-holiday-id="${esc(holiday.id)}" ${(sameYear ? open.has(holiday.id) : first === holiday) ? 'open' : ''}>
      <summary><span class="holiday-heading"><time datetime="${holiday.date}">${date}</time><strong>${esc(holiday.name)}</strong>
        ${vacation}<span class="chip">${activities.length ? `${activities.length} 项活动` : '未安排'}</span></span></summary>
      <div class="holiday-body">
        <div class="row">
          <button type="button" class="small" data-holiday-action="add">添加活动</button>
          <button type="button" class="small ghost" data-holiday-action="edit">编辑节日</button>
        </div>
        ${activities.length ? `<ul role="list">${activities.map(activity => `
          <li class="schedule-list-item" data-holiday-activity="${esc(activity.id)}">
            <div class="row row-between">
              <div class="row"><span class="muted">${activity.date} · ${formatScheduleMinute(activity.start)}–${activity.end < activity.start ? '次日 ' : ''}${formatScheduleMinute(activity.end)}</span>
                <strong>${esc(activity.title)}</strong><span class="chip holiday-active" hidden>当前活动</span></div>
              <button type="button" class="small ghost" data-holiday-action="activity" aria-label="${esc(`编辑活动 ${activity.title}`)}">编辑</button>
            </div>
            <p class="muted">${esc(activity.hint)}</p>
          </li>`).join('')}</ul>` : ''}
      </div>
    </details>`;
  }).join('') || (draft ? `<p class="muted">${year} 年还没有节日，添加节日后即可安排活动。</p>` : '');
  highlightHolidayActivity(currentActivity);
}

export function highlightHolidayActivity(active) {
  currentActivity = active;
  for (const row of $('holidayList').querySelectorAll('[data-holiday-activity]')) {
    row.querySelector('.holiday-active').hidden = !active?.holidayName || active.id !== row.dataset.holidayActivity;
  }
}

function openHolidayEditor(holiday) {
  editingHoliday = holiday;
  $('holidayEditorTitle').textContent = holiday ? '编辑节日' : `添加 ${year} 年节日`;
  $('holidayName').value = holiday?.name ?? '';
  const date = $('holidayDate');
  const today = beijingScheduleTime().date;
  date.min = `${year}-01-01`;
  date.max = `${year}-12-31`;
  date.value = holiday?.date ?? (today.startsWith(String(year)) ? today : '');
  $('holidayFrom').value = holiday?.from ?? '';
  $('holidayThrough').value = holiday?.through ?? '';
  $('holidayEditorError').textContent = '';
  $('btnHolidayDelete').hidden = !holiday;
  $('holidayEditor').showModal();
  $('holidayName').focus();
}

function readActivityTimes() {
  return {
    date: $('holidayActivityDate').value,
    start: parseScheduleTime($('holidayActivityStart').value.trim()),
    end: parseScheduleTime($('holidayActivityEnd').value.trim(), true),
  };
}

function updateConflict() {
  const hint = $('holidayConflict');
  hint.hidden = true;
  try {
    const { date, start, end } = readActivityTimes();
    const day = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
    if (!Number.isInteger(day) || start === end) return;
    const activity = scheduleSegments({ days: [day], start, end });
    const conflicts = schedule.entries.filter(entry => entry.probability > 0 && scheduleSegments(entry).some(weekly =>
      activity.some(segment => segment.day === weekly.day && segment.start < weekly.end && weekly.start < segment.end)));
    if (!conflicts.length) return;
    const names = conflicts.slice(0, 4).map(entry => `「${entry.title}」${entry.sleep ? '（睡眠）' : ''}`).join('、');
    hint.textContent = `活动时段优先于同时间的周表安排 ${names}${conflicts.length > 4 ? ` 等 ${conflicts.length} 项` : ''}。`;
    hint.hidden = false;
  } catch {
    // The form reports incomplete or invalid times on submit.
  }
}

function openActivityEditor(holiday, activity) {
  editingHoliday = holiday;
  editingActivity = activity;
  $('holidayActivityEditorTitle').textContent = `${activity ? '编辑' : '添加'}活动 · ${holiday.name}`;
  $('holidayActivityDate').value = activity?.date ?? holiday.date;
  $('holidayActivityTitle').value = activity?.title ?? '';
  $('holidayActivityHint').value = activity?.hint ?? '';
  $('holidayActivityStart').value = activity ? formatScheduleMinute(activity.start) : '';
  $('holidayActivityEnd').value = activity ? formatScheduleMinute(activity.end) : '';
  $('holidayActivityError').textContent = '';
  $('btnHolidayActivityDelete').hidden = !activity;
  updateConflict();
  $('holidayActivityEditor').showModal();
  $('holidayActivityTitle').focus();
}

function replaceHoliday(holiday) {
  const list = schedule.holidays ?? [];
  return editingHoliday ? list.map(previous => previous.id === editingHoliday.id ? holiday : previous) : [...list, holiday];
}

export function initHolidaySchedule({ onChange, isBusy }) {
  year = Number(beijingScheduleTime().date.slice(0, 4));
  renderHolidaySchedule();
  function changeYear(next) {
    if (Number.isInteger(next) && next >= 1000 && next <= 9999) year = next;
    renderHolidaySchedule(schedule);
  }
  $('holidayYear').onchange = event => changeYear(event.target.valueAsNumber);
  $('holidayPreviousYear').onclick = () => changeYear(year - 1);
  $('holidayNextYear').onclick = () => changeYear(year + 1);
  $('btnHolidayAdd').onclick = () => openHolidayEditor();
  $('holidayList').onclick = event => {
    const button = event.target.closest('[data-holiday-action]');
    if (!button || isBusy()) return;
    const holiday = yearHolidays().find(item => item.id === button.closest('[data-holiday-id]').dataset.holidayId);
    if (button.dataset.holidayAction === 'edit') openHolidayEditor(holiday);
    else if (button.dataset.holidayAction === 'add') openActivityEditor(holiday);
    else openActivityEditor(holiday, holiday.activities.find(item => item.id === button.closest('[data-holiday-activity]').dataset.holidayActivity));
  };

  function finish(list, dialogId, errorId, focusHolidayId, focusActivityId) {
    try {
      onChange(validateScheduleHolidays(list));
      $(dialogId).close();
      const card = focusHolidayId && $('holidayList').querySelector(`[data-holiday-id="${CSS.escape(focusHolidayId)}"]`);
      if (card) {
        card.open = true;
        const activity = focusActivityId && card.querySelector(`[data-holiday-activity="${CSS.escape(focusActivityId)}"] button`);
        (activity || card.querySelector('summary')).focus();
      } else $('btnHolidayAdd').focus();
    } catch (error) {
      $(errorId).textContent = error.message;
    }
  }

  $('btnHolidayCancel').onclick = () => $('holidayEditor').close();
  $('btnHolidayDelete').onclick = () => {
    if (!confirm(`删除「${editingHoliday.name}」及其所有活动？`)) return;
    finish(schedule.holidays.filter(item => item.id !== editingHoliday.id), 'holidayEditor', 'holidayEditorError');
  };
  $('holidayForm').onsubmit = event => {
    event.preventDefault();
    const holiday = {
      id: editingHoliday?.id ?? crypto.randomUUID(),
      name: $('holidayName').value,
      date: $('holidayDate').value,
      from: $('holidayFrom').value,
      through: $('holidayThrough').value,
      activities: editingHoliday?.activities ?? [],
    };
    finish(replaceHoliday(holiday), 'holidayEditor', 'holidayEditorError', holiday.id);
  };
  $('holidayActivityForm').oninput = updateConflict;
  $('btnHolidayActivityCancel').onclick = () => $('holidayActivityEditor').close();
  $('btnHolidayActivityDelete').onclick = () => {
    if (!confirm(`删除活动「${editingActivity.title}」？`)) return;
    const holiday = { ...editingHoliday, activities: editingHoliday.activities.filter(item => item.id !== editingActivity.id) };
    finish(replaceHoliday(holiday), 'holidayActivityEditor', 'holidayActivityError', holiday.id);
  };
  $('holidayActivityForm').onsubmit = event => {
    event.preventDefault();
    try {
      const activity = {
        id: editingActivity?.id ?? crypto.randomUUID(),
        ...readActivityTimes(),
        title: $('holidayActivityTitle').value,
        hint: $('holidayActivityHint').value,
      };
      const activities = editingActivity
        ? editingHoliday.activities.map(item => item.id === activity.id ? activity : item)
        : [...editingHoliday.activities, activity];
      finish(replaceHoliday({ ...editingHoliday, activities }), 'holidayActivityEditor', 'holidayActivityError', editingHoliday.id, activity.id);
    } catch (error) {
      $('holidayActivityError').textContent = error.message;
    }
  };
}

import { $, api, clone, esc } from '../shared/runtime.js';
import {
  beijingScheduleTime, currentPersonaSchedule, formatScheduleMinute, parseScheduleTime, personaSchedulePrompt,
  scheduleSegments, SCHEDULE_WEEKDAYS, validatePersonaSchedule,
} from '../shared/persona-schedule.js';
import { xiaoyiScheduleExample } from '../shared/xiaoyi-schedule-example.js';
import { highlightHolidayActivity, initHolidaySchedule, renderHolidaySchedule } from './schedule-holidays.js';

const route = '/api/persona-schedule';
const shortDays = SCHEDULE_WEEKDAYS.map(day => day.replace('星期', '周'));

let saved = null, draft = null, version;
let selectedDay = 0, editedId = null, editorDay = 0;
let editorSource = null;
let loading = false, saving = false, didScroll = false, loadFailed = false;

export function hasScheduleDraft() {
  return draft !== null && (saving || JSON.stringify(draft) !== JSON.stringify(saved));
}

function message(text, kind = '') {
  for (const id of ['scheduleMessage', 'holidayMessage']) {
    const status = $(id);
    status.hidden = !text;
    status.textContent = text;
    status.className = `msg ${kind}`;
  }
}

function updateControls() {
  const busy = loading || saving;
  $('btnScheduleSave').disabled = busy || !hasScheduleDraft();
  $('btnScheduleAdd').disabled = busy || !draft;
  $('btnScheduleExamples').disabled = busy || !draft;
  $('btnScheduleReload').disabled = busy;
  $('btnHolidaySave').disabled = busy || !hasScheduleDraft();
  $('btnHolidayAdd').disabled = busy || !draft;
  $('btnHolidayReload').disabled = busy;
}

function applySnapshot(snapshot) {
  if (snapshot.scheduleRevision !== 3) throw new Error('请更新控制台服务后重新读取时间表。');
  version = snapshot.version;
  saved = snapshot.data;
  draft = clone(saved);
  loadFailed = false;
  if (!didScroll) {
    selectedDay = snapshot.time.dayIndex;
    $('scheduleListDay').value = String(selectedDay);
  }
  renderHolidaySchedule(draft);
  renderGrid();
}

async function loadSchedule() {
  if (loading || saving) return;
  if (hasScheduleDraft() && !confirm('重新读取会丢弃本页未保存的草稿，继续？')) return;
  loading = true; updateControls(); message('正在读取…');
  if (!saved) $('schedulePublished').textContent = '读取中';
  try {
    applySnapshot(await api(route));
    message('');
  } catch (error) {
    loadFailed = true;
    message(`读取失败：${error.message}`, 'err');
  } finally {
    loading = false; updateControls(); updateNow();
  }
}

async function saveSchedule() {
  if (!hasScheduleDraft() || saving || loading) return;
  saving = true; updateControls(); message('正在保存…');
  try {
    applySnapshot(await api(route, { method: 'PUT', body: JSON.stringify({ data: draft, baseVersion: version }) }));
    message('已保存 · 已启用的人格下一轮生效', 'ok');
  } catch (error) {
    message(`保存失败：${error.message}（草稿已保留）`, 'err');
  } finally {
    saving = false; updateControls(); updateNow();
  }
}

function updateNow() {
  const time = beijingScheduleTime();
  const active = saved && currentPersonaSchedule(saved, time);
  const source = active ? ` · ${active.holidayName ? `节日活动 · ${active.holidayName}` : '每周安排'}` : '';
  const summary = saved ? `${time.weekday} ${time.hour}:${time.minute}${source} · ${active?.title ?? '当前无安排'}${active?.sleep ? ' · 睡眠中' : ''}${active?.mood === 'early-rise' ? ' · 起床气' : ''}`
    : loading || !loadFailed ? '正在读取时间表…' : '无法读取当前安排';
  if ($('scheduleCurrent').textContent !== summary) $('scheduleCurrent').textContent = summary;
  $('schedulePublished').textContent = loadFailed ? (saved ? '上次读取' : '读取失败')
    : !saved ? '读取中' : hasScheduleDraft() ? '有未保存修改' : (saved.entries.length || saved.holidays?.length) ? '已配置' : '未配置';
  $('schedulePreview').hidden = !active || active.sleep;
  const preview = personaSchedulePrompt(active, time);
  if ($('schedulePrompt').textContent !== preview) $('schedulePrompt').textContent = preview;
  highlightHolidayActivity(active);
  if (!draft) return;
  for (const head of $('scheduleGrid').querySelectorAll('[data-schedule-head]')) {
    if (Number(head.dataset.scheduleHead) === time.dayIndex) head.setAttribute('aria-current', 'date');
    else head.removeAttribute('aria-current');
  }
  const nowLine = $('scheduleNow');
  const today = $('scheduleGrid').querySelector(`[data-schedule-day="${time.dayIndex}"]`);
  if (today && nowLine.parentNode !== today) today.append(nowLine);
  nowLine.style.top = `calc(${time.minuteOfDay} * var(--schedule-hour) / 60)`;
  const currentDraft = currentPersonaSchedule(draft, time);
  for (const block of $('scheduleGrid').querySelectorAll('[data-schedule-id]')) {
    const matches = !currentDraft?.holidayName && block.dataset.scheduleId === currentDraft?.id
      && Number(block.parentNode.dataset.scheduleDay) === time.dayIndex
      && Number(block.dataset.start) <= time.minuteOfDay && time.minuteOfDay < Number(block.dataset.end);
    if (matches) block.setAttribute('aria-current', 'time');
    else block.removeAttribute('aria-current');
  }
}

function scrollToTime(minute) {
  const calendar = $('scheduleCalendar');
  const hourSize = parseFloat(getComputedStyle($('scheduleGrid')).getPropertyValue('--schedule-hour'));
  calendar.scrollTop = Math.max(0, (minute / 60 - 1.5) * hourSize);
}

function layoutDay(segments) {
  const lanes = [];
  let group = [], groupEnd = 0;
  const finish = () => { for (const item of group) item.lanes = lanes.length; };
  for (const item of segments.sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (item.start >= groupEnd) { finish(); group = []; lanes.length = 0; groupEnd = 0; }
    const available = lanes.findIndex(end => end <= item.start);
    item.lane = available < 0 ? lanes.length : available;
    lanes[item.lane] = item.end;
    group.push(item);
    groupEnd = Math.max(groupEnd, item.end);
  }
  finish();
  return segments;
}

function scheduleWeek() {
  const week = Array.from({ length: 7 }, () => []);
  for (const entry of draft.entries) {
    for (const segment of scheduleSegments(entry)) week[segment.day].push({ ...segment, entry });
  }
  return week;
}

function renderScheduleList(week = scheduleWeek()) {
  const filter = $('scheduleListDay').value;
  $('scheduleListCard').hidden = false;
  $('scheduleList').innerHTML = week.map((segments, day) => {
    if (filter !== 'all' && Number(filter) !== day) return '';
    const items = segments.sort((a, b) => a.start - b.start || a.end - b.end).map(({ entry, start, end }) => {
      const span = `${formatScheduleMinute(start)}–${formatScheduleMinute(end)}`;
      const continuation = start !== entry.start ? ' · 接前一夜'
        : end !== entry.end && entry.end !== 0 ? ' · 延续到次日' : '';
      const description = entry.sleep ? '睡眠命中期间不回群聊。' : '回话提示：';
      return `<li class="schedule-list-item">
        <div class="row row-between">
          <div class="row"><span class="muted">${span}${continuation}</span><strong>${esc(entry.title)}</strong>
            <span class="chip">${entry.probability}%</span>${entry.sleep ? '<span class="chip">睡眠</span>' : ''}</div>
          <button type="button" class="small ghost" data-schedule-list-id="${esc(entry.id)}" data-day="${day}"
            aria-label="编辑 ${esc(`${SCHEDULE_WEEKDAYS[day]} ${span} ${entry.title}`)}">编辑</button>
        </div>
        <p class="muted">${description}${entry.sleep && entry.hint ? ' 备注：' : ''}${esc(entry.hint)}</p>
      </li>`;
    }).join('');
    return `<section class="schedule-list-day"><h3>${SCHEDULE_WEEKDAYS[day]}</h3>
      ${items ? `<ul role="list">${items}</ul>` : '<p class="muted">这一天没有安排。</p>'}</section>`;
  }).join('');
}

function renderGrid() {
  const week = scheduleWeek();
  renderScheduleList(week);
  const other = day => day !== selectedDay ? ' data-other-day' : '';
  $('scheduleCalendar').hidden = false;
  $('scheduleDay').value = String(selectedDay);
  $('scheduleGrid').innerHTML = `<div class="schedule-head">时间</div>${shortDays.map((day, i) =>
    `<div class="schedule-head" data-schedule-head="${i}"${other(i)}>${day}</div>`).join('')}
    <div class="schedule-axis" aria-hidden="true">${Array.from({ length: 25 }, (_, hour) =>
    `<span class="schedule-tick" style="top:calc(${hour} * var(--schedule-hour))">${formatScheduleMinute(hour * 60)}</span>`).join('')}</div>
    ${week.map((segments, day) => `<div class="schedule-day" data-schedule-day="${day}"${other(day)} role="group" aria-label="${SCHEDULE_WEEKDAYS[day]}">
      ${layoutDay(segments).map(({ entry, start, end, lane, lanes }) => {
        const span = `${formatScheduleMinute(start)}–${formatScheduleMinute(end)}`;
        const badges = `${entry.probability}%${entry.sleep ? ' · 睡眠' : ''}`;
        const label = `${SCHEDULE_WEEKDAYS[day]} ${span} · ${entry.title} · ${badges}`;
        return `<button type="button" class="schedule-slot" data-schedule-id="${esc(entry.id)}" data-start="${start}" data-end="${end}"
          ${end - start < 38 ? 'data-compact' : ''} ${end - start < 18 ? 'data-tiny' : ''}
          title="${esc(label)}" aria-label="编辑 ${esc(label)}" style="--start:${start};--duration:${end - start};--lane:${lane};--lanes:${lanes}">
          <span class="schedule-slot-title"><strong>${entry.sleep ? '☾ ' : ''}${esc(entry.title)}</strong><span class="schedule-slot-chance">${entry.probability}%</span></span><small>${span}</small></button>`;
      }).join('')}
      ${day === selectedDay ? '<span id="scheduleNow" class="schedule-now" aria-hidden="true"></span>' : ''}</div>`).join('')}`;
  updateNow();
  if (!didScroll && !$('scheduleWeekPanel').hidden) {
    didScroll = true;
    scrollToTime(beijingScheduleTime().minuteOfDay);
  }
}

function openEditor(entry, day, start, end, source = null) {
  if (!draft || loading || saving) return;
  editorDay = day;
  editorSource = source;
  editedId = entry?.id ?? null;
  $('scheduleEditorTitle').textContent = entry ? '编辑安排' : '添加安排';
  for (const input of $('scheduleDays').querySelectorAll('input')) input.checked = (entry?.days ?? [day]).includes(Number(input.value));
  $('scheduleStart').value = formatScheduleMinute(entry?.start ?? start);
  $('scheduleEnd').value = formatScheduleMinute(entry?.end ?? end ?? Math.min(start + 60, 1440));
  $('scheduleTitle').value = entry?.title ?? '';
  $('scheduleHint').value = entry?.hint ?? '';
  $('scheduleProbability').value = entry?.probability ?? 100;
  $('scheduleSleep').checked = entry?.sleep ?? false;
  $('scheduleMood').value = entry?.mood ?? '';
  $('scheduleMood').disabled = $('scheduleSleep').checked;
  $('scheduleMeal').value = entry?.meal ?? '';
  $('scheduleMeal').disabled = $('scheduleSleep').checked;
  $('scheduleHint').required = !$('scheduleSleep').checked;
  $('scheduleEditorError').textContent = '';
  $('btnScheduleDelete').hidden = !entry;
  $('scheduleEditor').showModal();
  $('scheduleTitle').focus();
}

function finishEdit(focusId) {
  $('scheduleEditor').close();
  renderGrid(); updateControls(); message(hasScheduleDraft() ? '草稿已更新，保存后才会生效。' : '');
  if (editorSource === 'list') {
    const editButton = focusId && $('scheduleList').querySelector(`[data-day="${editorDay}"][data-schedule-list-id="${CSS.escape(focusId)}"]`);
    (editButton || $('scheduleListDay')).focus();
    return;
  }
  const slot = focusId && $('scheduleGrid').querySelector(`[data-schedule-day="${editorDay}"] [data-schedule-id="${CSS.escape(focusId)}"]`);
  if (slot?.getClientRects?.().length) slot.focus({ preventScroll: true });
  else $('btnScheduleAdd').focus({ preventScroll: true });
}

export function initSchedulePage() {
  initHolidaySchedule({
    isBusy: () => !draft || loading || saving,
    onChange: holidays => {
      draft = { ...draft, holidays };
      renderHolidaySchedule(draft);
      updateControls();
      updateNow();
      message('草稿已更新，保存后才会生效。');
    },
  });
  const tabs = [$('scheduleWeekTab'), $('scheduleHolidayTab')];
  function selectTab(tab) {
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute('aria-selected', selected);
      item.tabIndex = selected ? 0 : -1;
      $(item.getAttribute('aria-controls')).hidden = !selected;
    }
    if (tab === tabs[1] && draft) renderHolidaySchedule(draft);
    if (tab === tabs[0] && draft && !didScroll) renderGrid();
    else updateNow();
  }
  for (const [index, tab] of tabs.entries()) {
    tab.onclick = () => selectTab(tab);
    tab.onkeydown = event => {
      const next = { Home: tabs[0], End: tabs[1], ArrowLeft: tabs[1 - index], ArrowRight: tabs[1 - index] }[event.key];
      if (!next) return;
      event.preventDefault();
      selectTab(next);
      next.focus();
    };
  }
  const dayOptions = SCHEDULE_WEEKDAYS.map((day, i) => `<option value="${i}">${day}</option>`).join('');
  $('scheduleDay').innerHTML = dayOptions;
  $('scheduleListDay').innerHTML = `${dayOptions}<option value="all">整周</option>`;
  $('scheduleListDay').onchange = () => renderScheduleList();
  $('scheduleList').onclick = event => {
    const button = event.target.closest('[data-schedule-list-id]');
    if (!button || !draft) return;
    const entry = draft.entries.find(e => e.id === button.dataset.scheduleListId);
    if (entry) openEditor(entry, Number(button.dataset.day), undefined, undefined, 'list');
  };
  $('scheduleDays').innerHTML = shortDays.map((day, i) => `<label class="mem-check"><input type="checkbox" value="${i}"> ${day}</label>`).join('');
  $('scheduleDay').onchange = e => {
    selectedDay = Number(e.target.value);
    for (const col of $('scheduleGrid').querySelectorAll('[data-schedule-head], [data-schedule-day]')) {
      col.toggleAttribute('data-other-day', Number(col.dataset.scheduleHead ?? col.dataset.scheduleDay) !== selectedDay);
    }
  };
  $('btnScheduleHelp').onclick = () => $('scheduleHelp').showModal();
  $('btnScheduleReload').onclick = loadSchedule;
  $('btnScheduleSave').onclick = saveSchedule;
  $('btnHolidayReload').onclick = loadSchedule;
  $('btnHolidaySave').onclick = saveSchedule;
  $('btnScheduleExamples').onclick = () => {
    if (!draft || loading || saving) return;
    if (draft.entries.length && !confirm('用小易的示例周表替换当前草稿？已保存的周表不会改变，除非你再点击保存。')) return;
    draft = { ...draft, ...validatePersonaSchedule(xiaoyiScheduleExample) };
    renderGrid(); updateControls(); message('已载入小易周表草稿。请确认课程、概率和睡眠时段，再决定是否保存。');
    scrollToTime(435);
  };
  $('btnScheduleAdd').onclick = () => openEditor(null, selectedDay, Math.floor(beijingScheduleTime().minuteOfDay / 60) * 60);
  $('scheduleGrid').onclick = event => {
    const column = event.target.closest('[data-schedule-day]');
    if (!column || !draft) return;
    const day = Number(column.dataset.scheduleDay);
    const block = event.target.closest('[data-schedule-id]');
    if (block) return openEditor(draft.entries.find(e => e.id === block.dataset.scheduleId), day);
    const hourSize = parseFloat(getComputedStyle(column).getPropertyValue('--schedule-hour'));
    const minute = Math.floor((event.clientY - column.getBoundingClientRect().top) * 60 / hourSize);
    if (minute < 0 || minute >= 1440) return;
    const segments = draft.entries.flatMap(scheduleSegments).filter(segment => segment.day === day);
    const previousEnd = Math.max(0, ...segments.filter(s => s.end <= minute).map(s => s.end));
    const nextStart = Math.min(1440, ...segments.filter(s => s.start > minute).map(s => s.start));
    const start = Math.max(previousEnd, Math.floor(minute / 15) * 15);
    openEditor(null, day, start, Math.min(nextStart, start + 60));
  };
  $('scheduleSleep').onchange = () => {
    $('scheduleHint').required = !$('scheduleSleep').checked;
    $('scheduleMood').disabled = $('scheduleSleep').checked;
    $('scheduleMeal').disabled = $('scheduleSleep').checked;
  };
  $('btnScheduleCancel').onclick = () => $('scheduleEditor').close();
  $('btnScheduleDelete').onclick = () => {
    if (!editedId || !confirm('删除这条安排？它在所有选中的星期都会被移除。')) return;
    draft = { ...draft, entries: draft.entries.filter(entry => entry.id !== editedId) };
    finishEdit();
  };
  $('scheduleForm').onsubmit = event => {
    event.preventDefault();
    try {
      const entry = {
        id: editedId ?? crypto.randomUUID(), title: $('scheduleTitle').value, hint: $('scheduleHint').value,
        probability: $('scheduleProbability').valueAsNumber, sleep: $('scheduleSleep').checked,
        days: [...$('scheduleDays').querySelectorAll('input:checked')].map(input => Number(input.value)),
        start: parseScheduleTime($('scheduleStart').value.trim()), end: parseScheduleTime($('scheduleEnd').value.trim(), true),
      };
      if (!entry.sleep && $('scheduleMood').value) entry.mood = $('scheduleMood').value;
      if (!entry.sleep && $('scheduleMeal').value) entry.meal = $('scheduleMeal').value;
      const entries = editedId ? draft.entries.map(previous => previous.id === editedId ? entry : previous) : [...draft.entries, entry];
      draft = { ...draft, ...validatePersonaSchedule({ entries }) };
      finishEdit(entry.id);
    } catch (error) {
      $('scheduleEditorError').textContent = error.message;
    }
  };
  setInterval(() => { if (!$('paneSchedule').hidden) updateNow(); }, 10000);
}

export function showSchedulePage() {
  if (!draft) void loadSchedule();
  else updateNow();
}

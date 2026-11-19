import { $, api, esc } from '../shared/runtime.js';
import { eventDuration, matchesEvent, presentEvent } from './event-data.js';

const filters = [
  ['active', '进行中'],
  ['closed', '已结束'],
  ['inactive', '不跟进'],
  ['all', '全部事项'],
  ['emotion', '情绪记录'],
];
const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const time = at => Number(at) > 0 ? timeFormat.format(at) : '时间未记录';

let events = [];
let groupNames = new Map();
let filter = 'active';
let selected = '';
let reading = false;
let updating = false;

function showMessage(text, error = false) {
  $('eventsStatus').textContent = text;
  $('eventsStatus').classList.toggle('err', error);
}

function renderGroupOptions() {
  const control = $('eventGroup');
  const current = control.value;
  const groups = new Map(events.filter(event => event.gid).map(event => [String(event.gid), groupNames.get(event.gid) || event.gid]));
  control.replaceChildren(new Option('全部群聊', ''), ...[...groups]
    .sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'))
    .map(([id, name]) => new Option(name === id ? `群 ${id.slice(0, 8)}` : name, id)));
  if (groups.has(current)) control.value = current;
}

function eventRow(event) {
  const participants = [event.person, event.target !== event.person ? event.target : ''].filter(Boolean).join(' → ');
  const preview = event.category === 'emotion' ? '' : event.result || event.progress;
  return `<li><button type="button" class="event-item" data-event-id="${esc(event.id)}" ${event.id === selected ? 'aria-current="true"' : ''}>
    <span class="event-item-heading"><strong>${esc(event.title)}</strong><span class="event-pill" data-tone="${event.category}">${esc(event.state)}</span></span>
    <span class="event-item-meta">${esc([participants, event.group && groupLabel(event)].filter(Boolean).join(' · '))}</span>
    <span class="event-item-meta">${esc([event.dueAt ? `约定 ${event.dueAt}` : time(event.updatedAt), event.legacy ? '旧版记录' : ''].filter(Boolean).join(' · '))}</span>
    ${preview ? `<span class="event-item-preview">${esc(preview)}</span>` : ''}
  </button></li>`;
}

function groupLabel(event) {
  return event.group === event.gid && event.gid ? `群 ${event.gid.slice(0, 8)}` : event.group || '未记录';
}

function timelineLabel(entry) {
  if (entry.kind === 'start') return '首次记录';
  if (entry.kind === 'progress') return '更新进展';
  if (entry.kind === 'ask') return '小易追问';
  if (entry.reason === 'expired') return '到期结束';
  if (entry.reason === 'superseded') return '被新事项替代';
  if (entry.reason === 'manual') return entry.status === 'done' ? '手动标记完成' : '手动放弃跟进';
  if (entry.outcomeKind === '失败') return '结束 · 未成功';
  return entry.status === 'done' ? '完成' : '放弃';
}

function detailField(label, value) {
  return `<div><dt>${label}</dt><dd>${esc(value || '未记录')}</dd></div>`;
}

function renderDetail(event) {
  const detail = $('eventDetail');
  if (!event) {
    detail.innerHTML = '<div class="event-empty">没有可查看的事件</div>';
    return;
  }
  const emotion = event.category === 'emotion';
  const actions = emotion ? '' : event.rawStatus === 'open' ? `
    <button type="button" class="small ghost" data-event-status="dropped">放弃</button>
    <button type="button" class="small event-complete" data-event-status="done">标记完成</button>`
    : event.canReopen ? `<button type="button" class="small ghost" data-event-status="open">重新打开</button>` : '';
  const current = event.result || event.progress;
  const activity = event.timeline.map(entry => `<li data-event-kind="${esc(entry.kind)}">
    <div class="event-entry-heading"><strong>${timelineLabel(entry)}</strong><span>${esc(time(entry.at))}</span></div>
    ${entry.person && entry.kind !== 'ask' ? `<div class="event-entry-person">${esc(entry.person)}</div>` : ''}
    ${entry.evidence ? `<p>${esc(entry.evidence)}</p>` : ''}
  </li>`).join('');
  detail.innerHTML = `
    <button type="button" class="small ghost event-back" data-event-back>‹ 返回列表</button>
    <div class="event-detail-head">
      <div class="event-detail-title">
        <div class="event-detail-tags"><span class="event-pill" data-tone="${event.category}">${esc(event.state)}</span>${event.timing ? `<span>${esc(event.timing)}</span>` : ''}${event.legacy ? '<span>旧版记录</span>' : ''}</div>
        <h2 id="eventDetailTitle" tabindex="-1">${esc(event.title)}</h2>
      </div>
      ${actions ? `<div class="event-actions">${actions}</div>` : ''}
    </div>
    <dl class="event-fields">
      ${detailField(emotion || event.legacy ? '发言人' : '提出人', event.person)}
      ${emotion ? '' : detailField('跟进对象', event.target && event.target === event.person ? `${event.target}（本人）` : event.target)}
      ${emotion ? '' : detailField('事项对象', event.object)}
      ${detailField('群聊', groupLabel(event))}
      ${detailField('首次记录', time(event.startedAt))}
      ${emotion ? '' : detailField('持续时间', eventDuration(event.duration)) + detailField('约定日期', event.dueAt || '未约定')}
      ${event.endedAt && !emotion ? detailField('结束时间', time(event.endedAt)) : ''}
    </dl>
    ${emotion ? '' : `<section class="event-progress">
      <h3>${event.result ? '结算结果' : '当前进展'}</h3><p>${esc(current || '暂无进展记录')}</p>
      <span>确认追问 ${event.askCount} 次${event.unverifiedAskCount ? ` · 旧版提示 ${event.unverifiedAskCount} 次，发送未核实` : ''}</span>
    </section>`}
    <section class="event-activity">
      <h3>${emotion ? '发言记录' : '事件经过'}</h3><ol>${activity}</ol>
    </section>`;
  for (const action of detail.querySelectorAll('[data-event-status]')) action.disabled = updating;
}

function render({ focusDetail = false } = {}) {
  const group = $('eventGroup').value;
  const query = $('eventQuery').value;
  const now = Date.now();
  const matching = events.filter(event => !group || event.gid === group)
    .map(event => presentEvent(event, groupNames.get(event.gid), now))
    .filter(event => matchesEvent(event, query));
  const lists = new Map(filters.map(([key]) => [key, []]));
  for (const event of matching) {
    lists.get(event.category).push(event);
    if (event.category !== 'emotion') lists.get('all').push(event);
  }
  const visible = lists.get(filter).sort((a, b) =>
    (filter === 'active' ? Number(a.legacy) - Number(b.legacy) : 0) || b.updatedAt - a.updatedAt);
  const label = filters.find(([key]) => key === filter)[1];
  if (!visible.some(event => event.id === selected)) {
    selected = visible[0]?.id ?? '';
    delete $('eventsWorkspace').dataset.inspecting;
  }

  for (const button of $('eventFilters').querySelectorAll('button')) {
    const key = button.dataset.eventFilter;
    button.setAttribute('aria-pressed', String(key === filter));
    button.querySelector('span').textContent = lists.get(key).length;
  }
  $('eventIndexTitle').textContent = label;
  $('eventCount').textContent = `${visible.length} 条`;
  $('eventList').innerHTML = visible.length ? visible.map(eventRow).join('') : `<li class="event-empty">${query || group
    ? '当前筛选下没有事件' : filter === 'active' ? '目前没有待跟进事项' : '这里还没有记录'}</li>`;
  renderDetail(visible.find(event => event.id === selected));
  if (focusDetail) $('eventDetailTitle')?.focus();
}

export async function showEventsPage() {
  if (reading || updating) return;
  reading = true;
  $('btnReloadEvents').disabled = true;
  showMessage('正在读取事件…');
  try {
    const [snapshot, directory] = await Promise.all([
      api('/api/events'),
      api('/api/groups').catch(() => null),
    ]);
    if (directory) groupNames = new Map((directory.groups ?? []).map(group => [String(group.id), String(group.name ?? '')]));
    events = (snapshot.events ?? []).filter(event => event && typeof event.id === 'string');
    renderGroupOptions();
    render();
    showMessage('');
  } catch (error) {
    showMessage(`读取失败：${error.message}`, true);
  } finally {
    reading = false;
    $('btnReloadEvents').disabled = false;
  }
}

async function updateEvent(status) {
  if (!selected || updating || reading) return;
  const id = selected;
  updating = true;
  for (const action of $('eventDetail').querySelectorAll('[data-event-status]')) action.disabled = true;
  showMessage('正在更新事件…');
  try {
    await api('/api/events/update', { method: 'POST', body: JSON.stringify({ id, status }) });
    if (selected === id) {
      filter = status === 'open' ? 'active' : 'closed';
      const event = events.find(item => item.id === id);
      if (event && status === 'open') filter = presentEvent({ ...event, status, closedAt: undefined, closeReason: undefined }).category;
    }
    updating = false;
    await showEventsPage();
  } catch (error) {
    updating = false;
    showMessage(`更新失败：${error.message}`, true);
    render({ focusDetail: true });
  }
}

export function initEventsPage() {
  $('eventFilters').innerHTML = filters.map(([key, label]) => `<button type="button" data-event-filter="${key}" aria-pressed="${key === filter}">${label}<span>0</span></button>`).join('');
  $('btnReloadEvents').onclick = showEventsPage;
  $('eventGroup').onchange = () => render();
  $('eventQuery').oninput = () => render();
  $('eventFilters').onclick = event => {
    const key = event.target.closest('[data-event-filter]')?.dataset.eventFilter;
    if (!key) return;
    filter = key;
    delete $('eventsWorkspace').dataset.inspecting;
    $('eventList').scrollTop = 0;
    render();
  };
  $('eventList').onclick = event => {
    const id = event.target.closest('[data-event-id]')?.dataset.eventId;
    if (!id) return;
    selected = id;
    $('eventsWorkspace').dataset.inspecting = 'true';
    render({ focusDetail: true });
  };
  $('eventDetail').onclick = event => {
    if (event.target.closest('[data-event-back]')) {
      delete $('eventsWorkspace').dataset.inspecting;
      $('eventList').querySelector('[aria-current="true"]')?.focus();
    }
    const status = event.target.closest('[data-event-status]')?.dataset.eventStatus;
    if (status) void updateEvent(status);
  };
}

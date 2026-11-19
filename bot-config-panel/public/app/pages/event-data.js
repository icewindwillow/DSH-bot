const DAY = 86_400_000;
const text = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
const at = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;

export function readableEventText(value) {
  return text(value).replace(/<faceType=[^>]*>|<mface[^>]*>/gi, '').trim();
}

function expiryOf(event) {
  const start = at(event.createdAt);
  if (!start) return 0;
  const due = event.followupMode === 'scheduled' ? Date.parse(`${event.dueAt}T00:00:00+08:00`) : NaN;
  if (Number.isFinite(due)) return due + 3 * DAY;
  return Math.max(start, at(event.lastProgressAt)) + (event.kind === 'long' ? 60 : 3) * DAY;
}

function timelineOf(event, person) {
  const entries = Array.isArray(event.history) ? event.history.filter(entry => entry && typeof entry === 'object') : [];
  const timeline = entries.map(entry => ({ ...entry, evidence: readableEventText(entry.evidence) }));
  if (!timeline.some(entry => entry.kind === 'progress') && (event.progressEvidence || event.lastProgressAt)) {
    timeline.push({ kind: 'progress', at: event.lastProgressAt, person: event.progressPerson, evidence: readableEventText(event.progressEvidence) });
  }
  if (!timeline.some(entry => entry.kind === 'ask') && event.lastAskEvidence) {
    timeline.push({ kind: 'ask', at: event.lastAskAt, person: '小易', evidence: readableEventText(event.lastAskEvidence) });
  }
  if (event.closedAt && !timeline.some(entry => entry.kind === 'close' && entry.at === event.closedAt)) {
    timeline.push({ kind: 'close', at: event.closedAt, status: event.status, reason: event.closeReason, outcomeKind: event.outcomeKind,
      person: event.resultPerson, evidence: readableEventText(event.resultEvidence) });
  }
  timeline.push({ kind: 'start', at: event.createdAt, person, evidence: readableEventText(event.evidence) });
  return timeline.sort((a, b) => at(a.at) - at(b.at));
}

export function presentEvent(event, groupName, now = Date.now()) {
  const emotion = event.type === 'emotion';
  const expiry = emotion ? 0 : expiryOf(event);
  const ended = event.status === 'done' || event.status === 'dropped' || (expiry > 0 && expiry <= now);
  const category = emotion ? 'emotion' : ended ? 'closed' : event.followupMode === 'none' ? 'inactive' : 'active';
  const state = emotion ? `情绪 · ${event.emotion || '其他'}`
    : event.status === 'done' ? (event.outcomeKind === '失败' ? '已结束 · 未成功' : '已完成')
      : event.closeReason === 'superseded' ? '已替代'
        : event.closeReason === 'expired' || (event.status === 'open' && ended) ? '已过期'
          : event.status === 'dropped' ? '已放弃'
            : category === 'inactive' ? '不跟进' : '进行中';
  const person = text(event.sourcePerson) || text(event.person);
  const target = !emotion && ['soon', 'scheduled'].includes(event.followupMode) ? text(event.person) : '';
  const timeline = timelineOf(event, person);
  const latestProgress = timeline.findLast(entry => entry.kind === 'progress')?.evidence || '';
  const end = ended ? at(event.closedAt) || (event.status === 'open' ? expiry : 0) : now;
  return {
    id: event.id, rawStatus: event.status, category, state, timeline, person, target,
    legacy: !emotion && event.followupMode == null,
    canReopen: event.status !== 'open' && (!expiry || expiry > now),
    gid: text(event.gid), group: groupName || text(event.gid), object: text(event.object),
    title: readableEventText(event.title) || readableEventText(event.evidence) || (emotion ? state : '未命名事项'),
    duration: at(event.createdAt) && end ? Math.max(0, end - at(event.createdAt)) : null,
    startedAt: at(event.createdAt), endedAt: ended ? end : 0, dueAt: text(event.dueAt),
    updatedAt: Math.max(...timeline.map(entry => at(entry.at)), at(event.lastMentionedAt)),
    timing: emotion ? '' : event.followupMode === 'scheduled' ? '定期' : event.kind === 'long' ? '长期' : '近期',
    progress: latestProgress,
    result: readableEventText(event.resultEvidence),
    askCount: Number(event.verifiedAskCount) || 0,
    unverifiedAskCount: Math.max(0, (Number(event.askedCount) || 0) - (Number(event.verifiedAskCount) || 0)),
  };
}

export function matchesEvent(event, query) {
  const terms = text(query).toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const content = [event.title, event.person, event.target, event.object, event.group, event.state,
    ...event.timeline.flatMap(entry => [entry.evidence, entry.person])].filter(Boolean).join(' ').toLocaleLowerCase();
  return terms.every(term => content.includes(term));
}

export function eventDuration(ms) {
  if (ms === null) return '未记录';
  const minutes = Math.floor(ms / 60_000);
  if (minutes === 0) return '不足 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ''}`;
  return `${Math.floor(hours / 24)} 天${hours % 24 ? ` ${hours % 24} 小时` : ''}`;
}

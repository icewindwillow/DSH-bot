import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const hint = '可以用 /dsh list [工作区] 看正在推进的任务对话，/dsh watch SIMDM 盯任务，或用 /dsh send SIMDM "会话名" -- 消息内容 给已有会话发消息。';
const undecorate = text => text.trim().replace(/^(?:「(.+)」|"(.+)")$/, (_, a, b) => a ?? b);
const taskWorkspacePattern = /([^\s，,。！!]{1,40})\s*的?\s*工作区/gu;

export function isTaskConversationQuery(input) {
  const text = String(input ?? '').trim();
  if (!text) return false;
  const look = /(?:看一下|看看|查一下|查查|列一下|列出|看下)/u.test(text);
  const task = /(?:任务对话|任务会话|正在推进的任务|在推进的任务|在跑的任务|运行中的任务|会话列表)/u.test(text);
  const workspace = /工作区/u.test(text)
    && /(?:还在|是否|继续|推进|在跑|运行中|运行|状态|进展)/u.test(text);
  const taskProgress = /(?:任务对话|任务会话)/u.test(text)
    && /(?:推进|在跑|运行中|进行中)/u.test(text);
  return (look && (task || workspace)) || taskProgress;
}

function taskConversationWorkspace(input) {
  const matches = [...String(input ?? '').matchAll(taskWorkspacePattern)];
  const name = matches.at(-1)?.[1]?.trim().replace(/的$/u, '');
  return name ? undecorate(name) : '';
}

export function parseOwnerAction(input) {
  const plainChoice = /^选\s*(?:([a-f\d]{8})\s+)?(\d{1,2})$/i.exec(input);
  const commandChoice = /^\/dsh\s+choose\s+(?:([a-f\d]{8})\s+)?(\d{1,2})$/i.exec(input);
  const choice = commandChoice ?? plainChoice;
  if (choice) return { operation: 'choose', selection: choice[1]?.toLowerCase(), number: Number(choice[2]), allowFallback: !!plainChoice };
  const list = /^\/dsh\s+list(?:\s+([\s\S]+))?$/i.exec(input);
  if (list) return { operation: 'list', workspace: undecorate(list[1] ?? '') };
  if (isTaskConversationQuery(input)) return { operation: 'list', workspace: taskConversationWorkspace(input) };
  const watch = /^\/dsh\s+watch\s+(.+)$/i.exec(input);
  if (watch) return { operation: 'watch', workspace: undecorate(watch[1]) };
  const send = /^\/dsh\s+send\s+([\s\S]+?)\s+--\s+([\s\S]+)$/i.exec(input);
  if (send) {
    const args = send[1].match(/"([^"]+)"|「([^」]+)」|(\S+)/g) ?? [];
    if (args.length === 1 || args.length === 2) {
      const [workspace, session] = args.map(undecorate);
      return { operation: 'send', workspace, session, text: send[2].trim() };
    }
    return { operation: 'help' };
  }
  if (/^\/dsh\s+(watch|send|choose)(?:\s|$)/i.test(input)) return { operation: 'help' };
  const named = /^小易[，,、：:\s]*/.exec(input);
  if (!named) return;
  const body = input.slice(named[0].length);
  const listen = /^(?:帮我)?盯(?:一下|着|住)?\s*(.+?)\s*(?:工作区\s*)?(?:[里中]\s*的?|的)\s*(?:正在跑的|在跑的|运行中的|当前的?)?\s*(?:任务|会话)(?:[，,。！!].*|\s*结束了叫我[。！!]?)?$/u.exec(body);
  if (listen) return { operation: 'watch', workspace: undecorate(listen[1]) };
  const message = /^给\s*(.+?)(?:\s*工作区)?(?:[里中])?的\s*(?:「([^」]+)」(?:会话)?|"([^"]+)"(?:会话)?|任务|会话)\s*(?:发消息|发一句|留言)\s*[：:]\s*([\s\S]+)$/u.exec(body);
  if (message) return { operation: 'send', workspace: undecorate(message[1]), session: message[2] ?? message[3], text: message[4].trim() };
}

function describe(body) {
  const target = body.target && `「${body.target.workspace}」的「${body.target.title}」`;
  switch (body.status) {
    case 'list': {
      if (!body.targets?.length) return '当前没有正在推进的任务对话。';
      const lines = body.targets.map((item, index) => {
        const status = item.running ? '运行中' : '最近活动';
        const excerpt = item.excerpt ? `\n   ${item.excerpt}` : '';
        return `${index + 1}. ${item.workspace} / ${item.title} · ${status}${excerpt}`;
      });
      const heading = body.runningOnly === false
        ? '当前没有运行中的任务对话，最近活跃：'
        : '当前在推进的任务对话：';
      return [heading, ...lines, body.more ? '只列了前 8 个，可以指定工作区再查。' : '']
        .filter(Boolean).join('\n');
    }
    case 'forbidden': return '这个操作只有主人可以使用。';
    case 'watching': return `我在盯${target}当前这一轮。需要审批或这一轮结束时，我会私聊提醒你。`;
    case 'already-finished': return `${target}这一轮的监听已经结束。`;
    case 'sent': return `消息已交给${target}。如果那边正在跑，会按 DSH 的队列接收。`;
    case 'choose': return [
      '有多个会话，回复「选 1」之类的序号。',
      ...body.choices.map((choice, i) => `${i + 1}. ${choice.title}${choice.running ? '（运行中）' : ''}`),
      `如有多个待选列表，请回复「选 ${body.code} 序号」。${body.more ? '这里列了前 8 项，也可以带上会话名重发指令。' : ''}`,
    ].join('\n');
    case 'choose-code': return `有多个待选列表，请回复「选 列表码 序号」。列表码：${body.codes.join('、')}`;
    case 'invalid-choice': return '这个序号不在列表里，再选一次吧。';
    case 'no-choice': return '这份列表已过期，请重发原指令。';
    case 'workspace-ambiguous': return `匹配到几个工作区，请用完整名称：${body.names.join('、')}。`;
    case 'workspace-missing': return '我找不到这个可用工作区。如果在用个人技能，先用 /dsh 发一个任务，再用「我的工作区」查询。';
    case 'no-running': return '这个工作区里现在没有正在跑的会话。';
    case 'no-session': return '这个工作区里找不到符合条件的会话。';
    case 'stale-session': return '这个会话已从工作区移除或归档，请重新选择。';
    case 'watch-limit': return '现在已经在盯 12 轮任务，等其中一轮结束后再加吧。';
    case 'busy': return 'DSH 侧请求较多，请稍后再试。';
    default: return hint;
  }
}

export async function handleOwnerAction(action, { bridge, actor, messageId, reply, next, render }) {
  if (action.operation === 'help') return reply(hint);
  const id = createHash('sha256').update(JSON.stringify([actor.sender, 'owner-actions', messageId])).digest('hex').slice(0, 24);
  let body;
  try {
    const path = action.operation === 'choose' ? '/owner/choose' : '/owner/actions';
    ({ body } = await bridge('POST', path, actor, { ...action, id }));
  } catch {
    return reply('暂时连不上 DSH 桌面，请稍后再试。');
  }
  if (action.allowFallback && body.status === 'no-choice') return next();
  if (body.status === 'host-error') return reply('DSH 暂时无法处理这个请求，请在桌面确认会话状态。');
  const text = describe(body);
  if (body.status === 'list' && typeof render === 'function') {
    try {
      const rendered = await render(text);
      if (typeof rendered === 'string' && rendered.trim()) return reply(rendered);
    }
    catch { /* 人格渲染失败时回退到确定性列表 */ }
  }
  return reply(text);
}

const notices = {
  approval: '正在等你审批，请打开 DSH 桌面处理。',
  done: '这一轮已完成。',
  failed: '这一轮失败了，请在 DSH 桌面查看。',
  cancelled: '这一轮已取消。',
  unavailable: '这一轮的状态已无法读取，请在 DSH 桌面查看。',
  expired: '这次监听已满七天，请在 DSH 桌面查看。',
};
let notifier;

export function startOwnerWatchNotifier({ bot, bridge, loadAccess, logger, intervalMs = 3000 }) {
  notifier?.abort();
  const controller = new AbortController();
  notifier = controller;
  const sent = new Set();
  void (async () => {
    while (!controller.signal.aborted) {
      await delay(intervalMs, undefined, { signal: controller.signal, ref: false });
      try {
        const { owner } = await loadAccess();
        if (!owner) continue;
        const actor = { scope: 'c2c', sender: owner };
        const { body } = await bridge('GET', '/owner/notifications', actor);
        for (const notice of body.notices ?? []) {
          if (controller.signal.aborted || !notices[notice.kind]) break;
          if (notice.recipient && !(await loadAccess()).members?.some(member => member.dmOpenid === notice.recipient)) continue;
          if (!sent.has(notice.id)) {
            await bot.sendText({ scope: 'c2c', targetId: notice.recipient ?? owner }, `DSH「${notice.workspace}」·「${notice.title}」${notices[notice.kind]}`);
            sent.add(notice.id);
          }
          const { code } = await bridge('POST', '/owner/ack', actor, { id: notice.id });
          if (code === 200) sent.delete(notice.id);
          if (sent.size > 64) sent.delete(sent.values().next().value);
        }
      } catch (error) {
        if (!controller.signal.aborted && !['ENOENT', 'ECONNREFUSED', 'ABORT_ERR'].includes(error?.code)) {
          logger?.debug?.('DSH watch notice delivery will retry');
        }
      }
    }
  })().catch(error => { if (error?.name !== 'AbortError') logger?.warn?.('DSH watch notifier stopped'); });
  return () => controller.abort();
}

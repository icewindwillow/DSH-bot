import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAccess, identityHeaders } from './access.mjs';
import { handleOwnerAction, parseOwnerAction, startOwnerWatchNotifier } from './qq-owner-actions.mjs';

const active = new Set(['queued', 'running', 'cancelling']);
const labels = {
  queued: '排队中', running: '运行中，若需要确认请在 DSH 桌面处理',
  cancelling: '正在取消', cancelled: '已取消', done: '已完成',
  'no-result': '已结束，桌面里没有可回传的文字',
  'timed-out': '等待超时，可以在 DSH 桌面查看会话',
  mixed: '这轮还收到了桌面输入，请在 DSH 桌面查看结果',
  failed: '执行失败，请在 DSH 桌面查看会话',
};

function requestBridge(socketPath, method, path, actor, task) {
  return new Promise((resolve, reject) => {
    const body = task ? JSON.stringify(task) : undefined;
    const req = request({
      socketPath, path, method, signal: AbortSignal.timeout(5000),
      headers: { ...identityHeaders(actor), ...(body && { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }) },
    }, async res => {
      try {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        resolve({ code: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) });
      } catch (error) { reject(error); }
    });
    req.on('error', reject);
    req.end(body);
  });
}

function format(job, includeResult = true) {
  return `DSH 任务 ${job.id} · ${labels[job.status] ?? '状态未知'}${includeResult && job.result ? `\n\n${job.result}` : ''}`;
}

export function createOwnerDshMiddleware(bot, {
  socket = process.env.QQBOT_OWNER_DSH_SOCKET,
  owner = process.env.QQBOT_OWNER_DSH_OPENID,
  loadAccess = () => ({ owner }),
  pollMs = 1500,
  watchNotifications = false,
  logger,
} = {}) {
  if (!isAbsolute(socket ?? '')) return (_ctx, next) => next();
  const delivered = new Set();
  const submitting = new Set();
  const bridge = (method, path, actor, body) => requestBridge(socket, method, path, actor, body);
  const hostRequest = (method, id, actor, task) => bridge(method, `/jobs/${id}`, actor, task)
    .then(({ code, body }) => ({ code, job: body }));
  if (watchNotifications) startOwnerWatchNotifier({ bot, bridge, loadAccess, logger });

  return async (ctx, next) => {
    const { message, replyTarget } = ctx;
    const scope = message?.kind;
    if (scope !== 'c2c' && scope !== 'group') return next();
    const sender = message.senderId;
    const group = scope === 'group' ? message.groupOpenid : undefined;
    if (replyTarget?.scope !== scope || replyTarget.targetId !== (group ?? sender) ||
        !message.messageId || message.messageId !== replyTarget.msgId) return next();

    const input = typeof message.content === 'string' ? message.content.trim() : '';
    const command = /^\/dsh(?:\s+([\s\S]+))?$/.exec(input) ??
      (scope === 'group' && /^\/?群技能\s+DSH(?:[\s：:]+([\s\S]+))?$/i.exec(input));
    const natural = scope === 'group'
      ? /(?:^|[。！？!?；;\n])\s*小易[，,、：:\s]*(?:\/?群技能\s+DSH|让我的\s*DSH)(?:[\s：:]+([\s\S]+))?$/i.exec(input)
      : /^小易[，,、：:\s]*让我的\s*DSH\s*([\s\S]+)$/i.exec(input);
    const linkCommand = /^\/dsh\s+link(?:\s+([a-f0-9]{10}))?$/i.exec(input);
    const identityCommand = scope === 'group' && /^\/dsh\s+(?:身份|identity)$/i.test(input);
    const ownerAction = scope === 'c2c' ? parseOwnerAction(input)
      : /^\/dsh\s+(watch|send|choose)(?:\s|$)/i.test(input) && { operation: 'private-only' };
    if (!command && !natural && !ownerAction && !linkCommand) return next();
    const actor = { scope, sender, group };
    if (identityCommand) {
      const target = { scope, targetId: replyTarget.targetId, msgId: replyTarget.msgId };
      try {
        const { code, body } = await bridge('GET', '/owner/group-identity', actor);
        if (code === 200) return bot.sendText(target, `群身份码 ${body.code}。十分钟内有效，请把这条消息发给管理员关联档案。`);
      } catch { /* Retry through chat after the bridge reconnects. */ }
      return bot.sendText(target, '暂时无法取群身份码，请稍后重试。');
    }
    let access;
    try { access = createAccess(await loadAccess()); }
    catch { return; }
    const identity = access.identify(actor);
    if (linkCommand) {
      const target = { scope, targetId: replyTarget.targetId, msgId: replyTarget.msgId };
      if (scope === 'c2c' && identity?.owner) return bot.sendText(target, '主人账号已经可用。');
      try {
        const { body } = await bridge('POST', '/owner/link', actor, { code: linkCommand[1]?.toUpperCase() });
        if (body.status === 'link-code') return bot.sendText(target, `请在已获授权的群里 @小易 发送 /dsh link ${body.code}。五分钟内有效。`);
        if (body.status === 'linked') return bot.sendText(target, '已绑定 DSH 个人技能。用 /dsh 任务内容 就可以开始。');
        if (body.status === 'busy') return bot.sendText(target, '当前绑定请求较多，请过几分钟再试。');
        return bot.sendText(target, '没有匹配到有效绑定。请先在私聊取码，再从已获授权的群发送。');
      } catch { return bot.sendText(target, '暂时连不上 DSH 桌面，请稍后再试。'); }
    }
    if (!identity) return ownerAction?.allowFallback ? next() : undefined;
    const inGroup = scope === 'group';
    const groupOnly = inGroup && !identity.owner;
    const inputTask = (command?.[1] ?? natural?.[1] ?? '').trim();
    const routing = /^--workspace\s+(\S+)\s+([\s\S]+)$/.exec(inputTask);
    const task = routing?.[2]?.trim() ?? inputTask;
    const workspace = routing?.[1];
    const control = !routing && /^(status|cancel|result)\s+([a-f0-9]{24})$/.exec(task);
    const receivedAt = Date.now();
    const target = { scope, targetId: replyTarget.targetId, msgId: replyTarget.msgId };
    const reply = value => bot.sendText(
      Date.now() - receivedAt < 4 * 60_000 ? target : { scope: target.scope, targetId: target.targetId },
      value,
    );
    const privateReply = value => inGroup && !groupOnly
      ? bot.sendText({ scope: 'c2c', targetId: identity.dmOpenid }, value)
      : reply(value);
    if (ownerAction?.operation === 'private-only') return reply(groupOnly
      ? '群里可用 /dsh 任务内容、/dsh status 任务号、/dsh cancel 任务号 和 /dsh result 任务号。'
      : '盯任务和给桌面会话发消息，请私聊我操作。');
    if (ownerAction) return handleOwnerAction(ownerAction, { bridge, actor, messageId: message.messageId, reply, next });
    if (!task || /^(status|cancel|result)(?:\s|$)/.test(task) && !control || inputTask.startsWith('--workspace') && !routing) {
      await reply('用 /dsh 任务内容 下任务。用 /dsh status 任务号 查询，或用 /dsh cancel 任务号 取消。' +
        (identity.owner ? ' 指定成员工作区用 /dsh --workspace 别名 任务内容。'
          : ' 用 /dsh result 任务号 可把任务结果发到当前群。'));
      return;
    }

    if (!access.workspace(identity, workspace)) {
      await privateReply('这个工作区不可用。');
      return;
    }

    if (control) {
      const [, action, id] = control;
      try {
        const { code, job } = await hostRequest(action === 'cancel' ? 'DELETE' : 'GET', id, actor);
        await privateReply(code === 200 ? format(job, !groupOnly || action === 'result')
          : code === 404 ? '当前找不到这个 DSH 任务。' : '当前无法操作这条 DSH 任务。');
      } catch {
        await reply('暂时连不上主人侧 DSH。');
      }
      return;
    }
    if (task.length > 3000) {
      await reply('任务说明最多 3000 字，请精简后再发。');
      return;
    }
    const id = createHash('sha256').update(JSON.stringify([identity.principal, scope, group, message.messageId])).digest('hex').slice(0, 24);
    if (submitting.has(id) || delivered.has(id)) return;
    submitting.add(id);
    let accepted;
    try {
      accepted = await hostRequest('PUT', id, actor, { text: task, workspace });
    } catch {
      submitting.delete(id);
      await reply(`暂时无法确认 DSH 是否收到了任务。可用 /dsh status ${id} 查询。`);
      return;
    }
    if (![200, 202].includes(accepted.code)) {
      submitting.delete(id);
      await reply(accepted.code === 409 ? 'DSH 当前忙，请稍后再交任务。' : 'DSH 没有接收这个任务。');
      return;
    }
    const replyOnce = async job => {
      const activeIdentity = createAccess(await loadAccess()).identify(actor);
      if (!activeIdentity || activeIdentity.principal !== identity.principal || activeIdentity.dmOpenid !== identity.dmOpenid) return;
      const text = format(job, !groupOnly);
      await privateReply(groupOnly && job.result ? `${text}。用 /dsh result ${id} 可在群里查看正文。` : text);
      delivered.add(id);
      if (delivered.size > 128) delivered.delete(delivered.values().next().value);
    };
    // Start observing even if the immediate acknowledgement fails to reach QQ.
    void (async () => {
      let job = accepted.job;
      if (active.has(job.status)) {
        await reply(`我交给 DSH 了。任务号 ${id}${inGroup ? groupOnly ? '，状态会回到本群。' : '，结果回私聊。' : ''}`).catch(() => {});
      }
      const until = Date.now() + 11 * 60_000;
      while (active.has(job.status) && Date.now() < until) {
        await delay(pollMs, undefined, { ref: false });
        const state = await hostRequest('GET', id, actor).catch(() => null);
        if (state?.code === 200) job = state.job;
        if (state?.code === 403) return;
        if (state?.code === 404) {
          await privateReply(`DSH 任务 ${id} 的连接状态已丢失，请在桌面查看。`);
          return;
        }
      }
      await replyOnce(active.has(job.status) ? { id, status: 'timed-out' } : job);
    })().catch(() => logger?.warn?.('owner DSH result delivery failed (%s)', id))
      .finally(() => submitting.delete(id));
  };
}

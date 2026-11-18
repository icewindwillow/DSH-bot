import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { withQqbotProfileDocuments } from './profile-documents.js';
import { createQqbotTaskQueue } from './task-queue.js';

export const name = 'qqbot-core';

export function apply(ctx) {
  const queues = new Set();
  let disposed = false;
  ctx.effect(() => () => {
    disposed = true;
    for (const queue of queues) queue.close();
  });
  // This is the one periodic retention sweep for the installed DSH profile.
  const profile = process.env.QQBOT_PROFILE_DIR ?? ctx.get?.('profileContext')?.dir;
  if (profile) {
    const expire = () => {
      if (!existsSync(join(profile, 'qqbot-documents.sqlite'))) return;
      try { withQqbotProfileDocuments(profile, db => db.expire()); }
      catch (error) { console.warn('[qqbot-core] 保留清理失败:', error.code ?? error.name); }
    };
    ctx.effect(() => {
      expire();
      const timer = setInterval(expire, 60 * 60_000);
      timer.unref?.();
      return () => clearInterval(timer);
    });
  }
  ctx.provide('qqbotCore', {
    queue(options, tracing) {
      if (disposed) throw new Error('qqbot-core is disposed');
      const queue = createQqbotTaskQueue(options, tracing);
      const close = queue.close;
      queue.close = () => { queues.delete(queue); close(); };
      queues.add(queue);
      return queue;
    },
  });
}

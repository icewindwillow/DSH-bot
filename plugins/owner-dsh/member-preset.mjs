import { blenderTool, workspaceTool } from './member-files.mjs';

export const inject = ['tools', 'ownerDshMemberTools'];
export function apply(ctx) {
  ctx.effect(() => ctx.get('tools').restrict({ allow: [workspaceTool, blenderTool] }));
}

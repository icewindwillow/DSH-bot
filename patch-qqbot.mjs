#!/usr/bin/env node
/**
 * patch-qqbot.mjs — @tencent-connect/dsh-qqbot 的按群能力补丁（幂等）
 *
 * 补丁正文放在 ./qqbot-patches/*.js（原样插入，不做模板字面量转义），
 * 本脚本负责聚合预检、定位锚点、替换/追加、导入维护及有备份的事务部署。
 *
 * 补丁一览：
 *   group-mention        白名单群「唤醒词 + 对话窗口」门控，入站探针
 *   group-prompt         按 group_openid 取群聊人设
 *   group-prompt-helper  readGroupPromptOverride()
 *   silent-reply         模型回 [SILENT] 时不下发
 *   people-roster        注入「群成员档案」
 *   people-roster-helper buildPeopleRoster()
 *   role-skills-*        特定角色爱好（按说话人自动启用的角色技能）
 *
 * 用法：
 *   node patch-qqbot.mjs            # 应用 / 更新全部补丁
 *   node patch-qqbot.mjs --check    # 只读检查完整片段；缺失、过时或损坏 exit 2
 *   node patch-qqbot.mjs --plan     # 聚合内存预检 + 临时 .mjs 语法检查，不部署
 *   node patch-qqbot.mjs --only=web-fetch-errors,web-fetch-error-guard,group-rules-helper
 *                                  # 精确选择，不自动添加依赖（按 PATCHES 顺序）
 *   node patch-qqbot.mjs --revert   # 最近有效部署事务，按 hash 验证后恢复真实原件
 *   node patch-qqbot.mjs --revert --backup=<id>  # 指定事务；拒绝 --only
 *
 * --only 调用者负责所需依赖：例如 reply-gate 依赖 group-mention；mood 依赖
 * bot-control，diary 依赖 mood；helper/tool 的依赖也必须已安装或显式选中。
 * 嵌套补丁会保留；依赖锚点无法唯一定位时拒绝整个部署，不自动补装。
 * apply 全部预检成功后才备份/提交，错误 exit 2；逐文件原子 rename，失败回滚。
 * 这不是跨文件单一原子事务，也不承诺断电恢复；备份 manifest 保留恢复依据。
 * 默认绝不初始化或覆盖技能、JSON、凭据及运行数据，初始化由独立脚本负责。
 * 插件升级 / 重装 profile 会覆盖 dist，重跑本脚本即可。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmdirSync, realpathSync, statSync, renameSync, unlinkSync, openSync, closeSync, readdirSync, chmodSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNIPPETS = join(HERE, 'qqbot-patches');

const PROFILE_DIR =
  process.env.QQBOT_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'qqbot');
const PKG = join(PROFILE_DIR, 'node_modules', '@tencent-connect', 'dsh-qqbot', 'dist');

/** 每条补丁：文件 + 片段名 + 锚点（行数组，按 \n 连接）+ 是否需要 node:fs 导入 */
const PATCHES = [
  {
    name: 'error-log',
    file: join(PKG, 'gateway', 'middleware-setup.js'),
    snippet: 'error-log.js',
    anchor: [
      '    bot.use(errorHandler());',
    ],
    needsFs: false,
  },
  {
    name: 'group-mention',
    file: join(PKG, 'gateway', 'middleware-setup.js'),
    snippet: 'group-mention.js',
    anchor: [
      '    // 5. 群聊 @bot 门控',
      '    bot.use(mentionGate({',
      '        requireMentionInGroup: config.requireMention,',
      '    }));',
    ],
    needsFs: true,
  },
  {
    name: 'prompt-record-lookup',
    file: join(PKG, 'session', 'session-manager.js'),
    snippet: 'prompt-record-lookup.js',
    anchor: [
      '            const record = this.findByAgent(context.agent);',
    ],
    needsFs: true,
  },
  {
    name: 'memory-scope',
    file: join(PKG, 'session', 'session-manager.js'),
    snippet: 'memory-scope.js',
    anchor: [
      '        this.sessions.set(key, record);',
    ],
    needsFs: false,
  },
  {
    name: 'ltm-scope',
    file: process.env.LTM_PATCH_FILE ?? join(PROFILE_DIR, 'node_modules', '@tr1v3r', 'dsh-ltm', 'dist', 'index.js'),
    snippet: 'ltm-scope.js',
    anchor: [
      '\tfunction activeScope(scope) {',
      '\t\tif (!config.autoProjectScope) return config.defaultScope;',
      '\t\treturn resolveProjectScope(cwdFromAgentScope(scope), config.defaultScope).scope;',
      '\t}',
    ],
    needsFs: false,
  },
  {
    name: 'ltm-write-guard',
    file: process.env.LTM_PATCH_FILE ?? join(PROFILE_DIR, 'node_modules', '@tr1v3r', 'dsh-ltm', 'dist', 'index.js'),
    snippet: 'ltm-write-guard.js',
    anchor: null,
    needsFs: false,
  },
  {
    name: 'ltm-guard-write',
    file: process.env.LTM_PATCH_FILE ?? join(PROFILE_DIR, 'node_modules', '@tr1v3r', 'dsh-ltm', 'dist', 'index.js'),
    snippet: 'ltm-guard-write.js',
    anchor: [
      '\t\tmemory_write(args) {',
    ],
    needsFs: false,
  },
  {
    name: 'ltm-guard-forget',
    file: process.env.LTM_PATCH_FILE ?? join(PROFILE_DIR, 'node_modules', '@tr1v3r', 'dsh-ltm', 'dist', 'index.js'),
    snippet: 'ltm-guard-forget.js',
    anchor: [
      '\t\tmemory_forget(args) {',
    ],
    needsFs: false,
  },
  {
    name: 'ltm-guard-update',
    file: process.env.LTM_PATCH_FILE ?? join(PROFILE_DIR, 'node_modules', '@tr1v3r', 'dsh-ltm', 'dist', 'index.js'),
    snippet: 'ltm-guard-update.js',
    anchor: [
      '\t\tmemory_update(args) {',
    ],
    needsFs: false,
  },
  {
    name: 'ltm-guard-merge',
    file: process.env.LTM_PATCH_FILE ?? join(PROFILE_DIR, 'node_modules', '@tr1v3r', 'dsh-ltm', 'dist', 'index.js'),
    snippet: 'ltm-guard-merge.js',
    anchor: [
      '\t\tmemory_merge(args) {',
    ],
    needsFs: false,
  },
  {
    name: 'skeleton-person',
    file: join(PKG, 'gateway', 'middleware-setup.js'),
    snippet: 'skeleton-person.js',
    anchor: null,
    needsFs: true,
  },
  {
    name: 'people-store-mw',
    file: join(PKG, 'gateway', 'middleware-setup.js'),
    snippet: 'people-store.js',
    anchor: null,
    needsFs: true,
  },
  {
    name: 'affinity-tick',
    file: join(PKG, 'gateway', 'middleware-setup.js'),
    snippet: 'affinity-tick.js',
    anchor: null,
    needsFs: true,
  },
  {
    name: 'group-prompt',
    file: join(PKG, 'session', 'session-manager.js'),
    snippet: 'group-prompt.js',
    anchor: [
      "            const prompt = record.scope === 'group' ? this.config.groupPrompt : this.config.directPrompt;",
    ],
    needsFs: false,
  },
  {
    name: 'group-prompt-helper',
    file: join(PKG, 'session', 'session-manager.js'),
    snippet: 'group-prompt-helper.js',
    anchor: null,
    needsFs: true,
  },
  {
    name: 'group-rules-helper',
    file: join(PKG, 'session', 'session-manager.js'),
    snippet: 'group-rules-helper.js',
    anchor: null,
    needsFs: true,
  },
  {
    name: 'people-store-main',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'people-store.js',
    anchor: null,
    needsFs: true,
  },
  {
    name: 'profile-tools-helper',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'profile-tools-helper.js',
    anchor: null,
    needsFs: true,
  },
  {
    name: 'sticker-tool-helper',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'sticker-tool-helper.js',
    anchor: null,
    needsFs: true,
  },
  {
    name: 'social-engine-helper',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'social-engine-helper.js',
    anchor: null,
    needsFs: true,
  },
  {
    name: 'social-judge-helper',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'social-judge-helper.js',
    anchor: null,
    needsFs: false,
  },
  {
    name: 'social-judge-hook',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'social-judge-hook.js',
    anchor: [
      '        await handleInbound(mCtx, manager, config, logger);',
    ],
    needsFs: false,
  },
  {
    name: 'auto-sticker-helper',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'auto-sticker-helper.js',
    anchor: null,
    needsFs: false,
  },
  {
    name: 'tts-tool-helper',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'tts-tool-helper.js',
    anchor: null,
    needsFs: false,
  },
  {
    name: 'filler-openers',
    file: join(PKG, 'transport', 'outbound.js'),
    snippet: 'filler-openers.js',
    anchor: null,
    needsFs: false,
  },
  {
    name: 'stale-draft',
    file: join(PKG, 'transport', 'outbound.js'),
    snippet: 'stale-draft.js',
    anchor: null,
    needsFs: false,
  },
  {
    name: 'turn-start',
    file: join(PKG, 'transport', 'outbound.js'),
    snippet: 'turn-start.js',
    anchor: [
      '            case \'turn/end\':',
      '                this.onTurnEnd(session.header.id, record, event);',
      '                break;',
    ],
    needsFs: false,
  },
  {
    name: 'model-aware-search-inject',
    file: join(PKG, 'index.js'),
    snippet: 'model-aware-search-inject.js',
    anchor: ["export const inject = ['agents'];"],
    needsFs: false,
  },
  {
    name: 'model-aware-search-helper',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'model-aware-search-helper.js',
    anchor: null,
    needsFs: false,
  },
  {
    name: 'model-aware-fetch-helper',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'model-aware-fetch-helper.js',
    anchor: null,
    needsFs: false,
  },
  {
    name: 'model-aware-search',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'model-aware-search.js',
    anchor: ['    const manager = new SessionManager(ctx, agents, config, logger);'],
    needsFs: false,
  },
  {
    name: 'memory-gate-helper',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'memory-gate-helper.js',
    anchor: null,
    needsFs: false,
  },
  {
    name: 'memory-summary-helper',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'memory-summary-helper.js',
    anchor: null,
    needsFs: false,
  },
  {
    name: 'hook-judge-helper',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'hook-judge-helper.js',
    anchor: null,
    needsFs: false,
  },
  {
    name: 'reply-gate-helper',
    file: join(PKG, 'gateway', 'middleware-setup.js'),
    snippet: 'reply-gate-helper.js',
    anchor: null,
    needsFs: false,
  },
  {
    name: 'reply-gate',
    file: join(PKG, 'gateway', 'middleware-setup.js'),
    snippet: 'reply-gate.js',
    anchor: [
      '    bot.use(mentionGate({',
      '        requireMentionInGroup: config.requireMention,',
      '        isImplicitMention: (ctx) => {',
      '            const msg = ctx.message;',
      '            if (msg.kind !== \'group\' || !msg.groupOpenid)',
      '                return false;',
      '            try {',
      '                return decideGroupImplicit(msg.groupOpenid, msg.content);',
      '            }',
      '            catch (err) {',
      '                // 门控本身不能把整条消息搞挂：异常时放行，交给回话门控和模型判断',
      '                console.log(`[im-qqbot] 门控判定异常: ${err && err.stack ? err.stack : err}`);',
      '                return true;',
      '            }',
      '        },',
      '    }));',
    ],
    needsFs: false,
  },
  {
    name: 'bot-reply-stamp',
    file: join(PKG, 'transport', 'outbound.js'),
    snippet: 'bot-reply-stamp.js',
    anchor: [
      '                await this.bot.sendMarkdown(record.replyTarget, chunk);',
    ],
    needsFs: false,
  },
  {
    name: 'subject-judge-helper',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'subject-judge-helper.js',
    anchor: null,
    needsFs: false,
  },
  {
    name: 'transient-errors',
    file: join(PKG, 'transport', 'outbound.js'),
    snippet: 'transient-errors.js',
    anchor: null,
    needsFs: false,
  },
  {
    name: 'transient-error-guard',
    file: join(PKG, 'transport', 'outbound.js'),
    snippet: 'transient-error-guard.js',
    anchor: [
      '        if (failure !== undefined && !SILENT_TURN_ERROR_CODES.has(failure.code)) {',
      '            void this.send(record, `⚠️ 本轮异常结束\\n\\`${failure.code}\\`: ${failure.message}`, \'sendTurnEndError\');',
      '        }',
    ],
    needsFs: false,
  },
  {
    name: 'web-fetch-errors',
    file: join(PKG, 'transport', 'outbound.js'),
    snippet: 'web-fetch-errors.js',
    anchor: null,
    needsFs: false,
  },
  {
    name: 'web-fetch-error-guard',
    file: join(PKG, 'transport', 'outbound.js'),
    snippet: 'web-fetch-error-guard.js',
    anchor: [
      '        if (call === undefined)',
      '            return;',
      '        if (event.error === undefined && !this.config.showToolResults)',
      '            return;',
    ],
    needsFs: false,
  },
  {
    name: 'action-limiter',
    file: join(PKG, 'transport', 'outbound.js'),
    snippet: 'action-limiter.js',
    anchor: null,
    needsFs: false,
  },
  {
    name: 'ws-logging',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'ws-logging.js',
    anchor: [
      '    logger.info(`QQBot SDK initialized (UA: ${userAgent})`);',
    ],
    needsFs: false,
  },
  {
    name: 'reminder-target',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'reminder-target.js',
    anchor: [
      '    bot.on(\'message\', async (mCtx) => {',
      '        const msg = mCtx.message;',
    ],
    needsFs: false,
  },
  {
    name: 'reminders',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'reminders.js',
    anchor: [
      '    // ── 中间件链 ──',
      '    setupMiddlewares(bot, config, manager, logger);',
    ],
    needsFs: false,
  },
  {
    name: 'reminders-helper',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'reminders-helper.js',
    anchor: null,
    needsFs: true,
  },
  {
    name: 'command-owner-helper',
    file: join(PKG, 'gateway', 'middleware-setup.js'),
    snippet: 'command-owner-helper.js',
    anchor: null,
    needsFs: true,
  },
  {
    name: 'command-owner-gate',
    file: join(PKG, 'gateway', 'middleware-setup.js'),
    snippet: 'command-owner-gate.js',
    anchor: [
      '    const slash = slashCommand({',
      '        // 关闭 autoHelp：help 命令由 qqbot 注册为 /bot-help，',
      '        // 避免 SDK 再自动注册一个无前缀的 /help 造成重复',
      '        autoHelp: false,',
      '        commands: buildCommandList({ manager, config }),',
      '    });',
      '    bot.use(slash.middleware);',
    ],
    needsFs: true,
  },
  {
    name: 'compact-resume',
    file: join(PKG, 'commands', 'session.js'),
    snippet: 'compact-resume.js',
    anchor: [
      '            const outcome = await manager.compact(scope, peerId);',
    ],
    needsFs: false,
  },
  {
    name: 'auto-compact',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'auto-compact.js',
    anchor: [
      '    // 提醒功能：注册 set_reminder / list_reminders / cancel_reminder 三个工具，',
      '    // 并起一个 20 秒轮询的定时器，到点用主动消息发到当初那个会话。',
      '    setupReminders(ctx, bot, manager, config, logger);',
    ],
    needsFs: false,
  },
  {
    name: 'auto-compact-helper',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'auto-compact-helper.js',
    anchor: null,
    needsFs: false,
  },
  {
    name: 'silent-reply',
    file: join(PKG, 'transport', 'outbound.js'),
    snippet: 'silent-reply.js',
    anchor: [
      '    async send(record, text, tag) {',
      '        const chunks = chunkMarkdownText(text, this.config.textChunkLimit);',
    ],
    needsFs: false,
  },
  {
    name: 'people-roster',
    file: join(PKG, 'session', 'session-manager.js'),
    snippet: 'people-roster.js',
    anchor: [
      '            if (!prompt)',
      '                return assembled;',
      '            return {',
      '                ...assembled,',
      "                sections: [...(assembled.sections ?? []), { name: 'qqbot:scope-prompt', order: 90, text: prompt }],",
      '            };',
    ],
    needsFs: false,
  },
  {
    name: 'people-roster-helper',
    file: join(PKG, 'session', 'session-manager.js'),
    snippet: 'people-roster-helper.js',
    anchor: null,
    needsFs: true,
  },
  {
    name: 'role-skills-helper',
    file: join(PKG, 'session', 'session-manager.js'),
    snippet: 'role-skills-helper.js',
    anchor: null,
    needsFs: true,
  },
  {
    name: 'role-skills',
    file: join(PKG, 'session', 'session-manager.js'),
    snippet: 'role-skills.js',
    anchor: [
      '            if (speakerCtx !== \'\')',
      "                extraSections.push({ name: 'qqbot:speaker-context', order: 92, text: speakerCtx });",
    ],
    needsFs: false,
  },
  {
    name: 'role-skills-tool-helper',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'role-skills-tool-helper.js',
    anchor: null,
    needsFs: false,
  },
  {
    name: 'role-skills-tool',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'role-skills-tool.js',
    anchor: [
      '    setupProfileTools(ctx, logger);',
    ],
    needsFs: false,
  },
  {
    name: 'person-feedback-helper',
    file: join(PKG, 'session', 'session-manager.js'),
    snippet: 'person-feedback-helper.js',
    anchor: null,
    needsFs: true,
  },
  {
    name: 'person-feedback',
    file: join(PKG, 'session', 'session-manager.js'),
    snippet: 'person-feedback.js',
    anchor: [
      '            if (roleSkill !== \'\')',
      "                extraSections.push({ name: 'qqbot:role-skill', order: 93, text: roleSkill });",
    ],
    needsFs: false,
  },
  {
    name: 'person-feedback-tool-helper',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'person-feedback-tool-helper.js',
    anchor: null,
    needsFs: true,
  },
  {
    name: 'person-feedback-tool',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'person-feedback-tool.js',
    anchor: [
      '    // 角色爱好技能开关（switch_role_skill）',
      '    setupRoleSkillTools(ctx, logger);',
    ],
    needsFs: false,
  },
  {
    name: 'bot-control-helper',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'bot-control-helper.js',
    anchor: null,
    needsFs: false,
  },
  {
    name: 'bot-control',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'bot-control.js',
    anchor: [
      '    setupTtsTool(ctx, bot, config, logger);',
    ],
    needsFs: false,
  },
  {
    name: 'mood-helper',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'mood-helper.js',
    anchor: null,
    needsFs: false,
  },
  {
    name: 'mood',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'mood.js',
    anchor: [
      '    setupBotControl(ctx, manager, config, logger);',
    ],
    needsFs: false,
  },
  {
    name: 'mood-prompt',
    file: join(PKG, 'session', 'session-manager.js'),
    snippet: 'mood-prompt.js',
    anchor: [
      '                extraSections.push({ name: \'qqbot:person-feedback\', order: 94, text: personFeedback });',
    ],
    needsFs: false,
  },
  {
    name: 'diary-helper',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'diary-helper.js',
    anchor: null,
    needsFs: false,
  },
  {
    name: 'diary',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'diary.js',
    anchor: [
      '    setupMood(ctx, bot, config, logger);',
    ],
    needsFs: false,
  },
  {
    name: 'diary-prompt',
    file: join(PKG, 'session', 'session-manager.js'),
    snippet: 'diary-prompt.js',
    anchor: [
      '                extraSections.push({ name: \'qqbot:mood\', order: 95, text: moodLine });',
    ],
    needsFs: false,
  },
  {
    name: 'interaction-helper',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'interaction-helper.js',
    anchor: null,
    needsFs: false,
  },
  {
    name: 'person-card-helper',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'person-card-helper.js',
    anchor: null,
    needsFs: false,
  },
  {
    name: 'event-helper',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'event-helper.js',
    anchor: null,
    needsFs: false,
  },
  {
    name: 'vector-helper',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'vector-helper.js',
    anchor: null,
    needsFs: false,
  },
  // Dependencies create the next anchor: diary → interaction → person-card → events → vector.
  {
    name: 'interaction',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'interaction.js',
    anchor: [
      '    setupDiary(ctx, logger);',
    ],
    needsFs: false,
  },
  {
    name: 'person-card',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'person-card.js',
    anchor: [
      '    setupInteraction(ctx, bot, config, logger);',
    ],
    needsFs: false,
  },
  {
    name: 'events',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'events.js',
    anchor: [
      '    setupPersonCard(ctx, logger);',
    ],
    needsFs: false,
  },
  {
    name: 'vector',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'vector.js',
    anchor: [
      '    setupEvents(ctx, bot, config, logger);',
    ],
    needsFs: false,
  },
  {
    name: 'media-archive-helper',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'media-archive-helper.js',
    anchor: null,
    needsFs: false,
  },
  {
    name: 'media-archive',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'media-archive.js',
    anchor: [
      '    setupBotControl(ctx, manager, config, logger);',
    ],
    needsFs: false,
  },
  {
    name: 'image-generation-helper',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'image-generation-helper.js',
    anchor: null,
    needsFs: false,
  },
  {
    name: 'image-generation-tool',
    file: join(PKG, 'gateway', 'bootstrap.js'),
    snippet: 'image-generation-tool.js',
    anchor: ['    setupMediaArchive(ctx, bot, manager, config, logger);'],
    needsFs: false,
  },
  {
    name: 'image-generation-inbound',
    file: join(PKG, 'transport', 'inbound.js'),
    snippet: 'image-generation-inbound.js',
    anchor: ['    record.agent.followup(message);'],
    needsFs: false,
  },
  {
    name: 'image-generation-revoke',
    file: join(PKG, 'transport', 'inbound.js'),
    snippet: 'image-generation-revoke.js',
    anchor: ['        await record.agent.whenIdle();'],
    needsFs: false,
  },
];

// Deployment never copies skills, seeds JSON, or touches credentials. Initialize those separately.
const argv = process.argv.slice(2);
const mode = argv.includes('--revert') ? 'revert' : argv.includes('--check') ? 'check' : argv.includes('--plan') ? 'plan' : 'apply';
const onlyArg = argv.find((arg) => arg.startsWith('--only='));
const onlyNames = onlyArg?.slice(7).split(',');
const backupArg = argv.find((arg) => arg.startsWith('--backup='))?.slice(9);
const BACKUPS = join(PROFILE_DIR, '.qqbot-patch-backups');
const LOCK = join(PROFILE_DIR, '.qqbot-patch.lock');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const count = (source, token) => source.split(token).length - 1;
const selected = onlyNames ? PATCHES.filter((patch) => onlyNames.includes(patch.name)) : PATCHES;

function atomicWrite(file, bytes, mode = 0o600) {
  const tmp = `${file}.qqbot-tmp-${randomUUID()}`;
  try {
    writeFileSync(tmp, bytes, { mode, flag: 'wx' });
    chmodSync(tmp, mode);
    renameSync(tmp, file);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}
// Validate every marker in a target, including patches outside --only. Nested
// regions are legitimate: later PATCHES can replace anchors inside earlier ones.
function markerTree(source) {
  const tokens = [...source.matchAll(/\/\* (>>>|<<<) dsh-qqbot-patch:([\w-]+) \1 \*\//g)];
  if (count(source, 'dsh-qqbot-patch:') !== tokens.length) throw new Error('damaged marker syntax');
  const nodes = new Map(), stack = [];
  for (const token of tokens) {
    const [, direction, id] = token;
    if (direction === '>>>') {
      if (nodes.has(id)) throw new Error(`duplicate marker: ${id}`);
      const node = { id, a: token.index, children: [] };
      if (stack.length) stack.at(-1).children.push(node);
      nodes.set(id, node); stack.push(node);
    } else {
      const node = stack.pop();
      if (!node || node.id !== id) throw new Error(`incomplete, reversed or crossed markers: ${id}`);
      node.b = token.index + token[0].length;
    }
  }
  if (stack.length) throw new Error(`incomplete marker: ${stack.at(-1).id}`);
  return nodes;
}
function markerRange(source, snippet, name) {
  const own = markerTree(snippet);
  if (own.size !== 1) throw new Error(`${name}: invalid snippet markers`);
  const node = [...own.values()][0];
  if (node.a !== 0 || node.b !== snippet.length) throw new Error(`${name}: snippet must be enclosed by markers`);
  return markerTree(source).get(node.id);
}
function preserveChildren(snippet, range, source, patch) {
  if (!range) return snippet;
  const children = range.children.map((node) => {
    const definition = PATCHES.find((p) => p.file === patch.file && p.snippet === `${node.id}.js`);
    if (!definition || !definition.anchor) throw new Error(`cannot preserve nested patch: ${node.id}`);
    return { node, definition };
  }).sort((a, b) => PATCHES.indexOf(a.definition) - PATCHES.indexOf(b.definition));
  for (const { node, definition } of children) {
    const anchor = definition.anchor.join('\n');
    if (count(snippet, anchor) !== 1) throw new Error(`nested patch anchor missing or non-unique: ${node.id}`);
    snippet = snippet.replace(anchor, () => source.slice(node.a, node.b));
  }
  return snippet;
}
function fixFsImports(source) {
  const candidates = ['appendFileSync', 'readFileSync', 'writeFileSync', 'existsSync', 'mkdirSync', 'renameSync', 'copyFileSync', 'openSync', 'closeSync', 'unlinkSync', 'statSync'];
  const imports = [...source.matchAll(/^import\s*\{([^}]+)\}\s*from\s*['"]node:fs['"];?\r?\n/gm)];
  const names = new Set(imports.flatMap((m) => m[1].split(',').map((n) => n.trim()).filter(Boolean)));
  // Preserve all existing imports, including aliases and names outside the patch candidates.
  for (const name of candidates) if (new RegExp(`\\b${name}\\s*\\(`).test(source)) names.add(name);
  if (!names.size) return source;
  source = source.replace(/^import\s*\{([^}]+)\}\s*from\s*['"]node:fs['"];?\r?\n/gm, '');
  const line = `import { ${[...names].sort().join(', ')} } from 'node:fs';\n`;
  // A hashbang must remain the first line.
  return source.startsWith('#!') ? source.replace(/^(#![^\n]*\n)/, `$1${line}`) : line + source;
}
function checkSyntax(file, source) {
  // .mjs explicitly selects ESM even for synthetic fixtures without package.json.
  const tempDir = mkdtempSync(join(tmpdir(), 'qqbot-patch-syntax-'));
  const temp = join(tempDir, 'target.mjs');
  try {
    writeFileSync(temp, source, { flag: 'wx', mode: 0o600 });
    const result = spawnSync(process.execPath, ['--check', temp], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error || result.status !== 0)
      throw new Error(`syntax check failed: ${file}\n${result.error?.message ?? result.stderr}`);
  } finally {
    // Both absolute paths were constructed here inside our private mkdtemp directory.
    if (existsSync(temp)) unlinkSync(temp);
    rmdirSync(tempDir);
  }
}
function plan() {
  const files = new Map();
  const problems = [];
  for (const patch of selected) {
    try {
      const file = realpathSync(patch.file);
      if (!statSync(file).isFile()) throw new Error('target is not a regular file');
      let entry = files.get(file);
      if (!entry) {
        const before = readFileSync(file);
        entry = { file, before, source: before.toString('utf8'), mode: statSync(file).mode & 0o777, patches: [] };
        files.set(file, entry);
      }
      let snippet = readFileSync(join(SNIPPETS, patch.snippet), 'utf8').replace(/\n$/, '');
      const range = markerRange(entry.source, snippet, patch.name);
      snippet = preserveChildren(snippet, range, entry.source, patch);
      if (mode === 'check') {
        if (!range || entry.source.slice(range.a, range.b) !== snippet)
          throw new Error('missing or outdated patch');
        console.log(`● ${patch.name}: current`);
      } else if (range) {
        entry.source = entry.source.slice(0, range.a) + snippet + entry.source.slice(range.b);
      } else if (patch.anchor === null) {
        entry.source += `\n${snippet}\n`;
      } else {
        const anchor = patch.anchor.join('\n');
        if (count(entry.source, anchor) !== 1) throw new Error('anchor missing or non-unique; unsupported plugin version');
        entry.source = entry.source.replace(anchor, () => snippet);
      }
      entry.patches.push(patch.name);
    } catch (error) { problems.push(`${patch.name}: ${error.message}`); }
  }
  if (problems.length) throw new Error(problems.join('\n'));
  for (const entry of files.values()) {
    if (mode !== 'check') entry.source = fixFsImports(entry.source);
    markerTree(entry.source);
    // --check is strictly read-only (not even temporary syntax files).
    if (mode !== 'check') checkSyntax(entry.file, entry.source);
    entry.after = Buffer.from(entry.source);
  }
  return [...files.values()];
}
function sameCurrent(entry, expected) {
  if (realpathSync(entry.file) !== entry.file || hash(readFileSync(entry.file)) !== expected)
    throw new Error(`target changed after planning / local edits: ${entry.file}`);
}
function withLock(fn) {
  let fd;
  try {
    fd = openSync(LOCK, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  } catch (error) {
    if (fd !== undefined) { closeSync(fd); unlinkSync(LOCK); }
    throw new Error(`cannot acquire deployment lock (another deployment or stale lock): ${error.message}`);
  }
  try { return fn(); }
  finally { closeSync(fd); unlinkSync(LOCK); }
}
function apply(entries) {
  const changed = entries.filter((e) => !e.before.equals(e.after));
  if (!changed.length) { console.log('All selected patches are current; no files changed.'); return; }
  withLock(() => {
    for (const entry of entries) sameCurrent(entry, hash(entry.before));
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
    const dir = join(BACKUPS, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const manifest = {
      format: 1, id, at: new Date().toISOString(), status: 'prepared', node: process.version,
      patches: selected.map((p) => ({ name: p.name, sha256: hash(readFileSync(join(SNIPPETS, p.snippet))) })),
      files: changed.map((e, i) => ({ file: e.file, backup: `${i}.original`, before: hash(e.before), after: hash(e.after), mode: e.mode })),
    };
    changed.forEach((entry, i) => writeFileSync(join(dir, manifest.files[i].backup), entry.before, { mode: 0o600, flag: 'wx' }));
    const manifestFile = join(dir, 'manifest.json');
    atomicWrite(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    const written = [];
    try {
      for (const entry of changed) {
        sameCurrent(entry, hash(entry.before));
        atomicWrite(entry.file, entry.after, entry.mode);
        written.push(entry);
      }
      manifest.status = 'applied';
      atomicWrite(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    } catch (error) {
      const errors = [];
      for (const entry of written.reverse()) {
        try { sameCurrent(entry, hash(entry.after)); atomicWrite(entry.file, entry.before, entry.mode); }
        catch (rollbackError) { errors.push(rollbackError.message); }
      }
      manifest.status = errors.length ? 'recovery-required' : 'rolled-back';
      try { atomicWrite(manifestFile, JSON.stringify(manifest, null, 2) + '\n'); } catch { /* original backup remains */ }
      throw new Error(`deployment failed; ${errors.length ? 'manual recovery required: ' + errors.join('; ') : 'all written targets restored'}; backup=${id}; ${error.message}`);
    }
    console.log(`Applied ${changed.length} file(s); backup=${id}. User configuration and skills were not changed.`);
  });
}
function revert() {
  if (onlyNames) throw new Error('--revert does not support --only: restoration is by whole deployment transaction');
  if (backupArg !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(backupArg) || ['.', '..'].includes(backupArg))) throw new Error('invalid backup id');
  if (!existsSync(BACKUPS)) throw new Error('no deployment backup; reinstall the exact upstream version for legacy patches');
  const candidates = readdirSync(BACKUPS).filter((id) => /^[A-Za-z0-9.-]+$/.test(id)).sort().reverse();
  let chosen;
  for (const id of backupArg ? [backupArg] : candidates) {
    const file = join(BACKUPS, id, 'manifest.json');
    if (!existsSync(file)) { if (backupArg) throw new Error('backup manifest not found'); continue; }
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8'));
      if (!['applied', 'prepared', 'recovery-required'].includes(doc.status)) {
        if (backupArg) throw new Error('backup is already reverted or rolled back');
        continue;
      }
      if (doc.format !== 1 || doc.id !== id || !Array.isArray(doc.files) || !doc.files.length) throw new Error('invalid backup manifest');
      const targets = new Set();
      for (const [i, entry] of doc.files.entries()) {
        if (entry.backup !== `${i}.original` || typeof entry.file !== 'string' || !entry.file.startsWith('/') || targets.has(entry.file)
          || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777
          || !/^[a-f0-9]{64}$/.test(entry.before) || !/^[a-f0-9]{64}$/.test(entry.after)) throw new Error('invalid backup entry');
        targets.add(entry.file);
        if (hash(readFileSync(join(dirname(file), entry.backup))) !== entry.before) throw new Error('backup bytes checksum mismatch');
      }
      chosen = { file, doc }; break;
    } catch (error) {
      if (backupArg) throw error;
      // Ignore invalid backup directories, never fall back because of target edits.
      console.error(`Skipping invalid backup ${id}: ${error.message}`);
    }
  }
  if (!chosen) throw new Error('no active deployment backup');
  const { file: manifestFile, doc } = chosen;
  if (doc.format !== 1 || !Array.isArray(doc.files) || !doc.files.length) throw new Error('unsupported or invalid backup manifest');
  const entries = doc.files.map((entry, i) => {
    if (entry.backup !== `${i}.original` || typeof entry.file !== 'string' || !Number.isInteger(entry.mode)) throw new Error('invalid backup entry');
    const before = readFileSync(join(dirname(manifestFile), entry.backup));
    if (hash(before) !== entry.before) throw new Error('backup bytes checksum mismatch');
    if (realpathSync(entry.file) !== entry.file) throw new Error('backup target realpath changed');
    const current = readFileSync(entry.file), currentHash = hash(current);
    if (currentHash !== entry.after)
      throw new Error(`refusing to overwrite local edits / newer deployment: ${entry.file}`);
    // Original bytes may predate an upgrade; rollback restores exactly, without interpreting snippets.
    return { ...entry, original: before, current, currentHash };
  });
  withLock(() => {
    for (const entry of entries) sameCurrent(entry, entry.currentHash);
    const written = [];
    try {
      for (const entry of entries) {
        sameCurrent(entry, entry.currentHash);
        atomicWrite(entry.file, entry.original, entry.mode);
        written.push(entry);
      }
      doc.status = 'reverted'; doc.revertedAt = new Date().toISOString();
      atomicWrite(manifestFile, JSON.stringify(doc, null, 2) + '\n');
    } catch (error) {
      const failures = [];
      for (const entry of written.reverse()) {
        try { sameCurrent(entry, entry.before); atomicWrite(entry.file, entry.current, entry.mode); }
        catch (rollbackError) { failures.push(rollbackError.message); }
      }
      throw new Error(`restore failed: ${error.message}${failures.length ? '; manual recovery: ' + failures.join('; ') : '; restoration changes rolled back'}`);
    }
    console.log(`Restored original bytes for ${entries.length} file(s); backup=${doc.id}. User data retained.`);
  });
}
try {
  if (['--check', '--revert', '--plan'].filter((flag) => argv.includes(flag)).length > 1) throw new Error('--check, --revert and --plan are mutually exclusive');
  if (argv.some((arg) => !['--check', '--revert', '--plan'].includes(arg) && !arg.startsWith('--only=') && !arg.startsWith('--backup='))) throw new Error('unknown argument');
  if (argv.filter((a) => a.startsWith('--only=')).length > 1 || argv.filter((a) => a.startsWith('--backup=')).length > 1) throw new Error('duplicate option');
  if (onlyNames && onlyNames.some((name) => !PATCHES.some((p) => p.name === name))) throw new Error('--only requires registered nonempty patch names');
  if (backupArg !== undefined && mode !== 'revert') throw new Error('--backup is only valid with --revert');
  if (mode === 'revert') revert();
  else {
    const entries = plan();
    if (mode === 'apply') apply(entries);
    else console.log(mode === 'check' ? 'All selected snippets match (read-only).' : 'Preflight and syntax checks passed; no deployment performed.');
  }
} catch (error) { console.error(`✗ ${error.message}`); process.exitCode = 2; }

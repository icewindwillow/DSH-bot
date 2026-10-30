/* >>> dsh-qqbot-patch:tts-tool-helper >>> */
/**
 * 语音合成：文字 → mp3（Edge TTS，免费）→ QQ 语音消息。
 *
 * - 声线默认 zh-CN-XiaoyiNeural（少女音），可用 QQBOT_TTS_VOICE 换
 * - 走代理：QQBOT_TTS_PROXY 或 HTTPS_PROXY
 * - 限制：正文 ≤ 120 字；每群每小时最多 3 条；只在被明确要求时用
 */
function setupTtsTool(ctx, bot, config, logger) {
    let tools;
    try {
        tools = ctx.get('tools');
    }
    catch {
        tools = undefined;
    }
    if (!tools) {
        console.log('[im-qqbot] tools 不可用，语音工具未启用');
        return;
    }
    const fs = process.getBuiltinModule?.('node:fs');
    const profileDir = process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`;
    const audioDir = `${profileDir}/audio`;
    const voice = process.env.QQBOT_TTS_VOICE ?? 'zh-CN-XiaoyiNeural';
    const proxy = process.env.QQBOT_TTS_PROXY ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? '';
    const lastSentAt = new Map();   // gid → 上次发语音的时间

    tools.register({
        name: 'send_voice',
        description: [
            '把一句话用语音发到群里（QQ 语音消息）。',
            '只在对方明确要求时使用（例如「用语音说」「发条语音」），不要主动发语音。',
            'text 最多 120 字；每分钟最多一条，内容要短、口语化。',
        ].join(''),
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                text: { type: 'string', description: '要念出来的话，≤120 字' },
            },
            required: ['text'],
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean' },
                    message: { type: 'string' },
                },
                required: ['ok', 'message'],
            },
            render: (_args, value) => [{ type: 'text', text: value.message }],
        },
        isConcurrencySafe: false,
        async execute(args) {
            const text = typeof args?.text === 'string' ? args.text.trim() : '';
            if (text === '')
                throw new Error('text 不能为空');
            if (text.length > 120)
                return { ok: false, message: `太长了（${text.length} 字），语音最多 120 字。` };
            const target = globalThis.__qqbotLastTarget;
            if (!target)
                return { ok: false, message: '不知道发到哪个会话，先等有人说话。' };
            const now = Date.now();
            if (now - (lastSentAt.get(target.targetId) ?? 0) < 60 * 1000)
                return { ok: false, message: '一分钟内已经发过一条语音了，稍等一下。' };
            if (!fs)
                return { ok: false, message: '文件系统不可用。' };

            let EdgeTTS;
            try {
                const mod = await import('node-edge-tts');
                EdgeTTS = mod.EdgeTTS ?? mod.default?.EdgeTTS ?? mod.default;
            }
            catch (err) {
                return { ok: false, message: `TTS 模块加载失败：${err instanceof Error ? err.message : String(err)}` };
            }
            if (typeof EdgeTTS !== 'function')
                return { ok: false, message: 'TTS 模块不可用（EdgeTTS 未导出）。' };

            fs.mkdirSync(audioDir, { recursive: true });
            const file = `${audioDir}/tts-${Date.now()}.mp3`;
            try {
                const tts = new EdgeTTS({ voice, lang: 'zh-CN', proxy: proxy || undefined, timeout: 30000 });
                await tts.ttsPromise(text, file);
            }
            catch (err) {
                return { ok: false, message: `语音合成失败：${err instanceof Error ? err.message : String(err)}` };
            }
            try {
                await bot.sendVoice({ scope: target.scope, targetId: target.targetId, msgId: target.msgId }, { localPath: file });
                lastSentAt.set(target.targetId, now);
                console.log(`[im-qqbot] 语音已发送: ${text.slice(0, 20)}…`);
                return { ok: true, message: '语音已发出。' };
            }
            catch (err) {
                return { ok: false, message: `语音发送失败：${err instanceof Error ? err.message : String(err)}` };
            }
        },
    });
    console.log(`[im-qqbot] 语音工具已注册（Edge TTS，声线 ${voice}）`);
}
/* <<< dsh-qqbot-patch:tts-tool-helper <<< */

/* >>> dsh-qqbot-patch:tts-tool-helper >>> */
/**
 * 语音合成：文字 → 语音 → QQ 语音消息。
 *
 * 语音服务链由控制面板的「语音合成」配置驱动（<profile>/qqbot-tts.json），
 * 数组顺序即优先级，前一个失败自动尝试下一个。配置缺失时用内置默认：
 *   1. 本地 IndexTTS（POST {url}/tts，自建服务，返回 wav）
 *   2. OpenAI 兼容 /audio/speech（{baseUrl}/audio/speech，任何实现该接口的服务）
 *   3. Edge TTS（node-edge-tts，免费兜底）
 *
 * 配置文件不存在或损坏时按默认链工作，不会让语音功能整个失效。
 * 每次调用都重新读配置，面板保存后无需重启机器人。
 */
const qqbotTtsProfileReader = /* inline-profile-reader */ null;
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
    const settingsFile = `${profileDir}/qqbot-tts.json`;
    const EDGE_PROXY = process.env.QQBOT_TTS_PROXY ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? '';

    // ── 语音权限 ───────────────────────────────────────────────────────────
    // 和生图同一套机制：主人（qqbot-command-owners.json）、语音技能自己的受众
    // （qqbot-role-skills.json 里 id 等于 voicePermission.skill 的那个技能）、好感度阈值
    // （qqbot-people.json 的 social.affinity）。语音要烧本机算力，缺文件或损坏一律按「没权限」。
    const VOICE_PERMISSION_DEFAULTS = Object.freeze({ affinityMin: 60, skill: 'voice-gen' });

    function readPermissionDocument(type) {
        if (qqbotTtsProfileReader) return qqbotTtsProfileReader(profileDir, type);
        const file = `${profileDir}/qqbot-${type}.json`;
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024)
            throw new Error('unsafe voice permission source');
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    function voicePermission() {
        try {
            const raw = readPermissionDocument('role-skills')?.voicePermission;
            const min = Number(raw?.affinityMin);
            const skill = typeof raw?.skill === 'string' && raw.skill.trim() !== '' ? raw.skill.trim() : VOICE_PERMISSION_DEFAULTS.skill;
            return {
                affinityMin: Number.isInteger(min) && min >= 0 && min <= 100 ? min : VOICE_PERMISSION_DEFAULTS.affinityMin,
                skill,
            };
        }
        catch { /* 缺文件或损坏按缺省，不因此放开 */ }
        return { ...VOICE_PERMISSION_DEFAULTS };
    }
    function voiceNames(person) {
        const out = [person?.name, person?.addressing];
        for (const key of Object.keys(person ?? {}))
            if (key.indexOf('nickname') === 0)
                out.push(person[key]);
        if (Array.isArray(person?.aliases))
            out.push(...person.aliases);
        return out.filter((name) => typeof name === 'string' && name.trim() !== '').map((name) => name.trim());
    }
    function voicePerson(senderId) {
        try {
            const people = readPermissionDocument('people')?.people;
            return (Array.isArray(people) ? people : []).find((person) => Array.isArray(person?.openids) && person.openids.includes(senderId));
        }
        catch { return undefined; }
    }
    function voiceIsOwner(senderId, person) {
        let owners;
        try { owners = readPermissionDocument('command-owners'); } catch { return false; }
        if ((Array.isArray(owners?.openids) ? owners.openids : []).includes(senderId))
            return true;
        const names = (Array.isArray(owners?.names) ? owners.names : []).map((name) => String(name).trim()).filter(Boolean);
        if (names.length === 0 || !person)
            return false;
        return voiceNames(person).some((name) => names.includes(name));
    }
    /** 只认 voicePermission.skill 指名的那个技能，看它的 audiences；别的技能不顺带放行。 */
    function voiceRoleGrant(gid, senderId, person, skillId) {
        let skills;
        try { skills = readPermissionDocument('role-skills')?.skills; } catch { return undefined; }
        const skill = (Array.isArray(skills) ? skills : []).find((item) => item && String(item.id ?? '') === skillId);
        if (!skill)
            return undefined;
        for (const audience of Array.isArray(skill.audiences) ? skill.audiences : []) {
            if (!audience || typeof audience !== 'object')
                continue;
            const groups = (Array.isArray(audience.groups) ? audience.groups : []).filter((group) => typeof group === 'string' && group.trim() !== '');
            if (groups.length > 0 && !groups.includes(gid))
                continue;
            if (Array.isArray(audience.openids) && audience.openids.includes(senderId))
                return skillId;
            const wanted = String(audience.person ?? '').trim().toLowerCase();
            if (wanted && person && voiceNames(person).some((name) => name.toLowerCase() === wanted))
                return skillId;
        }
        return undefined;
    }
    function voicePermissionCheck(target) {
        const permission = voicePermission();
        const senderId = typeof target?.senderId === 'string' ? target.senderId : '';
        if (senderId === '')
            return { allowed: false, affinityMin: permission.affinityMin, skill: permission.skill };
        const person = voicePerson(senderId);
        if (voiceIsOwner(senderId, person))
            return { allowed: true, via: 'owner' };
        const gid = target?.scope === 'group' ? String(target.groupOpenid ?? target.targetId ?? '') : '';
        const role = voiceRoleGrant(gid, senderId, person, permission.skill);
        if (role)
            return { allowed: true, via: 'role', role };
        const raw = Number(person?.social?.affinity ?? person?.affinity);
        const affinity = Number.isFinite(raw) ? raw : undefined;
        if (affinity !== undefined && affinity >= permission.affinityMin)
            return { allowed: true, via: 'affinity', affinity };
        return { allowed: false, affinity, affinityMin: permission.affinityMin, skill: permission.skill };
    }

    /** 与 bot-config-panel/tts.mjs 的默认值保持一致。 */
    const DEFAULT_SETTINGS = {
        enabled: true,
        maxChars: 120,
        cooldownSeconds: 60,
        providers: [
            { id: 'index-tts-local', enabled: true, followMood: true, url: 'http://127.0.0.1:7793', voice: 'u2', emotion: '', emoAlpha: 0.5, durationFactor: 0.95, maxChars: 120, timeoutSeconds: 150 },
            { id: 'openai-compatible', enabled: true, baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/CosyVoice2-0.5B', voice: 'FunAudioLLM/CosyVoice2-0.5B:diana', credential: 'SILICONFLOW_API_KEY', responseFormat: 'mp3', speed: 1.1, timeoutSeconds: 20 },
            { id: 'edge', enabled: true, voice: 'zh-CN-XiaoyiNeural' },
        ],
    };
    const PROVIDER_LABELS = {
        'index-tts-local': 'IndexTTS',
        'openai-compatible': 'OpenAI兼容',
        'edge': 'Edge',
    };
    /**
     * 心情 → IndexTTS 情绪（服务端只认这 8 个名字，强度 0–1）。
     * 强度刻意压得很低：实测 0.5 的 happy 会把同一句从 6.0 秒拉到 8.3 秒，
     * 拖出颤音和叹息，听起来像在抽泣；0.25 以下才只是「语气更亮一点」。
     */
    const MOOD_EMOTION = {
        兴奋: { emotion: 'happy', emoAlpha: 0.3 },
        开心: { emotion: 'happy', emoAlpha: 0.25 },
        精神: { emotion: 'happy', emoAlpha: 0.15 },
        满足: { emotion: 'happy', emoAlpha: 0.12 },
        平静: { emotion: '', emoAlpha: 0 },
        困倦: { emotion: 'melancholic', emoAlpha: 0.12 },
        烦躁: { emotion: 'angry', emoAlpha: 0.2 },
        低落: { emotion: 'sad', emoAlpha: 0.15 },
        蔫蔫: { emotion: 'melancholic', emoAlpha: 0.15 },
    };
    const lastSentAt = new Map();      // targetId → 上次发送时间
    const downUntil = new Map();       // provider id → 冷却截止时间（刚失败的服务先跳过一分钟）

    function readSettings() {
        if (!fs)
            return DEFAULT_SETTINGS;
        try {
            const parsed = qqbotTtsProfileReader ? qqbotTtsProfileReader(profileDir, 'tts')
                : JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
            if (qqbotTtsProfileReader && Object.keys(parsed).length === 0) return DEFAULT_SETTINGS;
            if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.providers) || parsed.providers.length === 0)
                throw new Error('配置结构不完整');
            return parsed;
        }
        catch (err) {
            if (err?.code !== 'ENOENT')
                console.log(`[im-qqbot] 语音配置读取失败，使用默认链：${err instanceof Error ? err.message : String(err)}`);
            return DEFAULT_SETTINGS;
        }
    }

    /** 当前群的心情 → 情绪参数；拿不到（心情补丁没装 / 这个群还没记录）就返回 undefined，由调用方回退到固定档。 */
    function moodEmotion(target) {
        const mood = globalThis.__qqbotMood;
        if (!mood)
            return undefined;
        try {
            const group = target?.targetId === undefined ? undefined : mood.snapshot?.(String(target.targetId));
            const snap = group ?? mood.globalSnapshot?.();
            const mapped = snap && MOOD_EMOTION[snap.label];
            return mapped ? { ...mapped, label: snap.label } : undefined;
        }
        catch {
            return undefined;
        }
    }

    /** 凭据：环境变量 → credentials 服务 → 本地凭据文件。 */
    async function resolveCredential(name) {
        const valid = (value) => (typeof value === 'string' && value.trim() !== '' && !/[\r\n\u0000]/.test(value) ? value.trim() : undefined);
        const fromEnvironment = valid(process.env[name]);
        if (fromEnvironment)
            return fromEnvironment;
        try {
            const credentials = ctx?.get?.('credentials');
            if (credentials) {
                const { credentialRef } = await import('@deepseek-ai/dsh-credentials');
                const resolved = valid((await credentials.resolve(credentialRef(name)))?.value);
                if (resolved)
                    return resolved;
            }
        }
        catch { /* 退回本地凭据文件 */ }
        try {
            const hostFs = process.getBuiltinModule('node:fs');
            const hostOs = process.getBuiltinModule('node:os');
            const hostPath = process.getBuiltinModule('node:path');
            const text = hostFs.readFileSync(hostPath.join(hostOs.homedir(), '.dsh', '.credentials.yaml'), 'utf8');
            const match = text.match(new RegExp(`^\\s*${name}:\\s*(\\S.*)$`, 'm'));
            return valid(match?.[1]?.replace(/^['"]|['"]$/g, '').trim());
        }
        catch {
            return undefined;
        }
    }

    async function fetchAudio(url, init, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, { ...init, signal: controller.signal });
            if (!response.ok) {
                const detail = await response.text().catch(() => '');
                throw new Error(`HTTP ${response.status} ${detail.slice(0, 160)}`.trim());
            }
            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.length === 0)
                throw new Error('返回空音频');
            return bytes;
        }
        finally {
            clearTimeout(timer);
        }
    }

    /** 每个 provider 返回 { bytes, extension }。 */
    const PROVIDERS = {
        'index-tts-local': async (provider, text, target) => {
            const fixed = { emotion: provider.emotion ?? '', emoAlpha: provider.emoAlpha };
            const emotion = provider.followMood === false ? fixed : (moodEmotion(target) ?? fixed);
            const bytes = await fetchAudio(`${provider.url}/tts`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    text,
                    voice: provider.voice,
                    emotion: emotion.emotion,
                    emoAlpha: emotion.emoAlpha,
                    durationFactor: provider.durationFactor,
                }),
            }, (provider.timeoutSeconds ?? 150) * 1000);
            return { bytes, extension: 'wav', emotion: emotion.label ?? emotion.emotion };
        },
        'openai-compatible': async (provider, text) => {
            const key = await resolveCredential(provider.credential);
            if (!key)
                throw new Error(`缺少凭据 ${provider.credential}`);
            const bytes = await fetchAudio(`${provider.baseUrl}/audio/speech`, {
                method: 'POST',
                headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
                body: JSON.stringify({
                    model: provider.model,
                    voice: provider.voice,
                    input: text,
                    response_format: provider.responseFormat,
                    speed: provider.speed,
                }),
            }, (provider.timeoutSeconds ?? 20) * 1000);
            return { bytes, extension: provider.responseFormat };
        },
        'edge': async (provider, text) => {
            const hostFs = process.getBuiltinModule('node:fs');
            const mod = await import('node-edge-tts');
            const EdgeTTS = mod.EdgeTTS ?? mod.default?.EdgeTTS ?? mod.default;
            if (typeof EdgeTTS !== 'function')
                throw new Error('EdgeTTS 未导出');
            const file = `${audioDir}/edge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`;
            const tts = new EdgeTTS({ voice: provider.voice, lang: 'zh-CN', proxy: EDGE_PROXY || undefined, timeout: 30000 });
            await tts.ttsPromise(text, file);
            return { bytes: hostFs.readFileSync(file), extension: 'mp3', temp: file };
        },
    };

    tools.register({
        name: 'send_voice',
        description: [
            '把一句话用语音发到群里（QQ 语音消息）。',
            '对方明确要求时用（例如「用语音说」「发条语音」）；在你真的觉得需要让他「听见」的时候也可以主动发：对方情绪低落需要安慰、你在道歉认错、深夜谈心。一次回复最多一条。',
            '但别滥用：日常闲聊、你在生气怼人、信息量大时都不要发。每次合成很慢（本机算力）。',
            '内容最多 120 字，口语化、简短；同一群短时间内不能连发多条。',
            '文字必须按说话的样子带标点：逗号短停、句号/问号长停、省略号最长；整段没有标点会连读成一串。不要写 emoji、颜文字、星号动作或代码式文本。',
            '没有权限或服务失败时会返回失败，不要重试，也不要换个说法绕过。',
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
            const settings = readSettings();
            const maxChars = Number(settings.maxChars ?? DEFAULT_SETTINGS.maxChars);
            const cooldown = Math.max(0, Number(settings.cooldownSeconds ?? 60)) * 1000;
            if (settings.enabled === false)
                return { ok: false, message: '语音功能已在控制面板关闭。' };
            if (text.length > maxChars)
                return { ok: false, message: `太长了（${text.length} 字），语音最多 ${maxChars} 字。` };
            const target = globalThis.__qqbotLastTarget;
            if (!target)
                return { ok: false, message: '不知道发到哪个会话，先等有人说话。' };
            if (!fs)
                return { ok: false, message: '文件系统不可用。' };
            const permission = voicePermissionCheck(target);
            if (!permission.allowed) {
                const hint = permission.affinity === undefined
                    ? `你的档案里还没有好感度记录，需要达到 ${permission.affinityMin}`
                    : `好感度 ${permission.affinity}，还没达到 ${permission.affinityMin}`;
                return { ok: false, message: `当前账号没有语音权限：只有主人、被授予语音权限的角色，或好感度达标的人可以让我发语音；${hint}。不要重试，也不用换个说法再试。` };
            }
            const now = Date.now();
            if (cooldown > 0 && now - (lastSentAt.get(target.targetId) ?? 0) < cooldown)
                return { ok: false, message: `这个会话刚发过语音，${Math.ceil(cooldown / 1000)} 秒内不能连发。` };
            fs.mkdirSync(audioDir, { recursive: true });

            const errors = [];
            for (const provider of settings.providers) {
                if (!provider || provider.enabled === false)
                    continue;
                const run = PROVIDERS[provider.id];
                if (!run) {
                    errors.push(`${provider.id}: 不支持的服务类型`);
                    continue;
                }
                if (until_for(provider.id) > now)
                    continue;
                if (provider.id === 'index-tts-local' && text.length > Number(provider.maxChars ?? 120)) {
                    console.log(`[im-qqbot] 文本 ${text.length} 字超过本地阈值 ${provider.maxChars}，跳过 IndexTTS`);
                    continue;
                }
                try {
                    const { bytes, extension, temp, emotion } = await run(provider, text, target);
                    const file = `${audioDir}/tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
                    fs.writeFileSync(file, bytes, { mode: 0o600 });
                    if (temp)
                        fs.rmSync(temp, { force: true });
                    await bot.sendVoice({ scope: target.scope, targetId: target.targetId, msgId: target.msgId }, { localPath: file });
                    lastSentAt.set(target.targetId, now);
                    downUntil.delete(provider.id);
                    const label = PROVIDER_LABELS[provider.id] ?? provider.id;
                    const mood = provider.id === 'index-tts-local' && emotion ? `，情绪 ${emotion}` : '';
                    console.log(`[im-qqbot] 语音已发送（${label}${mood}）: ${text.slice(0, 20)}…`);
                    return { ok: true, message: '语音已发出。' };
                }
                catch (err) {
                    const reason = err instanceof Error ? err.message : String(err);
                    errors.push(`${PROVIDER_LABELS[provider.id] ?? provider.id}: ${reason}`);
                    downUntil.set(provider.id, now + 60 * 1000);
                    console.log(`[im-qqbot] ${PROVIDER_LABELS[provider.id] ?? provider.id} 合成失败，尝试下一个：${reason}`);
                }
            }
            return { ok: false, message: `语音合成失败：${errors.join('；') || '没有启用的语音服务'}` };
        },
    });

    // 刚失败的服务一分钟内先跳过，避免每条都等它超时。
    function until_for(id) {
        return downUntil.get(id) ?? 0;
    }

    const enabledIds = () => (readSettings().providers ?? [])
        .filter((provider) => provider && provider.enabled !== false)
        .map((provider) => PROVIDER_LABELS[provider.id] ?? provider.id)
        .join(' → ');
    console.log(`[im-qqbot] 语音工具已注册（配置 ${settingsFile}，当前链 ${enabledIds()}）`);
}
/* <<< dsh-qqbot-patch:tts-tool-helper <<< */

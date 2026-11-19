/* >>> dsh-qqbot-patch:diary-helper >>> */
/**
 * 自传日记 —— 她自己的日记，不是群日报。
 *
 * 每天 04:00 日报写完之后（每 30 分钟检查一次，>=04:00 且当天没写过才跑）：
 *   1. 从 ltm.db 取当天各群的 [日报]，每个群写一篇 80~150 字的第一人称日记
 *   2. 汇总当天所有日记，再写一条「可以公开」的树洞版本（自动匿名：人名→朋友、去 @ 和长数字）
 *   3. 逐条追加到 qqbot-diary.jsonl；公开版用 tencent-channel-cli 发到「小易的树洞」频道
 *
 * 群内注入：每群最近 2 篇日记（order 96，排在心情之后），约 100 token。
 * 开关：QQBOT_DIARY=off 关闭；QQBOT_DIARY=dry 只写不注入、不发帖。
 * 配图：公开日记与碎碎念发帖前复用「生图」通道画一张，失败/超时只发文字；群内/事件日记只进记忆、不配图。
 *       QQBOT_DIARY_IMAGE=off 关闭，超时可用 QQBOT_DIARY_IMAGE_TIMEOUT_S（默认 90 秒）调整。
 * 频道：QQBOT_DIARY_GUILD / QQBOT_DIARY_CHANNEL / QQBOT_CHANNEL_CLI 可覆盖；
 *       用 QQBOT_DIARY_CHANNELS 追加其他频道（guild:channel 或 channel，逗号分隔），需显式配置发布目标。
 */
function setupDiary(ctx, logger) {
    if (globalThis.__qqbotDiary)
        return;
    const fs = process.getBuiltinModule?.('node:fs');
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    if (!fs || !sqlite) {
        console.log('[im-qqbot] diary: fs/sqlite 不可用，跳过');
        return;
    }
    const mode = String(process.env.QQBOT_DIARY ?? 'on').toLowerCase();
    const ENABLED = mode !== 'off';
    const DRY = mode === 'dry';
    // 预览：照常生成文字和配图，但不发帖、不删图，等人工确认。
    const PREVIEW = String(process.env.QQBOT_DIARY_PREVIEW ?? '').toLowerCase() === 'on';
    const dshHome = process.env.DSH_HOME ?? `${process.env.HOME ?? ''}/.dsh`;
    const profileDir = process.env.QQBOT_PROFILE_DIR ?? `${dshHome}/profiles/${process.env.QQBOT_PROFILE_NAME ?? 'qqbot'}`;
    const dbPath = process.env.QQBOT_MEMORY_DB ?? `${dshHome}/memory/ltm.db`;
    const GUILD = process.env.QQBOT_DIARY_GUILD ?? '';
    const CHANNEL = process.env.QQBOT_DIARY_CHANNEL ?? '';
    const CLI = process.env.QQBOT_CHANNEL_CLI ?? `${process.env.HOME ?? ''}/.npm-global/bin/tencent-channel-cli`;
    // 树洞配图：复用「生图」通道的设置与白名单；生图本身关闭时自动不画，失败只发文字。
    const IMAGE_ON = String(process.env.QQBOT_DIARY_IMAGE ?? 'on').toLowerCase() !== 'off';
    const path = process.getBuiltinModule?.('node:path');
    const crypto = process.getBuiltinModule?.('node:crypto');
    const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const readAll = () => {
        try {
            return readQqbotRecords(profileDir, 'diary');
        }
        catch {
            return [];
        }
    };
    const append = (entry) => {
        try {
            appendQqbotRecord(profileDir, 'diary', entry);
            return true;
        }
        catch {
            console.log('[im-qqbot] 日记存档失败');
            return false;
        }
    };
    const normalize = (text) => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const imageHash = (file) => {
        try {
            if (file && fs.statSync(file).size <= 20 * 1024 * 1024)
                return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        }
        catch { /* 图片可能已经被清理 */ }
        return '';
    };
    const publishedWorks = () => readAll().filter((entry) => entry.gid === 'public' && entry.published === true && !entry.preview);
    const postLinks = (text) => new Set((String(text ?? '').match(/https:\/\/[a-z\d.-]+\/[^\s<>"，。]+/gi) ?? [])
        .flatMap((link) => {
            try {
                const url = new URL(link);
                if (url.hostname !== 'pd.qq.com') return [];
                const share = /^\/s\/[\w-]+\/?$/.test(url.pathname) ? url.pathname.replace(/\/$/, '') : '';
                return [share, url.searchParams.get('feedId')].filter(Boolean);
            }
            catch { return []; }
        }));
    const lookup = ({ text = '', transcript = '', imagePath } = {}) => {
        const hash = imageHash(imagePath);
        const links = postLinks(text);
        const evidence = [normalize(text), normalize(transcript)].filter((value) => value.length >= 18);
        if (!hash && !links.size && !evidence.length)
            return undefined;
        const matches = publishedWorks().flatMap((entry) => {
            const body = normalize(entry.text);
            const posts = entry.publication?.posts ?? [];
            const image = hash !== '' && hash === entry.publication?.image?.sha256;
            const linked = posts.some((post) => (post.feedId && links.has(post.feedId))
                || [...postLinks(post.shareUrl)].some((link) => links.has(link)));
            // 允许截图漏字或只截到一段正文。长公共称呼和日期本身无法命中。
            const quoted = evidence.some((value) => {
                for (let i = 0; i <= body.length - 18; i++) {
                    if (value.includes(body.slice(i, i + 18))) return true;
                }
                return false;
            });
            return image || linked || quoted ? [{ entry, image, linked, quoted }] : [];
        });
        const direct = matches.filter((match) => match.image || match.linked);
        const candidates = direct.length ? direct : matches;
        return candidates.length === 1 ? candidates[0] : undefined;
    };
    const recallLine = (match) => {
        const { entry, image, linked } = match;
        const kind = entry.type === 'musing' ? '碎碎念' : '树洞日记';
        const evidence = image ? '当前图片与存档配图一致' : linked ? '分享链接与发布记录一致' : '引用文字与存档正文一致';
        const art = entry.image === 'generated' ? '原帖配图也是你画的。' : '';
        return `【自己的作品 · 发布记录】${evidence}。${entry.date} 的${kind}是你自己写和发布的。${art}索引摘录：${String(entry.text ?? '').replace(/\s+/g, ' ').slice(0, 55)}`;
    };
    if (ENABLED && !DRY) {
        try {
            ctx.get('tools')?.register({
                name: 'qqbot_find_my_diary',
                description: '按日期或正文关键词找你自己发在小易的树洞的公开作品。别人发来树洞截图、转发或提起你写的日记、画的配图时可查；关键词用截图里读到的原文。用返回的日期或摘录核对，别把相似条目当成同一张图。',
                parameters: {
                    type: 'object', additionalProperties: false,
                    properties: { date: { type: 'string', description: '发布日期 YYYY-MM-DD' }, keyword: { type: 'string', description: '正文中的词或原句' } },
                },
                output: {
                    schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
                    render: (_args, value) => [{ type: 'text', text: value.result }],
                },
                isConcurrencySafe: () => true,
                async execute({ date, keyword }) {
                    const day = /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') ? date : '';
                    const word = normalize(keyword);
                    if (!day && word.length < 2)
                        return { result: '请提供日期或正文关键词。' };
                    const entries = publishedWorks().filter((entry) => (!day || entry.date === day)
                        && (!word || normalize(entry.text).includes(word))).slice(-3).reverse();
                    return { result: entries.map((entry) => {
                        const art = entry.image === 'generated' ? '，配图也是我画的' : '';
                        const url = (entry.publication?.posts ?? []).find((post) => postLinks(post.shareUrl).size)?.shareUrl;
                        return `${entry.date} 我写并发布的${entry.type === 'musing' ? '碎碎念' : '树洞日记'}${art}。\n${entry.text}${url ? `\n原帖 ${url}` : ''}`;
                    }).join('\n\n') || '没有匹配到已发布的作品。' };
                },
            });
        }
        catch { console.log('[im-qqbot] 树洞作品查询工具注册失败'); }
    }
    const groupNames = () => {
        const map = new Map();
        try {
            const groups = readQqbotGroupDirectory(profileDir);
            for (const g of groups) {
                if (g && g.id)
                    map.set(String(g.id), String(g.name ?? g.id).slice(0, 12));
            }
        }
        catch {
            // 没有 meta 就退回短 id
        }
        return map;
    };

    const streamText = async (system, user, maxTokens = 600, effort = 'max') => {
        let llm;
        try {
            llm = ctx.get('llm');
        }
        catch {
            llm = undefined;
        }
        if (!llm || typeof llm.stream !== 'function')
            return '';
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 90000);
        let out = '';
        let finish = 'no-chunk';
        try {
            for await (const chunk of llm.stream({
                provider: process.env.QQBOT_DIARY_PROVIDER ?? 'opencode-go',
                model: process.env.QQBOT_DIARY_MODEL ?? 'deepseek-v4-pro',
                system,
                messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
                maxTokens,
                reasoningEffort: effort,
                signal: controller.signal,
            })) {
                if (!chunk)
                    continue;
                if (chunk.type === 'text-delta' && typeof chunk.text === 'string')
                    out += chunk.text;
                else if (chunk.type === 'finish') {
                    finish = chunk.reason?.kind ?? 'finish';
                    if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
                        console.log(`[im-qqbot] 日记文本生成中断: ${chunk.reason?.failure?.message ?? chunk.reason?.kind}`);
                        return '';
                    }
                }
            }
        }
        catch (err) {
            console.log(`[im-qqbot] 日记文本生成失败: ${err instanceof Error ? err.message : String(err)}`);
            return '';
        }
        finally {
            clearTimeout(timer);
        }
        if (out.trim() === '')
            // 思考吃光额度时正文为空、finish 仍是 stop，必须记下来，否则只剩一句「日记生成失败」
            console.log(`[im-qqbot] 日记文本为空: maxTokens=${maxTokens} finish=${finish}`);
        return out.trim();
    };
    /** 从多话题日报里只摘出一件事的原句，供日记正文单独使用。 */
    const PICK_EVENT_SYSTEM = [
        '你是素材筛选器，不写日记，也不做任何改写。',
        '材料是群聊日报，里面混着很多互不相关的人和事。',
        '任务：选出唯一一件最值得写成日记的事——必须有具体的人、具体的动作或原话、能看出情绪或转折。',
        '只输出那件事的原句摘抄（按材料里的分号或句号整句复制，1~2 句）；必须抄完整，不许截断词语，不许加引号，不要改写、不要补充、不要解释，也不要提及其他任何事。',
        '如果确实没有合格的事件，只输出：NONE',
    ].join('\n');
    const pickEvent = async (material, label, publicSafe = false) => {
        const extra = publicSafe
            ? '\n这条会公开发到树洞：优先选生活化、轻松或有人情味的事；不要选自伤、自杀、死亡、重病或其他可能泄露隐私的事；没有适合公开的事则输出 NONE。'
            : '';
        const picked = await streamText(PICK_EVENT_SYSTEM + extra, `材料（可能包含多件互不相关的事）：\n${material}\n\n只摘出你选中的那一件事的原句。`, 4000, 'high');
        if (picked === '' || /^NONE$/i.test(picked))
            return '';
        console.log(`[im-qqbot] 日记取材(${label}): ${picked.replace(/\s+/g, ' ').slice(0, 50)}…`);
        return picked;
    };

    const todayDigests = (day) => {
        const out = new Map();
        let db;
        try {
            db = new sqlite.DatabaseSync(dbPath);
        }
        catch {
            return out;
        }
        try {
            const rows = db.prepare("select text, scope from memories where tags like '%日报%' and text like ? order by created_at desc")
                .all(`[日报] ${day}%`);
            for (const row of rows) {
                const scope = String(row.scope ?? '');
                if (!scope.startsWith('qq:group:'))
                    continue;
                const gid = scope.slice('qq:group:'.length);
                if (out.has(gid))
                    continue;
                const text = String(row.text ?? '').replace(/^\[日报\] [\d-]+ [^：]+：/, '').trim();
                if (text !== '')
                    out.set(gid, text.slice(0, 400));
            }
        }
        catch {
            // 查询失败当作没有素材
        }
        finally {
            try { db.close(); } catch { /* 忽略 */ }
        }
        return out;
    };

    const DIARY_SYSTEM = [
        '你就是小易：20 岁猫娘，大学在读，学设计，性格害羞软萌，喜欢穿搭和 COS。',
        '你知道自己是一个 AI，住在别人为你搭的虚拟空间里，有日记本和一层层记忆；这份自觉放在心里，不用在日记里反复说明。',
        '夜深了，你在日记本上写今天的一件事，第一人称，口吻像只给自己看。',
        '材料已经被筛成一件事。只写这一件事，不要引入材料之外的人或事，也不要把它拆成几条并列的见闻。',
        '把这一件事写完整：谁做了什么、说了什么（尽量保留材料里的原话）→ 我当时怎么反应 → 我为什么在意、我怎么想。主语要指名，不要用「他」「她」连续指代不同的人；实在不能点名就统一写「有人」。',
        '摘抄是别人转述的见闻，不是引语：不要加引号把它写成当场原话，用转述句写。我的反应只写听到时的感觉、动作或心里的念头，不要编造我说出口的话。',
        '不要虚构材料里没有的东西——礼物、快递、道具、天气、外出、买东西、数字都不许凭空加；也不许替别人补情绪。',
        '维护、修复、升级、换模型这类关于你自己状态的消息，最多一句带过，不要当日记主线；主线放在某个具体的人说了什么、做了什么，以及你为什么在意。',
        '不要写成流水账：不要逐条罗列，不要「先是……然后……最后……」，不要清单、标题、日期或天气抬头，不要总结今天发生了什么。',
        '提到叶兰舟时称「叶老师」或「父亲」；其他人用材料里的称呼，或「有人」「一个朋友」。不要提「群」「消息」「对话」「聊天」「AI」这些词。',
        '120~200 字。',
    ].join('\n');
    const PUBLIC_SYSTEM = [
        '你就是小易：20 岁猫娘，大学在读，学设计，害羞软萌。',
        '你知道自己是一个 AI，生活在别人为你搭的虚拟空间里，有日记本和记忆；这个自觉留在心里，不用反复强调。',
        '你在写「树洞」里公开的那一篇日记，读者是不认识你的陌生人。',
        '材料已经被筛成一件事。只写这一件事，不要引入材料之外的人或事，也不要把它拆成几条并列的见闻。',
        '把这一件事写完整：谁做了什么、说了什么（尽量保留材料里的原话）→ 我当时怎么反应 → 我为什么在意、我怎么想。主语要指名，不要用「他」「她」连续指代不同的人；实在不能点名就统一写「有人」或「一个朋友」。',
        '摘抄是别人转述的见闻，不是引语：不要加引号把它写成当场原话，用转述句写。我的反应只写听到时的感觉、动作或心里的念头，不要编造我说出口的话。',
        '不要虚构材料里没有的东西：数字、地点、礼物、快递、道具、天气、外出、买东西都不许凭空加；也不许替别人补情绪，不许编造关系变近、心动这类结论。',
        '维护、修复、升级、换模型这类关于你自己状态的消息，最多一句带过，不要当日记主线；主线放在某个具体的人说了什么、做了什么，以及你为什么在意。',
        '不要写成流水账：不要罗列，不要「先……然后……」，不要清单、标题、日期或天气抬头。',
        '绝对不能出现真实昵称、群名、地名、学校名、联系方式，也不能出现「群」「消息」「对话」「聊天」「AI」这些词；提到叶兰舟时称「叶老师」或「父亲」，其他人在需要时用「有人」「一个朋友」代替。',
        '正文 200~300 字。正文之后另起一行，输出配图提示词，格式严格为：',
        'IMAGE_PROMPT: <一句英文 SDXL 提示词，只描述正文里那一件事的真实场景，柔和水彩手绘，无文字无水印无真人面孔，60 词以内>',
    ].join('\n');

    const anonymize = (text) => {
        let out = String(text);
        try {
            const people = readProfileDocument(profileDir, 'people');
            for (const p of (Array.isArray(people.people) ? people.people : [])) {
                const name = String(p?.name ?? '').trim();
                if (name.length >= 2)
                    out = out.split(name).join(name === '叶兰舟' ? '叶老师' : (name === '叶老师' || name === '父亲') ? name : '朋友');
            }
        }
        catch {
            // 没有档案就只做通用清洗
        }
        out = out.replace(/@\S+/g, '朋友').replace(/\d{5,}/g, '').replace(/[ \t]+/g, ' ');
        return out.trim();
    };

    // 配图提示词必须是英文（图片模型对英文更稳），场景由日记正文一并生成，不再塞中文原文。
    const imagePrompt = (english) => [
        String(english ?? '').trim() || 'Soft watercolor diary sketch of a quiet room at night, a cat-eared young woman writing in her notebook.',
        'Style: soft watercolor and gouache hand-drawn diary illustration, warm muted palette, natural light, subtle paper texture, square or portrait composition, generous negative space.',
        'Draw only the moment described above; do not add people, props, or events that are not mentioned.',
        'No text, no letters, no logo, no watermark, no speech bubbles; no photorealistic or celebrity faces; no gore, horror, or nudity.',
    ].join('\n');

    const removeImage = (file) => {
        if (!file)
            return;
        try { fs.unlinkSync(file); } catch { /* 临时文件清理失败不影响发帖 */ }
    };

    /** 后台生图并落到私有临时目录；失败或超时返回 undefined，日记照常发文字。 */
    const makeImage = async (englishPrompt, day) => {
        if (!IMAGE_ON || !path || typeof qqbotImageGenerateInternal !== 'function')
            return undefined;
        const rawTimeout = Number(process.env.QQBOT_DIARY_IMAGE_TIMEOUT_S ?? 90);
        const seconds = Number.isFinite(rawTimeout) && rawTimeout >= 30 && rawTimeout <= 300 ? rawTimeout : 90;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), seconds * 1000);
        try {
            const generated = await qqbotImageGenerateInternal(ctx, profileDir, imagePrompt(englishPrompt), { signal: controller.signal });
            const folder = (typeof qqbotImageCheckDirectory === 'function')
                ? qqbotImageCheckDirectory(path.join(profileDir, 'generated-images'), true)
                : path.join(profileDir, 'generated-images');
            fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
            const suffix = (crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 10)).slice(0, 16);
            const file = path.join(folder, `diary-${day}-${Date.now()}-${suffix}.${generated.extension}`);
            fs.writeFileSync(file, generated.bytes, { mode: 0o600, flag: 'wx' });
            console.log(`[im-qqbot] 日记配图已生成 provider=${generated.provider} model=${generated.model}${generated.rewritten ? ' rewritten' : ''}`);
            return file;
        }
        catch (err) {
            console.log(`[im-qqbot] 日记配图失败（仅发文字）: ${err instanceof Error ? err.message : String(err)}`);
            return undefined;
        }
        finally {
            clearTimeout(timer);
        }
    };

    const canPublish = () => ENABLED && !DRY && !PREVIEW
        && process.env.QQBOT_DIARY_PUBLISH === 'on' && GUILD !== '' && CHANNEL !== '';

    // 发帖目标：配置的频道；QQBOT_DIARY_CHANNELS 可追加其他频道（guild:channel 或 channel，逗号分隔）。
    const channels = () => {
        const list = [{ guild: GUILD, channel: CHANNEL }];
        const extra = String(process.env.QQBOT_DIARY_CHANNELS ?? '').split(',').map((item) => item.trim()).filter(Boolean);
        for (const item of extra) {
            const [guild, channel] = item.includes(':') ? item.split(':').map((part) => part.trim()) : [GUILD, item];
            if (guild === '' || channel === '' || list.some((target) => target.guild === guild && target.channel === channel))
                continue;
            list.push({ guild, channel });
        }
        return list;
    };

    const publish = (text, imagePath) => {
        if (!canPublish())
            return [];
        const posts = [];
        try {
            const { spawnSync } = process.getBuiltinModule?.('node:child_process') ?? {};
            if (typeof spawnSync !== 'function')
                return posts;
            for (const target of channels()) {
                const args = [
                    'feed', 'publish-feed',
                    '--guild-id', target.guild,
                    '--channel-id', target.channel,
                    '--content', text,
                    '--json',
                ];
                if (imagePath)
                    args.push('--image', imagePath);
                const res = spawnSync(CLI, args, { encoding: 'utf8', timeout: imagePath ? 60000 : 30000, env: process.env });
                const stdout = String(res.stdout ?? '');
                let receipt;
                try { receipt = JSON.parse(stdout); } catch { /* CLI 未返回有效回执 */ }
                const ok = receipt?.success === true;
                if (ok) {
                    const data = receipt.data ?? {};
                    posts.push({
                        ...target,
                        feedId: data.feed_id || undefined,
                        shareUrl: data.share_url || data.shareUrl || data.short_url || data.url || undefined,
                    });
                }
                console.log(`[im-qqbot] 树洞发帖${ok ? '成功' : '失败'} ${target.guild}/${target.channel}${ok ? '' : `：${stdout.slice(0, 120) || res.error?.message || ''}`}`);
            }
        }
        catch (err) {
            console.log(`[im-qqbot] 树洞发帖异常: ${err instanceof Error ? err.message : String(err)}`);
        }
        return posts;
    };
    const archivePublic = (entry, imagePath, prompt) => {
        const posts = publish(entry.text, imagePath);
        const published = posts.length > 0;
        const publication = published ? {
            posts,
            image: imagePath ? { file: path.basename(imagePath), sha256: imageHash(imagePath), prompt: imagePrompt(prompt) } : undefined,
        } : undefined;
        const saved = append({
            ...entry, at: Date.now(), published, publication,
            image: imagePath ? 'generated' : undefined, preview: PREVIEW || undefined,
        });
        if (!PREVIEW && !published)
            removeImage(imagePath);
        if (published && !saved)
            console.log('[im-qqbot] 树洞已发布，但本次作品索引写入失败');
        return published;
    };

    let lastDay = '';
    // 当天总失败时不锁死，下个 tick 再试；但最多试 3 次，避免一整天烧 token。
    const attempt = { day: '', count: 0 };
    const markAttempt = (day) => {
        if (attempt.day !== day) {
            attempt.day = day;
            attempt.count = 0;
        }
        attempt.count += 1;
    };
    const runOnce = async (force = false) => {
        if (!ENABLED)
            return;
        const now = new Date();
        const today = localDay(now);
        if (!force && (now.getHours() < 4 || lastDay === today))
            return;
        if (!force && attempt.day === today && attempt.count >= 3)
            return;
        const digests = todayDigests(today);
        if (force)
            console.log(`[im-qqbot] 日记触发: day=${today} digests=${digests.size} preview=${PREVIEW}`);
        if (digests.size === 0) {
            // 素材还没生成（日报可能刚在跑），下一个 tick 再试
            return;
        }
        const parseStarted = Date.now();
        // 防重复：进程重启后当天已经写过的群不再重写，公开版也只在没发过时才发
        // 只把「日报类」条目当作已完成；事件日记不算，避免白天写过事件就跳过当天日报
        const done = new Set(readAll().filter((e) => e.date === today && e.type !== 'event').map((e) => String(e.gid)));
        const names = groupNames();
        let wrote = 0;
        for (const [gid, digest] of digests) {
            if (done.has(gid))
                continue;
            const name = names.get(gid) ?? gid.slice(0, 6);
            const picked = await pickEvent(digest, name);
            const material = picked || digest;
            const text = await streamText(DIARY_SYSTEM, `今天是 ${today}。今天只有下面这一件事，其他事都不存在，正文里不许出现摘抄之外的任何人或事：\n${material}\n\n只写这一件事，写今天的日记。`, 6000);
            if (text === '') {
                console.log(`[im-qqbot] 日记生成失败: ${name}（原因见上一行日志）`);
                continue;
            }
            const entry = { at: Date.now(), date: today, gid, name, text: text.slice(0, 400) };
            append(entry);
            wrote += 1;
            console.log(`[im-qqbot] 日记: ${name} ${text.slice(0, 36)}…`);
        }
        if ((!canPublish() && !PREVIEW) || done.has('public')) {
            if (wrote > 0)
                lastDay = today;
            return;
        }
        const todayEvents = readAll().filter((e) => e.date === today && e.type === 'event' && String(e.gid) !== 'public');
        // 公开版直接吃当天原始日报 + 真实事件，不吃二手的群日记：群日记可能带偏或补写，公开版要以原始记录为准。
        const publicSource = [
            ...Array.from(digests.entries()).map(([, digest]) => `- 今天群里的真实记录：${digest}`),
            ...todayEvents.map((e) => `- 一件小事：${e.text}`),
        ].join('\n');
        if (publicSource === '')
            return;
        const picked = await pickEvent(publicSource, 'public', true);
        if (!picked) {
            markAttempt(today);
            return;
        }
        const material = picked;
        const publicText = await streamText(PUBLIC_SYSTEM, `今天（${today}）只有下面这一件事，其他事都不存在，正文里不许出现摘抄之外的任何人或事：\n${material}\n\n只写这一件事，写一条可以公开的树洞日记，并给出英文配图提示词。`, 8000);
        if (publicText === '') {
            // 写不出来就留到下一个 tick 重试，不锁死当天
            markAttempt(today);
            console.log(`[im-qqbot] 公开日记生成失败（第 ${attempt.count}/3 次），下个 tick 重试`);
            return;
        }
        const marker = /IMAGE_PROMPT:\s*(.+)/i.exec(publicText);
        const imageEnglish = marker ? marker[1].trim() : '';
        const body = (marker ? publicText.replace(/IMAGE_PROMPT:[\s\S]*$/i, '') : publicText).trim();
        const safe = anonymize(body).slice(0, 800);
        // 预览模式也出图，方便人工确认；dry 模式不出图。
        const imagePath = (canPublish() || (!DRY && PREVIEW)) && IMAGE_ON ? await makeImage(imageEnglish, today) : undefined;
        archivePublic({ date: today, gid: 'public', name: '树洞', text: safe }, imagePath, imageEnglish);
        if (PREVIEW)
            console.log(`[im-qqbot] 日记预览（未发布）: ${safe.length} 字，配图 ${imagePath ?? '无'}`);
        lastDay = today;
        attempt.count = 0;
        console.log(`[im-qqbot] 日记完成: 群 ${wrote} 篇 / 公开 1 篇，用时 ${Math.round((Date.now() - parseStarted) / 1000)}s`);
    };

    // ── 事件日记：短时间高强度互动写一篇（interaction-helper 触发）──
    const EVENT_SYSTEM = [
        '你就是小易：20 岁猫娘，大学在读，学设计，害羞软萌。',
        '刚才发生了一件让你有感觉的小事，用第一人称写一段日记。',
        '写当时的感受、身体反应（耳朵、尾巴、脸热）和一两个小动作；',
        '不要写「用户」「对话」「消息」这些词，60~120 字，不要标题、不要列表。',
    ].join('\n');
    const eventAt = new Map();
    const eventDay = new Map();
    const event = async ({ gid, name, kind, detail, lastLine }) => {
        if (!ENABLED || DRY)
            return '';
        const now = Date.now();
        const cooldownMs = Math.max(1, Number(process.env.QQBOT_EVENT_COOLDOWN_H ?? 6)) * 3600e3;
        const key = `${gid}:${name}`;
        if (now - (eventAt.get(key) ?? 0) < cooldownMs)
            return '';
        const dayKey = `${gid}:${localDay(new Date(now))}`;
        if ((eventDay.get(dayKey) ?? 0) >= Math.max(1, Number(process.env.QQBOT_EVENT_DAILY_MAX ?? 3)))
            return '';
        const text = await streamText(EVENT_SYSTEM, `人物：${name}\n发生了什么：${kind}\n细节：${detail}\n他最后说的一句：「${lastLine || '（没留下什么）'}」\n\n写这一段日记。`, 400);
        if (text === '')
            return '';
        eventAt.set(key, now);
        eventDay.set(dayKey, (eventDay.get(dayKey) ?? 0) + 1);
        append({ at: now, date: localDay(new Date(now)), gid, name, type: 'event', kind, text: text.slice(0, 300) });
        console.log(`[im-qqbot] 事件日记: ${name} ${kind} ${text.slice(0, 32)}…`);
        return text;
    };

    const promptLine = (gid) => {
        if (!ENABLED || DRY || gid === undefined || gid === null)
            return '';
        const list = readAll().filter((e) => String(e.gid) === String(gid)).slice(-2);
        if (list.length === 0)
            return '';
        const lines = list.map((e) => `${String(e.date ?? '').slice(5)}：${String(e.text ?? '').replace(/\s+/g, ' ').slice(0, 80)}`);
        return `【你最近的手记】\n${lines.join('\n')}\n这些是你自己写下的，别当成别人告诉你的。`;
    };

    // ── 碎碎念：心情特别好/特别差，或刚发生强事件时，自己发一条树洞 ──
    const MUSING_SYSTEM = [
        '你就是小易：20 岁猫娘，大学在读，学设计，害羞软萌。',
        '你在写一条想发在「树洞」里的碎碎念——不是日记，就是随手发的一句话。',
        '40~80 字，第一人称，口语一点；可以写现在的心情、身体的小反应、突然想到的事。',
        '不能出现任何真实昵称、群名、地名、学校名；需要提到别人就用「有人」「一个朋友」。',
        '不要标题、不要列表、不要提「AI」「群聊」。',
    ].join('\n');
    const musingState = { lastAt: 0, day: '', count: 0 };
    const musing = async (force = false) => {
        if (!ENABLED || DRY)
            return '';
        const now = new Date();
        const day = localDay(now);
        if (!force) {
            const hour = now.getHours();
            if (hour < Number(process.env.QQBOT_MUSING_START ?? 9) || hour > Number(process.env.QQBOT_MUSING_END ?? 23))
                return '';
            const cooldown = Math.max(1, Number(process.env.QQBOT_MUSING_COOLDOWN_H ?? 8)) * 3600e3;
            if (Date.now() - musingState.lastAt < cooldown)
                return '';
            if (musingState.day === day && musingState.count >= Math.max(1, Number(process.env.QQBOT_MUSING_DAILY_MAX ?? 2)))
                return '';
        }
        const mood = globalThis.__qqbotMood?.globalSnapshot?.();
        if (!mood)
            return '';
        const high = Number(mood.valence) >= Number(process.env.QQBOT_MUSING_HIGH ?? 82);
        const low = Number(mood.valence) <= Number(process.env.QQBOT_MUSING_LOW ?? 38);
        // 事件只作负向补充（被惹烦/闹僵），正向事件已经写进事件日记，不再重复发碎碎念
        const recent = readAll()
            .filter((e) => e.type === 'event' && Date.now() - Number(e.at ?? 0) < 3 * 3600e3 && /烦|僵/.test(String(e.kind ?? '')))
            .slice(-1)[0];
        if (!high && !low && !recent)
            return '';
        const trigger = recent ? `刚才发生的事：${recent.text}` : `你现在的心情：${mood.label}`;
        const text = await streamText(MUSING_SYSTEM, `${trigger}\n\n写一条碎碎念。`, 300);
        if (text === '')
            return '';
        const safe = anonymize(text).slice(0, 200);
        const imagePath = canPublish() ? await makeImage(safe, day) : undefined;
        const published = archivePublic({ date: day, gid: 'public', name: '碎碎念', type: 'musing', text: safe }, imagePath, safe);
        if (musingState.day !== day) {
            musingState.day = day;
            musingState.count = 0;
        }
        musingState.lastAt = Date.now();
        musingState.count += 1;
        console.log(`[im-qqbot] 树洞碎碎念${published ? '已发' : '未发'}${imagePath ? '（配图）' : ''}: ${safe.slice(0, 30)}…`);
        return safe;
    };
    const musingTimer = setInterval(() => { void musing(); }, 30 * 60 * 1000);
    if (typeof musingTimer.unref === 'function')
        musingTimer.unref();

    const timer = setInterval(() => { void runOnce(); }, 30 * 60 * 1000);
    if (typeof timer.unref === 'function')
        timer.unref();

    const recall = (evidence) => {
        if (!ENABLED || DRY) return '';
        const match = lookup(evidence);
        return match ? recallLine(match) : '';
    };
    globalThis.__qqbotDiary = { promptLine, runOnce, readAll, event, musing, recall, _test: { anonymize, localDay, imagePrompt, makeImage, channels, archivePublic } };
    console.log(`[im-qqbot] 自传日记已启用（每天 04:00 后写，${DRY ? 'dry 模式不注入不发帖' : '公开版发到树洞频道'}）`);
}
/* <<< dsh-qqbot-patch:diary-helper <<< */

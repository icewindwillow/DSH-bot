/* >>> dsh-qqbot-patch:animation-generation-helper >>> */
/**
 * Multi-turn animation generation through CODEX-CLI.
 * The tool deliberately keeps the conversation state outside the model prompt and
 * only gives CODEX-CLI a private, per-request workspace.
 */
function setupAnimationGeneration(ctx, bot, manager, logger) {
    let tools;
    try { tools = ctx.get('tools'); } catch { return; }
    if (!tools?.register) return;

    const fs = process.getBuiltinModule('node:fs');
    const path = process.getBuiltinModule('node:path');
    const child = process.getBuiltinModule('node:child_process');
    const util = process.getBuiltinModule('node:util');
    const execFile = util.promisify(child.execFile);
    const profileDir = path.resolve(process.env.QQBOT_PROFILE_DIR ?? path.join(process.env.HOME ?? '', '.dsh', 'profiles', 'qqbot'));
    const root = path.join(profileDir, 'generated-animations');
    const states = new Map();
    const MAX_DESCRIPTION = 4000;
    const MAX_SECONDS = 60;
    const MAX_BYTES = 200 * 1024 * 1024;
    const MAX_REFERENCE_IMAGES = 2;
    const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
    const REMOTION_RUNTIME = path.join(root, 'remotion-runtime');
    const WORKSPACE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
    // launchd 的 PATH 里没有 ChatGPT.app 自带的 codex；直接 execFile('codex') 只会 ENOENT。
    // 先找 App 内置二进制，最后才退回 PATH（可用 QQBOT_ANIMATION_CODEX_CLI 覆盖）。
    const bundledCodex = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
    const defaultCodex = (() => {
        try { if (fs.statSync(bundledCodex).isFile()) return bundledCodex; } catch { /* fall through */ }
        return 'codex';
    })();
    const CLI = process.env.QQBOT_ANIMATION_CODEX_CLI || defaultCodex;
    const mediaRoots = [
        path.join(process.env.HOME ?? '', '.dsh-qqbot', 'media'),
        path.join(profileDir, 'media'),
    ];
    const isMediaPath = source => mediaRoots.some(root => source === root || source.startsWith(root + path.sep));
    const SOURCE_LABELS = { blender: '偏好使用 Blender', web: '偏好使用网页/HTML/CSS/Canvas', image: '偏好使用标准图片或图片生成', hybrid: '允许模型组合多种制作手段' };

    function targetFor(exec) {
        try {
            const record = exec?.agent && (manager.findByAgent(exec.agent) ?? manager.findBySessionId?.(exec.agent.session?.header?.id ?? ''));
            const target = record?.replyTarget;
            if (!record || !target || !['group', 'c2c'].includes(target.scope) || !target.targetId)
                return undefined;
            const senderId = String(target.senderId ?? record.__qqbotAnimationSenderId ?? '');
            return { key: `${target.scope}:${target.targetId}:${senderId}`, target, record };
        } catch { return undefined; }
    }

    function cleanText(value, max = MAX_DESCRIPTION) {
        return typeof value === 'string' ? value.trim().slice(0, max) : '';
    }

    function newState() {
        return { source: '', description: '', duration: 0, fps: 0, resolution: '', audio: '', referenceImages: [], referencePerson: '', trustedImages: [], phase: 'collecting', workspace: '', createdAt: Date.now(), updatedAt: Date.now() };
    }

    // 只接受最近 10 分钟内随消息发来的参考图；避免把几小时前的无关图片带进动画。
    function recentImages(record) {
        const at = Number(record?.__qqbotAnimationImagePathsAt ?? 0);
        const paths = Array.isArray(record?.__qqbotAnimationImagePaths) ? record.__qqbotAnimationImagePaths : [];
        return Date.now() - at <= 10 * 60 * 1000 ? paths.slice(0, MAX_REFERENCE_IMAGES) : [];
    }

    // 刚随这条消息发来的图（2 分钟内）：用户明确换了参考图时优先用它。
    function freshImages(record) {
        const at = Number(record?.__qqbotAnimationImagePathsAt ?? 0);
        return Date.now() - at <= 2 * 60 * 1000 ? recentImages(record) : [];
    }

    // ── 人物档案照片 ──────────────────────────────────────────────
    // 人物卡里已经存了「守秘人」等人的照片（face-memory 登记时写进
    // profile.photos / profile.photo）。参考图先取这里，不让用户重新发图。
    function animationPeople() {
        try {
            if (typeof readProfileDocument !== 'function') return [];
            const store = readProfileDocument(profileDir, 'people');
            return Array.isArray(store?.people) ? store.people : [];
        } catch { return []; }
    }

    function animationPersonNames(person) {
        return [person?.name, person?.addressing, ...(Array.isArray(person?.aliases) ? person.aliases : [])]
            .map(name => String(name ?? '').trim())
            .filter(Boolean);
    }

    function animationPersonPhotos(wanted) {
        const query = String(wanted ?? '').trim();
        if (!query) return [];
        const person = animationPeople().find(item => animationPersonNames(item).some(name => name === query));
        if (!person) return [];
        const listed = Array.isArray(person?.profile?.photos) ? person.profile.photos : [];
        const candidates = [...listed, person?.profile?.photo].filter(Boolean).map(photo => photo?.path).filter(Boolean);
        const photos = [];
        for (const photo of candidates) {
            if (photos.includes(photo)) continue;
            try {
                const stat = fs.lstatSync(photo);
                // 档案照片可以在媒体目录之外，但只来自人物卡，不是模型随手传的路径。
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_REFERENCE_IMAGE_BYTES) continue;
            } catch { continue; }
            photos.push(photo);
            if (photos.length >= MAX_REFERENCE_IMAGES) break;
        }
        return photos;
    }

    function animationPersonMentioned(text) {
        const source = String(text ?? '');
        if (!source) return '';
        let best = '';
        for (const person of animationPeople()) {
            for (const name of animationPersonNames(person)) {
                if (name.length < 2 || !source.includes(name)) continue;
                if (name.length > best.length) best = name;
            }
        }
        return best;
    }

    function usePersonPhotos(state, name) {
        const photos = animationPersonPhotos(name);
        if (photos.length === 0) return false;
        state.referenceImages = photos;
        state.referencePerson = String(name ?? '').trim();
        state.trustedImages = photos;
        return true;
    }

    function questionsFor(state) {
        if (!state.source) return { field: 'source', question: '制作手段有偏好吗？可回复「Blender」「网页」「图片」「混合」，也可以说「你来设计」。这只是偏好，本机模型会按镜头需要组合 Blender、网页、图片生成和后期工具。' };
        if (!state.description) return { field: 'description', question: '请描述动画的主体、叙事、动作、镜头、节奏和风格（越具体越好）。本机模型会据此决定是否组合 Blender、网页、图片生成和后期处理。' };
        if (!state.duration) return { field: 'duration', question: '动画时长要几秒？目前支持 1–60 秒。' };
        if (!state.resolution) return { field: 'resolution', question: '输出画幅要多大？例如 1920x1080、1080x1920 或 1024x1024。' };
        if (!state.fps) return { field: 'fps', question: '帧率要多少？支持 12、24、30 或 60。' };
        if (!state.audio) return { field: 'audio', question: '需要声音吗？回复「无声」，或描述配乐/音效需求（不会自动下载版权音乐）。' };
        if (state.referenceImages.length === 0) return { field: 'reference', question: '最后确认：需要图片参考吗？可以引用或发送一张图，也可以直接说人物名（用档案里存的照片）；不需要就回复「不用图片」。' };
        return undefined;
    }

    function parseAnswer(field, answer, state) {
        const text = cleanText(answer);
        if (!text) return '请给出这一项的具体内容。';
        if (field === 'source') {
            if (/混合|组合|都可以|你来|你决定|不限|综合/i.test(text)) state.source = 'hybrid';
            else if (/blender|三维|3d|模型/i.test(text)) state.source = 'blender';
            else if (/网页|html|css|canvas|web/i.test(text)) state.source = 'web';
            else if (/图片|照片|png|jpg|序列|生成图/i.test(text)) state.source = 'image';
            else return '制作手段没识别出来，请回复「Blender」「网页」「图片」「混合」，或说「你来设计」。';
        } else if (field === 'duration') {
            const n = Number((text.match(/\d+(?:\.\d+)?/) || [])[0]);
            if (!Number.isFinite(n) || n < 1 || n > MAX_SECONDS) return '时长请填写 1–60 秒之间的数字。';
            state.duration = n;
        } else if (field === 'fps') {
            const n = Number((text.match(/\d+/) || [])[0]);
            if (![12, 24, 30, 60].includes(n)) return '帧率只支持 12、24、30 或 60。';
            state.fps = n;
        } else if (field === 'resolution') {
            const m = text.match(/(\d{3,5})\s*[x×]\s*(\d{3,5})/i);
            if (!m || Number(m[1]) > 4096 || Number(m[2]) > 4096) return '请用宽x高填写画幅，单边不超过 4096，例如 1920x1080。';
            state.resolution = `${m[1]}x${m[2]}`;
        } else if (field === 'description') state.description = text;
        else if (field === 'reference') { if (!/不用|不需要|无图|没有|没图|跳过/i.test(text)) return '请引用或发送图片、说人物名（用档案照片），或回复「不用图片」。'; state.referenceImages = ['__none__']; }
        else if (field === 'audio') state.audio = text;
        state.updatedAt = Date.now();
        return undefined;
    }

    function cleanupWorkspaces() {
        let removed = 0;
        try {
            for (const name of fs.readdirSync(root)) {
                if (!name.startsWith('request-')) continue;
                const dir = path.join(root, name);
                try {
                    const stat = fs.lstatSync(dir);
                    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
                    if (Date.now() - stat.mtimeMs <= WORKSPACE_RETENTION_MS) continue;
                    fs.rmSync(dir, { recursive: true, force: true });
                    removed += 1;
                } catch { /* 单个坏目录不能拖住整次清理 */ }
            }
        } catch { /* 根目录还没建 */ }
        if (removed > 0) logger?.info?.(`[im-qqbot] 动画工作区清理: ${removed} 个超过 7 天的目录`);
    }
    cleanupWorkspaces();

    function safeWorkspace() {
        // 每次开新任务前顺手清理，长进程也不会一直堆旧 MP4。
        cleanupWorkspaces();
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        const dir = fs.mkdtempSync(path.join(root, 'request-'));
        fs.chmodSync(dir, 0o700);
        return dir;
    }

    function stageReferenceImages(workspace, state) {
        const inputDir = path.join(workspace, 'input');
        fs.mkdirSync(inputDir, { recursive: true, mode: 0o700 });
        const staged = [];
        const trusted = new Set(Array.isArray(state.trustedImages) ? state.trustedImages : []);
        for (const [index, source] of state.referenceImages.entries()) {
            if (source === '__none__') continue;
            let stat;
            try {
                stat = fs.lstatSync(source);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_REFERENCE_IMAGE_BYTES) continue;
                // 只接受机器人媒体目录里的图，或人物卡里登记过的档案照片，避免把任意本地路径当成参考图。
                if (!isMediaPath(source) && !trusted.has(source)) continue;
            } catch { continue; }
            const original = path.basename(source).replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^\.+/u, '_');
            const name = `${String(index + 1).padStart(2, '0')}-${original || 'reference-image'}`;
            const target = path.join(inputDir, name);
            try {
                fs.copyFileSync(source, target);
                staged.push(target);
            } catch { /* an unavailable reference is handled by the final empty check */ }
        }
        state.referenceImages = staged;
        return staged;
    }

    function validateProductionArtifacts(workspace) {
        const required = ['storyboard.md', 'motion-plan.json'];
        for (const name of required) {
            const file = path.join(workspace, name);
            if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`缺少动画制作文件 ${name}`);
        }
        const assets = path.join(workspace, 'assets');
        const frames = path.join(workspace, 'storyboard-frames');
        if (!fs.existsSync(assets) || !fs.statSync(assets).isDirectory()
            || !fs.readdirSync(assets).some(name => !name.startsWith('.'))) throw new Error('缺少拆分后的动画素材');
        if (!fs.existsSync(frames) || !fs.statSync(frames).isDirectory()
            || fs.readdirSync(frames).filter(name => /\.(?:png|jpg|jpeg|webp)$/i.test(name)).length < 4) throw new Error('缺少逐镜头重绘画面');
        const engine = fs.readFileSync(path.join(workspace, 'motion-plan.json'), 'utf8');
        if (!/remotion/i.test(engine)) throw new Error('MVP 必须使用 Remotion 输出管线');
        if (!fs.existsSync(REMOTION_RUNTIME)) throw new Error('Remotion runtime 未安装');
    }

    async function runCodex(workspace, state, signal, mode = 'video') {
        const references = state.referenceImages.filter(item => item !== '__none__');
        const prompt = [
            mode === 'storyboard'
                ? '你是动画总导演和视觉资产绘图师。当前阶段只生成分镜预览，不要生成 MP4。'
                : '你是动画总导演、视觉资产拆分师和执行代理。请把参考图转化为一个约定时长的原创短动画，并实际输出 animation.mp4。',
            '先分析参考图的角色、道具、材质、色彩、构图和可动区域，再建立视觉设定表。必须把参考图重绘或拆分成可动画化的本地素材，保存到 assets/，至少包含角色主体、关键道具、背景或场景层，以及需要独立运动的部件。不要把原图直接做简单平移缩放作为最终方案。',
            '必须先写 storyboard.md，包含每个镜头的时间段、景别、构图、镜头运动、角色动作、道具动作、字幕和声音。必须再写 motion-plan.json，记录素材清单、动作关键帧、镜头关键帧、字幕、声音和 render_engine。',
            `本 MVP 固定使用 Remotion 完成时间轴、镜头、字幕、声音和 MP4 渲染。Remotion runtime 已安装在 ${REMOTION_RUNTIME}，请在工作区创建 package.json、src/Root.jsx 或等价 Remotion 项目，并调用该 runtime 渲染。可以用本机绘图能力生成 storyboard-frames，也可以用 Pillow 或 SVG 做后处理，但最终视频必须使用每个完整分镜画面作为画面基础。`,
            '每个分镜画面都应独立绘制出完整构图。至少四张分镜图之间要有明确变化，例如眼神、手臂、叉子、立牌、反光、遮挡、景别或镜头位置变化。Remotion 负责在完整分镜之间做节奏、转场和轻微镜头运动。',
            '如果需要声音，请使用本地合成音效或本地 TTS，不要联网下载素材。字幕和声音必须写入分镜与 motion-plan.json。',
            '需求 JSON：', JSON.stringify({ productionPreference: SOURCE_LABELS[state.source], description: state.description, durationSeconds: state.duration, resolution: state.resolution, fps: state.fps, audio: state.audio, referenceImages: references.length }),
            mode === 'storyboard'
                ? '当前阶段完成后只需确保 storyboard-frames/ 至少有四张完整分镜图、storyboard.md 和 motion-plan.json。不要编码 MP4。'
                : '完成后用 ffprobe 检查 animation.mp4 的编码、像素格式、分辨率、帧率和时长，并确保最终文件位于当前工作区根目录。',
        ].join('\n');
        const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--approve-for-me', ...references.flatMap(file => ['-i', file]), '-C', workspace, prompt];
        const result = await execFile(CLI, args, { cwd: workspace, encoding: 'utf8', timeout: 20 * 60 * 1000, maxBuffer: 2 * 1024 * 1024, signal, env: { ...process.env, REMOTION_RUNTIME } });
        return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    }

    function findMp4(workspace) {
        const found = [];
        const walk = (dir) => {
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                if (entry.name.startsWith('.')) continue;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mp4')) found.push(full);
            }
        };
        walk(workspace);
        const preferred = found.find(item => path.basename(item).toLowerCase() === 'animation.mp4');
        const file = preferred ?? found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
        if (!file) throw new Error('CODEX-CLI 没有生成 MP4 文件');
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BYTES) throw new Error('生成的 MP4 大小不符合限制');
        return file;
    }

    function result(status, message, extra = {}) { return { ok: status === 'sent' || status === 'needs_input', status, message, ...extra }; }

    tools.register({
        name: 'animation_generation',
        description: [
            '通过多轮问答生成动画。信息收齐后先调用 CODEX-CLI 生成四张以上完整分镜图并发送，工具会暂停等待原需求者许可。只有收到“许可”“批准”“继续做视频”等明确同意，才调用 action=approve 继续生成和发送 MP4。',
            '支持本机模型统筹 Blender、网页、图片生成、镜头和后期等多种手段。Blender、网页或图片只是可组合的偏好，不代表固定主流程。只有确实要制作动画时调用；普通讨论、只要代码或只要静态图片不要调用。',
            '需求里点名了人物（例如“给守秘人做个动画”）时传 personName，工具会直接从人物档案的照片取参考图，不要让用户重新发图。',
            '生成过程可能需要数分钟，不要并发调用、不要自动重试。',
        ].join(''),
        parameters: { type: 'object', additionalProperties: false, properties: {
            action: { type: 'string', enum: ['start', 'answer', 'approve', 'cancel'], description: '开始收集需求、回答问题、批准分镜后继续生成视频，或取消任务' },
            answer: { type: 'string', description: '对工具上一个问题的回答，最多4000字' },
            description: { type: 'string', description: '也可以在 start 时直接提供完整动画描述' },
            personName: { type: 'string', description: '人物档案名（如“守秘人”）。需求点名人物或说“用他的照片”时传入，工具会用人物卡里存的照片做参考图。' },
        }, required: ['action'] },
        output: { schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, status: { type: 'string' }, message: { type: 'string' } }, required: ['ok', 'status', 'message'] }, render: (_args, value) => [{ type: 'text', text: value.message }] },
        isConcurrencySafe: () => false,
        timeoutMs: 22 * 60 * 1000,
        async execute(args, exec) {
            const targetInfo = targetFor(exec);
            if (!targetInfo) return result('not_authorized', '无法确认当前 QQ 会话，动画不会生成。');
            const { key, target, record } = targetInfo;
            if (args?.action === 'cancel') { states.delete(key); return result('cancelled', '已取消当前动画需求。'); }
            let state = states.get(key);
            if (state && Date.now() - state.updatedAt > 30 * 60 * 1000) { states.delete(key); state = undefined; }
            if (args?.action === 'start') {
                state = newState();
                const initial = cleanText(args?.description);
                if (initial) state.description = initial;
                const fresh = freshImages(record);
                const named = cleanText(args?.personName, 60) || animationPersonMentioned(state.description);
                // 刚发来的图优先；没有的话先看人物档案，最后才用 10 分钟内的旧图。
                if (fresh.length > 0) state.referenceImages = fresh;
                else if (!named || !usePersonPhotos(state, named)) state.referenceImages = recentImages(record);
                states.set(key, state);
            } else if (!['answer', 'approve'].includes(args?.action)) return result('invalid_request', 'action 只能是 start、answer、approve 或 cancel。');
            if (args?.action === 'approve') {
                if (!state || state.phase !== 'storyboard_ready' || !state.workspace)
                    return result('needs_input', '当前没有等待许可的分镜，请先开始一次动画需求。');
                const workspace = state.workspace;
                const signal = AbortSignal.timeout(20 * 60 * 1000);
                try {
                    await runCodex(workspace, state, signal, 'video');
                    validateProductionArtifacts(workspace);
                    const file = findMp4(workspace);
                    const sent = await bot.sendVideo(target, { localPath: file }, { content: `动画已生成（${state.duration} 秒，${state.resolution}，${state.fps} fps）` });
                    if (!sent?.message) return result('delivery_failed', 'MP4 已生成，但 QQ 没有返回发送回执。');
                    states.delete(key);
                    record.__qqbotAnimationImagePaths = [];
                    record.__qqbotAnimationImagePathsAt = 0;
                    return result('sent', `分镜已获许可，动画已生成并发送 MP4（${state.duration} 秒）。`, { path: file });
                } catch (error) {
                    logger?.warn?.(`[im-qqbot] approved animation generation failed: ${error instanceof Error ? error.message : String(error)}`);
                    return result('generation_failed', '分镜获许可后生成视频失败，没有发送 MP4。');
                }
            }
            if (args?.action === 'answer') {
                if (!state) return result('no_draft', '当前会话没有待回答的动画需求，请先重新开始。');
                let answeredByProfile = false;
                const question = questionsFor(state);
                // 问到参考图时，用户可以直接说人物名，从人物卡里取照片，不必再发一遍。
                if (question?.field === 'reference') {
                    const named = cleanText(args?.personName, 60) || animationPersonMentioned(args?.answer);
                    if (named !== '') {
                        answeredByProfile = usePersonPhotos(state, named);
                        if (!answeredByProfile)
                            return result('needs_input', `人物档案里没有 ${named} 可用的照片，请引用或发送一张，或回复「不用图片」。`, { field: 'reference' });
                    }
                }
                if (!answeredByProfile) {
                    if (state.referenceImages.length === 0) state.referenceImages = recentImages(record);
                    const error = parseAnswer(question?.field, args?.answer, state);
                    if (error) return result('needs_input', error, { field: question?.field, question: error });
                }
            }
            const question = questionsFor(state);
            if (question) return result('needs_input', question.question, question);
            state.referenceImages = state.referenceImages.filter(file => {
                if (file === '__none__') return true;
                try { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_REFERENCE_IMAGE_BYTES; }
                catch { return false; }
            });
            if (state.referenceImages.length === 0) return result('needs_input', '参考图片不可用，请重新引用或发送图片，或重新开始时选择不用图片。', { field: 'reference' });
            const noReference = state.referenceImages.includes('__none__');
            const workspace = safeWorkspace();
            const signal = AbortSignal.timeout(20 * 60 * 1000);
            try {
                stageReferenceImages(workspace, state);
                if (!noReference && state.referenceImages.length === 0)
                    return result('needs_input', '参考图片无法复制到动画工作区，请重新发送图片后再开始。', { field: 'reference' });
                logger?.info?.(`[im-qqbot] animation storyboard start source=${state.source} target=${key}`);
                await runCodex(workspace, state, signal, 'storyboard');
                const storyboard = path.join(workspace, 'storyboard-frames');
                const frames = fs.readdirSync(storyboard).filter(name => /\.(?:png|jpg|jpeg|webp)$/i.test(name)).sort().slice(0, 4);
                if (frames.length < 4) throw new Error('分镜图不足四张');
                for (const name of frames) {
                    const sent = await bot.sendImage(target, { localPath: path.join(storyboard, name) });
                    if (!sent?.message) throw new Error(`分镜图发送失败 ${name}`);
                }
                state.phase = 'storyboard_ready';
                state.workspace = workspace;
                state.updatedAt = Date.now();
                states.set(key, state);
                return result('needs_approval', '分镜图已发送。请确认分镜后回复“许可”“批准”或调用 action=approve，我再继续生成 MP4。', { workspace, frames });
            } catch (error) {
                logger?.warn?.(`[im-qqbot] animation storyboard failed: ${error instanceof Error ? error.message : String(error)}`);
                return result('generation_failed', '分镜生成失败，没有开始视频制作。');
            }
        },
    });
    const sendAnimationVideo = async ({ groupOpenid, file, content = '动画已生成' } = {}) => {
        const gid = String(groupOpenid ?? '').trim();
        const requested = path.resolve(String(file ?? ''));
        const base = path.resolve(root);
        const relative = path.relative(base, requested);
        if (!/^[A-Za-z0-9_-]{16,128}$/.test(gid) || relative.startsWith('..') || path.isAbsolute(relative))
            throw new Error('invalid animation delivery target');
        const stat = fs.lstatSync(requested);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_BYTES)
            throw new Error('invalid animation output');
        const sent = await bot.sendVideo({ scope: 'group', targetId: gid }, { localPath: requested }, { content: String(content).slice(0, 120) });
        if (!sent?.message) throw new Error('QQ 没有返回视频发送回执');
        return { ok: true, messageId: sent.message.id ?? null, file: requested };
    };
    globalThis.__qqbotAnimationSendVideo = sendAnimationVideo;
    ctx.on?.('dispose', () => { if (globalThis.__qqbotAnimationSendVideo === sendAnimationVideo) delete globalThis.__qqbotAnimationSendVideo; });
    console.log('[im-qqbot] 动画生成工具已注册（多轮需求 + CODEX-CLI + MP4）');
}
/* <<< dsh-qqbot-patch:animation-generation-helper <<< */

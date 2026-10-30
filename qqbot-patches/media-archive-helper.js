/* >>> dsh-qqbot-patch:media-archive-helper >>> */
/**
 * 媒体库：把群里分享的图片复制到机器人自己的目录，并建可搜索索引。
 *
 * 存储优先级：
 *   1. <profile>/media/          （机器人目录，默认 ~/.dsh/profiles/qqbot/media）
 *   2. ~/.dsh/qqbot-media/       （机器人目录不可写时退到 DSH 下）
 * 数据库：<mediaDir>/index.db（SQLite）
 *
 * 能力：
 *   - 收图时复制 + 按内容 sha 去重，QQ 清理临时图也不丢
 *   - media_search：按关键词 / 人 / 群搜图，返回 id + 本地路径 + 上下文
 *   - media_send：按 id 把图发回当前会话（不依赖 qqbot_send_file 的路径白名单）
 */
function setupMediaArchive(ctx, bot, manager, config, logger) {
    const fs = process.getBuiltinModule?.('node:fs');
    const os = process.getBuiltinModule?.('node:os');
    const path = process.getBuiltinModule?.('node:path');
    const crypto = process.getBuiltinModule?.('node:crypto');
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    if (!fs || !os || !path || !crypto || !sqlite) {
        console.log('[im-qqbot] 媒体库未启用：缺少 node:fs/os/path/crypto/sqlite');
        return;
    }

    const home = os.homedir();
    const profileDir = process.env.QQBOT_PROFILE_DIR ?? `${home}/.dsh/profiles/qqbot`;
    const candidates = [`${profileDir}/media`, `${home}/.dsh/qqbot-media`];
    let mediaDir = '';
    for (const dir of candidates) {
        try {
            fs.mkdirSync(dir, { recursive: true });
            const probe = `${dir}/.write-test`;
            fs.writeFileSync(probe, 'ok');
            fs.unlinkSync(probe);
            mediaDir = dir;
            break;
        }
        catch {
            // 换下一个目录
        }
    }
    if (mediaDir === '') {
        console.log('[im-qqbot] 媒体库未启用：没有可写目录');
        return;
    }

    const dbPath = `${mediaDir}/index.db`;
    let db;
    try {
        db = new sqlite.DatabaseSync(dbPath);
        db.exec('PRAGMA busy_timeout = 5000');
        db.exec(`
            CREATE TABLE IF NOT EXISTS media (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sha256 TEXT NOT NULL UNIQUE,
                path TEXT NOT NULL,
                group_id TEXT NOT NULL DEFAULT '',
                group_name TEXT NOT NULL DEFAULT '',
                sender_id TEXT NOT NULL DEFAULT '',
                sender_name TEXT NOT NULL DEFAULT '',
                caption TEXT NOT NULL DEFAULT '',
                context TEXT NOT NULL DEFAULT '',
                source_path TEXT NOT NULL DEFAULT '',
                bytes INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_media_group ON media(group_id);
            CREATE INDEX IF NOT EXISTS idx_media_sender ON media(sender_name);
            CREATE INDEX IF NOT EXISTS idx_media_time ON media(created_at);
            CREATE TABLE IF NOT EXISTS media_likes (
                media_id INTEGER PRIMARY KEY,
                reason TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '',
                liked_by TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_media_likes_time ON media_likes(created_at);
        `);
    }
    catch (err) {
        console.log(`[im-qqbot] 媒体库未启用：打开索引失败 ${err.message}`);
        return;
    }

    let groupNames = new Map();
    try {
        const meta = JSON.parse(fs.readFileSync(`${profileDir}/qqbot-groups-meta.json`, 'utf8'));
        groupNames = new Map((Array.isArray(meta?.groups) ? meta.groups : []).map((g) => [String(g.id), String(g.name ?? '')]));
    }
    catch {
        groupNames = new Map();
    }

    const canonicalName = (openid, fallback) => {
        if (!openid)
            return fallback;
        try {
            const store = JSON.parse(fs.readFileSync(`${profileDir}/qqbot-people.json`, 'utf8'));
            const person = (store.people ?? []).find((p) => p && Array.isArray(p.openids) && p.openids.includes(openid));
            return String(person?.addressing || person?.name || fallback || '').trim();
        }
        catch {
            return fallback;
        }
    };

    const mediaAllowPath = `${profileDir}/qqbot-media-allow.json`;
    const readMediaAllow = () => {
        try {
            const parsed = JSON.parse(fs.readFileSync(mediaAllowPath, 'utf8'));
            return Array.isArray(parsed?.people) ? parsed.people : [];
        }
        catch {
            return [];
        }
    };
    const mediaAllowEntry = (gid, senderId, senderName) => {
        const people = readMediaAllow();
        if (people.length === 0)
            return undefined;
        const canonical = canonicalName(senderId, senderName).trim();
        const raw = String(senderName ?? '').trim();
        return people.find((person) => {
            if (!person || typeof person !== 'object')
                return false;
            if (Array.isArray(person.groups) && person.groups.length > 0 && !person.groups.includes(gid))
                return false;
            if (Array.isArray(person.openids) && person.openids.includes(senderId))
                return true;
            const names = [person.name, person.addressing, ...(Array.isArray(person.aliases) ? person.aliases : [])]
                .filter((name) => typeof name === 'string' && name.trim() !== '')
                .map((name) => name.trim());
            return names.includes(canonical) || names.includes(raw);
        });
    };

    const detectMediaType = (bytes) => {
        if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8) return 'image/jpeg';
        if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png';
        if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
        if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
            && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
        return 'image/jpeg';
    };

    /** 视觉分类：美食 / 人像 / 梗图 / 表情包 / 其他；失败返回空串，交给文字兜底 */
    const classifyImageCategory = async (sourcePath) => {
        const vision = config?.vision ?? {};
        if (vision.enabled !== true || !vision.provider || !vision.model)
            return '';
        let llm;
        let attachments;
        try {
            llm = ctx.get('llm');
            attachments = ctx.get('attachments');
        }
        catch {
            return '';
        }
        if (!llm?.stream || !attachments?.saveImage)
            return '';
        try {
            const bytes = fs.readFileSync(sourcePath);
            const mediaType = detectMediaType(bytes);
            const ref = await attachments.saveImage({ data: bytes, mediaType, name: path.basename(sourcePath) });
            const { BlockAssembler, createUserMessage } = await import('@deepseek-ai/dsh-llm');
            const message = createUserMessage({
                content: [
                    { type: 'image', attachment: ref },
                    { type: 'text', text: '只输出一个词，不要解释：美食 / 人像 / 梗图 / 表情包 / 其他。美食=食物饮品菜品；人像=真人自拍或人物照片；梗图=网络搞笑图/带字meme；表情包=卡通/表情/贴纸类；其他=风景/截图/物品/游戏画面等。' },
                ],
                source: { kind: 'plugin', plugin: 'dsh-im-qqbot' },
            });
            const assembler = new BlockAssembler();
            for await (const chunk of llm.stream({
                provider: vision.provider,
                model: vision.model,
                messages: [message],
                maxTokens: 64,
                signal: AbortSignal.timeout(15000),
            }))
                assembler.push(chunk);
            const text = assembler.blocks().filter((block) => block.type === 'text').map((block) => block.text).join(' ').trim();
            for (const category of ['美食', '人像', '梗图', '表情包'])
                if (text.includes(category)) return category;
            return '其他';
        }
        catch (err) {
            console.log(`[im-qqbot] 媒体分类失败: ${String(err?.message ?? err).slice(0, 80)}`);
            return '';
        }
    };

    const cleanText = (text) => String(text ?? '')
        .replace(/^\s*-\s*Image:[^\n]*/gm, '')
        .replace(/\[(图片|视频|文件|表情)[^\]]*\]/g, '')
        .replace(/^\s*\[[^\]]*\([0-9A-F]+\)\]\s*/, '')
        .replace(/\s+/g, ' ')
        .trim();

    const insert = db.prepare(`
        insert into media (sha256, path, group_id, group_name, sender_id, sender_name, caption, context, source_path, bytes, created_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const findBySha = db.prepare('select id, caption, context, group_id, sender_name from media where sha256 = ?');
    const updateMeta = db.prepare('update media set caption = ?, context = ?, group_id = ?, group_name = ?, sender_id = ?, sender_name = ? where id = ?');
    const likeUpsert = db.prepare(`
        insert into media_likes (media_id, reason, tags, liked_by, created_at)
        values (?, ?, ?, ?, ?)
        on conflict(media_id) do update set
            reason = excluded.reason,
            tags = excluded.tags,
            liked_by = excluded.liked_by,
            created_at = excluded.created_at
    `);
    const likeDelete = db.prepare('delete from media_likes where media_id = ?');

    const detectImageExt = (bytes) => {
        if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8)
            return '.jpg';
        if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47)
            return '.png';
        if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
            return '.gif';
        if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
            && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50)
            return '.webp';
        if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4D)
            return '.bmp';
        return '';
    };

    const archiveFile = (sourcePath, meta) => {
        try {
            if (typeof sourcePath !== 'string' || !sourcePath.startsWith('/') || !fs.existsSync(sourcePath))
                return false;
            const stat = fs.statSync(sourcePath);
            if (!stat.isFile() || stat.size === 0)
                return false;
            if (sourcePath.startsWith(`${mediaDir}/`))
                return false;
            const bytes = fs.readFileSync(sourcePath);
            const sha = crypto.createHash('sha256').update(bytes).digest('hex');
            // QQ 临时文件经常扩展名和真实格式不一致（.png 里装 JPEG），按魔数判断
            const ext = detectImageExt(bytes) || (path.extname(sourcePath) || '.jpg').toLowerCase();
            const dest = `${mediaDir}/${sha}${ext}`;
            if (!fs.existsSync(dest))
                fs.copyFileSync(sourcePath, dest);

            const existing = findBySha.get(sha);
            if (existing) {
                const caption = String(meta.caption ?? '').trim();
                const context = String(meta.context ?? '').trim().slice(0, 1500);
                if ((!existing.caption || existing.caption === '图片') && caption && caption !== '图片')
                    updateMeta.run(caption, context || existing.context, meta.groupId ?? existing.group_id, meta.groupName ?? '', meta.senderId ?? '', meta.senderName ?? existing.sender_name, existing.id);
                else if (!existing.context && context)
                    updateMeta.run(existing.caption, context, meta.groupId ?? existing.group_id, meta.groupName ?? '', meta.senderId ?? '', meta.senderName ?? existing.sender_name, existing.id);
                return false;
            }
            insert.run(
                sha, dest,
                String(meta.groupId ?? ''), String(meta.groupName ?? ''),
                String(meta.senderId ?? ''), String(meta.senderName ?? ''),
                String(meta.caption ?? '图片').slice(0, 200), String(meta.context ?? '').slice(0, 1500),
                sourcePath, stat.size, Date.now(),
            );
            console.log(`[im-qqbot] 媒体归档: ${String(meta.caption ?? '图片').slice(0, 30) || '图片'} (${sha.slice(0, 8)}…)`);
            return true;
        }
        catch (err) {
            console.log(`[im-qqbot] 媒体归档失败: ${err.message}`);
            return false;
        }
    };

    /** 读象信 key：环境变量优先，其次 ~/.dsh/.credentials.yaml */
    const xiangxinKey = () => {
        if (String(process.env.XIANGXIN_API_KEY ?? '').trim() !== '')
            return String(process.env.XIANGXIN_API_KEY).trim();
        try {
            const text = fs.readFileSync(`${home}/.dsh/.credentials.yaml`, 'utf8');
            const match = text.match(/XIANGXIN_API_KEY:\s*(\S+)/);
            return match ? match[1].trim() : '';
        }
        catch {
            return '';
        }
    };

    /** 判断这张图是不是「分享人自己的生活 / 亲身经历 / 特别感想」；普通梗图、网图、表情包不归档 */
    const judgePersonalShare = async (state) => {
        const key = xiangxinKey();
        if (key === '')
            return { personal: 0, worth: 0, error: 'no-key' };
        try {
            const res = await fetch('https://api.xiangxinai.cn/v1/systemone', {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
                body: JSON.stringify({
                    model: 'xiangxin-latest',
                    state,
                    questions: {
                        personal: {
                            type: 'noul',
                            instructions: '这段内容是否在分享说话人自己的生活、亲身经历、近况、旅行/吃喝/购物/收藏体验，或带有特别的感想/情绪？普通表情包、网图、梗图、转发资讯、别人拍的图不算。',
                        },
                        worth: {
                            type: 'noul',
                            instructions: '这张图/这段分享是否值得以后拿出来回忆、再发或作为聊天素材？',
                        },
                    },
                }),
                signal: AbortSignal.timeout(8000),
            });
            if (!res.ok)
                return { personal: 0, worth: 0, error: `HTTP ${res.status}` };
            const json = await res.json();
            return {
                personal: Number(json.answers?.personal?.noul ?? 0),
                worth: Number(json.answers?.worth?.noul ?? 0),
                error: '',
            };
        }
        catch (err) {
            return { personal: 0, worth: 0, error: String(err?.message ?? err) };
        }
    };

    /** 象信不可用时的兜底：只认「我 + 生活事件」或两个以上生活词；宁可少收，不乱收 */
    const looksPersonalShare = (text) => {
        const value = String(text ?? '');
        if (value.trim() === '')
            return false;
        const hints = ['最近', '今天', '昨天', '前天', '上周', '去年', '今年', '之前', '后来', '终于', '第一次', '买了', '入手', '去了', '吃了', '喝了', '旅行', '出差', '回家', '家里', '公司', '加班', '生病', '医院', '猫', '狗', '孩子', '老婆', '老公', '男朋友', '女朋友', '生活', '日常'];
        const hits = hints.filter((word) => value.includes(word)).length;
        const feeling = /开心|难受|喜欢|讨厌|舍不得|怀念|回忆|感想|觉得|第一次|终于/.test(value);
        return (/(我|咱)/.test(value) && (hits >= 1 || feeling)) || hits >= 2;
    };

    const archive = async (mCtx) => {
        try {
            const msg = mCtx?.message;
            if (!msg || msg.kind !== 'group' || !msg.groupOpenid)
                return;
            const content = String(msg.content ?? '');
            const paths = new Set();
            for (const match of content.matchAll(/-\s*Image:\s*(\/[^\s]+)/g))
                paths.add(match[1]);
            for (const attachment of (Array.isArray(msg.attachments) ? msg.attachments : [])) {
                const local = attachment?.localPath ?? attachment?.path ?? attachment?.filePath;
                if (typeof local === 'string' && local.startsWith('/'))
                    paths.add(local);
            }
            if (paths.size === 0)
                return;
            const gid = String(msg.groupOpenid);
            const senderName = canonicalName(msg.senderId, String(msg.senderName ?? '').trim());
            const rawName = String(msg.senderName ?? '').trim();
            const recentEntries = globalThis.__qqbotRecentMessages?.get?.(gid) ?? [];
            const sameSender = recentEntries.filter((m) => String(m.name ?? '') === rawName).slice(-5)
                .map((m) => cleanText(m.content).slice(0, 180))
                .filter(Boolean);
            const caption = cleanText(content)
                || (sameSender.length > 0 ? sameSender[sameSender.length - 1].slice(0, 80) : '')
                || '图片';
            const recent = recentEntries.slice(-8)
                .map((m) => `${m.name ?? ''}: ${cleanText(m.content).slice(0, 160)}`)
                .filter((line) => line.trim() !== ':')
                .join('\n')
                .slice(0, 1500);
            // 只有「说话人自己的生活/经历/感想」才归档；普通梗图、表情包、网图一律不转
            // 收图/放图名单：由本地管理员配置。按 categories 用视觉分类，梗图/表情包排除；
            // 视觉不可用时只用文字线索保守兜底，不把整包图都收进来。
            const allowEntry = mediaAllowEntry(gid, msg.senderId, senderName);
            const allowCategories = Array.isArray(allowEntry?.categories)
                ? allowEntry.categories.map((category) => String(category ?? '').trim()).filter(Boolean)
                : [];
            let allowlisted = false;
            let allowCategory = '';
            if (allowEntry) {
                const source = paths.values().next().value;
                allowCategory = source ? await classifyImageCategory(source) : '';
                const text = [caption, ...sameSender].join('\n');
                const memeText = /梗图|表情包|表情|哈哈|笑死|草|乐|绷|图包|meme/i.test(text);
                if (allowCategory !== '') {
                    allowlisted = allowCategory !== '梗图' && allowCategory !== '表情包'
                        && (allowCategories.length === 0 || allowCategories.includes(allowCategory));
                }
                else if (!memeText) {
                    if (allowCategories.length === 0)
                        allowlisted = true;
                    else if (allowCategories.includes('美食') && /美食|吃|喝|饭|菜|餐|咖啡|酒|茶|甜品/i.test(text))
                        allowlisted = true;
                    else if (allowCategories.includes('人像') && /自拍|人像|照片|拍|脸|妆|穿|裙|合影/i.test(text))
                        allowlisted = true;
                }
                console.log(`[im-qqbot] 媒体名单判定: ${senderName} category=${allowCategory || '?'} categories=${allowCategories.join('/') || '全部'} → ${allowlisted ? '放行' : '跳过'}`);
            }
            // 测试/显式工具可以临时跳过判定；正常收图不设这个全局
            const verdict = allowlisted || globalThis.__qqbotMediaForceArchive === true
                ? { personal: 1, worth: 1, error: '' }
                : await judgePersonalShare({
                    说话人: senderName,
                    最近消息: sameSender.length > 0 ? sameSender.join('\n') : '（无）',
                    图片说明: caption,
                    当前消息: cleanText(content) || '（只有图片）',
                });
            const judgeFailed = verdict.error !== '' && verdict.error !== 'no-key';
            const fallback = judgeFailed && looksPersonalShare([caption, ...sameSender].join('\n'));
            if (verdict.personal < 0.6 && !fallback) {
                console.log(`[im-qqbot] 媒体跳过: ${senderName} personal=${verdict.personal.toFixed(2)} worth=${verdict.worth.toFixed(2)}${verdict.error ? ` (${verdict.error})` : ''}`);
                return;
            }
            if (allowlisted)
                console.log(`[im-qqbot] 媒体名单放行: ${senderName} @ ${gid.slice(0, 8)}… → 归档`);
            else if (fallback)
                console.log(`[im-qqbot] 媒体判定失败（${verdict.error}），按生活关键词兜底：${senderName}`);
            else
                console.log(`[im-qqbot] 媒体判定: ${senderName} personal=${verdict.personal.toFixed(2)} worth=${verdict.worth.toFixed(2)} → 归档`);
            for (const source of paths)
                archiveFile(source, {
                    groupId: gid,
                    groupName: groupNames.get(gid) ?? '',
                    senderId: String(msg.senderId ?? ''),
                    senderName,
                    caption,
                    context: recent,
                });
        }
        catch (err) {
            console.log(`[im-qqbot] 媒体归档异常: ${err.message}`);
        }
    };

    const normalizeTags = (tags) => {
        const list = Array.isArray(tags) ? tags : String(tags ?? '').split(/[,，、#\s]+/);
        return [...new Set(list
            .map((tag) => String(tag ?? '').trim().replace(/^#+/, ''))
            .filter(Boolean))]
            .slice(0, 5)
            .map((tag) => tag.slice(0, 20))
            .join(',');
    };

    /** 按 id / 本地路径 / 内容 sha 定位媒体库里的记录 */
    const locateMedia = (args) => {
        const id = Number(args?.id);
        if (Number.isInteger(id) && id > 0)
            return db.prepare('select * from media where id = ?').get(id);
        const image = String(args?.image ?? '').trim();
        if (image === '')
            return undefined;
        let row = db.prepare('select * from media where path = ? or source_path = ? order by id desc limit 1').get(image, image);
        if (row)
            return row;
        if (!fs.existsSync(image))
            return undefined;
        try {
            const bytes = fs.readFileSync(image);
            const sha = crypto.createHash('sha256').update(bytes).digest('hex');
            row = db.prepare('select * from media where sha256 = ?').get(sha);
            return row;
        }
        catch {
            return undefined;
        }
    };

    /** 收藏失败时按需补归档（例如归档发生在机器人启动前 / 临时图还没进库） */
    const archiveAndLocate = (image) => {
        const direct = locateMedia({ image });
        if (direct)
            return direct;
        try {
            if (!fs.existsSync(image))
                return undefined;
            const gid = String(globalThis.__qqbotLastGid ?? '');
            const feedback = globalThis.__qqbotFeedbackContexts?.get?.(gid);
            const speaker = feedback?.speaker ?? globalThis.__qqbotSpeakers?.get?.(gid);
            const senderName = feedback?.person
                || canonicalName(speaker?.id, String(speaker?.name ?? '').trim())
                || '图片';
            const recent = (globalThis.__qqbotRecentMessages?.get?.(gid) ?? []).slice(-8)
                .map((m) => `${m.name ?? ''}: ${cleanText(m.content).slice(0, 160)}`)
                .filter((line) => line.trim() !== ':')
                .join('\n')
                .slice(0, 1500);
            archiveFile(image, {
                groupId: gid,
                groupName: groupNames.get(gid) ?? '',
                senderId: String(speaker?.id ?? ''),
                senderName,
                caption: '图片',
                context: recent,
            });
        }
        catch {
            return undefined;
        }
        return locateMedia({ image });
    };

    /** 当前工具调用的群 + 说话人：用于「图片按群隔离」 */
    const resolveTurnScope = (exec) => {
        if (!exec)
            return undefined;
        let gid = '';
        try {
            const record = (exec.agent !== undefined && manager && typeof manager.findByAgent === 'function')
                ? manager.findByAgent(exec.agent)
                : undefined;
            if (record) {
                if (record.replyTarget?.scope === 'group')
                    gid = String(record.replyTarget.targetId ?? '');
            }
            else {
                gid = String(globalThis.__qqbotLastGid ?? '');
            }
        }
        catch {
            gid = String(globalThis.__qqbotLastGid ?? '');
        }
        let requesterId = '';
        let requesterName = '';
        const turn = gid !== '' ? globalThis.__qqbotRoleTurnInbound?.get?.(gid) : undefined;
        const pending = gid !== '' ? globalThis.__qqbotPendingInbound?.get?.(gid) : undefined;
        const first = (Array.isArray(turn) ? turn[0] : undefined) ?? (Array.isArray(pending) ? pending[0] : undefined);
        if (first?.id)
            requesterId = String(first.id);
        if (requesterId === '' && gid !== '') {
            const speaker = globalThis.__qqbotSpeakers?.get?.(gid);
            requesterId = String(speaker?.id ?? '');
        }
        const speaker = gid !== '' ? globalThis.__qqbotSpeakers?.get?.(gid) : undefined;
        requesterName = canonicalName(requesterId, String(first?.name ?? speaker?.name ?? '')).trim();
        return { gid, requesterId, requesterName };
    };

    const searchMedia = (args, scope) => {
        const query = String(args?.query ?? '').trim();
        const person = String(args?.person ?? '').trim();
        const group = String(args?.group ?? '').trim();
        const tag = String(args?.tag ?? '').trim();
        const favorites = args?.favorites === true || String(args?.favorites ?? '') === '1' || String(args?.favorites ?? '') === 'true';
        const limit = Math.max(1, Math.min(100, Number(args?.limit) || 10));
        const clauses = [];
        const params = [];
        if (scope) {
            const gid = String(scope.gid ?? '');
            const requester = String(scope.requesterId ?? '');
            if (gid !== '') {
                const requesterName = String(scope.requesterName ?? '').trim();
                if (requester !== '' && requesterName !== '') {
                    // 当前群的图 + 说话人自己的图（本人要求才可跨群；跨群 openid 可能不同，按档案名兜底）
                    clauses.push("(m.group_id = ? OR (m.sender_id = ? AND m.sender_id <> '') OR (m.sender_name = ? AND m.sender_name <> ''))");
                    params.push(gid, requester, requesterName);
                }
                else if (requester !== '') {
                    clauses.push("(m.group_id = ? OR (m.sender_id = ? AND m.sender_id <> ''))");
                    params.push(gid, requester);
                }
                else {
                    clauses.push('m.group_id = ?');
                    params.push(gid);
                }
            }
            else if (requester !== '') {
                // 私聊：只允许看自己分享过的图
                const requesterName = String(scope.requesterName ?? '').trim();
                if (requesterName !== '') {
                    clauses.push("(m.sender_id = ? OR m.sender_name = ?)");
                    params.push(requester, requesterName);
                }
                else {
                    clauses.push('m.sender_id = ?');
                    params.push(requester);
                }
            }
            else {
                clauses.push('1 = 0');
            }
        }
        if (query !== '') {
            clauses.push('(m.caption LIKE ? OR m.context LIKE ? OR m.sender_name LIKE ?)');
            params.push(`%${query}%`, `%${query}%`, `%${query}%`);
        }
        if (person !== '') {
            clauses.push('m.sender_name LIKE ?');
            params.push(`%${person}%`);
        }
        if (group !== '') {
            clauses.push('(m.group_id = ? OR m.group_name LIKE ?)');
            params.push(group, `%${group}%`);
        }
        if (favorites)
            clauses.push('l.media_id IS NOT NULL');
        if (tag !== '') {
            clauses.push('l.tags LIKE ?');
            params.push(`%${tag}%`);
        }
        const where = clauses.length > 0 ? `where ${clauses.join(' and ')}` : '';
        const order = favorites ? 'l.created_at desc' : 'm.created_at desc';
        const rows = db.prepare(`
            select m.id, m.path, m.caption, m.sender_name, m.group_name, m.group_id, m.created_at,
                   l.media_id as liked_id, l.reason as like_reason, l.tags as like_tags, l.created_at as liked_at
            from media m left join media_likes l on l.media_id = m.id
            ${where} order by ${order} limit ?
        `).all(...params, limit);
        return {
            items: rows.map((row) => ({
                id: Number(row.id),
                path: String(row.path),
                caption: String(row.caption ?? ''),
                sender: String(row.sender_name ?? ''),
                group: String(row.group_name || row.group_id || ''),
                createdAt: new Date(Number(row.created_at)).toISOString(),
                liked: row.liked_id !== null && row.liked_id !== undefined,
                reason: String(row.like_reason ?? ''),
                tags: String(row.like_tags ?? ''),
                likedAt: row.liked_at ? new Date(Number(row.liked_at)).toISOString() : '',
            })),
        };
    };

    const favoriteMedia = (args, exec) => {
        const image = String(args?.image ?? '').trim();
        let row = locateMedia(args);
        if (!row && image !== '')
            row = archiveAndLocate(image);
        if (!row)
            return { ok: false, id: 0, favorite: false, sender: '', caption: '', reason: '', tags: '', message: '媒体库里找不到这张图：先确认图片路径来自【本轮图片】，或先用 media_search 拿 id。' };
        const scope = resolveTurnScope(exec);
        if (scope && row) {
            const sameGroup = scope.gid !== '' && String(row.group_id ?? '') === scope.gid;
            const own = (scope.requesterId !== '' && String(row.sender_id ?? '') === scope.requesterId)
                || (scope.requesterName !== '' && String(row.sender_name ?? '') === scope.requesterName);
            if (!sameGroup && !own)
                return { ok: false, id: Number(row.id), favorite: false, sender: String(row.sender_name ?? ''), caption: String(row.caption ?? ''), reason: '', tags: '', message: '这张图是别的群的分享，只有分享人本人要求才能跨群收藏。' };
        }
        const remove = args?.remove === true;
        if (remove) {
            likeDelete.run(row.id);
            console.log(`[im-qqbot] 媒体取消收藏: #${row.id} ${String(row.caption ?? '').slice(0, 30)}`);
            return {
                ok: true, id: Number(row.id), favorite: false,
                sender: String(row.sender_name ?? ''), caption: String(row.caption ?? ''),
                reason: '', tags: '',
                message: `已取消收藏 #${row.id}。`,
            };
        }
        const reason = String(args?.reason ?? '').trim().slice(0, 200);
        if (reason === '')
            return { ok: false, id: Number(row.id), favorite: false, sender: String(row.sender_name ?? ''), caption: String(row.caption ?? ''), reason: '', tags: '', message: '收藏要写一句具体理由（构图/光线/味道/氛围），不能空着。' };
        const tags = normalizeTags(args?.tags);
        likeUpsert.run(row.id, reason, tags, '小易', Date.now());
        console.log(`[im-qqbot] 媒体收藏: #${row.id} [${String(row.sender_name ?? '')}] ${reason.slice(0, 40)}`);
        return {
            ok: true, id: Number(row.id), favorite: true,
            sender: String(row.sender_name ?? ''), caption: String(row.caption ?? ''),
            reason, tags,
            message: `已收藏 #${row.id}（分享人：${String(row.sender_name ?? '未知')}）${tags ? ` [${tags}]` : ''}：${reason}`,
        };
    };

    const tools = (() => {
        try {
            return ctx.get('tools');
        }
        catch {
            return undefined;
        }
    })();

    if (tools?.register) {
        tools.register({
            name: 'media_search',
            description: [
                '搜索机器人媒体库里的图片（已从 QQ 临时目录复制到机器人目录，QQ 清图也不会丢）。',
                '可按关键词（图片上下文/说明）、人（群昵称或档案称呼）、群（群名或 group_openid）、标签过滤。',
                'favorites=true 只看小易收藏过的图；返回 id、本地路径、说明、分享人、时间、是否收藏和收藏理由。',
                '图片按群隔离：默认只返回当前群的图；当前说话人本人分享过的图可以跨群返回。',
                '要发图用 media_send（id）；要收藏当前图用 media_favorite（image 传【本轮图片】路径）。',
            ].join(''),
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    query: { type: 'string', description: '关键词，例如 威士忌、酒、旅行、猫' },
                    person: { type: 'string', description: '分享人的昵称或档案称呼，例如 成员甲' },
                    group: { type: 'string', description: '群名或 group_openid' },
                    tag: { type: 'string', description: '收藏标签，例如 风景、美食' },
                    favorites: { type: 'boolean', description: 'true = 只看收藏过的图' },
                    limit: { type: 'integer', description: '返回条数，默认 10，最多 100' },
                },
            },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        items: {
                            type: 'array',
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                properties: {
                                    id: { type: 'integer' },
                                    path: { type: 'string' },
                                    caption: { type: 'string' },
                                    sender: { type: 'string' },
                                    group: { type: 'string' },
                                    createdAt: { type: 'string' },
                                    liked: { type: 'boolean' },
                                    reason: { type: 'string' },
                                    tags: { type: 'string' },
                                    likedAt: { type: 'string' },
                                },
                                required: ['id', 'path', 'caption', 'sender', 'group', 'createdAt', 'liked', 'reason', 'tags', 'likedAt'],
                            },
                        },
                    },
                    required: ['items'],
                },
                render: (_args, value) => {
                    if (!value.items.length)
                        return [{ type: 'text', text: '媒体库里没有匹配的图片。' }];
                    return [{ type: 'text', text: value.items.map((item) => `${item.liked ? '⭐ ' : ''}${item.id}. [${item.sender || '?'}] ${item.caption || '图片'} · ${item.createdAt}${item.tags ? ` · #${item.tags}` : ''}\n   ${item.reason ? `理由：${item.reason}\n   ` : ''}${item.path}`).join('\n\n') }];
                },
            },
            execute(args, exec) {
                return searchMedia(args, resolveTurnScope(exec));
            },
        });

        tools.register({
            name: 'media_send',
            description: '把媒体库里的一张图按 id 发回当前会话。图片按群隔离：只能发当前群的图；当前说话人本人分享过的图才能跨群发。先 media_search 拿到 id；不要用 QQ 临时图路径。',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: { id: { type: 'integer', description: 'media_search 返回的 id' } },
                required: ['id'],
            },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        fileName: { type: 'string' },
                        fileSize: { type: 'integer' },
                        target: { type: 'string' },
                        messageId: { type: 'string' },
                    },
                    required: ['fileName', 'fileSize', 'target'],
                },
                render: (_args, value) => [{ type: 'text', text: `已发送 ${value.fileName} → ${value.target}` }],
            },
            async execute(args, exec) {
                const row = db.prepare('select id, path, caption, group_id, sender_id, sender_name from media where id = ?').get(Number(args?.id));
                if (!row)
                    throw new Error(`media_send: 媒体库里没有 id=${args?.id}`);
                const filePath = String(row.path);
                if (!fs.existsSync(filePath))
                    throw new Error(`media_send: 文件不存在: ${filePath}`);
                const scope = resolveTurnScope(exec);
                if (scope) {
                    const sameGroup = scope.gid !== '' && String(row.group_id ?? '') === scope.gid;
                    const own = (scope.requesterId !== '' && String(row.sender_id ?? '') === scope.requesterId)
                        || (scope.requesterName !== '' && String(row.sender_name ?? '') === scope.requesterName);
                    if (!sameGroup && !own)
                        throw new Error('media_send: 这张图是别的群的分享，只有分享人本人要求才能跨群发。');
                }
                const target = exec.agent !== undefined ? manager.findByAgent(exec.agent)?.replyTarget : undefined;
                if (!target)
                    throw new Error('media_send: 无法确定发送目标（只能在当前会话里发）');
                const stat = fs.statSync(filePath);
                const ext = path.extname(filePath).toLowerCase();
                const image = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']).has(ext);
                const result = image
                    ? await bot.sendImage(target, { localPath: filePath })
                    : await bot.sendFile(target, { localPath: filePath }, { fileName: path.basename(filePath) });
                logger.info(`im-qqbot: media_send 发送 ${path.basename(filePath)} (${stat.size} bytes) → ${target.scope}:${target.targetId}`);
                return {
                    fileName: path.basename(filePath),
                    fileSize: stat.size,
                    target: `${target.scope}:${target.targetId}`,
                    ...(result.message?.id !== undefined ? { messageId: result.message.id } : {}),
                };
            },
        });
        tools.register({
            name: 'media_favorite',
            description: [
                '把一张真的好看/有分享价值的图收藏进媒体库（数据库里记下理由和标签）。',
                'image 传【本轮图片】里的本地绝对路径；也可以用 media_search 返回的 id。',
                'reason 写具体的好看在哪（构图/光线/色彩/味道/氛围），一次对话最多收藏 1–2 张。',
                'remove=true 取消收藏。',
            ].join(''),
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    image: { type: 'string', description: '图片的本地绝对路径（【本轮图片】里的路径）' },
                    id: { type: 'integer', description: '也可以用 media_search 返回的 id' },
                    reason: { type: 'string', description: '为什么好看，具体一点；收藏时必填' },
                    tags: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '2–3 个标签，例如 风景、摄影、美食、构图',
                    },
                    remove: { type: 'boolean', description: 'true = 取消收藏' },
                },
            },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        ok: { type: 'boolean' },
                        id: { type: 'integer' },
                        favorite: { type: 'boolean' },
                        sender: { type: 'string' },
                        caption: { type: 'string' },
                        reason: { type: 'string' },
                        tags: { type: 'string' },
                        message: { type: 'string' },
                    },
                    required: ['ok', 'id', 'favorite', 'sender', 'caption', 'reason', 'tags', 'message'],
                },
                render: (_args, value) => [{ type: 'text', text: value.message }],
            },
            isConcurrencySafe: () => true,
            execute(args, exec) {
                return favoriteMedia(args, exec);
            },
        });
        console.log('[im-qqbot] 媒体库工具已注册（media_search / media_send / media_favorite）');
    }
    else {
        console.log('[im-qqbot] 媒体库工具未注册：tools 服务不可用（归档仍生效）');
    }

    globalThis.__qqbotMediaArchive = { archive, mediaDir, dbPath, db, search: searchMedia, favorite: favoriteMedia, locate: locateMedia };

    try {
        const count = db.prepare('select count(*) c from media').get().c;
        const liked = db.prepare('select count(*) c from media_likes').get().c;
        console.log(`[im-qqbot] 媒体库已启用（${mediaDir}，${count} 张，收藏 ${liked} 张）`);
    }
    catch {
        console.log(`[im-qqbot] 媒体库已启用（${mediaDir}）`);
    }
}
/* <<< dsh-qqbot-patch:media-archive-helper <<< */

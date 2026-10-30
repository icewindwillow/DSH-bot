/* >>> dsh-qqbot-patch:people-store >>> */
/**
 * qqbot-people.json 的唯一写入口：文件锁 + 临时文件 + rename 原子替换 + 备份。
 *
 * 为什么需要：档案现在有五个写者——模型的 record_social_event / update_person_profile、
 * 象信裁判、亲密度自然增长、骨架建档、还有本地编辑器。它们都是「读全量 → 改一块 → 写回」，
 * 无锁并发时后写的会把先写的整段覆盖（social 更新丢失、设置被改回旧值都可能是这个原因）。
 *
 * 约定：
 *   store.update(mutator)  mutator 拿到 store，返回 false 表示「不写」，其余返回值原样带回；
 *                          锁是同步自旋的（Node 主线程用 Atomics.wait 睡），等不到 4 秒就抛错。
 *   store.read()           只读取，读到的永远是完整 JSON（写侧 rename 是原子的）。
 *   store.signal(text)     一句群消息的「社交信号」权重，正向/负向分开算，累加用。
 */
function installPeopleStore() {
    if (globalThis.__qqbotPeopleStore)
        return;

    const sleepSync = (ms) => {
        try {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
        }
        catch {
            // 没有 SharedArrayBuffer 就忙等（极短，兜底而已）
            const end = Date.now() + ms;
            while (Date.now() < end) { /* spin */ }
        }
    };

    const dir = () => process.env.QQBOT_PROFILE_DIR ?? `${process.env.HOME ?? ''}/.dsh/profiles/qqbot`;
    const path = () => `${dir()}/qqbot-people.json`;

    const read = () => JSON.parse(readFileSync(path(), 'utf8'));

    const update = (mutator) => {
        const file = path();
        const lock = `${file}.lock`;
        const deadline = Date.now() + 4000;
        let fd;
        for (;;) {
            try {
                fd = openSync(lock, 'wx');
                break;
            }
            catch (err) {
                if (!err || err.code !== 'EEXIST')
                    throw err;
                // 僵尸锁（进程被 kill 掉时留下的）：超过 8 秒就清掉
                try {
                    if (Date.now() - statSync(lock).mtimeMs > 8000)
                        unlinkSync(lock);
                }
                catch {
                    // 已经被别人清掉了
                }
                if (Date.now() > deadline)
                    throw new Error('qqbot-people.json 写入锁等待超时');
                sleepSync(15);
            }
        }
        try {
            const store = JSON.parse(readFileSync(file, 'utf8'));
            const result = mutator(store);
            if (result === false)
                return { store, result: undefined, wrote: false };
            const tmp = `${file}.tmp-${process.pid}`;
            writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
            try {
                copyFileSync(file, `${file}.bak`);
            }
            catch {
                // 首次写没有旧文件
            }
            renameSync(tmp, file);
            return { store, result, wrote: true };
        }
        finally {
            try { closeSync(fd); } catch { /* 忽略 */ }
            try { unlinkSync(lock); } catch { /* 忽略 */ }
        }
    };

    const INSULTS = ['傻逼', '智障', '弱智', '废物', '垃圾', '滚', '去死', '脑残', '蠢货', '混蛋', '有病', '闭嘴', 'sb'];
    const PRAISE = ['谢谢', '多谢', '感谢', '厉害', '牛啊', '牛', '可爱', '喜欢', '爱了', '帮你', '救我', '抱歉', '对不起'];

    /**
     * 一句话的社交信号（0 起步，不封顶，调用方自己限制）。
     * pos = 值得关系变好的证据，neg = 值得记负向事件的证据。
     * 不再用「有没有叫机器人名字」当开关：名字只是 pos 里的一小项。
     */
    const signal = (raw) => {
        const text = String(raw ?? '');
        let pos = 0;
        let neg = 0;
        const lower = text.toLowerCase();
        if (INSULTS.some((w) => lower.includes(w)))
            neg += 3;
        if (/[!！?？]{2,}/.test(text))
            neg += 0.4;
        if (/(.)\1{3,}/.test(text))
            neg += 0.4;
        if (text.trim().length <= 2)
            neg += 0.15;                              // 两个字来回刷，偏向噪音
        if (PRAISE.some((w) => text.includes(w)))
            pos += 1;
        if (/[?？]\s*$/.test(text))
            pos += 0.3;                               // 提问 = 愿意聊
        if (/[哈嘿嘻]/.test(text))
            pos += 0.3;
        if (text.length >= 12)
            pos += 0.4;                               // 有内容
        if (/小易|易喵|大肥鱼/.test(text))
            pos += 0.6;
        return { pos, neg };
    };

    globalThis.__qqbotPeopleStore = { dir, path, read, update, signal };
}
installPeopleStore();
/* <<< dsh-qqbot-patch:people-store <<< */

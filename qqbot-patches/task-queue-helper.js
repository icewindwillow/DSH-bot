/* >>> dsh-qqbot-patch:task-queue-helper >>> */
// In-process queue. A timed-out job keeps its slot until it actually stops.
export function createQqbotTaskQueue({ concurrency = 1, capacity = 2 } = {}, tracing) {
    const pending = [];
    const keys = new Set();
    const active = new Set();
    let closed = false;
    const counts = { running: 0, accepted: 0, completed: 0, failed: 0, dropped: 0 };
    const limit = (value, min, fallback) => Number.isFinite(value) ? Math.max(min, Math.floor(value)) : fallback;
    concurrency = limit(concurrency, 1, 1);
    capacity = limit(capacity, 0, 2);
    function pump() {
        while (!closed && counts.running < concurrency && pending.length) {
            const { key, run, timeoutMs, trace } = pending.shift();
            counts.running++;
            if (trace) tracing?.workerLog('worker-start', trace);
            const controller = new AbortController();
            active.add(controller);
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            Promise.resolve()
                .then(() => {
                    if (controller.signal.aborted) return;
                    const execute = () => run(controller.signal, trace);
                    return trace ? tracing.run(trace, execute) : execute();
                })
                .then((result) => { counts[result?.ok && !controller.signal.aborted ? 'completed' : 'failed']++; },
                    () => { counts.failed++; })
                .finally(() => {
                    clearTimeout(timer);
                    active.delete(controller);
                    if (trace) tracing?.workerLog('worker-end', trace);
                    counts.running--;
                    keys.delete(key);
                    pump();
                });
        }
    }
    return {
        configure(options) {
            concurrency = limit(options.concurrency, 1, concurrency);
            capacity = limit(options.capacity, 0, capacity);
            pump();
        },
        enqueue({ key, run, timeoutMs, trace }) {
            if (closed) return { ok: false, queued: false, reason: 'queue-closed' };
            if (keys.has(key)) return { ok: false, queued: false, reason: 'duplicate' };
            if (counts.running >= concurrency && pending.length >= capacity) {
                counts.dropped++;
                return { ok: false, queued: false, reason: 'queue-full' };
            }
            keys.add(key);
            pending.push({ key, trace: tracing?.workerTrace(trace), run, timeoutMs: Math.min(2_147_483_647, limit(timeoutMs, 1, 30_000)) });
            counts.accepted++;
            pump();
            return { ok: true, queued: true, key };
        },
        close() {
            if (closed) return;
            closed = true;
            counts.dropped += pending.length;
            for (const item of pending.splice(0)) keys.delete(item.key);
            for (const controller of active) controller.abort();
        },
        snapshot: () => ({ status: closed ? 'closed' : 'ready', depth: pending.length, capacity, ...counts }),
    };
}
export function qqbotQueueForContext(ctx, options) {
    let service;
    try { service = ctx?.get?.('qqbotCore'); } catch { /* optional bundle */ }
    const tracing = globalThis.__qqbotCorrelation;
    return service?.queue?.(options, tracing) ?? createQqbotTaskQueue(options, tracing);
}
/* <<< dsh-qqbot-patch:task-queue-helper <<< */

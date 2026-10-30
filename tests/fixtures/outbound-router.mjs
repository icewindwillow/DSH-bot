// Synthetic transport contract, authored solely for offline patch tests.
// Not copied from an installed profile/dist. This is not an upstream integration test.
class OutboundRouter {
    constructor(manager, bot, config, logger) {
        this.manager = manager;
        this.config = config;
        this.logger = logger;
        this.toolCalls = new Map();
    }
    route(header, raw) {
        const record = this.manager.findBySessionId(header.header.id);
        if (!record)
            return;
        if (raw.type === 'tool/call') {
            this.toolCalls.set(raw.data.callId, { name: raw.data.name, args: raw.data.arguments });
            return;
        }
        if (raw.type === 'tool/result') {
            const id = raw.data.message?.source?.callId;
            const call = this.toolCalls.get(id);
            this.toolCalls.delete(id);
            this.result(record, call, { error: raw.data.error, raw: raw.data });
            return;
        }
        if (raw.type === 'assistant/message') {
            const text = raw.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
            this.send(record, text, 'assistant');
        }
    }
    result(record, call, event) {
        if (call === undefined)
            return;
        if (event.error === undefined && !this.config.showToolResults)
            return;
        const message = event.raw?.message;
        const blocks = message?.content ?? [];
        const text = blocks.flatMap(block => block.type === 'tool-result' ? block.content : [block])
            .filter(block => block.type === 'text').map(block => block.text).join('\n');
        this.send(record, text, event.error ? 'error' : 'tool');
    }
}
export function createOutboundHandler() {
    return OutboundRouter;
}

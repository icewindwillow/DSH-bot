/* >>> dsh-qqbot-patch:event-speaker-context >>> */
        const eventSpeaker = typeof roleSkillReplySpeaker === 'function' ? roleSkillReplySpeaker(gid, record) : undefined;
        const eventLine = globalThis.__qqbotEvents?.promptLine?.(gid, {
            name: speaker.name,
            id: speaker.id,
        }, { messageId: eventSpeaker ? String(record.replyTarget.msgId ?? '') : '' });
/* <<< dsh-qqbot-patch:event-speaker-context <<< */

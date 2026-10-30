/* >>> dsh-qqbot-patch:turn-start >>> */
            case 'turn/start':
                this.turnStarts ??= new Map();
                this.turnStarts.set(record.replyTarget?.targetId ?? '', Date.now());
                globalThis.__qqbotRoleSkillTurnStart?.(record.peerId, Date.now());
                break;
            case 'turn/end':
                this.onTurnEnd(session.header.id, record, event);
                globalThis.__qqbotRoleSkillTurnEnd?.(record.peerId, Date.now());
                break;
/* <<< dsh-qqbot-patch:turn-start <<< */

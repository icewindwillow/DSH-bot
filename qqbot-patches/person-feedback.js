/* >>> dsh-qqbot-patch:person-feedback >>> */
            // 通用反馈体系：按当前说话人注入「怎么接」的策略（风格仍由角色技能负责）
            const personFeedback = record.scope === 'group' ? buildPersonFeedbackSection(record.peerId, record) : '';
            if (roleSkill !== '')
                extraSections.push({ name: 'qqbot:role-skill', order: 93, text: roleSkill });
            if (personFeedback !== '')
                extraSections.push({ name: 'qqbot:person-feedback', order: 94, text: personFeedback });
/* <<< dsh-qqbot-patch:person-feedback <<< */

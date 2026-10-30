/* >>> dsh-qqbot-patch:role-skills >>> */
            // 特定角色爱好：只在「对的人」说话时注入（由本地注册表绑定成员与技能）
            const roleSkill = record.scope === 'group' ? buildRoleSkillSection(record.peerId, record) : '';
            if (speakerCtx !== '')
                extraSections.push({ name: 'qqbot:speaker-context', order: 92, text: speakerCtx });
            if (roleSkill !== '')
                extraSections.push({ name: 'qqbot:role-skill', order: 93, text: roleSkill });
/* <<< dsh-qqbot-patch:role-skills <<< */

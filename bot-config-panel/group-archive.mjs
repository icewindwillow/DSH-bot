import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { withQqbotProfileDocuments } from '../qqbot-patches/profile-document-reader.js';

const groupMessage = /^\S+ ([\w-]{1,128}) event=GROUP_(?:AT_)?MESSAGE_CREATE .*? sender=(.*)\(([\w-]{1,128})\)$/;

export async function readObservedGroups(profile, groupId) {
  const groups = new Map();
  const input = createReadStream(join(profile, 'qqbot-seen-groups.log'));
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const match = line.match(groupMessage);
      if (!match) continue;
      const [, id, senderName, openid] = match;
      if (groupId !== undefined && id !== groupId) continue;
      const group = groups.get(id) ?? { id, members: new Map() };
      const name = senderName.trim();
      if (name && name !== '?') group.members.set(openid, name);
      else if (!group.members.has(openid)) group.members.set(openid, '');
      // Preserve last-seen order for the unregistered group list.
      groups.delete(id);
      groups.set(id, group);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return groups;
}

export async function archiveObservedGroup(profile, id, name) {
  const observed = (await readObservedGroups(profile, id)).get(id);
  const members = observed?.members ?? new Map();
  const now = new Date().toISOString();
  let result;
  withQqbotProfileDocuments(profile, db => db.updateMany(['groups-meta', 'people'], current => {
    const directory = current['groups-meta'];
    const people = current.people;
    if (!Array.isArray(directory.groups) || !Array.isArray(people.people)) throw new Error('档案数据格式有误');

    const next = {};
    let group = directory.groups.find(item => item.id === id);
    if (!group && !observed) throw Object.assign(new Error('没有收到该群的消息，请核对群 OpenID'), { status: 404 });
    const groupCreated = !group;
    if (groupCreated) {
      group = { id, name: name || `群 ${id.slice(-8)}` };
      directory.groups.push(group);
      next['groups-meta'] = directory;
    }

    const byOpenid = new Map();
    for (const person of people.people) {
      if (!Array.isArray(person?.openids)) continue;
      for (const openid of person.openids) {
        if (!byOpenid.has(openid)) byOpenid.set(openid, person);
      }
    }
    let created = 0;
    let linked = 0;
    for (const [openid, displayName] of members) {
      const person = byOpenid.get(openid);
      if (!person) {
        people.people.push({
          name: displayName || `成员 ${openid.slice(-8)}`,
          openids: [openid],
          groups: [id],
          profile: {},
          autoCreated: true,
          autoCreatedAt: now,
        });
        created++;
      } else if (Array.isArray(person.groups) && person.groups.some(gid => typeof gid === 'string' && gid) && !person.groups.includes(id)) {
        person.groups.push(id);
        linked++;
      }
    }
    if (created || linked) next.people = people;
    result = { group, groupCreated, created, linked, observed: members.size, groups: directory.groups, data: people };
    return next;
  }));
  return result;
}

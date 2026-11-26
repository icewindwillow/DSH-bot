import { randomBytes, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';

export const personalSkillId = 'local-task-shell';
export const legacyPersonalSkillId = 'owner-dsh';
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const digest = value => createHash('sha256').update(value).digest('hex');
const codePattern = /^[A-F0-9]{10}$/;
const linkLifetime = 5 * 60_000;

export function personalDshGrants(roleDoc, peopleDoc, state, owner) {
  const skill = roleDoc?.skills?.find(row =>
    (row?.id === personalSkillId || row?.id === legacyPersonalSkillId) &&
    row.scope === 'personal' && row.kind === 'access');
  if (!skill || skill.scope !== 'personal' || skill.kind !== 'access' || skill.enabled === false) return [];
  const rows = Array.isArray(peopleDoc?.people) ? peopleDoc.people : [];
  const counts = new Map();
  for (const row of rows) for (const id of new Set(Array.isArray(row?.openids) ? row.openids : [])) {
    if (validId(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const seenNames = new Set(['owner']);
  const grants = [];
  for (const row of rows) {
    if (!Array.isArray(row?.openids) || row.openids.length !== 1 || !validId(row.openids[0]) ||
        row.openids[0] === owner || counts.get(row.openids[0]) !== 1) continue;
    const [principal] = row.openids;
    const groups = Object.create(null);
    for (const group of Array.isArray(row.groups) ? row.groups : []) {
      if (!validId(group)) continue;
      const toggle = state?.[`${group}:openid:${principal}:${personalSkillId}`]
        ?? state?.[`${group}:openid:${principal}:${legacyPersonalSkillId}`];
      if (toggle?.by === 'panel' && toggle.enabled === true) groups[group] = principal;
    }
    if (!Object.keys(groups).length) continue;
    const stable = digest(principal).slice(0, 10);
    let name = String(row.name ?? '').normalize('NFKC').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 20) || `成员-${stable}`;
    if (seenNames.has(name)) name = `${name.slice(0, 20)}-${stable}`;
    if (seenNames.has(name)) continue;
    seenNames.add(name);
    grants.push({ principal, name, groups });
  }
  return grants;
}

export function createPersonalAccess({ bridgeDir, readDocuments, loadConfig }) {
  const file = join(bridgeDir, 'personal-links.sqlite');
  let db;
  function database() {
    if (db) return db;
    db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    db.exec(`
      PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS claims (code TEXT PRIMARY KEY, dm TEXT NOT NULL UNIQUE, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS links (principal TEXT PRIMARY KEY, dm TEXT NOT NULL UNIQUE);
    `);
    return db;
  }
  function grants(config) {
    const { skills, people, state } = readDocuments();
    return personalDshGrants(skills, people, state, config.owner);
  }
  function load() {
    const config = loadConfig();
    const members = grants(config);
    if (!members.length) return { ...config, members };
    const links = new Map(database().prepare('SELECT principal,dm FROM links').all().map(row => [row.principal, row.dm]));
    return { ...config, members: members.map(member => ({
      ...member, dmOpenid: links.get(member.principal),
    })) };
  }
  function link(actor, code) {
    const config = loadConfig();
    const permitted = grants(config);
    const store = database();
    const now = Date.now();
    store.exec('BEGIN IMMEDIATE');
    try {
      store.prepare('DELETE FROM claims WHERE expires <= ?').run(now);
      let result;
      if (actor.scope === 'c2c' && !actor.group && validId(actor.sender) && actor.sender !== config.owner && !code) {
        const linked = store.prepare('SELECT principal FROM links WHERE dm=?').get(actor.sender);
        if (linked) result = { status: permitted.some(member => member.principal === linked.principal) ? 'linked' : 'link-denied' };
        else {
          const pending = store.prepare('SELECT count(*) AS n FROM claims').get();
          const existing = store.prepare('SELECT code FROM claims WHERE dm=?').get(actor.sender);
          if (existing) result = { status: 'link-code', code: existing.code };
          else if (pending.n >= 96) result = { status: 'busy' };
          else {
            const token = randomBytes(5).toString('hex').toUpperCase();
            store.prepare('INSERT INTO claims VALUES (?,?,?)').run(token, actor.sender, now + linkLifetime);
            result = { status: 'link-code', code: token };
          }
        }
      } else if (actor.scope === 'group' && validId(actor.group) && codePattern.test(code ?? '')) {
        const member = permitted.find(item => item.groups[actor.group] === actor.sender);
        const claim = member && store.prepare('SELECT dm FROM claims WHERE code=?').get(code);
        if (!member || !claim || claim.dm === config.owner) result = { status: 'link-denied' };
        else {
          const existing = store.prepare('SELECT dm FROM links WHERE principal=?').get(member.principal);
          const alreadyUsed = store.prepare('SELECT principal FROM links WHERE dm=?').get(claim.dm);
          if ((existing && existing.dm !== claim.dm) || (alreadyUsed && alreadyUsed.principal !== member.principal)) {
            result = { status: 'link-denied' };
          } else {
            store.prepare('INSERT OR IGNORE INTO links VALUES (?,?)').run(member.principal, claim.dm);
            store.prepare('DELETE FROM claims WHERE code=?').run(code);
            result = { status: 'linked' };
          }
        }
      } else result = { status: 'link-denied' };
      store.exec('COMMIT');
      return result;
    } catch (error) {
      store.exec('ROLLBACK');
      throw error;
    }
  }
  return { load, link, close: () => { db?.close(); db = undefined; } };
}

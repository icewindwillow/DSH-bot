/* >>> dsh-qqbot-patch:profile-document-reader >>> */
// Shared by the installed gateway, native plugin, panel and offline commands. Read-only paths never create the database.
function decodeQqbotDocument(payload) {
    const value = JSON.parse(payload);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Document must be a JSON object');
    return value;
}

function readQqbotLegacyDocument(profile, { legacyFile, empty, checkLegacyFile }) {
    const { readFileSync } = process.getBuiltinModule('node:fs');
    const { join } = process.getBuiltinModule('node:path');
    for (const file of [legacyFile].flat().filter(Boolean)) {
        const path = join(profile, file);
        try {
            if (checkLegacyFile) checkLegacyFile(path);
            return decodeQqbotDocument(readFileSync(path, 'utf8'));
        }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return empty();
}

export function readQqbotProfileDocument(profile, type, policy) {
    const { empty } = policy;
    const fs = process.getBuiltinModule('node:fs');
    const { join } = process.getBuiltinModule('node:path');
    const file = join(profile, 'qqbot-documents.sqlite');
    let exists = true;
    try { fs.statSync(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }
    if (exists) {
        const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
        const db = new DatabaseSync(file, { readOnly: true });
        try {
            db.exec('pragma busy_timeout = 500; begin');
            const hasTable = db.prepare("select 1 from sqlite_schema where type='table' and name='document'").get();
            const row = hasTable && db.prepare('select payload from document where type = ?').get(type);
            if (row) {
                if (row.payload === null) return empty();
                return policy.keyedCounts ? readQqbotCountRows(db) : decodeQqbotDocument(row.payload);
            }
        }
        finally { db.close(); }
    }
    return policy.readLegacy ? policy.readLegacy() : readQqbotLegacyDocument(profile, policy);
}

function readQqbotCountRows(db) {
    return Object.fromEntries(db.prepare('select key, count from sender_count').all().map(({ key, count }) => [key, count]));
}

export function qqbotGroupDirectoryPolicy() {
    return { legacyFile: 'qqbot-groups-meta.json', empty: () => ({ groups: [] }) };
}

export function readQqbotGroupDirectory(profile) {
    const doc = readQqbotProfileDocument(profile, 'groups-meta', qqbotGroupDirectoryPolicy());
    return Array.isArray(doc.groups) ? doc.groups : [];
}
export function readProfileDocument(profile, type) {
    if (!Object.hasOwn(profileDocumentTypes, type)) throw new Error(`Unknown document type: ${type}`);
    return readQqbotProfileDocument(profile, type, profileDocumentTypes[type]);
}

export function mutateQqbotPeople(profile, mutator) {
    let outcome;
    withQqbotProfileDocuments(profile, db => db.update('people', store => {
        if (!Array.isArray(store.people)) throw new Error('People document must have a people array');
        const result = mutator(store);
        outcome = { store, result: result === false ? undefined : result, wrote: result !== false };
        return outcome.wrote ? store : undefined;
    }));
    return outcome;
}

export function mutateQqbotEvents(profile, mutator) {
    let result;
    withQqbotProfileDocuments(profile, db => db.update('events', state => {
        if (!Array.isArray(state.events)) throw new Error('Event document must have an events array');
        result = mutator(state);
        return result === false ? undefined : state;
    }));
    return result === false ? undefined : result;
}

export function withQqbotProfileDocuments(profile, fn) {
    const { resolve } = process.getBuiltinModule('node:path');
    // The gateway embeds this helper in several modules. Nested synchronous writes share a connection.
    const active = globalThis[Symbol.for('qqbot.profile-document-connections')] ??= new Map();
    const key = resolve(profile);
    if (active.has(key)) return fn(active.get(key));
    const db = openProfileDocuments(key);
    active.set(key, db);
    try { return fn(db); }
    finally { active.delete(key); db.close(); }
}

// Keep the existing checks used by the voice/image permission readers during JSON fallback.
function checkQqbotPermissionLegacyFile(file) {
    const info = process.getBuiltinModule('node:fs').lstatSync(file);
    if (!info.isFile() || info.nlink !== 1 || info.size > 4 * 1024 * 1024)
        throw new Error('Invalid legacy permission source');
}

export const profileDocumentTypes = Object.freeze({
  reminders: Object.freeze({ legacyFile: 'qqbot-reminders.json', empty: () => ({ reminders: [] }) }),
  'scheduled-messages': Object.freeze({ legacyFile: 'qqbot-scheduled-messages.json', empty: () => ({ messages: [] }) }),
  events: Object.freeze({ legacyFile: 'qqbot-events.json', empty: () => ({ version: 1, events: [] }) }),
  'newsjudge-config': Object.freeze({ legacyFile: Object.freeze(['qqbot-newsjudge.json', 'newsjudge.json']), empty: () => ({}) }),
  'newsjudge-jobs': Object.freeze({ legacyFile: 'qqbot-newsjudge-jobs.json', empty: () => ({ jobs: [] }) }),
  'interest-config': Object.freeze({ legacyFile: 'qqbot-interest.json', empty: () => ({}) }),
  'interest-activity': Object.freeze({ legacyFile: 'qqbot-interest-activity.json', empty: () => ({ groups: {} }), retainMs: 7 * 86400000 }),
  ...Object.fromEntries(['observe', 'search', 'share'].map(kind => {
    const type = `interest-${kind}-request`;
    return [type, Object.freeze({ legacyFile: `qqbot-${type}.json`, empty: () => null, consumable: true })];
  })),
  personas: Object.freeze({ legacyFile: 'qqbot-personas.json', empty: () => ({ modules: {}, personas: {}, archetypes: {} }) }),
  'groups-config': Object.freeze({ legacyFile: 'qqbot-groups.json', empty: () => ({}) }),
  people: Object.freeze({ legacyFile: 'qqbot-people.json', checkLegacyFile: checkQqbotPermissionLegacyFile, empty: () => ({ people: [] }) }),
  'command-owners': Object.freeze({ legacyFile: 'qqbot-command-owners.json', checkLegacyFile: checkQqbotPermissionLegacyFile, empty: () => ({}) }),
  permissions: Object.freeze({ legacyFile: 'qqbot-permissions.json', empty: () => ({}) }),
  'person-modules': Object.freeze({ legacyFile: 'qqbot-person-modules.json', empty: () => ({ people: {} }) }),
  'media-allow': Object.freeze({ legacyFile: 'qqbot-media-allow.json', empty: () => ({ people: [] }) }),
  'role-skills': Object.freeze({ legacyFile: 'qqbot-role-skills.json', checkLegacyFile: checkQqbotPermissionLegacyFile, empty: () => ({ skills: [] }) }),
  'role-skills-state': Object.freeze({ legacyFile: 'qqbot-role-skills-state.json', empty: () => ({}) }),
  mood: Object.freeze({ legacyFile: 'qqbot-mood.json', empty: () => ({}) }),
  'channel-replies': Object.freeze({ legacyFile: 'qqbot-channel-replies.json', empty: () => ({}) }),
  'reply-weight': Object.freeze({ legacyFile: 'qqbot-reply-weight.json', empty: () => ({}) }),
  attitude: Object.freeze({ legacyFile: 'qqbot-attitude.json', empty: () => ({}) }),
  'affinity-care': Object.freeze({ legacyFile: 'qqbot-affinity-care.json', empty: () => ({}) }),
  'affinity-care-state': Object.freeze({ legacyFile: 'qqbot-affinity-care-state.json', empty: () => ({}) }),
  'person-card-state': Object.freeze({ legacyFile: 'qqbot-person-card-state.json', empty: () => ({}) }),
  self: Object.freeze({ legacyFile: 'qqbot-self.json', empty: () => ({}) }),
  'aggregate': Object.freeze({ legacyFile: 'qqbot-aggregate.json', empty: () => ({}) }),
  'interest-depth': Object.freeze({ legacyFile: 'qqbot-interest-depth.json', empty: () => ({}) }),
  'interest-gallery-state': Object.freeze({ legacyFile: 'qqbot-interest-gallery-state.json', empty: () => ({}) }),
  'person-feedback': Object.freeze({ legacyFile: 'qqbot-person-feedback.json', empty: () => ({}) }),
  'profile-review': Object.freeze({ legacyFile: 'qqbot-profile-review.json', empty: () => ({}) }),
  'song': Object.freeze({ legacyFile: 'qqbot-song.json', empty: () => ({}) }),
  'sticker-prefs': Object.freeze({ legacyFile: 'qqbot-sticker-prefs.json', empty: () => ({}) }),
  'sticker-state': Object.freeze({ legacyFile: 'qqbot-sticker-state.json', empty: () => ({}) }),
  'weather-cache': Object.freeze({ legacyFile: 'qqbot-weather-cache.json', empty: () => ({}) }),
  tts: Object.freeze({ legacyFile: 'qqbot-tts.json', empty: () => ({}) }),
  'image-generation': Object.freeze({ legacyFile: 'qqbot-image-generation.json', empty: () => ({}) }),
  window: Object.freeze({ legacyFile: 'qqbot-window.json', empty: () => ({}), retainMs: 30 * 60000 }),
  recent: Object.freeze({ legacyFile: 'qqbot-recent.json', empty: () => ({}), retainMs: 15 * 60000 }),
  'sender-counts': Object.freeze({ legacyFile: 'qqbot-sender-counts.json', empty: () => ({}), keyedCounts: true }),
  greetings: Object.freeze({ legacyFile: 'qqbot-greetings.json', empty: () => ({}) }),
  'groups-meta': Object.freeze(qqbotGroupDirectoryPolicy()),
  'model-providers': Object.freeze({ legacyFile: 'qqbot-model-providers.json', empty: () => ({}) }),
});

const qqbotRecordKinds = new Set([
  'unified-hint', 'unified-gate', 'unified-shadow', 'unified-aging', 'unified-recall',
  'unified-explore', 'interest-gallery', 'memory-gate', 'interest-log', 'diary', 'chat',
]);

function qqbotRecordFiles(kind, bucket) {
  if (!qqbotRecordKinds.has(kind)) throw new Error(`Unknown record kind: ${kind}`);
  if (kind === 'diary' && bucket !== '') throw new Error('Unexpected diary bucket');
  if (kind === 'chat') {
    if (!/^[\w-]{1,128}\/\d{4}-\d{2}-\d{2}$/.test(bucket)) throw new Error('Invalid chat bucket');
    return [`chat-log/${bucket}.jsonl`];
  }
  if (kind === 'interest-log') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bucket)) throw new Error('Invalid interest log date');
    return [`qqbot-interest-${bucket}.jsonl`];
  }
  if (bucket !== '') throw new Error('Unexpected record bucket');
  if (kind === 'diary') return ['qqbot-diary.jsonl'];
  const file = `qqbot-${kind}.jsonl`;
  return kind === 'memory-gate' ? [`${file}.1`, file] : [file];
}

function qqbotRecordTime(value, fallback) {
  const time = value.at ?? value.t ?? value.date;
  const parsed = typeof time === 'number' ? time : Date.parse(time);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function qqbotRecordCutoff(kind, at) {
  if (kind === 'diary') return 0;
  const config = kind === 'memory-gate' ? Number(process.env.QQBOT_MEMORY_GATE_LOG_DAYS ?? 30) : 30;
  const days = Number.isFinite(config) && config > 0 ? config : 30;
  return at - days * 86400000;
}

function readQqbotLegacyRecords(profile, files, cutoff) {
  const fs = process.getBuiltinModule('node:fs');
  const { join } = process.getBuiltinModule('node:path');
  return files.flatMap(file => {
    const path = join(profile, file);
    try {
      const at = fs.statSync(path).mtimeMs;
      const rows = [];
      for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
        try {
          const value = decodeQqbotDocument(line);
          if (qqbotRecordTime(value, at) >= cutoff) rows.push([value, at]);
        } catch { /* One damaged or empty line does not affect the rest. */ }
      }
      return rows;
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  });
}

export function readQqbotRecords(profile, kind, bucket = '', limit = -1) {
  const files = qqbotRecordFiles(kind, bucket);
  const cutoff = qqbotRecordCutoff(kind, Date.now());
  const { existsSync } = process.getBuiltinModule('node:fs');
  const { join } = process.getBuiltinModule('node:path');
  const path = join(profile, 'qqbot-documents.sqlite');
  if (existsSync(path)) {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec('pragma busy_timeout=500; begin');
      const hasTable = db.prepare("select 1 from sqlite_schema where name='record_bucket'").get();
      if (hasTable && db.prepare('select 1 from record_bucket where kind=? and bucket=?').get(kind, bucket)) {
        return db.prepare('select payload from profile_record where kind=? and bucket=? and at>=? order by id desc limit ?')
          .all(kind, bucket, cutoff, limit).reverse().map(row => decodeQqbotDocument(row.payload));
      }
    } finally { db.close(); }
  }
  const entries = readQqbotLegacyRecords(profile, files, cutoff);
  return (limit < 0 ? entries : entries.slice(Math.max(0, entries.length - limit))).map(([value]) => value);
}

export function appendQqbotRecord(profile, kind, value, bucket = '') {
  return withQqbotProfileDocuments(profile, db => db.appendRecord(kind, bucket, value));
}

export function openProfileDocuments(profile, { types = profileDocumentTypes, now = Date.now } = {}) {
  const { closeSync, openSync } = process.getBuiltinModule('node:fs');
  const { join } = process.getBuiltinModule('node:path');
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const file = join(profile, 'qqbot-documents.sqlite');
  closeSync(openSync(file, 'a', 0o600));
  const db = new DatabaseSync(file);
  try {
    db.exec(`pragma busy_timeout = 500;
      create table if not exists document (type text primary key, payload text, changed_at integer not null);
      create table if not exists record_bucket (kind text not null, bucket text not null, primary key(kind,bucket));
      create table if not exists profile_record (
        id integer primary key, kind text not null, bucket text not null, at integer not null, payload text not null
      );
      create index if not exists profile_record_bucket on profile_record(kind,bucket,id);
      create index if not exists profile_record_time on profile_record(kind,at);
      create table if not exists sender_count (key text primary key, count integer not null);
      create table if not exists document_audit (
        id integer primary key, type text not null, action text not null, at integer not null
      );`);
  } catch (error) { db.close(); throw error; }
  function policy(type) {
    if (!Object.hasOwn(types, type)) throw new Error(`Unknown document type: ${type}`);
    return types[type];
  }
  let depth = 0;
  function transaction(cb) {
    const point = depth ? `document_${depth}` : '';
    db.exec(point ? `savepoint ${point}` : 'begin immediate');
    depth++;
    try {
      const result = cb();
      db.exec(point ? `release ${point}` : 'commit');
      return result;
    } catch (error) {
      db.exec(point ? `rollback to ${point}; release ${point}` : 'rollback');
      throw error;
    } finally { depth--; }
  }
  const get = db.prepare('select payload, changed_at from document where type = ?');
  const put = db.prepare(`insert into document(type,payload,changed_at) values(?,?,?)
    on conflict(type) do update set payload=excluded.payload, changed_at=excluded.changed_at`);
  const log = db.prepare('insert into document_audit(type,action,at) values(?,?,?)');
  function write(type, value, action, at) {
    const text = value === null ? null : JSON.stringify(value);
    if (text !== null) decodeQqbotDocument(text);
    if (policy(type).keyedCounts) {
      db.exec('delete from sender_count');
      const insert = db.prepare('insert into sender_count(key,count) values(?,?)');
      for (const [key, count] of Object.entries(value ?? {})) {
        if (Number.isSafeInteger(Number(count)) && Number(count) > 0) insert.run(key, Number(count));
      }
    }
    put.run(type, policy(type).keyedCounts && text !== null ? '{}' : text, at);
    log.run(type, action, at);
  }
  function read(type) {
    const p = policy(type);
    const row = get.get(type);
    if (!row) return readQqbotLegacyDocument(profile, p);
    if (row.payload === null) return p.empty();
    return p.keyedCounts ? readQqbotCountRows(db) : decodeQqbotDocument(row.payload);
  }
  function update(type, change) {
    const existed = Boolean(get.get(type));
    const value = change(read(type));
    if (value === undefined) return undefined;
    if (value === null) throw new Error('Use remove to delete a document');
    write(type, value, existed ? 'update' : 'initialize', now());
    return value;
  }
  return {
    importLegacy(type) {
      const p = policy(type);
      if (p.consumable) throw new Error('Requests are migrated on consumption; do not bulk import them');
      return transaction(() => {
        if (get.get(type)) return false;
        const value = readQqbotLegacyDocument(profile, { ...p, empty: () => null });
        if (value === null) return false;
        write(type, value, 'import', now());
        return true;
      });
    },
    read,
    appendRecord(kind, bucket, value) {
      const files = qqbotRecordFiles(kind, bucket);
      return transaction(() => {
        const at = now();
        const marked = db.prepare('insert or ignore into record_bucket values(?,?)').run(kind, bucket);
        const insert = db.prepare('insert into profile_record(kind,bucket,at,payload) values(?,?,?,?)');
        if (marked.changes) {
          const legacy = readQqbotLegacyRecords(profile, files, qqbotRecordCutoff(kind, at));
          for (const [entry, timestamp] of legacy)
            insert.run(kind, bucket, qqbotRecordTime(entry, timestamp), JSON.stringify(entry));
          if (legacy.length) log.run(`records:${kind}`, 'import', at);
        }
        const payload = JSON.stringify(value);
        decodeQqbotDocument(payload);
        insert.run(kind, bucket, qqbotRecordTime(value, at), payload);
      });
    },
    removeRecords(kind, bucket = '') {
      qqbotRecordFiles(kind, bucket);
      return transaction(() => {
        db.prepare('insert or ignore into record_bucket values(?,?)').run(kind, bucket);
        const { changes } = db.prepare('delete from profile_record where kind=? and bucket=?').run(kind, bucket);
        log.run(`records:${kind}`, 'delete', now());
        return changes;
      });
    },
    bumpSenderCount(gid, senderId) {
      const type = 'sender-counts';
      return transaction(() => {
        const row = get.get(type);
        const at = now();
        if (!row || row.payload === null) write(type, read(type), 'initialize', at);
        const { count } = db.prepare(`insert into sender_count(key,count) values(?,1)
          on conflict(key) do update set count=count+1 returning count`).get(`${gid}:${senderId}`);
        log.run(type, 'increment', at);
        return count;
      });
    },
    update(type, change) {
      return transaction(() => update(type, change));
    },
    // Compute related documents from snapshots taken under one write lock.
    updateMany(types, change) {
      return transaction(() => {
        const current = Object.fromEntries(types.map(type => [type, read(type)]));
        const next = change(current);
        for (const type of Object.keys(next)) {
          if (!Object.hasOwn(current, type)) throw new Error(`Document not selected: ${type}`);
          const value = next[type];
          if (value === null || value === undefined) throw new Error('Invalid replacement document');
          write(type, value, get.get(type) ? 'update' : 'initialize', now());
        }
        return next;
      });
    },
    take(type) {
      const p = policy(type);
      if (!p.consumable) throw new Error(`Document is not consumable: ${type}`);
      return transaction(() => {
        const row = get.get(type);
        const value = row ? (row.payload === null ? null : decodeQqbotDocument(row.payload)) : readQqbotLegacyDocument(profile, p);
        if (value !== null) write(type, null, 'consume', now());
        return value;
      });
    },
    remove(type) {
      policy(type);
      // Keep only a tombstone in SQLite, preventing stale legacy JSON from resurfacing.
      return transaction(() => {
        if (get.get(type)?.payload === null) return false;
        write(type, null, 'delete', now());
        return true;
      });
    },
    expire() {
      return transaction(() => {
        const at = now();
        let removed = 0;
        for (const [type, { retainMs }] of Object.entries(types)) {
          if (!Number.isSafeInteger(retainMs) || retainMs <= 0) continue;
          const row = get.get(type);
          if (row && row.payload !== null && row.changed_at <= at - retainMs) {
            write(type, null, 'expire', at);
            removed++;
          }
        }
        const deleteOldRecords = db.prepare('delete from profile_record where kind=? and at<?');
        for (const kind of qqbotRecordKinds) {
          const cutoff = qqbotRecordCutoff(kind, at);
          if (cutoff > 0 && deleteOldRecords.run(kind, cutoff).changes) log.run(`records:${kind}`, 'expire', at);
        }
        db.prepare('delete from document_audit where at <= ?').run(at - 30 * 86400000);
        return removed;
      });
    },
    audit() {
      return db.prepare('select type, action, at from document_audit order by id desc limit 100').all();
    },
    close() { db.close(); },
  };
}
/* <<< dsh-qqbot-patch:profile-document-reader <<< */

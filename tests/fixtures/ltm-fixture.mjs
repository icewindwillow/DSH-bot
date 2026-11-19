import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Create only the tables exercised by offline memory tests; never copy a live DB. */
export function createMemoryFixture(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, last_confirmed_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE memory_vectors (memory_id INTEGER PRIMARY KEY, dim INTEGER NOT NULL, vec BLOB NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE mem_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_uid TEXT NOT NULL,
      scope TEXT NOT NULL, subject_key TEXT NOT NULL, subject_name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'state', slot TEXT NOT NULL, op TEXT NOT NULL,
      value TEXT NOT NULL DEFAULT '', raw TEXT NOT NULL DEFAULT '',
      speaker_key TEXT NOT NULL DEFAULT '', speaker_name TEXT NOT NULL DEFAULT '',
      event_at INTEGER NOT NULL, ingested_at INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT '', confidence REAL NOT NULL DEFAULT 0,
      memory_id INTEGER, object_key TEXT NOT NULL DEFAULT '', object_name TEXT NOT NULL DEFAULT '',
      subject_id TEXT NOT NULL DEFAULT '', speaker_id TEXT NOT NULL DEFAULT '', object_id TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE person_states (
      id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, subject_key TEXT NOT NULL,
      subject_name TEXT NOT NULL, slot TEXT NOT NULL, status TEXT NOT NULL,
      value TEXT NOT NULL DEFAULT '', valid_from INTEGER NOT NULL, valid_to INTEGER,
      last_confirmed_at INTEGER NOT NULL, confidence REAL NOT NULL DEFAULT 0,
      evidence_event_ids TEXT NOT NULL DEFAULT '[]', first_event_id INTEGER NOT NULL,
      last_event_id INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL
    );
    CREATE TABLE person_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, alias_key TEXT NOT NULL,
      alias_name TEXT NOT NULL, subject_key TEXT NOT NULL, subject_name TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE person_interests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, person_key TEXT NOT NULL,
      person_name TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, title TEXT NOT NULL,
      title_key TEXT NOT NULL, progress TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, medium TEXT NOT NULL DEFAULT ''
    );
  `);
  db.close();
}

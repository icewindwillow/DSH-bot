// Entirely synthetic schema: only columns read/written by the memory snippets.
// Never inspect, import, or clone a user's memory database.
import { DatabaseSync } from 'node:sqlite';

export function createMemoryStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE memories (
    id INTEGER PRIMARY KEY,
    text TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_confirmed_at INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1
  )`);
  return db;
}

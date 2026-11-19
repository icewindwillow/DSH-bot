import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openProfileDocuments, profileDocumentTypes } from '../lib/profile-documents.mjs';

test('legacy JSONL records can be migrated explicitly and idempotently', (t) => {
  const profile = mkdtempSync(join(tmpdir(), 'qqbot-record-migration-'));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  writeFileSync(join(profile, 'qqbot-unified-hint.jsonl'), `${JSON.stringify({ at: 100, value: 'a' })}\n${JSON.stringify({ at: 101, value: 'b' })}\n`);
  const store = openProfileDocuments(profile, { now: () => 200 });
  assert.deepEqual(store.importLegacyRecords('unified-hint'), { imported: true, added: 2, count: 2 });
  assert.deepEqual(store.importLegacyRecords('unified-hint'), { imported: false, added: 0, count: 2 });
  writeFileSync(join(profile, 'qqbot-unified-hint.jsonl'), `${JSON.stringify({ at: 100, value: 'a' })}\n${JSON.stringify({ at: 101, value: 'b' })}\n${JSON.stringify({ at: 102, value: 'c' })}\n`);
  assert.deepEqual(store.importLegacyRecords('unified-hint'), { imported: true, added: 1, count: 3 });
  store.close();
  const verify = openProfileDocuments(profile, { now: () => 200 });
  assert.deepEqual(verify.read('people'), { people: [] });
  assert.equal(verify.audit().filter(row => row.type === 'records:unified-hint').length, 2);
  verify.close();
});

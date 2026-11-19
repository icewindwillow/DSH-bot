#!/usr/bin/env node
import { readdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { openProfileDocuments, profileDocumentTypes } from '../lib/profile-documents.mjs';

const [profile] = process.argv.slice(2);
if (!profile || !isAbsolute(profile)) {
  console.error('Usage: node scripts/migrate-profile-json-to-sqlite.mjs <absolute-profile>');
  process.exit(2);
}

if (!statSync(profile, { throwIfNoEntry: false })?.isDirectory()) {
  console.error('The profile directory does not exist.');
  process.exit(2);
}

const store = openProfileDocuments(profile);
try {
  const documents = [];
  for (const [type, policy] of Object.entries(profileDocumentTypes)) {
    if (policy.consumable) continue;
    if (store.importLegacy(type)) documents.push(type);
  }

  const records = [];
  const files = readdirSync(profile);
  const add = (kind, bucket = '') => {
    const result = store.importLegacyRecords(kind, bucket);
    records.push({ kind, bucket, ...result });
  };
  const fixedKinds = new Set();
  for (const file of files) {
    const interest = file.match(/^qqbot-interest-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (interest) add('interest-log', interest[1]);
    const fixed = file.match(/^qqbot-(unified-(?:hint|gate|shadow|aging|recall|explore)|interest-gallery|memory-gate|diary)\.jsonl$/);
    if (fixed) fixedKinds.add(fixed[1]);
    if (file === 'qqbot-memory-gate.jsonl.1') fixedKinds.add('memory-gate');
  }
  for (const kind of fixedKinds) add(kind);

  const managedLegacy = new Set(Object.values(profileDocumentTypes)
    .flatMap(policy => Array.isArray(policy.legacyFile) ? policy.legacyFile : [policy.legacyFile])
    .filter(Boolean));
  const managedRecord = file => /^qqbot-(?:interest-\d{4}-\d{2}-\d{2}|interest-gallery|memory-gate|diary|unified-(?:hint|gate|shadow|aging|recall|explore))\.jsonl$/.test(file)
    || file === 'qqbot-memory-gate.jsonl.1';
  const unmanaged = files.filter(file => /^qqbot-.*\.(json|jsonl)$/.test(file)
    && !managedLegacy.has(file) && !managedRecord(file));
  console.log(JSON.stringify({ ok: true, profile, documents, records, unmanaged }, null, 2));
} finally {
  store.close();
}

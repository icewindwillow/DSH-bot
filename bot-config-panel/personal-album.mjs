import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const imageTypes = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.bmp', 'image/bmp'],
]);
const memoryImageTable = 'memory_images';
export const memoryImageMaxBytes = 8 * 1024 * 1024;
const memoryImageDb = profileDir => join(profileDir, 'qqbot-album-memory-images.sqlite');

function uploadedImageType(data) {
  if (data.length < 12) return '';
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (['GIF87a', 'GIF89a'].includes(data.toString('latin1', 0, 6))) return 'image/gif';
  if (data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

function readIndex(file, table, empty, read) {
  try { statSync(file); }
  catch (err) {
    if (err.code === 'ENOENT') return empty;
    throw err;
  }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table)
      ? read(db) : empty;
  } finally {
    db.close();
  }
}

export function listAlbumPhotos(profileDir) {
  return readIndex(join(profileDir, 'interest-gallery', 'index.db'), 'gallery', [], db => db.prepare(`
    select id, topic_name as topic, title, caption, page_url as sourceUrl
    from gallery order by pinned desc, created_at desc, id desc
  `).all());
}

export function readAlbumPhoto(profileDir, id) {
  const albumDir = join(profileDir, 'interest-gallery');
  const row = readIndex(join(albumDir, 'index.db'), 'gallery', null, db =>
    db.prepare('select path from gallery where id = ?').get(id));
  if (!row?.path) return null;

  const filesDir = join(albumDir, 'files');
  const path = resolve(albumDir, row.path);
  if (!path.startsWith(filesDir + sep)) return null;
  const type = imageTypes.get(extname(path).toLowerCase());
  if (!type) return null;
  try {
    // The saved index may refer to a file already pruned by the collector.
    const realAlbum = realpathSync(albumDir);
    const realFiles = realpathSync(filesDir);
    const realFile = realpathSync(path);
    if (realFiles !== join(realAlbum, 'files') || !realFile.startsWith(realFiles + sep) || !statSync(realFile).isFile()) return null;
    return { type, data: readFileSync(realFile) };
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

export function listOwnedMemories(memoryFile, schedule) {
  const rows = readIndex(memoryFile, 'bot_memory_library', [], db => {
    const columns = new Set(db.prepare('pragma table_info(bot_memory_library)').all().map(column => column.name));
    const topic = columns.has('topic') ? 'topic' : "'' as topic";
    const affinity = columns.has('min_affinity') ? 'min_affinity' : '0';
    const familiarity = columns.has('min_familiarity') ? 'min_familiarity' : '0';
    return db.prepare(`
      select id, ${topic}, text, tags, ${affinity} as minAffinity, ${familiarity} as minFamiliarity
      from bot_memory_library order by pinned desc, updated_at desc, id desc
    `).all();
  });
  const memories = rows.filter(row => row.tags.split(/\s+/).includes('自己的东西'))
    .map(({ id, topic, text, minAffinity, minFamiliarity }) => ({
      id, title: topic || text.split('\n')[0], text, source: 'memory', minAffinity, minFamiliarity,
    }));

  const dollEntries = schedule.entries.filter(entry => !entry.sleep && [
    'xiaoyi-doll-pattern', 'xiaoyi-doll-sewing', 'xiaoyi-doll-photos',
  ].includes(entry.id));
  if (dollEntries.length) {
    memories.push({ id: 'bjd', title: '自己的 BJD 娃娃', text: dollEntries.map(entry => entry.title).join('、'), source: 'schedule' });
  }
  return memories;
}

export function withMemoryImages(profileDir, memories) {
  if (!memories.length) return memories;
  return readIndex(memoryImageDb(profileDir), memoryImageTable, memories.map(memory => ({ ...memory, images: [] })), db => {
    const list = db.prepare(`
      select id, name, tags from memory_images where memory_id = ? order by id desc
    `);
    return memories.map(memory => ({
      ...memory,
      images: list.all(String(memory.id)).map(image => ({ ...image, tags: JSON.parse(image.tags) })),
    }));
  });
}

export function hasManualMemory(memoryFile, id) {
  return readIndex(memoryFile, 'bot_memory_library', false, db =>
    Boolean(db.prepare('select 1 from bot_memory_library where id = ?').get(id)));
}

export function validateMemoryImage(body) {
  if (typeof body?.data !== 'string' || typeof body?.name !== 'string' ||
      (body.tags !== undefined && typeof body.tags !== 'string')) {
    throw new Error('请选择一张图片。');
  }
  const data = Buffer.from(body.data, 'base64');
  if (data.length > memoryImageMaxBytes) throw new Error('图片大小不能超过 8 MiB。');
  if (data.toString('base64') !== body.data) throw new Error('图片数据无效。');
  const type = uploadedImageType(data);
  if (!type) throw new Error('请选择 JPG、PNG、WebP 或 GIF 图片。');
  const name = body.name.split(/[\\/]/).at(-1).trim().slice(0, 160) || '记忆图片';
  const tags = [...new Set((body.tags ?? '').split(/[\s,，、]+/).filter(Boolean))];
  if (tags.length > 8 || tags.some(tag => [...tag].length > 32)) {
    throw new Error('最多可填写 8 个标签，每个标签最多 32 个字。');
  }
  return { data, type, name, tags };
}

export function saveMemoryImage(profileDir, memoryId, image) {
  const file = memoryImageDb(profileDir);
  closeSync(openSync(file, 'a', 0o600));
  const db = new DatabaseSync(file, { timeout: 3000 });
  try {
    db.exec(`
      create table if not exists memory_images (
        id integer primary key,
        memory_id text not null,
        sha256 text not null,
        name text not null,
        tags text not null,
        mime text not null,
        data blob not null,
        unique (memory_id, sha256)
      )
    `);
    const hash = createHash('sha256').update(image.data).digest('hex');
    return db.prepare(`
      insert into memory_images (memory_id, sha256, name, tags, mime, data)
      values (?, ?, ?, ?, ?, ?)
      on conflict (memory_id, sha256) do update set name = excluded.name, tags = excluded.tags
      returning id
    `).get(String(memoryId), hash, image.name, JSON.stringify(image.tags), image.type, image.data);
  } finally {
    db.close();
  }
}

export function readMemoryImage(profileDir, id, memoryId) {
  return readIndex(memoryImageDb(profileDir), memoryImageTable, null, db =>
    db.prepare('select mime as type, data from memory_images where id = ? and memory_id = ?').get(id, String(memoryId)));
}

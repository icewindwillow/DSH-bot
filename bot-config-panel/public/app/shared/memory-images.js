import { $, api, esc, toast } from './runtime.js';

const endpoint = '/api/personal-album/memory-image';
const urlFor = (memoryId, imageId) => `${endpoint}?id=${encodeURIComponent(imageId)}&memoryId=${encodeURIComponent(memoryId)}`;
let uploadTarget;

export function renderMemoryImages({ id, images }) {
  if (!images?.length) return '';
  return `<div class="album-memory-images">${images.map(image => `
    <button type="button" class="album-photo album-memory-photo" data-memory-image="${esc(image.id)}">
      <img src="${esc(urlFor(id, image.id))}" alt="" loading="lazy">
      <strong>${esc(image.name)}</strong>
      ${image.tags.length ? `<span class="album-memory-photo-tags">${image.tags.map(tag => `<span>${esc(tag)}</span>`).join('')}</span>` : ''}
    </button>
  `).join('')}</div>`;
}

export function showImagePreview({ title, url, caption, sourceUrl }) {
  $('albumPreviewTitle').textContent = title;
  const image = $('albumPreviewImage');
  image.src = url;
  image.alt = title;
  $('albumPreviewCaption').textContent = caption ?? '';
  $('albumPreviewCaption').hidden = !caption || caption === title;
  const source = $('albumPreviewSource');
  source.removeAttribute('href');
  if (sourceUrl) {
    try {
      const parsed = new URL(sourceUrl);
      if (['https:', 'http:'].includes(parsed.protocol)) source.href = parsed.href;
    } catch { /* 图片来源可能已失效。 */ }
  }
  source.hidden = !source.hasAttribute('href');
  $('albumPreview').showModal();
}

export function previewMemoryImage(memory, imageId) {
  const image = memory.images?.find(item => String(item.id) === imageId);
  if (!image) return;
  showImagePreview({
    title: image.name,
    url: urlFor(memory.id, image.id),
    caption: [`关联到「${memory.title}」`, ...image.tags.map(tag => `#${tag}`)].join(' · '),
  });
}

export async function readMemoryImageDraft(file, tags) {
  if (!file) return null;
  if (file.size > 8 * 1024 * 1024) throw new Error('图片大小不能超过 8 MiB。');
  if (file.type && !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
    throw new Error('请选择 JPG、PNG、WebP 或 GIF 图片。');
  }
  const labels = [...new Set(tags.split(/[\s,，、]+/).filter(Boolean))];
  if (labels.length > 8 || labels.some(label => [...label].length > 32)) {
    throw new Error('最多可填写 8 个标签，每个标签最多 32 个字。');
  }
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('无法读取所选文件，请重新选择。'));
    reader.readAsDataURL(file);
  });
  return { name: file.name, tags: labels.join(' '), data };
}

export function saveMemoryImage(memoryId, draft) {
  return api(endpoint, { method: 'POST', body: JSON.stringify({ memoryId, ...draft }) });
}

export function openMemoryImageUpload(memory, onSaved) {
  uploadTarget = { memory, onSaved };
  $('albumUploadForm').reset();
  $('albumUploadMemory').textContent = `关联到「${memory.title}」`;
  $('albumUploadMessage').hidden = true;
  $('albumUpload').showModal();
}

async function submitUpload(event) {
  event.preventDefault();
  const file = $('albumUploadFile').files[0];
  const save = $('albumUploadSave');
  if (!uploadTarget || save.disabled || !file) return;
  const { memory, onSaved } = uploadTarget;
  const message = $('albumUploadMessage');
  const controls = ['albumUploadFile', 'albumUploadTags', 'albumUploadSave', 'albumUploadCancel'].map($);
  message.hidden = false;
  message.removeAttribute('data-error');
  message.textContent = '正在上传…';
  controls.forEach(control => { control.disabled = true; });
  try {
    await saveMemoryImage(memory.id, await readMemoryImageDraft(file, $('albumUploadTags').value));
  } catch (err) {
    message.textContent = err.message;
    message.setAttribute('data-error', '');
    return;
  } finally {
    controls.forEach(control => { control.disabled = false; });
  }
  $('albumUpload').close();
  toast(`图片已关联到「${memory.title}」`, 'ok');
  await onSaved();
}

export function initMemoryImages() {
  $('albumUploadForm').onsubmit = submitUpload;
  $('albumUploadCancel').onclick = () => $('albumUpload').close();
  $('albumUpload').oncancel = (event) => { if ($('albumUploadSave').disabled) event.preventDefault(); };
  $('albumPreview').onclose = () => $('albumPreviewImage').removeAttribute('src');
}

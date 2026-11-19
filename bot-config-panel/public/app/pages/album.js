import { $, api, esc } from '../shared/runtime.js';
import { openMemoryImageUpload, previewMemoryImage, renderMemoryImages, showImagePreview } from '../shared/memory-images.js';

const pageSize = 36;
const tabs = ['albumPhotosTab', 'albumMemoriesTab'];
let selectedTab = 0;
let photos = [];
let memories = [];
let limit = pageSize;
let request = 0;

const photoUrl = (id) => `/api/personal-album/photo?id=${encodeURIComponent(id)}`;
const photoTitle = (photo) => photo.title || photo.caption || photo.topic || '相册图片';

function renderPhotos() {
  const topic = $('albumTopic').value;
  const matching = topic ? photos.filter(photo => photo.topic === topic) : photos;
  $('albumPhotoStatus').textContent = matching.length ? `${matching.length} 张` : '相册里还没有图片。';
  $('albumPhotoGrid').innerHTML = matching.slice(0, limit).map(photo => `
    <button class="album-photo" type="button" data-photo-id="${esc(photo.id)}">
      <img src="${photoUrl(photo.id)}" alt="" loading="lazy">
      <strong>${esc(photoTitle(photo))}</strong>
      <small>${esc(photo.topic || '未归类')}</small>
    </button>
  `).join('');
  $('albumMore').hidden = matching.length <= limit;
}

function renderMemories(items) {
  memories = items;
  const status = $('albumMemoryStatus');
  status.hidden = memories.length > 0;
  status.textContent = memories.length ? '' : '这里还没有收录的记忆。';
  $('albumMemoryGrid').innerHTML = memories.map(memory => `
    <article class="card album-memory" data-memory-id="${esc(memory.id)}">
      <h2>${esc(memory.title)}</h2>
      <p>${esc(memory.text)}</p>
      <div class="album-memory-meta">
        <small>${memory.source === 'schedule' ? '来自小易的时间表' : '来自私人记忆'}</small>
        <button type="button" class="small" data-upload-memory aria-label="上传图片到 ${esc(memory.title)}">上传图片</button>
      </div>
      ${memory.minAffinity || memory.minFamiliarity ? `<p class="hint">分享阈值 · ${[
        memory.minAffinity ? `好感 ≥ ${esc(memory.minAffinity)}` : '',
        memory.minFamiliarity ? `熟悉 ≥ ${esc(memory.minFamiliarity)}` : '',
      ].filter(Boolean).join(' · ')}</p>` : ''}
      ${renderMemoryImages(memory)}
    </article>
  `).join('');
}

export async function showAlbumPage() {
  const sequence = ++request;
  const viewingMemories = selectedTab === 1;
  const status = $(viewingMemories ? 'albumMemoryStatus' : 'albumPhotoStatus');
  status.hidden = false;
  status.textContent = '正在读取…';
  $(viewingMemories ? 'albumMemoryGrid' : 'albumPhotoGrid').replaceChildren();
  $('albumReload').disabled = true;
  if (!viewingMemories) {
    $('albumTopic').disabled = true;
    $('albumMore').hidden = true;
  }
  try {
    if (viewingMemories) {
      const result = await api('/api/personal-album/memories');
      if (sequence === request) renderMemories(result.memories);
    } else {
      const result = await api('/api/personal-album');
      if (sequence !== request) return;
      photos = result.photos;
      const topic = $('albumTopic');
      const previous = topic.value;
      const names = [...new Set(photos.map(photo => photo.topic).filter(Boolean))];
      names.sort((a, b) => a.localeCompare(b, 'zh-CN'));
      topic.replaceChildren(new Option('全部主题', ''), ...names.map(name => new Option(name, name)));
      if (names.includes(previous)) topic.value = previous;
      renderPhotos();
    }
  } catch (err) {
    if (sequence === request) {
      status.textContent = `读取失败：${err.message}`;
      if (!viewingMemories) photos = [];
    }
  } finally {
    if (sequence === request) {
      $('albumReload').disabled = false;
      $('albumTopic').disabled = false;
    }
  }
}

function selectTab(index, focus = false) {
  if (focus) $(tabs[index]).focus();
  if (index === selectedTab) return;
  selectedTab = index;
  tabs.forEach((id, position) => {
    const tab = $(id);
    const active = position === index;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !active;
  });
  void showAlbumPage();
}

export function initAlbumPage() {
  tabs.forEach((id, index) => {
    $(id).onclick = () => selectTab(index);
    $(id).onkeydown = (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : 1 - index;
      selectTab(next, true);
    };
  });
  $('albumReload').onclick = showAlbumPage;
  $('albumTopic').onchange = () => { limit = pageSize; renderPhotos(); };
  $('albumMore').onclick = () => {
    const previousLimit = limit;
    limit += pageSize;
    renderPhotos();
    $('albumPhotoGrid').children[previousLimit]?.focus();
  };
  $('albumPhotoGrid').onclick = (event) => {
    const card = event.target.closest('[data-photo-id]');
    if (!card) return;
    const photo = photos.find(item => String(item.id) === card.dataset.photoId);
    if (photo) showImagePreview({ ...photo, title: photoTitle(photo), url: photoUrl(photo.id) });
  };
  $('albumMemoryGrid').onclick = (event) => {
    const card = event.target.closest('[data-memory-id]');
    const memory = memories.find(item => String(item.id) === card?.dataset.memoryId);
    if (!memory) return;
    if (event.target.closest('[data-upload-memory]')) {
      openMemoryImageUpload(memory, async () => {
        await showAlbumPage();
        $('albumMemoryGrid').querySelector(`[data-memory-id="${memory.id}"] [data-upload-memory]`)?.focus();
      });
      return;
    }
    const trigger = event.target.closest('[data-memory-image]');
    if (trigger) previewMemoryImage(memory, trigger.dataset.memoryImage);
  };
}

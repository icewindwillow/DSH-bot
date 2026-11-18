const PALETTE_KEY = 'qqbot-console-theme';
const PALETTES = new Set(['blue', 'purple', 'warm', 'whale']);

export function applyPalette(name) {
  const palette = PALETTES.has(name) ? name : 'blue';
  document.body.dataset.theme = palette;
  document.querySelectorAll('[data-theme-choice]').forEach((el) => {
    el.classList.toggle('active', el.dataset.themeChoice === palette);
  });
  try { localStorage.setItem(PALETTE_KEY, palette); } catch (_) {}
}

export function initPalette() {
  let palette = 'blue';
  try { palette = localStorage.getItem(PALETTE_KEY) || 'blue'; } catch (_) {}
  applyPalette(palette);
  document.querySelectorAll('[data-theme-choice]').forEach((el) => {
    el.onclick = () => applyPalette(el.dataset.themeChoice);
  });
}

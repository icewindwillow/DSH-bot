// Shared browser runtime used by every control-panel page module.
export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const clone = (o) => JSON.parse(JSON.stringify(o));

export function toast(text, kind = '', ms = 3200) {
  const el = $('toast');
  el.textContent = text;
  el.className = `toast show ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, ms);
}

export async function api(path, options = {}) {
  const { __panelRetry = false, ...requestOptions } = options;
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    ...requestOptions,
  });
  let body = null;
  try { body = await res.json(); } catch { body = { ok: false, error: `HTTP ${res.status}` }; }
  if (res.status === 401 && body?.error === '请先打开本机面板页面' && !__panelRetry) {
    await fetch(`${location.origin}/?panel-refresh=${Date.now()}`, { credentials: 'same-origin', cache: 'no-store' });
    return api(path, { ...requestOptions, __panelRetry: true });
  }
  if (!res.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

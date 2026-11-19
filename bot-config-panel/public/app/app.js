import { initEventsPage, showEventsPage } from './pages/events.js';
import { $, api, clone, esc, toast } from './shared/runtime.js';
import { applyPalette, initPalette } from './shared/palette.js';
import { DAY_MS, dashboardDayStart } from './shared/dashboard-day.js';


'use strict';

// ─────────────────────────── 状态 ───────────────────────────
let OV = null;                 // /api/overview 的返回
let modelDraft = null;         // { provider, model, reasoningEffort, routeReasoning }
let personas = null;           // 人格数据（深拷贝）
let baseMtime = { patch: 0 };
let personaVersion;
let selectedKey = 'default';
let personaView = 'equip';
let ownersDraft = { openids: [], names: [] };
let dirty = { model: false, personas: false, owners: false, people: false };

// ─────────────────────────── 加载 ───────────────────────────
async function load() {
  try {
    OV = await api('/api/overview');
    baseMtime.patch = OV.mtimes.patch;
    personaVersion = OV.personaVersion;
    modelDraft = {
      provider: OV.model.provider || (OV.providers[0] ?? ''),
      model: OV.model.model || '',
      reasoningEffort: OV.model.reasoningEffort || '',
      routeReasoning: OV.route?.reasoning || '',
    };
    ownersDraft = {
      openids: [...(OV.owners?.openids ?? [])],
      names: [...(OV.owners?.names ?? [])],
    };
    personas = clone(OV.personas);
    if (!personas.modules) personas.modules = {};
    if (!personas.personas) personas.personas = {};
    if (!personas.archetypes) personas.archetypes = {};
    selectedKey = 'default';
    dirty = { model: false, personas: false, owners: false, people: false };
    galleryLoaded = false;
    galleryAllowLoaded = false;
    galleryItems = [];
    try { await loadPeopleData(); }
    catch (err) { peopleLoaded = false; toast(`读取群成员档案失败：${err.message}`, 'err'); }
    renderAll();
    if (!$('paneGallery').hidden) void loadGallery();
  }
  catch (err) {
    $('botText').textContent = '读取失败';
    toast(`读取配置失败：${err.message}`, 'err');
  }
}

function renderHealth(health) {
  const value = Math.max(0, Math.min(100, Number(health?.score) || 0));
  const checks = Array.isArray(health?.checks) ? health.checks : [];
  $('healthScore').textContent = `${value}%`;
  $('healthStatus').textContent = health?.status || '暂无数据';
  $('healthSummary').textContent = health ? `基于 ${checks.length} 项实时检查` : '真实状态暂不可用';
  const tone = value >= 80 ? 'var(--ok)' : value >= 60 ? 'var(--warn)' : 'var(--err)';
  const attention = checks.filter((check) => !check.ok).length;
  $('healthAlert').textContent = attention === 0 ? '● 无待处理告警' : `● ${attention} 项需关注`;
  $('healthAlert').style.color = tone;
  $('healthAlert').onclick = () => {
    const issues = checks.filter((check) => !check.ok);
    $('settingsDetailTitle').textContent = '健康度详情';
    $('settingsDetailBody').innerHTML = issues.length
      ? `<div class=\"detail-section\"><h3>需要关注的项目</h3>${issues.map((check) => `<div class=\"health-detail-row\"><strong>${esc(check.label)}</strong><p>${esc(check.detail)}</p><small>${check.warning ? '这是提醒，不会影响整体服务运行。' : '这项检查未通过，请检查对应服务。'}</small></div>`).join('')}</div>`
      : '<p class=\"hint\">当前没有需要关注的项目。</p>';
    $('settingsDetailModal').classList.add('show');
  };
  $('healthRing').style.background = `conic-gradient(${tone} 0 ${value}%, #eaf4ef ${value}% 100%)`;
  $('healthChecks').innerHTML = checks.map((check) => `<div class=\"health-check ${check.ok ? '' : check.warning ? 'warn' : 'bad'}\"><i></i><span>${esc(check.label)}：${esc(check.detail)}</span></div>`).join('');
}

async function loadDashboard() {
  try {
    const data = await api('/api/dashboard');
    const fmt = (n) => Number(n || 0).toLocaleString('zh-CN');
    $('dashMessages').innerHTML = `${fmt(data.todayMessages)} <span>条</span>`;
    $('dashGroups').innerHTML = `${fmt(data.activeGroups24h)} <span>个</span>`;
    $('dashReplies').innerHTML = `${fmt(data.triggeredToday)} <span>次</span>`;
    $('dashMessagesMeta').textContent = '来自 qqbot-seen-groups.log';
    $('dashGroupsMeta').textContent = '按近 24 小时真实消息去重';
    $('dashRepliesMeta').textContent = 'wake=true 的真实判定次数';
    renderHealth(data.health);
    const max = Math.max(1, ...data.days.map((d) => d.messages));
    const points = data.days.map((d, i) => `${Math.round(i * 720 / 6)} ${155 - Math.round(d.messages / max * 125)}`);
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${p}`).join(' ');
    const eventData = await api('/api/events');
    const events = (eventData.events || []).filter((e) => e && (e.createdAt || e.updatedAt || e.at)).slice(0, 4);
    const activity = $('dashboardActivity');
    activity.innerHTML = events.length ? events.map((e, i) => {
      const at = e.createdAt || e.updatedAt || e.at;
      const when = Number.isFinite(Number(at)) ? new Date(Number(at)) : new Date(at);
      const time = Number.isNaN(when.getTime()) ? '—' : when.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return `<div class=\"event\"><div class=\"event-icon\">${['✓','✦','↻','◎'][i]}</div><div><strong>${esc(e.title || e.name || e.type || '事件')}</strong><p>${esc(e.detail || e.description || e.status || '')}</p></div><time>${time}</time></div>`;
    }).join('') : '<div class=\"event\"><div class=\"event-icon\">—</div><div><strong>暂无事件记录</strong><p>真实事件会显示在这里</p></div><time>—</time></div>';
    const svg = document.querySelector('.dashboard .chart-svg');
    const main = svg?.querySelector('path[stroke="#6C8494"]');
    if (main) main.setAttribute('d', line);
    const labels = document.querySelector('.dashboard .xlabels');
    if (labels) labels.innerHTML = data.days.map((d) => `<span>${esc(d.date.slice(5))}</span>`).join('');
  } catch (err) {
    $('dashMessagesMeta').textContent = '真实日志暂不可用';
    $('dashGroupsMeta').textContent = '真实日志暂不可用';
    $('dashRepliesMeta').textContent = '真实日志暂不可用';
  }
}

function startDashboardRefresh() {
  let timer;
  let loadedDay;
  function refreshOnDayChange() {
    const now = Date.now();
    const day = dashboardDayStart(now);
    if (day !== loadedDay) {
      loadedDay = day;
      void loadDashboard();
    }
    clearTimeout(timer);
    timer = setTimeout(refreshOnDayChange, day + DAY_MS - now);
  }
  refreshOnDayChange();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshOnDayChange();
  });
  window.addEventListener('pageshow', refreshOnDayChange);
}

function renderAll() {
  $('cfgPath').textContent = OV.paths.patch.replace(/^.*\/\.dsh\//, '~/.dsh/');
  renderBot();
  renderModelTab();
  renderPersonaTab();
  renderPersonaGroupConfig();
  renderOwners();
  renderPeopleTab();
  renderGalleryFilters();
}

function renderBot() {
  const pill = $('botPill');
  const running = OV.bot.running;
  pill.className = `pill ${running ? 'on' : 'off'}`;
  $('botText').textContent = running ? `运行中 · PID ${OV.bot.pids.join(', ')}` : '未运行';

  const mp = $('modelPill');
  const ms = OV.modelStatus;
  if (!ms) {
    mp.className = 'pill';
    mp.title = '还没有模型运行记录（机器人尚未遇到错误，或状态文件未生成）';
    $('modelText').textContent = '模型状态未知';
    return;
  }
  const bad = ms.ok === false;
  mp.className = `pill ${bad ? 'off' : 'on'}`;
  $('modelText').textContent = bad
    ? `模型异常 · ${ms.lastError?.code ?? 'ERROR'}${ms.degraded && ms.channel === 'backup' ? ' · 已切兜底' : ''}`
    : (ms.degraded ? '模型兜底中' : '模型正常');
  const err = ms.lastError;
  mp.title = [
    err ? `${err.code ?? 'ERROR'}: ${err.message ?? ''}` : '',
    err?.at ? `最近错误：${new Date(err.at).toLocaleString()}` : '',
    ms.updatedAt ? `更新：${new Date(ms.updatedAt).toLocaleString()}` : '',
  ].filter(Boolean).join('\n');
}

// ─────────────────────────── 模型与推理 ───────────────────────────
const supportOf = (modelId) => (OV.effortSupport && OV.effortSupport[modelId]) || null;
const routeOf = (provider) => (OV.routes || []).find((r) => r.provider === provider) ?? null;

function renderModelTab() {
  const providers = OV.providers ?? [];
  $('selProvider').innerHTML = providers.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  $('selProvider').value = modelDraft.provider;

  const route = routeOf(modelDraft.provider);
  const external = route?.external === true;   // 插件注册的 provider（our-free-model）
  const models = route?.models ?? [];
  $('selModel').innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.id)} — ${esc(m.name)}</option>`).join('');
  if (!models.some((m) => m.id === modelDraft.model)) modelDraft.model = models[0]?.id ?? '';
  $('selModel').value = modelDraft.model;

  $('routeName').textContent = modelDraft.provider;

  // 顶部警示
  const alerts = [];
  if (OV.warnings?.length) alerts.push(`<div class="alert warn">⚠ ${OV.warnings.map(esc).join('<br>⚠ ')}</div>`);
  if (external) alerts.push('<div class="alert info">这个 provider 由 dsh-our-free-model 插件提供：模型清单和可用性随插件探测刷新，换模型后点「重启机器人」生效；它没有 llm-pi-ai 里的「路由默认推理强度」，只用上面的默认推理强度。</div>');
  const picked = (route?.models ?? []).find((m) => m.id === modelDraft.model);
  if (external && picked?.lane === 'opencode') alerts.push('<div class="alert warn">⚠ 这是 OpenCode 免费车道：额度按出口 IP 统计，用尽时上游直接回 429，机器人会「不说话」。额度没恢复前，建议选 Kilo 免费池的模型（kilo-auto/free 等）。</div>');
  if (!OV.bot.running) alerts.push('<div class="alert err">机器人当前没在运行，点右上角「重启机器人」拉起来。</div>');
  if (OV.modelStatus && OV.modelStatus.ok === false) {
    const e = OV.modelStatus.lastError ?? {};
    alerts.push(`<div class="alert err">模型调用异常：${esc(e.code ?? 'ERROR')} — ${esc(e.message ?? '')}${e.at ? `（${esc(new Date(e.at).toLocaleString())}）` : ''}</div>`);
  }
  if (dirty.model) alerts.push('<div class="alert info">模型/推理强度的改动还没保存。</div>');
  $('modelAlerts').innerHTML = alerts.join('');

  // 档位下拉
  const levels = supportOf(modelDraft.model);
  const options = [['', '（不设置，交给模型默认）']];
  if (levels) for (const l of levels) options.push([l, l]);
  else for (const l of OV.allEfforts) options.push([l, l]);
  // 当前配置值如果这个模型不支持，也要列出来（标红提示），否则下拉会「假装」是空
  const withCurrent = (current) => {
    const list = options.slice();
    if (current && !list.some(([v]) => v === current)) list.push([current, `${current}（当前设置，模型不支持）`]);
    return list;
  };
  const effortOpts = withCurrent(modelDraft.reasoningEffort);
  const routeOpts = withCurrent(modelDraft.routeReasoning);
  $('selEffort').innerHTML = effortOpts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
  $('selEffort').value = modelDraft.reasoningEffort;
  $('selRouteEffort').innerHTML = routeOpts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
  $('selRouteEffort').value = modelDraft.routeReasoning;
  $('selRouteEffort').disabled = external;

  // 支持档位 chips
  if (levels) {
    $('effortChips').innerHTML = OV.allEfforts
      .filter((l) => l !== 'minimal' && l !== 'xhigh' || levels.includes(l))
      .map((l) => `<span class="chip ${levels.includes(l) ? 'ok' : 'bad'}">${esc(l)}</span>`)
      .join('');
    $('modelMeta').textContent = levels.length
      ? `${modelDraft.model || '—'} · 支持 ${levels.join(' / ')}`
      : `${modelDraft.model || '—'} · 无推理档位，请选择「不设置」`;
  }
  else {
    $('effortChips').innerHTML = '<span class="chip">这个模型没在内置档位表里，按服务商实际支持为准</span>';
    $('modelMeta').textContent = `${modelDraft.model || '—'} · 档位未知`;
  }

  // 矩阵
  const rows = (route?.models ?? []).map((m) => {
    const lv = supportOf(m.id);
    if (!modelDraft.routeReasoning || !lv) {
      return `<tr><td class="mono">${esc(m.id)}</td><td class="muted">${lv ? lv.join(' / ') : '未知'}</td><td class="muted">${modelDraft.routeReasoning ? '—' : '不设置'}</td></tr>`;
    }
    const ok = lv.includes(modelDraft.routeReasoning);
    return `<tr><td class="mono">${esc(m.id)}</td><td class="muted">${esc(lv.join(' / '))}</td>
      <td class="${ok ? 'ok' : 'bad'}">${ok ? '✓ 支持' : '✗ 不支持'}</td></tr>`;
  }).join('');
  $('matrix').innerHTML = external
    ? '<tbody><tr><td class="muted">our-free-model 是插件路由，没有「路由默认推理强度」这一层；每个模型的档位由插件按模型自身声明下发，面板不猜。</td></tr></tbody>'
    : `<thead><tr><th>模型</th><th>支持的档位</th><th>路由默认「${esc(modelDraft.routeReasoning || '未设置')}」</th></tr></thead><tbody>${rows}</tbody>`;

  $('btnSaveModel').disabled = !dirty.model;
  $('btnSaveRestart').disabled = !dirty.model;
  if (!dirty.model) $('modelMsg').textContent = '';

  // 事件（重渲染后重新绑定）
  $('selProvider').onchange = (e) => {
    modelDraft.provider = e.target.value;
    modelDraft.model = '';
    modelDraft.routeReasoning = routeOf(e.target.value)?.reasoning ?? '';
    dirty.model = true;
    renderModelTab();
  };
  $('selModel').onchange = (e) => { modelDraft.model = e.target.value; dirty.model = true; renderModelTab(); };
  $('selEffort').onchange = (e) => { modelDraft.reasoningEffort = e.target.value; dirty.model = true; renderModelTab(); };
  $('selRouteEffort').onchange = (e) => { modelDraft.routeReasoning = e.target.value; dirty.model = true; renderModelTab(); };
}

async function saveModel(opts = {}) {
  const btn = $('btnSaveModel');
  const btnRestart = $('btnSaveRestart');
  const msg = $('modelMsg');
  btn.disabled = true; btnRestart.disabled = true;
  msg.className = 'msg'; msg.textContent = opts.restart ? '保存并重启中…' : '保存中…';
  try {
    const levels = supportOf(modelDraft.model);
    if (levels && modelDraft.reasoningEffort && !levels.includes(modelDraft.reasoningEffort))
      throw new Error(`模型 ${modelDraft.model} 不支持推理强度「${modelDraft.reasoningEffort}」`);
    if (levels && modelDraft.routeReasoning && !levels.includes(modelDraft.routeReasoning))
      throw new Error(`模型 ${modelDraft.model} 不支持路由默认「${modelDraft.routeReasoning}」，用到它会报错`);

    const res = await api('/api/model', {
      method: 'PUT',
      body: JSON.stringify({ ...modelDraft, baseMtimeMs: baseMtime.patch }),
    });
    baseMtime.patch = res.mtimeMs;
    dirty.model = false;
    const backupName = res.backup.split('/').pop();
    if (opts.restart) {
      await doRestart(`已保存（备份：${backupName}）并重启`);
      msg.className = 'msg ok';
      msg.textContent = `已写入（备份：${backupName}）· 已重启`;
      return;
    }
    toast('模型配置已保存，记得重启机器人', 'ok');
    await refreshBot();
    renderModelTab();
    // renderModelTab 会清空提示，所以保存结果放在它之后写
    msg.className = 'msg ok';
    msg.textContent = `已写入（备份：${backupName}）· 重启机器人后生效`;
  }
  catch (err) {
    msg.className = 'msg err';
    msg.textContent = err.message;
    toast(err.message, 'err');
  }
  finally { btn.disabled = !dirty.model; btnRestart.disabled = !dirty.model; }
}

// ─────────────────────────── 私有凭据（仅状态，不回显） ───────────────────────────
const credentialFields = [
  { key: 'QQBOT_APPID', title: 'QQ 机器人 AppID', hint: '从 QQ 开放平台机器人管理页获取。', qq: true, type: 'text' },
  { key: 'QQBOT_SECRET', title: 'QQ 机器人密钥', hint: '机器人 Client Secret，不是个人 QQ 密码。', qq: true },
  { key: 'OPENAI_API_KEY', title: 'OpenAI', hint: 'OpenAI 官方聊天与生图；按官方 API 计费。' },
  { key: 'SILICONFLOW_API_KEY', title: '硅基流动（可选，免费生图）', hint: 'Kwai-Kolors/Kolors 生图用；控制台完成实名认证后创建，保存后重启机器人生效。' },
  { key: 'CLOUDFLARE_API_TOKEN', title: 'Cloudflare API Token（可选，免费额度生图）', hint: 'flux-1-schnell 生图用；控制台创建，权限至少 Workers AI: Read。' },
  { key: 'CLOUDFLARE_ACCOUNT_ID', title: 'Cloudflare Account ID', hint: '32 位十六进制账号 ID，与上面的 Token 配对；不是密钥，但缺它拼不出账号作用域接口。' },
  { key: 'DEEPSEEK_API_KEY', title: 'DeepSeek', hint: 'DeepSeek API 路由及相关搜索/读取功能，是否需要取决于当前配置。' },
  { key: 'XIANGXIN_API_KEY', title: '象信 AI（判断模型，推荐）', hint: '先用它做回复 / 记忆门控与分类，主模型只处理值得回的消息，可大幅节省 Token。' },
  { key: 'OPENCODE_GO_API_KEY', title: 'OpenCode Go（可选）', hint: '现有部分辅助判断或对应模型路由可能依赖，不是免费模型通行证。' },
];
let credentialsLoaded = false;
let credentialsState = null;
let credentialsBusy = false;
let credentialsDirty = false;
function credentialInput(key) { return $(`credential-${key}`); }
function credentialRemove(key) { return $(`credential-remove-${key}`); }
function clearCredentialInputs() {
  for (const { key } of credentialFields) {
    credentialInput(key).value = '';
    credentialInput(key).disabled = false;
    credentialRemove(key).checked = false;
  }
  credentialsDirty = false;
}
function updateCredentialSaveButton() {
  // 不靠 credentialsDirty 禁用：密码管理器自动填充、回车提交等场景可能不触发 input，
  // 导致按钮一直灰着、点了也没有任何提示。改成保存时再检查「有没有新值」。
  $('btnSaveCredentials').disabled = credentialsBusy || !credentialsLoaded;
}
function renderCredentialFields() {
  for (const qq of [true, false]) {
    $(qq ? 'qqCredentialFields' : 'apiCredentialFields').innerHTML = credentialFields.filter((f) => Boolean(f.qq) === qq).map((f) => `
      <div class="field">
        <label for="credential-${f.key}">${esc(f.title)} <span class="mono">${f.key}</span></label>
        <span class="sub" id="credential-status-${f.key}">尚未读取状态</span>
        <input type="${f.type || 'password'}" id="credential-${f.key}" autocomplete="off" spellcheck="false" autocapitalize="off" maxlength="8192" placeholder="留空保留；输入新值以替换本地副本" aria-describedby="credential-status-${f.key}" />
        <span class="sub">${esc(f.hint)}</span>
        <label><input type="checkbox" id="credential-remove-${f.key}" /> 保存时删除本地副本（不能删除继承环境变量）</label>
      </div>`).join('');
  }
  for (const { key } of credentialFields) {
    credentialInput(key).oninput = () => { credentialsDirty = true; updateCredentialSaveButton(); };
    credentialRemove(key).onchange = () => {
      credentialInput(key).disabled = credentialRemove(key).checked;
      if (credentialRemove(key).checked) credentialInput(key).value = '';
      credentialsDirty = true;
      updateCredentialSaveButton();
    };
  }
}
function showCredentialStatus(result) {
  // Accept only the documented presence/source shape, not arbitrary values from a response.
  const labels = { dsh: '已配置 · DSH 全局凭据', local: '已配置 · 本地私有文件', environment: '已配置 · 继承环境变量（优先使用）', missing: '未配置' };
  for (const { key } of credentialFields) {
    const item = result?.keys?.[key];
    if (!item || typeof item.configured !== 'boolean' || !Object.hasOwn(labels, item.source)
      || item.configured !== (item.source !== 'missing')) throw new Error('Invalid credential status');
  }
  for (const { key } of credentialFields) {
    const item = result.keys[key];
    $(`credential-status-${key}`).textContent = labels[item.source];
    $(`credential-status-${key}`).style.color = item.configured ? 'var(--ok)' : 'var(--muted)';
  }
}
async function loadCredentials() {
  if (credentialsBusy) return;
  credentialsBusy = true; updateCredentialSaveButton();
  $('credentialsMsg').className = 'msg';
  $('credentialsMsg').textContent = '读取状态中…';
  try {
    const result = await api('/api/credentials', { cache: 'no-store' });
    showCredentialStatus(result);
    credentialsState = result;
    clearCredentialInputs();
    credentialsLoaded = true;
    $('credentialsMsg').textContent = '已读取状态；已有值不会回显。';
    $('credentialsAlerts').textContent = '';
  } catch {
    credentialsState = null;
    credentialsLoaded = false;
    $('credentialsMsg').className = 'msg err';
    $('credentialsMsg').textContent = '读取密钥状态失败，请检查面板服务及本地文件权限后重试。';
  } finally {
    credentialsBusy = false;
    updateCredentialSaveButton();
    // 密钥状态是异步读取的；设置首页必须在读取完成后刷新，避免短暂显示“未配置”。
    if (document.body.classList.contains('settings-mode') && document.body.classList.contains('settings-model-keys')) {
      renderSettingsConcept();
    }
  }
}
async function saveCredentials(event) {
  event.preventDefault();
  if (credentialsBusy || !credentialsLoaded) return;
  const values = {};
  const remove = [];
  for (const { key } of credentialFields) {
    if (credentialRemove(key).checked) remove.push(key);
    else if (credentialInput(key).value.trim()) values[key] = credentialInput(key).value.trim().replace(/[\r\n]+/g, '');
  }
  if (Object.keys(values).length === 0 && remove.length === 0) {
    $('credentialsMsg').className = 'msg err';
    $('credentialsMsg').textContent = '没有检测到新值：请先在对应输入框填写，再点保存。';
    return;
  }
  credentialsBusy = true;
  updateCredentialSaveButton();
  $('credentialsMsg').className = 'msg';
  $('credentialsMsg').textContent = '保存中…';
  // Clear typed secrets immediately, including on network failure. Never persist them in browser storage.
  clearCredentialInputs();
  try {
    const result = await api('/api/credentials', { method: 'PUT', cache: 'no-store', body: JSON.stringify({ values, remove }) });
    showCredentialStatus(result);
    credentialsState = result;
    $('credentialsMsg').className = 'msg ok';
    $('credentialsMsg').textContent = '已保存本地配置；停止旧机器人后，在同一 profile 环境中运行 npm run bot 生效。继承环境变量仍优先。';
    $('credentialsAlerts').textContent = '保存不会自动启动、切换模型或清除继承环境。右上角重启按钮仅适用于已显式配置的 macOS launchd 服务；首次使用请按部署指南启动。';
    toast('凭据已保存，请重启机器人', 'ok');
  } catch {
    // 保持 credentialsLoaded，否则按钮会一直灰着，用户连重试都做不到
    // Do not echo server errors: a proxy or validation layer may include a submitted secret.
    $('credentialsMsg').className = 'msg err';
    $('credentialsMsg').textContent = '保存失败：请检查面板服务及本地文件权限后重试（输入已清空，请重新填写后再保存）';
    toast('保存失败，请检查面板服务及本地文件权限后重试', 'err', 6000);
  } finally {
    for (const key of Object.keys(values)) delete values[key];
    credentialsBusy = false;
    updateCredentialSaveButton();
  }
}
renderCredentialFields();
$('credentialsForm').onsubmit = saveCredentials;
$('btnReloadCredentials').onclick = () => {
  if (credentialsDirty && !confirm('刷新会清空尚未保存的输入和删除选择，继续？')) return;
  void loadCredentials();
};

// ── 生图设置：无 Key / 无付费探测 ──
const imageGenerationControls = {
  enabled: 'imageEnabled', model: 'imageModel', size: 'imageSize', quality: 'imageQuality',
  timeoutSeconds: 'imageTimeout',
};
const imageGenerationModels = ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-1.5', 'gpt-image-1-mini', 'Kwai-Kolors/Kolors'];
const imageGenerationFreeModels = ['Kwai-Kolors/Kolors', '@cf/black-forest-labs/flux-1-schnell'];
const imageGenerationSizes = {
  openai: ['1024x1024', '1536x1024', '1024x1536'],
  siliconflow: ['1024x1024', '960x1280', '768x1024'],
  cloudflare: ['1024x1024'],
};
const imageGenerationProviderOf = (model) => model === 'Kwai-Kolors/Kolors' ? 'siliconflow'
  : model === '@cf/black-forest-labs/flux-1-schnell' ? 'cloudflare' : 'openai';
const imageGenerationSizesFor = (model) => imageGenerationSizes[imageGenerationProviderOf(model)];
let imageGenerationLoaded = false;
let imageGenerationBusy = false;
let imageGenerationDirty = false;
let imageGenerationSavedEnabled = false;
function updateImageGenerationControls() {
  $('imageGenerationFields').disabled = imageGenerationBusy || !imageGenerationLoaded;
  $('btnSaveImageGeneration').disabled = imageGenerationBusy || !imageGenerationLoaded || !imageGenerationDirty;
  $('btnReloadImageGeneration').disabled = imageGenerationBusy;
}
function validateImageGenerationDraft(settings) {
  const fields = Object.keys(imageGenerationControls);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)
    || Object.keys(settings).length !== fields.length || fields.some((key) => !Object.hasOwn(settings, key))
    || typeof settings.enabled !== 'boolean'
    || ![...imageGenerationModels, ...imageGenerationFreeModels].includes(settings.model)
    || !imageGenerationSizesFor(settings.model).includes(settings.size)
    || !['low', 'medium', 'high'].includes(settings.quality)) throw new Error('Invalid image settings');
  for (const [key, min, max] of [['timeoutSeconds', 30, 300]]) {
    if (!Number.isInteger(settings[key]) || settings[key] < min || settings[key] > max) throw new Error('Invalid image limits');
  }
  return settings;
}
let imageFormParent = null;
let imageFormNext = null;
function updateImageOverview(settings = null) {
  const status = $('imageOverviewStatus'), summary = $('imageOverviewSummary');
  if (!status || !summary) return;
  if (!settings) { status.className = 'sc-status off'; status.textContent = imageGenerationLoaded ? '状态未知' : '读取中'; return; }
  status.className = `sc-status${settings.enabled ? '' : ' off'}`;
  status.textContent = settings.enabled ? '已启用' : '已关闭';
  summary.textContent = `${settings.model} · ${settings.size} · ${settings.quality} · 超时 ${settings.timeoutSeconds}s`;
}
function openImageConfigEditor() {
  const form = $('imageGenerationForm');
  if (!form || !form.parentNode) return;
  imageFormParent = form.parentNode; imageFormNext = form.nextSibling;
  $('imageConfigBody').appendChild(form);
  $('imageConfigModal').classList.add('show');
}
function closeImageConfigEditor() {
  if (imageFormParent) {
    imageFormParent.insertBefore($('imageGenerationForm'), imageFormNext && imageFormNext.parentNode === imageFormParent ? imageFormNext : null);
    imageFormParent = null; imageFormNext = null;
  }
  $('imageConfigModal').classList.remove('show');
  updateImageOverview(imageGenerationLoaded ? {
    enabled: $('imageEnabled').checked, model: $('imageModel').value, size: $('imageSize').value,
    quality: $('imageQuality').value, timeoutSeconds: Number($('imageTimeout').value),
  } : null);
}
function showImageGenerationSettings(settings) {
  validateImageGenerationDraft(settings);
  for (const [key, id] of Object.entries(imageGenerationControls)) {
    if (key === 'enabled') $(id).checked = settings.enabled;
    else $(id).value = String(settings[key]);
  }
  $('imageQuality').disabled = imageGenerationProviderOf(settings.model) !== 'openai';
  imageGenerationSavedEnabled = settings.enabled;
  imageGenerationDirty = false;
  imageGenerationLoaded = true;
  updateImageOverview(settings);
}
async function loadImageGenerationSettings() {
  if (imageGenerationBusy) return;
  imageGenerationBusy = true; updateImageGenerationControls();
  $('imageGenerationMsg').className = 'msg';
  $('imageGenerationMsg').textContent = '读取生图设置中…';
  try {
    const result = await api('/api/image-generation', { cache: 'no-store' });
    showImageGenerationSettings(result.settings);
    $('imageGenerationMsg').textContent = result.settings.enabled ? '已启用生图；仅明确画图请求可触发，可能计费。' : '生图已关闭；保存 Key 不会自动启用。';
  } catch {
    imageGenerationLoaded = false;
    $('imageEnabled').checked = false;
    $('imageGenerationMsg').className = 'msg err';
    $('imageGenerationMsg').textContent = '无法读取生图设置，请检查配置文件格式与权限后刷新；不会自动覆盖或启用。';
  } finally { imageGenerationBusy = false; updateImageGenerationControls(); }
}
async function saveImageGenerationSettings(event) {
  event.preventDefault();
  if (imageGenerationBusy || !imageGenerationLoaded || !imageGenerationDirty) return;
  const settings = {};
  for (const [key, id] of Object.entries(imageGenerationControls)) {
    settings[key] = key === 'enabled' ? $(id).checked : key === 'timeoutSeconds' ? Number($(id).value) : $(id).value;
  }
  try { validateImageGenerationDraft(settings); }
  catch { $('imageGenerationMsg').className = 'msg err'; $('imageGenerationMsg').textContent = '请检查生图枚举选项和整数范围。'; return; }
  if (settings.enabled && !imageGenerationSavedEnabled && !confirm('启用后，仅明确画图请求可向所选图片服务发送本轮新 prompt 并产生费用（硅基流动 Kolors 当前为免费模型）；不附带群历史，每次单张且不自动重试。确认启用？')) return;
  imageGenerationBusy = true; updateImageGenerationControls();
  $('imageGenerationMsg').className = 'msg';
  $('imageGenerationMsg').textContent = '保存生图设置中（不会生成图片）…';
  try {
    const result = await api('/api/image-generation', { method: 'PUT', cache: 'no-store', body: JSON.stringify(settings) });
    showImageGenerationSettings(result.settings);
    $('imageGenerationMsg').className = 'msg ok';
    $('imageGenerationMsg').textContent = '设置已保存，后续请求动态生效；未调用生图接口。新 Key 仍需重启机器人。';
  } catch {
    imageGenerationLoaded = false;
    $('imageGenerationMsg').className = 'msg err';
    $('imageGenerationMsg').textContent = '保存未确认成功，请刷新生图设置核对；不会自动重试或生成图片。';
  } finally { imageGenerationBusy = false; updateImageGenerationControls(); }
}
for (const id of Object.values(imageGenerationControls)) {
  const mark = () => { if (imageGenerationLoaded && !imageGenerationBusy) { imageGenerationDirty = true; updateImageGenerationControls(); } };
  $(id).oninput = mark;
  $(id).onchange = mark;
}
$('imageModel').onchange = () => {
  const allowed = imageGenerationSizesFor($('imageModel').value);
  if (!allowed.includes($('imageSize').value)) $('imageSize').value = allowed[0];
  $('imageQuality').disabled = imageGenerationProviderOf($('imageModel').value) !== 'openai';
};
$('imageGenerationForm').onsubmit = saveImageGenerationSettings;
$('btnReloadImageGeneration').onclick = () => {
  if (imageGenerationDirty && !confirm('刷新会丢弃未保存的生图设置，继续？')) return;
  void loadImageGenerationSettings();
};
$('btnOpenImageConfig').onclick = openImageConfigEditor;
$('imageConfigClose').onclick = closeImageConfigEditor;
$('imageConfigModal').onclick = (e) => { if (e.target.id === 'imageConfigModal') closeImageConfigEditor(); };
updateImageGenerationControls();
// ── 生图设置结束 ──

// ── 语音合成设置：可插拔 provider 列表（顺序即优先级） ──
const ttsProviderSpecs = {
  'index-tts-local': {
    label: '本地 IndexTTS',
    fields: [
      { key: 'followMood', label: '情绪跟随机器人心情（烦躁时语气略带急）', type: 'checkbox' },
      { key: 'url', label: '服务地址（只允许本机）', type: 'text', placeholder: 'http://127.0.0.1:7793' },
      { key: 'voice', label: '音色名（~/index-tts/voices 下的文件名）', type: 'text', placeholder: 'u2' },
      { key: 'emotion', label: '情绪（可空）', type: 'select', options: ['', 'happy', 'angry', 'sad', 'afraid', 'disgusted', 'melancholic', 'surprised', 'calm'] },
      { key: 'emoAlpha', label: '情绪强度（0–1）', type: 'number', min: 0, max: 1, step: 0.1 },
      { key: 'durationFactor', label: '语速系数（0.5–2，越大越慢）', type: 'number', min: 0.5, max: 2, step: 0.05 },
      { key: 'maxChars', label: '本地长度上限（字）', type: 'number', min: 1, max: 500, step: 1 },
      { key: 'timeoutSeconds', label: '超时（秒）', type: 'number', min: 5, max: 300, step: 1 },
    ],
  },
  'openai-compatible': {
    label: 'OpenAI 兼容 /audio/speech',
    fields: [
      { key: 'baseUrl', label: '接口根地址（https）', type: 'text', placeholder: 'https://api.siliconflow.cn/v1' },
      { key: 'model', label: '模型名', type: 'text', placeholder: 'FunAudioLLM/CosyVoice2-0.5B' },
      { key: 'voice', label: '音色名（按服务要求，可带模型前缀）', type: 'text', placeholder: 'FunAudioLLM/CosyVoice2-0.5B:diana' },
      { key: 'credential', label: '凭据变量名', type: 'text', placeholder: 'SILICONFLOW_API_KEY' },
      { key: 'responseFormat', label: '返回格式', type: 'select', options: ['mp3', 'wav', 'opus', 'aac', 'flac'] },
      { key: 'speed', label: '语速（0.25–4）', type: 'number', min: 0.25, max: 4, step: 0.05 },
      { key: 'timeoutSeconds', label: '超时（秒）', type: 'number', min: 5, max: 300, step: 1 },
    ],
  },
  'edge': {
    label: 'Edge TTS（免费兜底）',
    fields: [
      { key: 'voice', label: '声线', type: 'text', placeholder: 'zh-CN-XiaoyiNeural' },
    ],
  },
};
const ttsProviderDefaults = {
  'index-tts-local': { enabled: true, followMood: true, url: 'http://127.0.0.1:7793', voice: 'u2', emotion: '', emoAlpha: 0.5, durationFactor: 0.95, maxChars: 120, timeoutSeconds: 150 },
  'openai-compatible': { enabled: true, baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/CosyVoice2-0.5B', voice: 'FunAudioLLM/CosyVoice2-0.5B:diana', credential: 'SILICONFLOW_API_KEY', responseFormat: 'mp3', speed: 1.1, timeoutSeconds: 20 },
  'edge': { enabled: true, voice: 'zh-CN-XiaoyiNeural' },
};
let ttsLoaded = false;
let ttsBusy = false;
let ttsDirty = false;
let ttsSavedEnabled = false;
let ttsState = { enabled: true, maxChars: 120, cooldownSeconds: 60, providers: [] };
function updateTtsControls() {
  $('ttsFields').disabled = ttsBusy || !ttsLoaded;
  $('btnSaveTts').disabled = ttsBusy || !ttsLoaded || !ttsDirty;
  $('btnReloadTts').disabled = ttsBusy;
}
function ttsMarkDirty() {
  if (ttsLoaded && !ttsBusy) { ttsDirty = true; updateTtsControls(); }
}
function ttsInput(provider, field) {
  if (field.type === 'checkbox') {
    const box = document.createElement('div');
    box.className = 'field';
    const radio = document.createElement('label');
    radio.style.cssText = 'display:flex;align-items:center;gap:6px';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = provider[field.key] !== false;
    toggle.onchange = () => { provider[field.key] = toggle.checked; ttsMarkDirty(); };
    radio.append(toggle, document.createTextNode(field.label));
    box.append(radio);
    return box;
  }
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const label = document.createElement('label');
  label.textContent = field.label;
  let control;
  if (field.type === 'select') {
    control = document.createElement('select');
    for (const option of field.options) {
      const el = document.createElement('option');
      el.value = option;
      el.textContent = option === '' ? '（不指定）' : option;
      control.appendChild(el);
    }
    control.value = String(provider[field.key] ?? '');
  } else {
    control = document.createElement('input');
    if (field.type === 'number') {
      control.type = 'number';
      control.min = String(field.min);
      control.max = String(field.max);
      control.step = String(field.step);
    } else {
      control.type = 'text';
      if (field.placeholder) control.placeholder = field.placeholder;
    }
    control.value = String(provider[field.key] ?? '');
  }
  control.oninput = () => {
    provider[field.key] = field.type === 'number' ? Number(control.value) : control.value;
    ttsMarkDirty();
  };
  control.onchange = control.oninput;
  wrap.append(label, control);
  return wrap;
}
function ttsProviderSummary(provider) {
  if (provider.id === 'index-tts-local') return `本机服务 · ${provider.voice || '未设置音色'} · 语速 ${provider.durationFactor ?? '默认'}`;
  if (provider.id === 'openai-compatible') return `${provider.model || '未设置模型'} · ${provider.voice || '未设置音色'}`;
  return `免费兜底 · ${provider.voice || '未设置声线'}`;
}
function openTtsProviderEditor(index) {
  const provider = ttsState.providers[index], spec = ttsProviderSpecs[provider?.id];
  if (!provider || !spec) return;
  const modal = $('ttsProviderModal'), body = $('ttsProviderBody');
  $('ttsProviderTitle').textContent = `${spec.label}配置`;
  body.textContent = '';
  const section = document.createElement('div');
  section.className = 'detail-section';
  const heading = document.createElement('h3');
  heading.textContent = '服务参数';
  section.appendChild(heading);
  const grid = document.createElement('div');
  grid.className = 'detail-grid';
  for (const field of spec.fields) grid.appendChild(ttsInput(provider, field));
  section.appendChild(grid);
  const actions = document.createElement('div');
  actions.className = 'sc-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'small'; cancel.textContent = '取消';
  cancel.onclick = closeTtsProviderEditor;
  const save = document.createElement('button');
  save.type = 'button'; save.className = 'small primary'; save.textContent = '完成配置';
  save.onclick = closeTtsProviderEditor;
  actions.append(cancel, save);
  body.append(section, actions);
  modal.classList.add('show');
}
function closeTtsProviderEditor() {
  $('ttsProviderModal').classList.remove('show');
  renderTts();
}
function renderTts() {
  const list = $('ttsProviders');
  list.textContent = '';
  ttsState.providers.forEach((provider, index) => {
    const spec = ttsProviderSpecs[provider.id];
    if (!spec) return;
    const card = document.createElement('article');
    card.className = 'sc-card tts-provider-card';
    card.onclick = (event) => { if (!event.target.closest('button,input')) openTtsProviderEditor(index); };
    const head = document.createElement('div');
    head.className = 'sc-top';
    const title = document.createElement('h3');
    title.textContent = `${index + 1}. ${spec.label}`;
    const tools = document.createElement('div');
    tools.className = 'sc-card-tools';
    const status = document.createElement('span');
    status.className = `sc-status${provider.enabled ? '' : ' off'}`;
    status.textContent = provider.enabled ? '已启用' : '已停用';
    const enableLabel = document.createElement('label');
    enableLabel.className = 'tts-enable';
    const enable = document.createElement('input');
    enable.type = 'checkbox'; enable.checked = provider.enabled; enable.setAttribute('aria-label', `启用${spec.label}`);
    enable.onchange = () => { provider.enabled = enable.checked; ttsMarkDirty(); renderTts(); };
    enableLabel.append(enable, document.createTextNode('启用'));
    tools.append(status, enableLabel);
    head.append(title, tools);
    const summary = document.createElement('p');
    summary.className = 'tts-provider-summary'; summary.textContent = ttsProviderSummary(provider);
    const foot = document.createElement('div'); foot.className = 'sc-foot';
    const order = document.createElement('span'); order.textContent = '服务顺序 · 可调整';
    const actions = document.createElement('div'); actions.className = 'tts-card-actions';
    const config = document.createElement('button'); config.type = 'button'; config.className = 'small primary'; config.textContent = '配置'; config.onclick = () => openTtsProviderEditor(index);
    const up = document.createElement('button'); up.type = 'button'; up.className = 'small'; up.textContent = '上移'; up.disabled = index === 0;
    up.onclick = () => { [ttsState.providers[index - 1], ttsState.providers[index]] = [ttsState.providers[index], ttsState.providers[index - 1]]; ttsMarkDirty(); renderTts(); };
    const down = document.createElement('button'); down.type = 'button'; down.className = 'small'; down.textContent = '下移'; down.disabled = index === ttsState.providers.length - 1;
    down.onclick = () => { [ttsState.providers[index], ttsState.providers[index + 1]] = [ttsState.providers[index + 1], ttsState.providers[index]]; ttsMarkDirty(); renderTts(); };
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'small danger'; remove.textContent = '移除'; remove.disabled = ttsState.providers.length <= 1;
    remove.onclick = () => { if (ttsState.providers.length <= 1) return; ttsState.providers.splice(index, 1); ttsMarkDirty(); renderTts(); };
    actions.append(config, up, down, remove); foot.append(order, actions);
    card.append(head, summary, foot); list.appendChild(card);
  });
}
function showTtsSettings(settings) {
  ttsState = {
    enabled: settings.enabled,
    maxChars: settings.maxChars,
    cooldownSeconds: settings.cooldownSeconds,
    providers: settings.providers.map((provider) => ({ ...provider })),
  };
  $('ttsEnabled').checked = settings.enabled;
  $('ttsMaxChars').value = String(settings.maxChars);
  $('ttsCooldown').value = String(settings.cooldownSeconds);
  ttsSavedEnabled = settings.enabled;
  ttsDirty = false;
  ttsLoaded = true;
  renderTts();
}
async function loadTtsSettings() {
  if (ttsBusy) return;
  ttsBusy = true; updateTtsControls();
  $('ttsMsg').className = 'msg';
  $('ttsMsg').textContent = '读取语音设置中…';
  try {
    const result = await api('/api/tts', { cache: 'no-store' });
    showTtsSettings(result.settings);
    $('ttsMsg').textContent = result.settings.enabled ? '语音已启用；按列表顺序尝试，失败自动降级。' : '语音已关闭；保存不会自动启用。';
  } catch {
    ttsLoaded = false;
    $('ttsEnabled').checked = false;
    $('ttsMsg').className = 'msg err';
    $('ttsMsg').textContent = '无法读取语音设置，请检查配置文件格式与权限后刷新；不会自动覆盖或启用。';
  } finally { ttsBusy = false; updateTtsControls(); }
}
async function saveTtsSettings(event) {
  event.preventDefault();
  if (ttsBusy || !ttsLoaded || !ttsDirty) return;
  const settings = {
    enabled: $('ttsEnabled').checked,
    maxChars: Number($('ttsMaxChars').value),
    cooldownSeconds: Number($('ttsCooldown').value),
    providers: ttsState.providers,
  };
  if (!Number.isInteger(settings.maxChars) || settings.maxChars < 1 || settings.maxChars > 500
      || !Number.isInteger(settings.cooldownSeconds) || settings.cooldownSeconds < 0 || settings.cooldownSeconds > 3600) {
    $('ttsMsg').className = 'msg err';
    $('ttsMsg').textContent = '请检查单条上限（1–500）与冷却时间（0–3600）是否为整数。';
    return;
  }
  if (!settings.providers.some((provider) => provider.enabled)) {
    $('ttsMsg').className = 'msg err';
    $('ttsMsg').textContent = '至少要启用一个语音服务。';
    return;
  }
  if (settings.enabled && !ttsSavedEnabled && !confirm('启用后，明确要求语音时才调用所选服务；云端模型可能产生费用。确认启用？')) return;
  ttsBusy = true; updateTtsControls();
  $('ttsMsg').className = 'msg';
  $('ttsMsg').textContent = '保存语音设置中（不合成）…';
  try {
    const result = await api('/api/tts', { method: 'PUT', cache: 'no-store', body: JSON.stringify(settings) });
    showTtsSettings(result.settings);
    $('ttsMsg').className = 'msg ok';
    $('ttsMsg').textContent = '设置已保存，后续语音请求动态生效，无需重启。';
  } catch {
    ttsLoaded = false;
    $('ttsMsg').className = 'msg err';
    $('ttsMsg').textContent = '保存未确认成功，请刷新语音设置核对；不会自动重试或合成。';
  } finally { ttsBusy = false; updateTtsControls(); }
}
for (const id of ['ttsEnabled', 'ttsMaxChars', 'ttsCooldown']) $(id).oninput = ttsMarkDirty;
$('ttsForm').onsubmit = saveTtsSettings;
$('btnReloadTts').onclick = () => {
  if (ttsDirty && !confirm('刷新会丢弃未保存的语音设置，继续？')) return;
  void loadTtsSettings();
};
$('btnAddTtsProvider').onclick = () => {
  const id = $('ttsNewProvider').value;
  if (ttsState.providers.some((provider) => provider.id === id)) {
    $('ttsMsg').className = 'msg err';
    $('ttsMsg').textContent = '这个语音服务已经在列表里了。';
    return;
  }
  if (ttsState.providers.length >= 4) {
    $('ttsMsg').className = 'msg err';
    $('ttsMsg').textContent = '最多 4 个语音服务。';
    return;
  }
  ttsState.providers.push({ id, ...ttsProviderDefaults[id] });
  ttsMarkDirty();
  renderTts();
};
updateTtsControls();
void loadTtsSettings();
// ── 语音合成设置结束 ──
function personaKeys() {
  // 默认、通配、以及每个群（元数据里有名字），再补上数据里有但元数据缺的 key
  const keys = ['default', '*'];
  for (const g of OV.groups ?? []) keys.push(g.id);
  for (const k of Object.keys(personas.personas ?? {})) if (!keys.includes(k)) keys.push(k);
  return keys;
}

function groupName(key) {
  if (key === 'default') return '默认人格';
  if (key === '*') return '通配（* 未单独配置的群）';
  const g = (OV.groups ?? []).find((x) => x.id === key);
  return g?.name ?? '未知群';
}

function effectiveEntry(key) {
  return personas.personas?.[key] ?? personas.personas?.['*'] ?? personas.personas?.default ?? null;
}

function inheritedFrom(key) {
  if (key === 'default' || key === '*') return null;   // 这两份是最底层，没有可继承的对象
  if (personas.personas?.[key]) return null;
  if (personas.personas?.['*']) return '*';
  return 'default';
}

function entryModules(key) {
  const entry = effectiveEntry(key);
  if (!entry) return [];
  return Array.isArray(entry) ? entry.slice() : (entry.modules ?? []).slice();
}

function entryArchetype(key) {
  const entry = effectiveEntry(key);
  return Array.isArray(entry) ? '' : (entry.archetype ?? '');
}
function entryName(key) {
  const entry = effectiveEntry(key);
  return Array.isArray(entry) ? '' : (typeof entry?.name === 'string' ? entry.name.trim() : '');
}

function setEntry(key, { modules, archetype, name } = {}) {
  const current = personas.personas?.[key];
  const currentName = Array.isArray(current) ? '' : (typeof current?.name === 'string' ? current.name : '');
  const nextName = name === undefined ? currentName : String(name).trim();
  personas.personas[key] = { modules, ...(archetype ? { archetype } : {}), ...(nextName ? { name: nextName } : {}) };
  dirty.personas = true;
}

const PERSONA_ARCHETYPE_NAMES = {
  curious: '好奇心型', aloof: '清冷型', teasing: '调侃型', caring: '关怀型',
};
const PERSONA_MODULE_NAMES = {
  'cat.identity': '猫娘身份', 'hobbies.common': '通用爱好', 'self.name': '自我姓名',
  'cat.manner': '说话方式', curiosity: '认知边界', care: '关心他人',
  'chat.register': '语域判断', 'cat.boundaries': '硬性边界', draw: '画图能力',
  bili: 'B站视频', silence: '何时闭嘴', 'whale.identity': '鲸鱼娘身份',
  'whale.manner': '鲸鱼娘说话方式', 'whale.boundaries': '鲸鱼娘边界',
};
function archetypeDisplay(id) { return PERSONA_ARCHETYPE_NAMES[id] ?? id; }
function moduleDisplay(id) { return PERSONA_MODULE_NAMES[id] ?? id; }
function personaSignature(key) { return JSON.stringify({ modules: entryModules(key), archetype: entryArchetype(key) }); }
function personaProfiles() {
  const result = [];
  const bySignature = new Map();
  for (const key of personaKeys()) {
    const own = Boolean(personas.personas?.[key]);
    if (key !== 'default' && key !== '*' && !own) continue;
    const signature = personaSignature(key);
    let profile = bySignature.get(signature);
    if (!profile) {
      const arch = entryArchetype(key);
      const first = entryModules(key)[0];
      const explicitName = entryName(key);
      const name = explicitName || (key === 'default' ? '默认人格' : key === '*' ? '通用人格' : (arch ? archetypeDisplay(arch) : `${moduleDisplay(first || 'custom')}人格`));
      profile = { sourceKey: key, name, memberKeys: [] };
      bySignature.set(signature, profile); result.push(profile);
    }
    profile.memberKeys.push(key);
  }
  return result.map((profile, index) => ({ ...profile, name: index > 1 && result.filter((x) => x.name === profile.name).indexOf(profile) > 0 ? `${profile.name} ${result.filter((x) => x.name === profile.name).indexOf(profile) + 1}` : profile.name }));
}

function renderPersonaTab() {
  // 左侧显示人格，不再显示群组名称；每个条目保留一个真实数据源 key
  const profiles = personaProfiles();
  $('plist').innerHTML = profiles.map((profile) => {
    const key = profile.sourceKey;
    const own = Boolean(personas.personas?.[key]);
    const from = inheritedFrom(key);
    const badge = own ? '<span class="badge own">已装备</span>' : `<span class="badge">继承 ${esc(from === '*' ? '通用' : '默认')}</span>`;
    const users = profile.memberKeys.filter((x) => x !== 'default' && x !== '*').length;
    const sub = users ? `${users} 个群组使用` : (key === '*' ? '未单独配置的群组' : '基础人格模板');
    return `<li data-key="${esc(key)}" class="${key === selectedKey ? 'active' : ''}">
      <span>${esc(profile.name)} <small class="id">${esc(sub)}</small></span><span>${badge}</span></li>`;
  }).join('');
  $('personaCount').textContent = `${profiles.length} 个`;
  for (const li of $('plist').children) {
    li.onclick = () => { selectedKey = li.dataset.key; renderPersonaTab(); };
  }

  const key = selectedKey;
  const own = Boolean(personas.personas?.[key]);
  const from = inheritedFrom(key);
  const isBase = key === 'default' || key === '*';
  $('personaTitle').textContent = personaProfiles().find((profile) => profile.sourceKey === key)?.name ?? entryName(key) ?? (key === '*' ? '通用人格' : '默认人格');
  $('personaHint').innerHTML = own
    ? '这份人格有独立内容，编辑后保存即生效。'
    : isBase
      ? '还没有配置这份人格，点右上角「新建人格」从空模板开始。'
      : (from ? `当前继承自「${from === '*' ? '通配' : '默认人格'}」；点「启用独立人格」才会为它单独存一份。` : '还没有任何人格数据。');

  $('btnOwn').textContent = isBase ? '新建人格' : '启用独立人格';
  $('btnOwn').hidden = own;
  $('btnInherit').hidden = !own || isBase;

  // archetype
  const archetypes = Object.keys(personas.archetypes ?? {});
  $('selArchetype').innerHTML = `<option value="">（不用人格类型）</option>`
    + archetypes.map((a) => `<option value="${esc(a)}">${esc(archetypeDisplay(a))}</option>`).join('');
  $('selArchetype').value = own ? entryArchetype(key) : '';
  $('selArchetype').disabled = !own;

  // 模块顺序
  const mods = entryModules(key);
  const allIds = Object.keys(personas.modules ?? {});
  $('moduleList').innerHTML = mods.map((id, i) => {
    const text = personas.modules?.[id] ?? '';
    return `<li>
      <span class="name" title="${esc(id)}">${esc(moduleDisplay(id))}</span>
      <span class="preview">${esc(text.replace(/\s+/g, ' ').slice(0, 70))}</span>
      <span class="ops">
        <button class="mini" data-op="up" data-i="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="mini" data-op="down" data-i="${i}" ${i === mods.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="mini danger" data-op="rm" data-i="${i}">✕</button>
      </span></li>`;
  }).join('') || '<li class="muted">（空人格）</li>';

  $('moduleList').onclick = (e) => {
    const btn = e.target.closest('button[data-op]');
    if (!btn) return;
    if (!own) return toast('先点「启用独立人格」再改模块', 'err');
    const list = entryModules(key);
    const i = Number(btn.dataset.i);
    const op = btn.dataset.op;
    if (op === 'up' && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
    if (op === 'down' && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
    if (op === 'rm') list.splice(i, 1);
    setEntry(key, { modules: list, archetype: $('selArchetype').value });
    renderPersonaTab();
  };

  // 追加模块
  $('selAddModule').innerHTML = allIds.map((id) => `<option value="${esc(id)}">${esc(moduleDisplay(id))}</option>`).join('');
  $('btnAddModule').disabled = !own || allIds.length === 0;

  // 复制到
  const targets = personaKeys().filter((k) => k !== key);
  $('selCopyTo').innerHTML = targets.map((k) => `<option value="${esc(k)}">${esc(groupName(k))}</option>`).join('');
  $('btnCopy').disabled = !own || targets.length === 0;

  // 模块库
  $('moduleCount').textContent = `${allIds.length} 个模块`;
  $('personaModuleChip').textContent = `模块 ${mods.length} 个`;
  $('moduleEditor').innerHTML = allIds.map((id) => {
    const text = personas.modules?.[id] ?? '';
    return `<details class="mod" data-id="${esc(id)}">
      <summary title="${esc(id)}"><span class="mono">${esc(moduleDisplay(id))}</span><span class="muted" style="font-size:11px">${text.length} 字</span></summary>
      <div class="body">
        <div class="meta">
          <span class="mono">${esc(moduleDisplay(id))}</span>
          <button class="mini" data-act="rename">重命名</button>
          <button class="mini danger" data-act="del">删除</button>
        </div>
        <textarea data-text="${esc(id)}" rows="8">${esc(text)}</textarea>
      </div></details>`;
  }).join('') || '<div class="muted">还没有模块，点「+ 新建模块」开始。</div>';

  $('moduleEditor').oninput = (e) => {
    const ta = e.target.closest('textarea[data-text]');
    if (!ta) return;
    personas.modules[ta.dataset.text] = ta.value;
    dirty.personas = true;
    const li = ta.closest('details').querySelector('summary .muted');
    if (li) li.textContent = `${ta.value.length} 字`;
    renderPreview(key);
    markPersonaDirty();
  };
  $('moduleEditor').onclick = (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    e.preventDefault();
    const id = btn.closest('details').dataset.id;
    if (btn.dataset.act === 'rename') {
      const next = prompt(`把模块 ${id} 改名为：`, id);
      if (!next || next === id) return;
      if (personas.modules[next] !== undefined) return toast('这个名字已经被占用了', 'err');
      personas.modules[next] = personas.modules[id];
      delete personas.modules[id];
      for (const [k, entry] of Object.entries(personas.personas)) {
        const list = Array.isArray(entry) ? entry : entry.modules;
        const at = list.indexOf(id);
        if (at !== -1) list[at] = next;
        if (Array.isArray(entry)) personas.personas[k] = list;
      }
      dirty.personas = true;
      renderPersonaTab(); markPersonaDirty();
    }
    if (btn.dataset.act === 'del') {
      const users = Object.entries(personas.personas).filter(([, entry]) => {
        const list = Array.isArray(entry) ? entry : entry.modules; return list.includes(id);
      }).map(([k]) => groupName(k));
      if (users.length && !confirm(`模块 ${id} 正被这些地方使用：\n${users.join('、')}\n\n删除后会从它们的顺序里一并移除，继续？`)) return;
      delete personas.modules[id];
      for (const [k, entry] of Object.entries(personas.personas)) {
        const list = Array.isArray(entry) ? entry : entry.modules;
        const at = list.indexOf(id);
        if (at !== -1) list.splice(at, 1);
        if (Array.isArray(entry)) personas.personas[k] = list;
      }
      dirty.personas = true;
      renderPersonaTab(); markPersonaDirty();
    }
  };

  $('selArchetype').onchange = (e) => {
    if (!own) return;
    const mods = entryModules(key);
    if (e.target.value) setEntry(key, { modules: mods, archetype: e.target.value });
    else { personas.personas[key] = { modules: mods }; dirty.personas = true; }
    renderPreview(key); markPersonaDirty();
  };

  $('btnOwn').onclick = () => {
    const from = inheritedFrom(key);
    const list = entryModules(from ?? 'default');
    const arch = from ? entryArchetype(from) : '';
    setEntry(key, { modules: list, archetype: arch });
    renderPersonaTab(); markPersonaDirty();
  };
  $('btnInherit').onclick = () => {
    if (!confirm('删掉这个群的独立人格，恢复继承默认？')) return;
    delete personas.personas[key];
    dirty.personas = true;
    renderPersonaTab(); markPersonaDirty();
  };
  $('btnAddModule').onclick = () => {
    const id = $('selAddModule').value;
    if (!id) return;
    setEntry(key, { modules: [...entryModules(key), id], archetype: $('selArchetype').value });
    renderPersonaTab(); markPersonaDirty();
  };
  $('btnCopy').onclick = () => {
    const target = $('selCopyTo').value;
    if (!target) return;
    if (!confirm(`把这个群的人格覆盖到「${groupName(target)}」？`)) return;
    setEntry(target, { modules: entryModules(key), archetype: $('selArchetype').value });
    renderPersonaTab(); markPersonaDirty();
  };
  $('btnNewModule').onclick = () => {
    const id = prompt('新模块 id（建议 角色.用途，例如 cat.identity）：', 'new.module');
    if (!id) return;
    if (personas.modules[id] !== undefined) return toast('已存在同名模块', 'err');
    personas.modules[id] = '';
    dirty.personas = true;
    renderPersonaTab(); markPersonaDirty();
    const el = $('moduleEditor').querySelector(`details[data-id="${CSS.escape(id)}"]`);
    if (el) { el.open = true; el.querySelector('textarea').focus(); }
  };

  renderPreview(key);
  $('btnSavePersona').disabled = !dirty.personas;
  if (!dirty.personas) $('personaMsg').textContent = '';
}

function renderPersonaGroupConfig() {
  const groups = OV.groups ?? [];
  const profiles = personaProfiles();
  // 多个群可共用同一个人格选项；选项的值是代表群，而不一定是当前群。
  const profileKeyByMember = new Map(profiles.flatMap(({ sourceKey, memberKeys }) =>
    memberKeys.map((key) => [key, sourceKey])));
  const fallback = personas.personas?.['*'] ? '*' : 'default';
  const options = profiles.map(({ sourceKey, name }) => `<option value="${esc(sourceKey)}">${esc(name)}</option>`).join('');
  const batch = $('personaBatchProfile');
  if (!batch) return;
  batch.innerHTML = `<option value="">选择人格模板…</option>${options}`;
  $('personaFallback').value = fallback;
  $('personaGroupList').innerHTML = groups.length ? groups.map((group) => {
    const own = Boolean(personas.personas?.[group.id]);
    return `<div class="group-row" data-group-id="${esc(group.id)}">
      <span class="group-avatar">${esc((group.name || group.id || '群').slice(0, 1))}</span>
      <div class="group-info"><strong>${esc(group.name || group.id)}</strong><small>群 ${esc(String(group.id).slice(0, 8))}… · ${own ? '独立配置' : `继承${fallback === '*' ? '通配' : '默认'}`}</small></div>
      <select data-group-persona="${esc(group.id)}">${options}</select>
      <div class="group-wake"><label>唤醒</label><input type="range" min="0" max="100" step="5" value="${OV.wakeIndex?.map?.[group.id] ?? OV.wakeIndex?.default ?? 100}" data-group-wake="${esc(group.id)}"><strong data-group-wake-value="${esc(group.id)}">${OV.wakeIndex?.map?.[group.id] ?? OV.wakeIndex?.default ?? 100}</strong></div>
    </div>`;
  }).join('') : '<div class="muted">暂无已发现群组。</div>';
  for (const select of $('personaGroupList').querySelectorAll('select[data-group-persona]')) {
    select.value = profileKeyByMember.get(select.dataset.groupPersona) ?? profileKeyByMember.get(fallback);
    select.onchange = () => {
      const gid = select.dataset.groupPersona;
      const source = select.value;
      if (source === 'default' || source === '*') {
        delete personas.personas[gid];
      } else {
        setEntry(gid, { modules: entryModules(source), archetype: entryArchetype(source), name: entryName(source) });
      }
      dirty.personas = true;
      renderPersonaGroupConfig();
      markPersonaDirty();
    };
  }
  for (const input of $('personaGroupList').querySelectorAll('input[data-group-wake]')) {
    const value = $('personaGroupList').querySelector(`[data-group-wake-value="${CSS.escape(input.dataset.groupWake)}"]`);
    input.oninput = () => { if (value) value.textContent = input.value; };
    input.onchange = () => { void saveWakeIndex(Number(input.value), input.dataset.groupWake); };
  }
  batch.onchange = () => {
    const source = batch.value;
    if (!source) return;
    for (const group of groups) {
      if (source === 'default' || source === '*') delete personas.personas[group.id];
      else setEntry(group.id, { modules: entryModules(source), archetype: entryArchetype(source), name: entryName(source) });
    }
    dirty.personas = true;
    renderPersonaGroupConfig();
    markPersonaDirty();
  };
  $('personaFallback').onchange = () => {
    const source = $('personaFallback').value;
    for (const group of groups) {
      if (!personas.personas?.[group.id]) continue;
      // 仅更新继承策略，不覆盖已经独立配置的群组。
    }
    if (source === '*' && !personas.personas?.['*']) toast('当前还没有通配人格，未配置群组仍会回落到默认人格。', 'err');
    renderPersonaGroupConfig();
  };
}

function savePersonaName(name) {
  const next = String(name ?? '').trim();
  if (!next) throw new Error('人格名称不能为空');
  const current = personas.personas?.[selectedKey];
  const source = inheritedFrom(selectedKey);
  if (!current && source) setEntry(selectedKey, { modules: entryModules(source), archetype: entryArchetype(source), name: next });
  else if (Array.isArray(current)) setEntry(selectedKey, { modules: current, name: next });
  else setEntry(selectedKey, { modules: entryModules(selectedKey), archetype: entryArchetype(selectedKey), name: next });
}
function openPersonaNameEditor() {
  const modal = $('personaNameModal');
  const input = $('personaNameInput');
  input.value = personaProfiles().find((profile) => profile.sourceKey === selectedKey)?.name ?? entryName(selectedKey) ?? '';
  modal.classList.add('show');
  input.focus(); input.select();
}
function closePersonaNameEditor() { $('personaNameModal').classList.remove('show'); }

function setupPersonaViews() {
  for (const tab of document.querySelectorAll('[data-persona-view]')) {
    tab.onclick = () => {
      personaView = tab.dataset.personaView;
      document.querySelectorAll('[data-persona-view]').forEach((x) => x.classList.toggle('active', x === tab));
      $('personaViewEquip').classList.toggle('active', personaView === 'equip');
      $('personaViewGroups').classList.toggle('active', personaView === 'groups');
      if (personaView === 'groups') renderPersonaGroupConfig();
    };
  }
  $('btnSavePersonaTop').onclick = () => void savePersonas();
  $('btnSaveGroupConfig').onclick = () => void savePersonas();
  $('btnRenamePersona').onclick = openPersonaNameEditor;
  $('btnFullPreview').onclick = () => { $('fullPreview').textContent = $('preview').textContent; $('fullPreviewHint').textContent = $('previewHint').textContent; $('personaPreviewModal').classList.add('show'); };
  $('btnFullPreviewClose').onclick = () => $('personaPreviewModal').classList.remove('show');
  $('personaPreviewModal').onclick = (event) => { if (event.target.id === 'personaPreviewModal') event.currentTarget.classList.remove('show'); };
  $('btnPersonaNameCancel').onclick = closePersonaNameEditor;
  $('personaNameModal').onclick = (event) => { if (event.target.id === 'personaNameModal') closePersonaNameEditor(); };
  $('btnPersonaNameConfirm').onclick = () => {
    try { savePersonaName($('personaNameInput').value); closePersonaNameEditor(); renderPersonaTab(); renderPersonaGroupConfig(); markPersonaDirty(); }
    catch (err) { toast(err.message, 'err'); }
  };
  $('personaNameInput').onkeydown = (event) => { if (event.key === 'Enter') $('btnPersonaNameConfirm').click(); if (event.key === 'Escape') closePersonaNameEditor(); };
  $('btnPersonaImport').onclick = () => toast('导入人格将在正式版接入 JSON 文件导入。', 'ok');
  $('btnNewPersona').onclick = () => {
    selectedKey = 'default';
    renderPersonaTab();
    $('btnOwn').hidden = false;
    $('btnOwn').click();
  };
}

function renderPreview(key) {
  const mods = entryModules(key);
  const parts = mods.map((id) => personas.modules?.[id]).filter((t) => typeof t === 'string' && t.trim() !== '');
  const arch = entryArchetype(key);
  if (arch && personas.archetypes?.[arch]) parts.push(personas.archetypes[arch]);
  const text = parts.join('\n\n');
  $('preview').textContent = text || '（这个群现在没有可用的人格文本，会回落到插件 config.groupPrompt）';
  $('previewHint').textContent = `拼接顺序 = 模块顺序 → 人格类型 → 【群聊行为守则】（插件内置，所有群共用）。当前 ${parts.length} 段，共 ${text.length} 字。`;
  if ($('previewCount')) $('previewCount').textContent = `当前 ${text.length} 字`;
}

function markPersonaDirty() {
  const msg = $('personaMsg');
  msg.className = 'msg warn';
  msg.textContent = '有未保存的改动';
  $('btnSavePersona').disabled = false;
}

async function saveWakeIndex(value, keyOverride = selectedKey) {
  const key = keyOverride;
  try {
    const res = await api('/api/wake-index', {
      method: 'PUT',
      body: JSON.stringify({ groupOpenid: key, value, baseVersion: OV.wakeIndex?.version }),
    });
    OV.wakeIndex = { ...(OV.wakeIndex ?? {}), map: res.map, default: res.default, version: res.version };
    renderPersonaTab();
    if (personaView === 'groups') renderPersonaGroupConfig();
    toast(`「${groupName(key)}」唤醒指数已设为 ${value}，无需重启`, 'ok');
  }
  catch (err) {
    toast(err.message, 'err');
    renderPersonaTab();   // 失败时把滑块滚回磁盘上的值
  }
}

async function savePersonas() {
  const btn = $('btnSavePersona');
  const msg = $('personaMsg');
  btn.disabled = true; msg.className = 'msg'; msg.textContent = '保存中…';
  try {
    const res = await api('/api/personas', {
      method: 'PUT',
      body: JSON.stringify({ data: personas, baseVersion: personaVersion }),
    });
    personaVersion = res.version;
    dirty.personas = false;
    toast('人格已保存，无需重启', 'ok');
    renderPersonaTab();
    msg.className = 'msg ok';
    msg.textContent = '已保存 · 下一轮回复就生效';
  }
  catch (err) {
    msg.className = 'msg err';
    msg.textContent = err.message;
    toast(err.message, 'err');
  }
  finally { btn.disabled = !dirty.personas; }
}

setupPersonaViews();

// ─────────────────────────── 指令权限 ───────────────────────────
function renderOwners() {
  const ids = ownersDraft.openids;
  const names = ownersDraft.names;
  $('ownerIds').innerHTML = ids.length
    ? ids.map((id) => `<span class="chip ok">${esc(id)}<button class="mini" data-rm-id="${esc(id)}" title="移除">×</button></span>`).join('')
    : '<span class="muted">（空）现在谁都不能用指令</span>';
  $('ownerNames').innerHTML = names.length
    ? names.map((n) => `<span class="chip ok">${esc(n)}<button class="mini" data-rm-name="${esc(n)}" title="移除">×</button></span>`).join('')
    : '<span class="muted">（空）</span>';
  const people = (OV.people ?? []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
  $('peoplePool').innerHTML = people.length
    ? people.map((p) => `<button class="chip${names.includes(p.name) ? ' ok' : ''}" data-person="${esc(p.name)}" title="${esc((p.openids ?? []).join(', ') || '还没有 openid')}">${esc(p.name)}</button>`).join('')
    : '<span class="muted">还没有成员档案</span>';
  $('ownersAlert').innerHTML = (ids.length === 0 && names.length === 0)
    ? '<div class="alert warn">名单是空的 —— 现在谁都发不了指令，包括你自己。</div>' : '';
  $('btnSaveOwners').disabled = !dirty.owners;
  if (!dirty.owners) $('ownersMsg').textContent = '';
}

function markOwnersDirty() {
  dirty.owners = true;
  const msg = $('ownersMsg');
  msg.className = 'msg warn';
  msg.textContent = '有未保存的改动';
  renderOwners();
}

function addOwnerPerson(name) {
  const person = (OV.people ?? []).find((p) => p.name === name);
  if (!person) return;
  if (!ownersDraft.names.includes(name)) ownersDraft.names.push(name);
  for (const id of person.openids ?? []) {
    if (!ownersDraft.openids.includes(id)) ownersDraft.openids.push(id);
  }
  markOwnersDirty();
}

async function saveOwners() {
  const btn = $('btnSaveOwners');
  const msg = $('ownersMsg');
  btn.disabled = true; msg.className = 'msg'; msg.textContent = '保存中…';
  try {
    const res = await api('/api/owners', {
      method: 'PUT',
      body: JSON.stringify({ openids: ownersDraft.openids, names: ownersDraft.names }),
    });
    ownersDraft = { openids: res.openids, names: res.names };
    OV.owners = { openids: res.openids, names: res.names };
    dirty.owners = false;
    renderOwners();
    msg.className = 'msg ok';
    msg.textContent = '已保存 · 下一条指令就按新名单判断';
    toast('指令权限已保存，无需重启', 'ok');
  }
  catch (err) {
    msg.className = 'msg err';
    msg.textContent = err.message;
    toast(err.message, 'err');
  }
  finally { btn.disabled = !dirty.owners; }
}

// ─────────────────────────── 机器人进程 ───────────────────────────
async function refreshBot() {
  try {
    const s = await api('/api/bot/status');
    OV.bot.running = s.running;
    OV.bot.pids = s.pids;
    try {
      const ms = await api('/api/model/status');
      OV.modelStatus = ms.status;
    }
    catch { /* 模型状态读不到时保持原值 */ }
    renderBot();
  }
  catch { /* 状态查询失败不影响主流程 */ }
}

// 重启：不用 window.confirm —— 浏览器/WebView 可能直接吞掉弹窗，
// 表现就是「点了右上角没反应」。改成两次点击确认，任何环境都能用。
let restartArmed = false;
let restartArmTimer = 0;

async function doRestart(doneLabel) {
  const btn = $('btnRestart');
  restartArmed = false;
  clearTimeout(restartArmTimer);
  btn.disabled = true; btn.textContent = '重启中…';
  try {
    const res = await api('/api/bot/restart', { method: 'POST' });
    OV.bot.running = res.running;
    OV.bot.pids = res.pids;
    renderBot();
    const ready = res.ready === true;
    if (ready) {
      toast(`${doneLabel ?? '已重启并就绪'}：PID ${res.pids.join(', ')}`, 'ok');
    } else {
      const tail = (res.tail ?? []).slice(-3).join(' ⏎ ');
      toast(`已请求重启，但没等到 Bot ready${res.pids?.length ? `（PID ${res.pids.join(', ')}）` : '（进程没起来）'}：${tail || `看 ${res.logPath ?? '日志'}`}`, 'err', 9000);
    }
    // 有没保存的草稿时不要整页重载，否则草稿会被冲掉
    if (dirty.model || dirty.personas || dirty.owners) await refreshBot();
    else await load();     // overview 一起刷新（模型、路径、状态）
    return ready;
  }
  catch (err) {
    toast(`重启失败：${err.message}`, 'err');
    return false;
  }
  finally {
    btn.disabled = false;
    btn.textContent = '重启机器人';
    const msg = $('modelMsg');
    if (msg && msg.className.includes('ok')) msg.textContent += ` · PID ${OV.bot.pids.join(', ') || '?'}`;
  }
}

function restartBot() {
  const btn = $('btnRestart');
  if (btn.disabled) return;
  if (!restartArmed) {
    restartArmed = true;
    btn.textContent = '再点一次确认重启';
    clearTimeout(restartArmTimer);
    restartArmTimer = setTimeout(() => {
      restartArmed = false;
      btn.textContent = '重启机器人';
    }, 4000);
    return;
  }
  void doRestart();
}

// ─────────────────────────── 群成员档案 ───────────────────────────
const PEOPLE_ALL = 'ALL';
const PEOPLE_GLOBAL = 'GLOBAL';
const P_PROFILE_FIELDS = [
  ['gender', '性别'], ['age', '年龄'], ['height', '身高'], ['education', '学历'],
  ['identity', '职业'], ['city', '城市'], ['region', '区域'], ['personality', '性格'], ['health', '身体状况'],
  ['status', '近况'], ['background', '经历'], ['habits', '习惯'], ['other', '其他'],
];
let peopleStore = { people: [] };
let peopleGroups = [];
let discoveredGroups = [];
let peopleVersion;
let peopleCurrent = -1;
let peopleFilter = PEOPLE_ALL;
let peopleQuery = '';
let peopleLoaded = false;
let peopleModulesLoaded = false;
let peopleSaving = false;
let peopleLoading = false;
let peopleLoadRequest;
let peopleView = 'overview';
let peopleViewedPerson;
let peoplePersistedNames = new WeakMap();
let personModules = {};
let moduleSkills = [];

const pEl = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) node.append(c instanceof Node ? c : document.createTextNode(c ?? ''));
  return node;
};

const pGroupLabel = (gid) => peopleGroups.find((g) => g.id === gid)?.name ?? String(gid ?? '').slice(0, 6);
const pGroupsOf = (person) => (Array.isArray(person?.groups) ? person.groups.filter((g) => typeof g === 'string' && g) : []);
const pIsGlobal = (person) => pGroupsOf(person).length === 0;
const pInGroup = (person, gid) => gid === PEOPLE_ALL
  ? true
  : gid === PEOPLE_GLOBAL
    ? pIsGlobal(person)
    : (pIsGlobal(person) || pGroupsOf(person).includes(gid));
const pNamesOf = (person) => {
  const out = [person?.name, person?.addressing];
  for (const key of Object.keys(person ?? {})) if (/^nickname\d+$/.test(key)) out.push(person[key]);
  if (Array.isArray(person?.aliases)) out.push(...person.aliases);
  if (Array.isArray(person?.openids)) out.push(...person.openids);
  return out.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim());
};
const pSearchText = (person) => pNamesOf(person).join(' ').toLowerCase();
const pPersonName = (person) => typeof person?.name === 'string' ? person.name : '';
/** 回话概率：缺省 / 空值 / 坏值一律按 100（老行为），免得把空串误当成 0% */
const pReplyIndexOf = (person) => {
  const raw = person?.replyIndex;
  if (raw === undefined || raw === null || raw === '') return 100;
  const num = Number(raw);
  return Number.isFinite(num) ? Math.max(0, Math.min(100, Math.round(num))) : 100;
};
const pFilteredIndexes = () => {
  const out = [];
  peopleStore.people.forEach((person, index) => {
    if (pInGroup(person, peopleFilter)) out.push(index);
  });
  return out;
};
const pSocialOf = (person) => {
  const social = person?.social && typeof person.social === 'object' ? person.social : null;
  const num = (v, d) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : d);
  const out = social
    ? {
        affinity: num(social.affinity, 50),
        familiarity: num(social.familiarity, 30),
        trust: num(social.trust, 50),
        irritation: num(social.irritation, 0),
        banter: num(social.banterTolerance, 25),
      }
    : { affinity: num(person?.affinity, 50), familiarity: 30, trust: 50, irritation: 0, banter: 25 };
  const tiers = [[85, '老朋友'], [65, '很熟'], [45, '熟人'], [25, '聊过几次'], [10, '见过几次'], [0, '不熟']];
  out.relation = (tiers.find(([min]) => out.familiarity >= min) ?? tiers[tiers.length - 1])[1];
  out.attitude = out.irritation >= 85 ? '很差' : out.irritation >= 60 ? '冷淡' : out.irritation >= 35 ? '有点烦' : out.affinity >= 65 ? '友好' : '中性';
  return out;
};
const pGroupText = (person) => {
  const groups = pGroupsOf(person);
  return groups.length ? groups.map(pGroupLabel).join('、') : '全局';
};
const pCard = (title, children) => pEl('div', { class: 'card' }, [
  pEl('h2', {}, title),
  ...[].concat(children).filter(Boolean),
]);
const pField = (label, value, oninput, opts = {}) => {
  const input = opts.textarea
    ? pEl('textarea', {})
    : pEl('input', { type: 'text' });
  input.value = value ?? '';
  input.addEventListener('input', (event) => oninput(event.target.value));
  return pEl('label', { class: 'field' }, [pEl('span', {}, label), input]);
};
function pSetStatus(text, cls = '') {
  const toolbar = $('peopleStatus');
  toolbar.textContent = text;
  toolbar.className = `msg people-status ${cls}`;
  $('btnSavePeople').disabled = !dirty.people || peopleSaving || peopleLoading;
}
function pMarkDirty() {
  dirty.people = true;
  pSetStatus('有未保存的修改', 'warn');
}

async function loadPeopleModules() {
  peopleModulesLoaded = false;
  try {
    const res = await api('/api/modules');
    personModules = res.people && typeof res.people === 'object' ? res.people : {};
    moduleSkills = Array.isArray(res.skills) ? res.skills : [];
    peopleModulesLoaded = true;
  }
  catch { personModules = {}; moduleSkills = []; }
}

function loadPeopleData() {
  if (!peopleLoadRequest) peopleLoadRequest = readPeopleData().finally(() => { peopleLoadRequest = null; });
  return peopleLoadRequest;
}

async function readPeopleData() {
  const [peopleRes, groupsRes] = await Promise.all([api('/api/people'), api('/api/groups'), loadPeopleModules()]);
  applyPeopleSnapshot(peopleRes);
  peopleGroups = Array.isArray(groupsRes.groups) ? groupsRes.groups : [];
  peopleLoaded = true;
  dirty.people = false;
  const visible = pFilteredIndexes();
  peopleCurrent = visible.length ? visible[0] : -1;
}

function applyPeopleSnapshot({ data, version }) {
  peopleStore = data && Array.isArray(data.people) ? data : { people: [] };
  peoplePersistedNames = new WeakMap(peopleStore.people.filter((person) => person && typeof person === 'object').map((person) => [person, pPersonName(person)]));
  peopleVersion = version;
}

async function savePeople() {
  if (peopleSaving || peopleLoading) return false;
  peopleSaving = true;
  $('peopleShell').inert = true;
  pSetStatus('正在保存档案…');
  try {
    const res = await api('/api/people', {
      method: 'PUT',
      body: JSON.stringify({ data: peopleStore, baseVersion: peopleVersion }),
    });
    peopleVersion = res.version;
    peoplePersistedNames = new WeakMap(peopleStore.people.filter((person) => person && typeof person === 'object').map((person) => [person, pPersonName(person)]));
    dirty.people = false;
    if (OV) {
      OV.people = peopleStore.people.map((person) => ({
        name: person.name,
        openids: Array.isArray(person.openids) ? person.openids : [],
        groups: pGroupsOf(person),
      }));
      renderOwners();
    }
    await loadPeopleModules();
    renderPeopleTab();
    pSetStatus(`已保存 ${res.count} 人`, 'ok');
    return true;
  }
  catch (err) {
    pSetStatus(`保存失败：${err.message}`, 'err');
    return false;
  }
  finally {
    peopleSaving = false;
    $('peopleShell').inert = false;
    $('btnSavePeople').disabled = !dirty.people;
  }
}

async function saveGroupsMeta() {
  const res = await api('/api/groups', { method: 'PUT', body: JSON.stringify({ groups: peopleGroups }) });
  peopleGroups = Array.isArray(res.groups) ? res.groups : peopleGroups;
  if (OV) {
    OV.groups = peopleGroups.map((group) => ({ id: group.id, name: group.name }));
    renderPersonaTab();
  }
  renderPeopleTab();
}

async function reloadPeopleArchive() {
  if (peopleLoading || peopleSaving) return;
  if (dirty.people && !confirm('档案有未保存的修改，重新读取会丢弃它们，继续？')) return;
  peopleLoading = true;
  $('peopleShell').inert = true;
  pSetStatus('正在读取群成员档案…');
  try {
    await loadPeopleData();
    renderPeopleTab();
    pSetStatus('已重新读取', 'ok');
  }
  catch (err) {
    renderPeopleTab();
    pSetStatus(`读取失败：${err.message}`, 'err');
  }
  finally {
    peopleLoading = false;
    $('peopleShell').inert = false;
    $('btnSavePeople').disabled = !dirty.people;
  }
}

function renderPeopleTab() {
  $('btnAddPerson').disabled = !peopleLoaded;
  $('btnGroupManage').disabled = !peopleLoaded;
  if (!peopleLoaded) {
    $('memberForm').replaceChildren(pEl('div', { class: 'empty' }, '档案尚未读取，请点击「重新读取」。'));
    return;
  }
  renderPeopleGroupFilter();
  renderPeopleList();
  renderMemberForm();
  renderGroupManage();
  if (!dirty.people) pSetStatus(`已读取 ${peopleStore.people.length} 人`);
}

function renderPeopleGroupFilter() {
  const select = $('peopleGroupFilter');
  const entries = [[PEOPLE_ALL, '全部档案'], ...peopleGroups.map((group) => [group.id, group.name]), [PEOPLE_GLOBAL, '仅全局档案']];
  select.replaceChildren(...entries.map(([key, label]) => pEl('option', { value: key }, label)));
  if (!entries.some(([key]) => key === peopleFilter)) peopleFilter = PEOPLE_ALL;
  select.value = peopleFilter;
}

function pInitial(person, large = false) {
  const initial = Array.from(pPersonName(person).trim() || '未')[0];
  return pEl('span', { class: `people-initial${large ? ' large' : ''}`, 'aria-hidden': 'true' }, initial);
}

function renderPeopleList() {
  const ul = $('peopleList');
  const query = peopleQuery.trim().toLowerCase();
  const visible = pFilteredIndexes().filter((index) => !query || pSearchText(peopleStore.people[index]).includes(query));
  if (!visible.includes(peopleCurrent)) peopleCurrent = visible[0] ?? -1;
  $('btnDupPerson').disabled = peopleCurrent < 0;
  $('peopleCount').textContent = `${visible.length} 人`;
  ul.replaceChildren(...visible.map((index) => {
    const person = peopleStore.people[index];
    const name = person.name || '(未命名)';
    const button = pEl('button', { type: 'button', class: 'people-list-item', 'aria-pressed': String(index === peopleCurrent) }, [
      pInitial(person), pEl('span', {}, [pEl('strong', {}, name), pEl('small', { class: 'sub' }, person.autoCreated ? '自动建档' : pIsGlobal(person) ? '全局档案' : person.addressing || pGroupText(person))]),
    ]);
    button.addEventListener('click', () => {
      if (peopleCurrent === index) return;
      peopleCurrent = index;
      ul.querySelector('[aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-pressed', 'true');
      renderMemberForm();
    });
    return pEl('li', {}, button);
  }));
  if (!visible.length) ul.append(pEl('li', { class: 'empty' }, query ? '没有匹配的成员' : '这个范围还没有档案'));
}

function renderGroupManage() {
  const box = $('groupManageList');
  if (!box) return;
  renderDiscoveredGroups();
  box.innerHTML = '';
  if (peopleGroups.length === 0) {
    box.append(pEl('p', { class: 'hint' }, '还没有群，先加一个。'));
    return;
  }
  for (const group of peopleGroups) {
    box.append(pEl('div', { class: 'gmrow' }, [
      pEl('strong', {}, group.name),
      pEl('span', { class: 'gid' }, group.id),
      pEl('span', { class: 'grow' }),
      pEl('button', {
        class: 'mini',
        onclick: () => archivePeopleGroup(group.id),
      }, '手动建档'),
      pEl('button', {
        class: 'mini',
        onclick: () => groupSessionAction(group, 'new'),
      }, '新会话'),
      pEl('button', {
        class: 'mini',
        onclick: () => groupSessionAction(group, 'compact'),
      }, '压缩'),
      pEl('button', {
        class: 'mini',
        onclick: async () => {
          const name = prompt('群名', group.name);
          if (name === null) return;
          const trimmed = name.trim();
          if (!trimmed) return;
          group.name = trimmed;
          try { await saveGroupsMeta(); toast('群名已保存', 'ok'); }
          catch (err) { toast(`保存群名失败：${err.message}`, 'err'); }
        },
      }, '改名'),
      pEl('button', {
        class: 'mini danger',
        onclick: async () => {
          if (!confirm(`删除群「${group.name}」？\n绑定到这个群的角色会变成不绑群（对所有群生效）。`)) return;
          peopleGroups = peopleGroups.filter((item) => item.id !== group.id);
          for (const person of peopleStore.people) {
            if (!Array.isArray(person.groups)) continue;
            const rest = person.groups.filter((gid) => gid !== group.id);
            if (rest.length) person.groups = rest;
            else delete person.groups;
          }
          if (peopleFilter === group.id) peopleFilter = PEOPLE_ALL;
          pMarkDirty();
          try {
            await saveGroupsMeta();
            if (!await savePeople()) throw new Error("成员绑定未保存，可关闭弹窗后重试保存档案");
            toast(`已删除群「${group.name}」，成员绑定也已保存`, 'ok');
          }
          catch (err) { toast(`删除失败：${err.message}`, 'err'); }
        },
      }, '删'),
    ]));
  }
  box.append(pEl('p', { class: 'hint', style: 'margin:6px 0 0' },
    '「新会话」会清空该群当前上下文；长期记忆、档案、关系值不受影响。「压缩」保留摘要。'));
}

function renderDiscoveredGroups() {
  const box = $('discoveredGroupList');
  const unregistered = discoveredGroups.filter(group => !peopleGroups.some(known => known.id === group.id));
  box.replaceChildren();
  if (!unregistered.length) return;
  box.append(pEl('p', { class: 'hint' }, '已收到消息、待登记的群'));
  for (const group of unregistered) {
    const name = pEl('input', { type: 'text', 'aria-label': `群 ${group.id} 的名称`, placeholder: '群名称（可选）' });
    box.append(pEl('div', { class: 'gmrow' }, [
      pEl('span', { class: 'gid' }, group.id),
      pEl('span', {}, `已观察到 ${group.observed} 位发言者`),
      pEl('span', { class: 'grow' }),
      name,
      pEl('button', { class: 'mini', onclick: () => archivePeopleGroup(group.id, name.value.trim()) }, '手动建档'),
    ]));
  }
}

async function openGroupManage() {
  const status = $('groupArchiveStatus');
  status.textContent = '';
  discoveredGroups = [];
  renderGroupManage();
  $('groupManage').showModal();
  try {
    const result = await api('/api/groups?discover=1');
    discoveredGroups = result.discovered ?? [];
    renderDiscoveredGroups();
  }
  catch (error) {
    if (!peopleSaving) status.textContent = `读取待登记群失败：${error.message}`;
  }
}

async function archivePeopleGroup(id, name) {
  if (peopleSaving || peopleLoading) return;
  const status = $('groupArchiveStatus');
  if (dirty.people) {
    status.textContent = '请先关闭群管理并保存成员档案，再手动建档。';
    return;
  }
  peopleSaving = true;
  const controls = ['groupManageAddRow', 'groupManageList', 'discoveredGroupList'].map($);
  for (const control of controls) control.inert = true;
  $('btnCloseGroupManage').disabled = true;
  status.textContent = '正在根据群消息建档…';
  try {
    const res = await api('/api/groups/archive', {
      method: 'POST',
      body: JSON.stringify({ groupOpenid: id, name }),
    });
    applyPeopleSnapshot(res);
    peopleGroups = res.groups;
    peopleFilter = id;
    peopleCurrent = pFilteredIndexes()[0] ?? -1;
    if (OV) {
      OV.groups = peopleGroups.map(group => ({ id: group.id, name: group.name }));
      OV.people = peopleStore.people.map(person => ({ name: person.name, openids: person.openids ?? [], groups: pGroupsOf(person) }));
      renderPersonaTab();
      renderOwners();
    }
    renderPeopleTab();
    const summary = res.observed
      ? `已观察 ${res.observed} 人，新建 ${res.created} 份成员档案，补绑 ${res.linked} 人`
      : '暂无可用于建档的群消息';
    status.textContent = `「${res.group.name}」${res.groupCreated ? '已登记，' : '：'}${summary}。`;
    pSetStatus(status.textContent, 'ok');
  }
  catch (error) {
    status.textContent = `建档失败：${error.message}`;
  }
  finally {
    peopleSaving = false;
    for (const control of controls) control.inert = false;
    $('btnCloseGroupManage').disabled = false;
  }
}

async function groupSessionAction(group, action) {
  if (action === 'new' && !confirm(`给「${group.name}」开新会话？\n当前对话上下文会清空，长期记忆和档案不受影响。`)) return;
  try {
    const res = await api('/api/groups/session', {
      method: 'POST',
      body: JSON.stringify({ groupOpenid: group.id, action }),
    });
    if (action === 'new') {
      toast(`已给「${group.name}」开新会话`, 'ok');
      return;
    }
    const outcome = res.outcome ?? {};
    if (outcome.ok) {
      toast(outcome.shadowed ? `已压缩「${group.name}」${outcome.shadowed} 条历史` : `「${group.name}」没有可压缩的历史`, 'ok');
    }
    else {
      const reason = { 'no-session': '当前没有活跃会话', busy: '正在生成，稍后再试', unavailable: '压缩能力不可用' }[outcome.reason] ?? (outcome.reason ?? '未知原因');
      toast(`压缩「${group.name}」失败：${reason}`, 'err');
    }
  }
  catch (err) {
    toast(`群操作失败：${err.message}`, 'err');
  }
}

async function addPeopleGroup() {
  const id = $('newGroupId').value.trim();
  const name = $('newGroupName').value.trim();
  if (!id || !name) { toast('group_openid 和群名都要填', 'err'); return; }
  if (peopleGroups.some((group) => group.id === id)) { toast('这个群已经存在了', 'err'); return; }
  peopleGroups.push({ id, name });
  try {
    await saveGroupsMeta();
    $('newGroupId').value = '';
    $('newGroupName').value = '';
    peopleFilter = id;
    renderPeopleTab();
    toast(`已新增群：${name}`, 'ok');
  }
  catch (err) { toast(`加群失败：${err.message}`, 'err'); }
}

function pGroupsSection(person, onChange) {
  const groupChips = peopleGroups.map((group) => pEl('button', {
    class: 'gchip',
    title: group.id,
    onclick: () => {
      const set = new Set(pGroupsOf(person));
      set.add(group.id);
      person.groups = Array.from(set);
      pMarkDirty();
      renderPeopleTab();
    },
  }, group.name));
  groupChips.push(pEl('button', {
    class: 'gchip',
    onclick: () => {
      delete person.groups;
      pMarkDirty();
      renderPeopleTab();
    },
  }, '设为全局（清空）'));
  return pEl('div', { style: 'margin-top:14px' }, [
    pField('生效群（group_openid，逗号分隔；留空 = 所有群）', pGroupsOf(person).join(', '), (value) => {
      const list = value.split(',').map((item) => item.trim()).filter(Boolean);
      if (list.length) person.groups = list;
      else delete person.groups;
      onChange?.();
      pMarkDirty();
    }, { textarea: true }),
    pEl('div', { class: 'groups-list' }, groupChips),
    pEl('p', { class: 'hint' }, '点群名把它加进「生效群」；留空表示所有群都能认出这个人。'),
  ]);
}

function pNumberedSection(title, prefix, person, labelPrefix) {
  const keys = Object.keys(person)
    .filter((key) => key.indexOf(prefix) === 0 && key.length > prefix.length && String(Number(key.slice(prefix.length))) !== 'NaN')
    .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
  const rows = pEl('div', { class: 'rows' });
  for (const key of keys) {
    const input = pEl('input', {
      type: 'text', 'aria-label': labelPrefix + key.slice(prefix.length),
      oninput: (event) => { person[key] = event.target.value; pMarkDirty(); },
    });
    input.value = person[key] ?? '';
    rows.append(pEl('div', { class: 'row' }, [
      pEl('span', { class: 'rowlabel' }, labelPrefix + key.slice(prefix.length)),
      input,
      pEl('button', {
        class: 'small danger',
        onclick: () => { delete person[key]; pMarkDirty(); renderMemberForm(); },
      }, '删除'),
    ]));
  }
  const next = keys.length
    ? Math.max(...keys.map((key) => Number(key.slice(prefix.length)))) + 1
    : 1;
  return pEl('div', { style: 'margin-top:14px' }, [
    pEl('div', { class: 'row row-between' }, [
      pEl('label', {}, title),
      pEl('button', {
        class: 'small',
        onclick: () => { person[prefix + next] = ''; pMarkDirty(); renderMemberForm(); },
      }, `＋ 加${labelPrefix}`),
    ]),
    rows,
  ]);
}

function pListSection(title, target, key, label) {
  if (!Array.isArray(target[key])) target[key] = target[key] ? [String(target[key])] : [];
  const list = target[key];
  const rows = pEl('div', { class: 'rows' });
  list.forEach((value, index) => {
    const input = pEl('input', {
      type: 'text', 'aria-label': `${label} ${index + 1}`,
      oninput: (event) => { list[index] = event.target.value; pMarkDirty(); },
    });
    input.value = value;
    rows.append(pEl('div', { class: 'row' }, [
      pEl('span', { class: 'rowlabel' }, label + (index + 1)),
      input,
      pEl('button', {
        class: 'small danger',
        onclick: () => { list.splice(index, 1); pMarkDirty(); renderMemberForm(); },
      }, '删除'),
    ]));
  });
  return pEl('div', {}, [
    pEl('div', { class: 'row row-between' }, [
      pEl('label', {}, title),
      pEl('button', {
        class: 'small',
        onclick: () => { target[key].push(''); pMarkDirty(); renderMemberForm(); },
      }, `＋ 加${label}`),
    ]),
    rows,
  ]);
}

function pRelationsSection(person) {
  person.profile = person.profile || {};
  const relations = person.profile.relations && typeof person.profile.relations === 'object'
    ? person.profile.relations
    : (person.profile.relations = {});
  const rows = pEl('div', { class: 'rows' });
  for (const key of Object.keys(relations)) {
    const value = relations[key];
    const text = Array.isArray(value) ? value.join('、') : String(value ?? '');
    let currentKey = key;
    const keyInput = pEl('input', { type: 'text', placeholder: '关系（弟弟/姐姐/好朋友）' });
    keyInput.value = key;
    keyInput.addEventListener('input', (event) => {
      const nextKey = event.target.value;
      if (nextKey === currentKey) return;
      const old = currentKey;
      currentKey = nextKey;
      relations[nextKey] = relations[old];
      delete relations[old];
      pMarkDirty();
    });
    const valueInput = pEl('input', { type: 'text', placeholder: '对方名字（多个用、分隔）' });
    valueInput.value = text;
    valueInput.addEventListener('input', (event) => {
      relations[currentKey] = event.target.value;
      pMarkDirty();
    });
    rows.append(pEl('div', { class: 'row' }, [
      keyInput,
      valueInput,
      pEl('button', {
        class: 'small danger',
        onclick: () => { delete relations[currentKey]; pMarkDirty(); renderMemberForm(); },
      }, '删除'),
    ]));
  }
  return pEl('div', { style: 'margin-top:10px' }, [
    pEl('div', { class: 'row row-between' }, [
      pEl('label', {}, '关系（每条一行，填写关系类型与对方名字）'),
      pEl('button', {
        class: 'small',
        onclick: () => { relations['新关系'] = ''; pMarkDirty(); renderMemberForm(); },
      }, '＋ 加关系'),
    ]),
    rows,
  ]);
}

// 角色模块注册表：加新模块只需要在这里加一项（再配一条服务端写入规则）。
// input = 勾选后出现的一行文本（逗号分隔成数组）；select = 勾选后出现的下拉。
const P_MODULES = [
  {
    id: 'collectImages',
    title: '收集图片',
    desc: '只收这个人的图；分类留空表示除梗图 / 表情包外都收。',
    input: { key: 'categories', short: '收图分类', label: '收图分类（逗号 / 顿号分隔）', placeholder: '美食、人像、风景…' },
  },
  {
    id: 'topics',
    title: '回应主题',
    desc: '他分享作品、游戏、电影或链接时，先查口碑再评论；不收图。',
    input: { key: 'topics', short: '关注主题', label: '关注主题（可选）', placeholder: '游戏、电影、小说、链接…' },
  },
  {
    id: 'style',
    title: '用特定语言方式回应',
    desc: '选一个角色技能；只对这个人生效。',
    select: { key: 'skill', label: '语言风格' },
  },
  {
    id: 'imageGen',
    title: '允许他让机器人画图',
    desc: '勾上后可以直接说「画一只猫」，不必打 /生图。',
  },
  {
    id: 'voiceGen',
    title: '允许他让机器人用语音说话',
    desc: '勾上后可以直接说「用语音说」，机器人也会在安慰、道歉、深夜谈心时主动发语音。',
  },
];

function pModuleFallback(module) {
  if (module.input) return { enabled: false, [module.input.key]: [] };
  if (module.select) return { enabled: false, [module.select.key]: '' };
  return { enabled: false };
}

function pAction(text, onclick, className = 'ghost') {
  return pEl('button', { type: 'button', class: className, onclick }, text);
}

function pValues(values) {
  return pEl('dl', { class: 'people-values' }, values.map(([key, value]) =>
    pEl('div', {}, [pEl('dt', {}, key), pEl('dd', {}, value)])));
}

let peopleDialogSequence = 0;
function pDialog(title, hint, opener = document.activeElement) {
  const id = `people-dialog-title-${++peopleDialogSequence}`;
  const content = pEl('div');
  const actions = pEl('div', { class: 'people-dialog-actions' });
  const dialog = pEl('dialog', { class: 'people-dialog', 'aria-labelledby': id }, [
    pEl('h2', { id }, title), pEl('p', { class: 'hint' }, hint), content, actions,
  ]);
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (opener?.isConnected) opener.focus();
  }, { once: true });
  $('panePeople').append(dialog);
  return { dialog, content, actions };
}

function pSwitch(title, hint, checked, onChange) {
  const input = pEl('input', { type: 'checkbox', role: 'switch', 'aria-label': title });
  input.checked = checked;
  const state = pEl('span', { 'aria-hidden': 'true' }, checked ? '开启' : '关闭');
  input.addEventListener('change', () => {
    state.textContent = input.checked ? '开启' : '关闭';
    onChange(input.checked);
  });
  return pEl('label', { class: 'people-switch' }, [
    pEl('span', { class: 'people-switch-copy' }, [pEl('strong', {}, title), pEl('small', {}, hint)]),
    input,
    pEl('span', { class: 'people-switch-indicator' }, [state, pEl('i', { class: 'people-switch-track', 'aria-hidden': 'true' })]),
  ]);
}

function pPolicyValues(person) {
  return [
    ['个人回话概率', `${pReplyIndexOf(person)}%`],
    ['每日首条必接', person.dailyFirstReply === true ? '已开启' : '未开启'],
    ['观察对象', person.observe === true ? '已开启' : '未开启'],
  ];
}

function pOpenPolicy(person) {
  const draft = { dailyFirstReply: person.dailyFirstReply === true, observe: person.observe === true, replyIndex: pReplyIndexOf(person) };
  const { dialog, content, actions } = pDialog(`互动设置 · ${person.name}`, '只修改当前成员。应用后，点击页面上的「保存档案」才会写入。');
  const id = `people-reply-${peopleDialogSequence}`;
  const range = pEl('input', { id, type: 'range', min: '0', max: '100', step: '1', 'aria-describedby': `${id}-hint` });
  const output = pEl('output', { for: id });
  const detail = pEl('p', { id: `${id}-hint`, class: 'hint' });
  const refreshReply = () => {
    const value = draft.replyIndex;
    range.value = String(value);
    range.disabled = draft.observe;
    output.textContent = `${value}%`;
    detail.textContent = draft.observe ? '观察对象默认不触发普通回复。关闭上方的「观察对象」即可调整概率。'
      : value === 100 ? '100%：不额外抽样，消息仍须通过其他回复规则。'
      : value === 0 ? '0%：不触发普通回复；斜杠指令仍受指令权限限制。'
      : `约 ${value}% 的消息通过个人概率筛选；@ 小易或呼唤名字也会参与筛选。`;
  };
  range.addEventListener('input', () => { draft.replyIndex = Number(range.value); refreshReply(); });
  content.append(
    pEl('div', { class: 'people-setting-row' }, pSwitch('每日首条必接', '每天在每个群第一次出现时，按首条规则回应。', draft.dailyFirstReply, (next) => { draft.dailyFirstReply = next; })),
    pEl('div', { class: 'people-setting-row' }, pSwitch('观察对象', '用于群里的其他机器人。开启时回话概率归零，关闭时恢复默认 100%。主人仍可临时授权对话。', draft.observe, (next) => {
      draft.observe = next;
      draft.replyIndex = next ? 0 : 100;
      refreshReply();
    })),
    pEl('div', { class: 'people-range' }, [
      pEl('div', { class: 'people-range-head' }, [pEl('label', { for: id }, pEl('strong', {}, '个人回话概率')), output]),
      range, detail,
    ]),
  );
  refreshReply();
  actions.append(pAction('取消', () => dialog.close()), pAction('应用到档案草稿', () => {
    const changed = draft.dailyFirstReply !== (person.dailyFirstReply === true)
      || draft.observe !== (person.observe === true) || draft.replyIndex !== pReplyIndexOf(person);
    if (!changed) { dialog.close(); return; }
    if (draft.dailyFirstReply) person.dailyFirstReply = true;
    else delete person.dailyFirstReply;
    if (draft.observe) person.observe = true;
    else delete person.observe;
    if (draft.replyIndex < 100) person.replyIndex = draft.replyIndex;
    else delete person.replyIndex;
    pMarkDirty();
    dialog.close();
    renderMemberForm(true);
  }, 'primary'));
  dialog.showModal();
}

function pModuleValue(module, state) {
  if (module.input) {
    const values = state[module.input.key];
    return Array.isArray(values) && values.length ? values.join('、') : '未指定';
  }
  const skill = state[module.select.key];
  return moduleSkills.find((item) => item.id === skill)?.name || skill || '未选择';
}

function pConfigureModule(module, state, onApply) {
  const { dialog, content, actions } = pDialog(module.title, `角色模块 / ${module.desc}`);
  const field = module.input || module.select;
  let input;
  if (module.input) {
    input = pEl('input', { type: 'text', placeholder: field.placeholder });
    input.value = Array.isArray(state[field.key]) ? state[field.key].join('、') : '';
  } else {
    const skills = [{ id: '', name: '请选择语言风格' }, ...moduleSkills.filter((item) => item.id)];
    if (state[field.key] && !skills.some((item) => item.id === state[field.key])) {
      skills.push({ id: state[field.key], name: `${state[field.key]}（当前不可用）` });
    }
    input = pEl('select', {}, skills.map((skill) => pEl('option', { value: skill.id }, skill.name)));
    input.value = state[field.key] || '';
  }
  content.append(pEl('label', { class: 'field' }, [pEl('span', {}, field.label), input]));
  actions.append(pAction('返回', () => dialog.close()), pAction('应用并返回', () => {
    state[field.key] = module.input ? [...new Set(input.value.split(/[,，、\s]+/).filter(Boolean))].slice(0, module.id === 'collectImages' ? 5 : 10) : input.value;
    onApply();
    dialog.close();
  }, 'primary'));
  dialog.showModal();
}

function pOpenModules(person) {
  if (!peopleModuleReady(person)) return;
  const name = pPersonName(person).trim();
  const current = Object.hasOwn(personModules, name) ? personModules[name] : {};
  const draft = Object.fromEntries(P_MODULES.map((module) => [module.id, { ...pModuleFallback(module), ...current?.[module.id] }]));
  const { dialog, content, actions } = pDialog(`角色模块 · ${name}`, '开关与参数单独保存，不会写入其他档案修改。');
  for (const module of P_MODULES) {
    const state = draft[module.id];
    const row = pEl('div', { class: 'people-setting-row' }, pSwitch(module.title, module.desc, state.enabled === true, (next) => { state.enabled = next; }));
    if (module.input || module.select) {
      const value = pEl('span', { class: 'muted' }, pModuleValue(module, state));
      row.append(pEl('div', { class: 'people-module-config' }, [
        value, pAction(`配置${module.input?.short || module.select.label} →`, () => pConfigureModule(module, state, () => { value.textContent = pModuleValue(module, state); }), 'small ghost'),
      ]));
    }
    content.append(row);
  }
  const status = pEl('p', { class: 'msg', role: 'status' });
  content.append(status);
  let saving = false;
  const cancel = pAction('取消', () => dialog.close());
  const save = pAction('保存模块', async () => {
    if (saving) return;
    if (draft.style.enabled && !moduleSkills.some((item) => item.id && item.id === draft.style.skill)) {
      status.className = 'msg people-danger';
      status.textContent = '请为语言风格选择可用的角色技能，或关闭该模块。';
      return;
    }
    saving = true;
    dialog.querySelectorAll('button, input').forEach((control) => { control.disabled = true; });
    status.className = 'msg';
    status.textContent = '正在保存模块…';
    try {
      const res = await api('/api/modules', { method: 'PUT', body: JSON.stringify({ name, modules: draft }) });
      personModules = { ...personModules, [name]: res.modules };
      galleryAllowLoaded = false;
      dialog.close();
      renderMemberForm(true);
      toast('角色模块已保存', 'ok');
    }
    catch (err) {
      status.className = 'msg people-danger';
      status.textContent = `保存模块失败：${err.message}`;
    }
    finally {
      saving = false;
      dialog.querySelectorAll('button, input').forEach((control) => { control.disabled = false; });
    }
  }, 'primary');
  dialog.addEventListener('cancel', (event) => { if (saving) event.preventDefault(); });
  actions.append(cancel, save);
  dialog.showModal();
}

function peopleModuleReady(person) {
  const name = pPersonName(person);
  return peopleModulesLoaded && !!name.trim() && name === name.trim() && peoplePersistedNames.get(person) === name;
}

function renderMemberForm(restoreFocus = false) {
  const form = $('memberForm');
  form.replaceChildren();
  const person = peopleStore.people[peopleCurrent];
  if (peopleViewedPerson !== person) {
    peopleViewedPerson = person;
    peopleView = 'overview';
  }
  if (!person) {
    form.append(pEl('div', { class: 'card empty' }, '请从成员目录选择档案，或调整范围与搜索词。'));
    return;
  }
  const social = pSocialOf(person);
  const tabs = [['overview', '概览'], ['profile', '档案资料'], ['policy', '互动设置'], ['records', '自动记录']];
  const setView = (view) => { peopleView = view; renderMemberForm(true); };
  const tabButtons = tabs.map(([key, label]) => pEl('button', {
    type: 'button', 'aria-pressed': String(key === peopleView), onclick: () => setView(key),
  }, label));
  const head = pEl('div', { class: 'form-head' }, [
    pInitial(person, true),
    pEl('div', { class: 'fh-main' }, [
      pEl('h2', { class: 'fh-name' }, person.name || '(未命名)'),
      pEl('div', { class: 'fh-sub' }, person.addressing ? `小易称呼：${person.addressing}` : '未设置单独称呼'),
    ]),
    peopleView !== 'profile' ? pAction('编辑资料', () => setView('profile'), 'primary') : null,
  ].filter(Boolean));
  const meta = () => [
    pEl('span', { class: 'chip' }, `生效范围：${pIsGlobal(person) ? '所有群（全局）' : pGroupText(person)}`),
    pEl('span', { class: `chip${person.openids?.length ? '' : ' warn'}` }, person.openids?.length ? '已绑定 OpenID' : '未绑定 OpenID'),
    person.autoCreated ? pEl('span', { class: 'chip' }, '自动建档') : null,
  ].filter(Boolean);
  const metaNode = pEl('div', { class: 'people-meta' }, meta());
  form.append(pEl('section', { class: 'card people-identity' }, [
    head, metaNode, pEl('nav', { class: 'people-tabs', 'aria-label': '成员档案分区' }, tabButtons),
  ]));
  const body = pEl('div', { class: 'form-body' });
  form.append(body);
  if (restoreFocus) tabButtons[tabs.findIndex(([key]) => key === peopleView)]?.focus();
  const openPolicy = () => pOpenPolicy(person);
  if (peopleView === 'overview') {
    const recent = pEl('div', { class: 'hint people-memory-preview' }, '正在读取近期记忆…');
    body.append(pCard('档案摘要', pEl('p', { class: 'people-overview-summary' }, String(person.summary ?? '').trim() || '还没有一句话概括。')),
      pEl('div', { class: 'people-overview-grid' }, [
        pCard('互动设置', [pValues(pPolicyValues(person)), pAction('打开互动设置 →', openPolicy)]),
        pCard('小易的近期记录', [pEl('strong', {}, `${social.relation} · ${social.attitude}`), recent,
          pAction('查看自动记录 →', () => setView('records'))]),
      ]));
    void loadPersonMemories(person, recent, true);
    return;
  }
  if (peopleView === 'policy') {
    const current = Object.hasOwn(personModules, person.name) ? personModules[person.name] : {};
    const reason = !peopleModulesLoaded ? '角色模块读取失败，请重新读取档案后再试。'
      : !peopleModuleReady(person) ? '新增或改名后，请先保存档案，再设置角色模块。' : '';
    body.append(pCard('回复规则', [pValues(pPolicyValues(person)), pAction('打开互动设置 →', openPolicy, 'primary')]),
      pCard('角色模块', [
        peopleModulesLoaded ? pValues(P_MODULES.map((module) => [module.title, current?.[module.id]?.enabled ? '已开启' : '未开启'])) : null,
        reason ? pEl('p', { class: 'hint' }, reason) : pAction('配置角色模块 →', () => pOpenModules(person)),
      ]));
    return;
  }
  if (peopleView === 'profile') {
    person.profile = person.profile || {};
    const basics = pCard('身份与识别', [
      pEl('div', { class: 'grid' }, [
        pField('主称呼（必填）', person.name, (value) => {
          person.name = value.trim();
          pMarkDirty();
          const title = form.querySelector('.fh-name');
          if (title) title.textContent = value || '(未命名)';
          head.firstChild.textContent = Array.from(value.trim() || '未')[0];
        }),
        pField('小易怎么称呼这个人', person.addressing, (value) => { person.addressing = value; head.querySelector('.fh-sub').textContent = value ? `小易称呼：${value}` : '未设置单独称呼'; pMarkDirty(); }),
        pField('生日', person.birthday, (value) => { person.birthday = value; pMarkDirty(); }),
        pField('一句话概括', person.summary, (value) => { person.summary = value; pMarkDirty(); }),
        pField('QQ 号（仅展示）', person.qq, (value) => { person.qq = value; pMarkDirty(); }),
        pField('OpenID（用逗号分隔）', Array.isArray(person.openids) ? person.openids.join(', ') : '', (value) => {
          const list = value.split(',').map((item) => item.trim()).filter(Boolean);
          if (list.length) person.openids = list;
          else delete person.openids;
          metaNode.replaceChildren(...meta());
          pMarkDirty();
        }),
      ]),
      pGroupsSection(person, () => metaNode.replaceChildren(...meta())),
      pNumberedSection('昵称（识别用，一个一行）', 'nickname', person, '昵称'),
    ]);

    const profileCard = pCard('个人资料', [
      pEl('p', { class: 'hint', style: 'margin:-6px 0 10px' }, '「区域」用于回话时带上对方所在地：填得越具体越好（例如「杭州西湖区」）；留空会用「城市」兜底。机器人会按它查当地天气和温度。'),
      pEl('div', { class: 'grid' }, P_PROFILE_FIELDS.map(([key, label]) => pField(label, person.profile[key], (value) => {
        person.profile[key] = value;
        pMarkDirty();
      }))),
      pListSection('爱好（可多条）', person.profile, 'hobbies', '爱好'),
      pListSection('雷区（可多条）', person.profile, 'dislikes', '雷区'),
      pListSection('擅长（可多条）', person.profile, 'skills', '擅长'),
      pListSection('宠物（可多只）', person.profile, 'pets', '宠物'),
    ]);

    const relationsCard = pCard('手动维护的关系', [pRelationsSection(person)]);

    const noteCard = pCard('备注与其他', [
      pField('备注', person.note, (value) => { person.note = value; pMarkDirty(); }, { textarea: true }),
      pEl('div', { style: 'margin-top:12px' }, [
        pEl('button', {
          class: 'danger',
          onclick: () => {
            if (!confirm(`确定删除「${person.name || '未命名'}」吗？需要再点保存才会写入。`)) return;
            peopleStore.people.splice(peopleCurrent, 1);
            const visible = pFilteredIndexes();
            peopleCurrent = visible.length ? visible[0] : -1;
            pMarkDirty();
            renderPeopleTab();
          },
        }, '删除这个人'),
      ]),
    ]);

    body.append(basics, profileCard, relationsCard, noteCard);
    return;
  }

  const sources = person.sources && typeof person.sources === 'object' ? Object.entries(person.sources) : [];
  const autoCard = pCard('自动记录（只读）', [
    person.autoCreated ? pEl('p', { class: 'hint' }, '🤖 这条档案是机器人自动创建的（autoCreated）') : null,
    pEl('p', { class: 'hint' }, `关系：${social.relation} ｜ 态度：${social.attitude}`),
    pEl('p', { class: 'hint mono' }, `好感 ${social.affinity} · 熟悉 ${social.familiarity} · 信任 ${social.trust} · 烦躁 ${social.irritation} · 互损 ${social.banter}`),
    pEl('p', { class: 'hint' }, '（数值只是内部状态，机器人看不到，它只看到上面那句关系描述）'),
    sources.length
      ? pEl('div', { class: 'rows' }, sources.map(([field, info]) => pEl('div', { class: 'row', style: 'align-items:flex-start' }, [
          pEl('span', { style: 'width:150px;flex:0 0 auto;color:var(--muted);font-size:12px' }, field),
          pEl('span', { style: 'flex:1;font-size:12px' }, String(info?.evidence ?? '(未注明)')),
          pEl('span', { style: 'flex:0 0 auto;color:var(--muted);font-size:11px' }, String(info?.at ?? '').slice(0, 16).replace('T', ' ')),
        ])))
      : null,
  ]);

  const memoriesBox = pEl('div', { class: 'rows' }, pEl('span', { class: 'hint' }, '加载中…'));
  const memoriesCard = pCard('最近记忆（只读）', [
    pEl('p', { class: 'hint' }, '显示当前群的最近 10 条长期记忆；对话时最多自动读取最新 5 条。'),
    memoriesBox,
  ]);
  body.append(autoCard, memoriesCard);
  void loadPersonMemories(person, memoriesBox);
}

function pAddPerson() {
  const person = { name: '新成员', profile: {} };
  if (peopleFilter !== PEOPLE_ALL && peopleFilter !== PEOPLE_GLOBAL) person.groups = [peopleFilter];
  peopleStore.people.push(person);
  peopleCurrent = peopleStore.people.length - 1;
  peopleQuery = $('peopleSearch').value = '';
  peopleViewedPerson = peopleStore.people[peopleCurrent];
  peopleView = 'profile';
  pMarkDirty();
  renderPeopleTab();
}

async function loadPersonMemories(person, box, preview = false) {
  const gid = (peopleFilter !== PEOPLE_ALL && peopleFilter !== PEOPLE_GLOBAL)
    ? peopleFilter
    : (Array.isArray(person.groups) && person.groups.length ? person.groups[0] : '');
  if (!gid || !person.name) {
    box.textContent = '请选择具体群查看近期记忆。';
    return;
  }
  try {
    const res = await api(`/api/person-memories?gid=${encodeURIComponent(gid)}&name=${encodeURIComponent(person.name)}`);
    const list = Array.isArray(res.memories) ? res.memories : [];
    box.replaceChildren();
    if (list.length === 0) {
      box.append(pEl('span', { class: 'hint' }, '这个群还没有关于 TA 的长期记忆'));
      return;
    }
    if (preview) {
      const latest = String(list[0].text ?? '');
      box.textContent = `记忆摘录：${latest.length > 80 ? `${latest.slice(0, 80)}…` : latest}`;
      return;
    }
    for (const m of list) {
      box.append(pEl('div', { class: 'row', style: 'align-items:flex-start' }, [
        pEl('span', { style: 'flex:0 0 auto;color:var(--muted);font-size:11px;width:96px' }, String(m.at ?? '').slice(0, 16).replace('T', ' ')),
        pEl('span', { style: 'flex:1;font-size:12px' }, String(m.text ?? '')),
      ]));
    }
  }
  catch (err) {
    box.innerHTML = `<span class="hint">读取失败：${esc(err.message)}</span>`;
  }
}

function pDuplicatePerson() {
  const person = peopleStore.people[peopleCurrent];
  if (!person) return;
  const copy = JSON.parse(JSON.stringify(person));
  copy.name = `${person.name || '未命名'} 副本`;
  peopleStore.people.push(copy);
  peopleCurrent = peopleStore.people.length - 1;
  peopleQuery = $('peopleSearch').value = '';
  peopleViewedPerson = peopleStore.people[peopleCurrent];
  peopleView = 'profile';
  pMarkDirty();
  renderPeopleTab();
}


// ─────────────────────────── 图库 ───────────────────────────
let galleryLoaded = false;
let galleryItems = [];
let galleryLoading = false;
let galleryTimer = 0;
let lightboxItem = null;
let gallerySelected = new Set();
let galleryAllowLoaded = false;
let allowDraft = new Map();

function renderGalleryFilters() {
  const groups = OV?.groups ?? [];
  const select = $('galleryGroup');
  const current = select.value;
  select.innerHTML = '<option value="">全部群</option>'
    + groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name || g.id.slice(0, 8))}</option>`).join('');
  select.value = current;
  const names = new Set();
  for (const p of (peopleStore?.people ?? [])) {
    if (p.addressing) names.add(p.addressing);
    if (p.name) names.add(p.name);
  }
  for (const p of (OV?.people ?? [])) if (p.name) names.add(p.name);
  $('galleryPeople').innerHTML = [...names].filter(Boolean)
    .map((n) => `<option value="${esc(n)}"></option>`).join('');
}

function galleryQueryString() {
  const params = new URLSearchParams();
  const query = $('galleryQuery').value.trim();
  const person = $('galleryPerson').value.trim();
  const group = $('galleryGroup').value;
  if (query) params.set('query', query);
  if (person) params.set('person', person);
  if (group) params.set('group', group);
  if ($('galleryFavorites')?.checked) params.set('favorites', '1');
  params.set('limit', '100');
  return params.toString();
}

function renderAllowList() {
  const box = $('allowList');
  const filter = $('allowSearch').value.trim().toLowerCase();
  box.innerHTML = '';
  const names = [...allowDraft.keys()].filter((name) => filter === '' || name.toLowerCase().includes(filter));
  if (names.length === 0) {
    box.innerHTML = '<div class="gallery-empty">没有匹配的人</div>';
    return;
  }
  for (const name of names) {
    const state = allowDraft.get(name);
    const check = pEl('input', { type: 'checkbox' });
    check.checked = state.checked;
    const cats = pEl('input', { type: 'text', class: 'cats', placeholder: '分类：美食 / 人像 / 风景…' });
    cats.value = state.categories;
    cats.disabled = !state.checked;
    check.addEventListener('change', () => {
      state.checked = check.checked;
      cats.disabled = !check.checked;
    });
    cats.addEventListener('input', () => { state.categories = cats.value; });
    box.append(pEl('div', { class: 'allow-row' }, [check, pEl('span', { class: 'nm' }, name), cats]));
  }
}

async function openAllowEditor() {
  try {
    const res = await api('/api/media/allow');
    const existing = new Map((Array.isArray(res.people) ? res.people : []).map((person) => [String(person.name ?? '').trim(), Array.isArray(person.categories) ? person.categories : []]));
    const names = new Set();
    for (const person of (peopleStore?.people ?? [])) if (person?.name) names.add(person.name);
    for (const person of (OV?.people ?? [])) if (person?.name) names.add(person.name);
    for (const name of existing.keys()) if (name) names.add(name);
    allowDraft = new Map([...names].filter(Boolean).sort().map((name) => [name, {
      checked: existing.has(name),
      categories: (existing.get(name) ?? []).join('、'),
    }]));
    $('allowSearch').value = '';
    renderAllowList();
    $('allowModal').hidden = false;
  }
  catch (err) {
    toast(`读取名单失败：${err.message}`, 'err');
  }
}

async function saveAllowEditor() {
  const people = [...allowDraft.entries()]
    .filter(([, state]) => state.checked)
    .map(([name, state]) => ({
      name,
      categories: state.categories.split(/[,，、\s]+/).map((item) => item.trim()).filter(Boolean),
    }));
  try {
    await api('/api/media/allow', { method: 'PUT', body: JSON.stringify({ people }) });
    $('allowModal').hidden = true;
    galleryAllowLoaded = false;
    await loadGalleryAllow();
    toast(`名单已保存（${people.length} 人）`, 'ok');
  }
  catch (err) {
    toast(`保存名单失败：${err.message}`, 'err');
  }
}

async function loadGalleryAllow() {
  if (galleryAllowLoaded) return;
  try {
    const res = await api('/api/media/allow');
    const people = Array.isArray(res.people) ? res.people : [];
    const label = people.map((person) => {
      const name = String(person?.name ?? '').trim();
      const cats = Array.isArray(person?.categories) ? person.categories.filter(Boolean) : [];
      return name + (cats.length > 0 ? `（${cats.join(' / ')}）` : '');
    }).filter(Boolean).join('、');
    $('galleryAllowNote').textContent = label ? `收图/放图名单：${label}` : '收图/放图名单：空（在 qqbot-media-allow.json 里添加）';
    galleryAllowLoaded = true;
  }
  catch {
    $('galleryAllowNote').textContent = '收图/放图名单读取失败';
  }
}

async function loadGallery() {
  if (galleryLoading) return;
  galleryLoading = true;
  try {
    const res = await api(`/api/media?${galleryQueryString()}`);
    galleryItems = Array.isArray(res.items) ? res.items : [];
    gallerySelected.clear();
    galleryLoaded = true;
    renderGallery();
  }
  catch (err) {
    galleryItems = [];
    galleryLoaded = false;
    $('galleryGrid').innerHTML = `<div class="gallery-empty">读取失败：${esc(err.message)}</div>`;
    $('galleryCount').textContent = '';
    toast(`图库读取失败：${err.message}`, 'err');
  }
  finally {
    galleryLoading = false;
  }
}

function renderGallery() {
  const grid = $('galleryGrid');
  grid.innerHTML = '';
  $('galleryCount').textContent = galleryItems.length ? `${galleryItems.length} 张` : '';
  if (!galleryItems.length) {
    grid.innerHTML = '<div class="gallery-empty">没有匹配的图片。换个关键词，或点「搜索」看全部。</div>';
    updateGallerySelection();
    return;
  }
  for (const item of galleryItems) {
    const dt = new Date(item.createdAt);
    const when = Number.isNaN(dt.getTime()) ? '' : `${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
    const card = pEl('div', { class: `gcard${gallerySelected.has(item.id) ? ' selected' : ''}`, title: item.path, onclick: () => openLightbox(item) }, []);
    const check = pEl('input', { type: 'checkbox', class: 'gcheck', title: '选择这张' });
    check.checked = gallerySelected.has(item.id);
    check.addEventListener('click', (event) => event.stopPropagation());
    check.addEventListener('change', (event) => {
      if (event.target.checked) gallerySelected.add(item.id);
      else gallerySelected.delete(item.id);
      card.classList.toggle('selected', event.target.checked);
      updateGallerySelection();
    });
    card.append(
      check,
      pEl('img', {
        src: `/api/media/file?id=${encodeURIComponent(item.id)}`,
        alt: item.caption || '图片',
        loading: 'lazy',
        onerror: (event) => { event.target.style.opacity = '0.25'; },
      }),
      pEl('div', { class: 'cap' }, `${item.liked ? '⭐ ' : ''}${item.caption || '图片'}`),
      pEl('div', { class: 'sub' }, [
        pEl('span', {}, item.sender || '未知'),
        pEl('span', {}, [item.group || '', when].filter(Boolean).join(' · ')),
      ]),
      ...(item.liked && item.reason ? [pEl('div', { class: 'sub', title: item.reason }, `收藏：${item.reason}`)] : []),
    );
    grid.append(card);
  }
  updateGallerySelection();
}

function updateGallerySelection() {
  const count = gallerySelected.size;
  const del = $('galleryDelete');
  const all = $('gallerySelectAll');
  if (del) {
    del.disabled = count === 0;
    del.textContent = count > 0 ? `删除选中 (${count})` : '删除选中';
  }
  if (all)
    all.textContent = galleryItems.length > 0 && count === galleryItems.length ? '取消全选' : '全选';
}

async function deleteGallery(ids) {
  const wanted = [...new Set(ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (wanted.length === 0) return;
  if (!confirm(`确定删除选中的 ${wanted.length} 张图片？\n会同时删除媒体库里的文件，不可恢复。`)) return;
  try {
    const res = await api('/api/media/delete', { method: 'POST', body: JSON.stringify({ ids: wanted }) });
    const gone = new Set(wanted);
    galleryItems = galleryItems.filter((item) => !gone.has(item.id));
    gallerySelected.clear();
    if (lightboxItem && gone.has(lightboxItem.id)) closeLightbox();
    renderGallery();
    toast(`已删除 ${res.deleted ?? wanted.length} 张`, 'ok');
  }
  catch (err) {
    toast(`删除失败：${err.message}`, 'err');
  }
}

function openLightbox(item) {
  lightboxItem = item;
  $('lightboxImg').src = `/api/media/file?id=${encodeURIComponent(item.id)}`;
  $('lightboxImg').alt = item.caption || '图片';
  $('lightboxCap').textContent = item.caption || '图片';
  $('lightboxMeta').textContent = [
    item.liked ? '⭐ 已收藏' : '',
    item.sender || '未知',
    item.group || '',
    item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : '',
    item.reason ? `收藏理由：${item.reason}` : '',
    item.tags ? `#${item.tags}` : '',
  ].filter(Boolean).join(' · ');
  $('lightbox').classList.add('show');
}

function closeLightbox() {
  $('lightbox').classList.remove('show');
  $('lightboxImg').removeAttribute('src');
  lightboxItem = null;
}

function scheduleGallery() {
  clearTimeout(galleryTimer);
  galleryTimer = setTimeout(() => { galleryLoaded = false; void loadGallery(); }, 300);
}

$('tabGallery').onclick = () => switchTab('gallery');
$('tabEvents').onclick = () => switchTab('events');
initEventsPage();
$('galleryAllowEdit').onclick = openAllowEditor;
$('allowSearch').addEventListener('input', renderAllowList);
$('allowSave').onclick = saveAllowEditor;
$('allowCancel').onclick = () => { $('allowModal').hidden = true; };
$('allowClose').onclick = () => { $('allowModal').hidden = true; };
$('allowModal').addEventListener('click', (event) => { if (event.target === $('allowModal')) $('allowModal').hidden = true; });
$('gallerySearch').onclick = () => { galleryLoaded = false; void loadGallery(); };
$('galleryQuery').addEventListener('input', scheduleGallery);
$('galleryPerson').addEventListener('input', scheduleGallery);
$('galleryGroup').addEventListener('change', () => { galleryLoaded = false; void loadGallery(); });
$('galleryFavorites').addEventListener('change', () => { galleryLoaded = false; void loadGallery(); });
$('galleryQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); galleryLoaded = false; void loadGallery(); } });
$('galleryPerson').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); galleryLoaded = false; void loadGallery(); } });
$('gallerySelectAll').onclick = () => {
  if (gallerySelected.size === galleryItems.length) gallerySelected.clear();
  else for (const item of galleryItems) gallerySelected.add(item.id);
  renderGallery();
};
$('galleryDelete').onclick = () => { void deleteGallery([...gallerySelected]); };
$('lightboxDelete').onclick = () => { if (lightboxItem) void deleteGallery([lightboxItem.id]); };
$('lightboxClose').onclick = closeLightbox;
$('lightbox').addEventListener('click', (e) => { if (e.target === $('lightbox')) closeLightbox(); });
$('lightboxCopy').onclick = async () => {
  if (!lightboxItem?.path) return;
  try {
    await navigator.clipboard.writeText(lightboxItem.path);
    toast('路径已复制', 'ok');
  }
  catch {
    prompt('复制路径', lightboxItem.path);
  }
};
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('lightbox').classList.contains('show')) closeLightbox(); });

$('tabPeople').onclick = () => switchTab('people');
$('peopleSearch').addEventListener('input', (event) => {
  peopleQuery = event.target.value;
  renderPeopleList();
  if (peopleStore.people[peopleCurrent] !== peopleViewedPerson) renderMemberForm();
});
$('peopleGroupFilter').addEventListener('change', (event) => {
  peopleFilter = event.target.value;
  renderPeopleList();
  renderMemberForm();
});
$('btnAddPerson').onclick = pAddPerson;
$('btnDupPerson').onclick = pDuplicatePerson;
$('btnReloadPeople').onclick = reloadPeopleArchive;
$('btnSavePeople').onclick = savePeople;
$('btnGroupManage').onclick = openGroupManage;
$('groupManage').addEventListener('cancel', event => { if (peopleSaving) event.preventDefault(); });
$('btnCloseGroupManage').onclick = () => $('groupManage').close();
$('btnAddGroup').onclick = addPeopleGroup;

// ─────────────────────────── 私人记忆 ───────────────────────────
const memoriesState = {
  mode: 'library', groups: [], library: [], auto: [], query: { library: '', auto: '' },
  selected: { library: null, auto: null }, requests: { library: 0, auto: 0 },
  messages: { library: '读取中…', auto: '读取中…' }, person: '', includeArchived: false, personaProfiles: [], edit: null, scope: null,
};
const memoryGroupLabel = (id) => memoriesState.groups.find((group) => group.id === id)?.name || id.slice(0, 8);
const memoryPersonaLabel = (id) => {
  const profile = memoriesState.personaProfiles.find((item) => item.id === id);
  if (!profile) return '已删除的人格';
  return profile.name || (Array.isArray(profile.modules) ? profile.modules.map((moduleId) => moduleDisplay(moduleId)).join(' · ') : '') || profile.firstModule || profile.key || '人格组合';
};
const memoryTitle = (item) => item.humanTitle || item.topic || item.text.split('\n').find((line) => line.trim())?.trim().slice(0, 40) || `记忆 #${item.id}`;
const memoryChip = (label, style = '') => `<span class="mem-chip ${style}">${esc(label)}</span>`;
function memoryStatus(item) {
  if (item.scopeType === 'legacy-groups') return memoryChip(`旧版范围 · ${item.groups.length} 个群`, 'warn');
  return item.personaIds.length ? memoryChip(`已启用 · ${item.personaIds.length} 套人格`, 'on') : memoryChip('未启用');
}

async function loadMemoriesTab() {
  renderMemoryWorkspace();
  if (memoriesState.mode === 'library') {
    try { memoriesState.personaProfiles = (await api('/api/memory-library/personas')).profiles ?? []; }
    catch (err) { memoriesState.messages.library = `读取人格组合失败：${err.message}`; }
    await loadMemoryList('library');
  }
  else await loadMemoryGroups();
}

async function loadMemoryGroups() {
  const previous = $('memAutoGid').value;
  const seq = ++memoriesState.requests.auto;
  memoriesState.messages.auto = '正在读取群列表…';
  renderMemoryWorkspace();
  try {
    const result = await api('/api/groups');
    if (seq !== memoriesState.requests.auto) return;
    memoriesState.groups = result.groups ?? [];
    $('memAutoGid').replaceChildren(...memoriesState.groups.map((g) => new Option(memoryGroupLabel(g.id), g.id)));
    if (memoriesState.groups.some((g) => g.id === previous)) $('memAutoGid').value = previous;
    await loadMemoryList('auto');
  }
  catch (err) {
    if (seq !== memoriesState.requests.auto) return;
    memoriesState.groups = [];
    $('memAutoGid').replaceChildren();
    memoriesState.messages.auto = `读取群列表失败：${err.message}`;
    renderMemoryWorkspace();
  }
}

async function loadMemoryList(mode) {
  const isAuto = mode === 'auto';
  const gid = $('memAutoGid').value;
  const seq = ++memoriesState.requests[mode];
  memoriesState[mode] = [];
  memoriesState.messages[mode] = isAuto && !gid ? '还没有可查看的群。' : '正在读取记忆…';
  renderMemoryWorkspace();
  if (isAuto && !gid) return;
  try {
    const params = new URLSearchParams({ gid, q: memoriesState.query.auto });
    const result = await api(isAuto ? `/api/memories?${params}` : '/api/memory-library');
    if (seq !== memoriesState.requests[mode]) return;
    memoriesState[mode] = result.memories ?? [];
    memoriesState.messages[mode] = '';
  }
  catch (err) {
    if (seq !== memoriesState.requests[mode]) return;
    memoriesState.messages[mode] = `读取失败：${err.message}`;
  }
  renderMemoryWorkspace();
}

function renderMemoryWorkspace() {
  const state = memoriesState;
  const isAuto = state.mode === 'auto';
  document.querySelectorAll('[data-mem-mode]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.memMode === state.mode)));
  $('btnMemAdd').hidden = isAuto;
  $('memGroupField').hidden = !isAuto;
  $('memAutoFilters').hidden = !isAuto;
  $('memListHeading').textContent = isAuto ? '按类型浏览' : '记忆列表';
  $('memContext').textContent = isAuto ? '按类型浏览群记忆，也可以选一个人物查看相关记录。' : '同一条记忆可供多个选中的人格组合召回。';
  $('memQuery').placeholder = isAuto ? '搜索人物、原文或标签' : '搜索主题、正文或标签';
  const q = state.query[state.mode].trim().toLowerCase();
  if (isAuto) return renderAutoMemories(state, q);
  $('memList').classList.remove('mem-grouped');
  const list = state.library.filter((m) => !q || [memoryTitle(m), m.text, m.tags].some((value) => value.toLowerCase().includes(q)));
  if (!list.some((m) => m.id === state.selected[state.mode]) && list.length) state.selected[state.mode] = list[0].id;
  const statusText = state.messages[state.mode] || (!list.length ? q ? '没有匹配的记忆。' : '记忆库为空。你可以新增一条记忆。' : '');
  $('memCount').textContent = state.messages[state.mode] ? '' : `${list.length} 条`;
  $('memMsg').hidden = !statusText;
  $('memMsg').textContent = statusText;
  $('memList').innerHTML = list.map((m) => `<button type="button" class="mem-list-item" data-mem-id="${m.id}" aria-current="${m.id === state.selected[state.mode]}">
    <strong>${m.pinned ? '置顶 · ' : ''}${esc(memoryTitle(m))}</strong>
    <span class="mem-excerpt muted">${esc(m.text)}</span><span class="mem-meta">${memoryStatus(m)}</span></button>`).join('');
  const item = list.find((m) => m.id === state.selected[state.mode]);
  const detail = $('memDetail');
  detail.hidden = !item;
  if (!item) { detail.replaceChildren(); return; }
  const legacy = item.scopeType === 'legacy-groups' || item.scopeType === 'legacy-modules';
  detail.innerHTML = `<div class="mem-meta">${memoryStatus(item)}${item.pinned ? memoryChip('置顶') : ''}</div>
    <h3>${esc(memoryTitle(item))}</h3><p class="muted">更新于 ${esc(new Date(item.updatedAt).toLocaleString())}</p>
    <section><h4>记忆正文</h4><p class="mem-body">${esc(item.text)}</p><div class="mem-meta">${item.tags.split(/\s+/).filter(Boolean).map((tag) => memoryChip(tag)).join('') || '<span class="muted">无标签</span>'}</div></section>
    <section>
      <div class="mem-scope-head"><h4>启用范围</h4><button type="button" data-mem-action="scope">编辑人格范围</button></div>
      ${legacy ? `<p class="muted">仍使用旧版范围，保存人格范围后才会替换。</p><div class="mem-meta">${item.groups.map((g) => memoryChip(memoryGroupLabel(g))).join('')}</div>` :
        item.personaIds.length ? `<div class="mem-meta">${item.personaIds.map((id) => memoryChip(memoryPersonaLabel(id))).join('')}</div>` : '<p class="muted">未选择人格组合，不参与召回。</p>'}</section>
    <div class="mem-actions"><button type="button" class="ghost danger" data-mem-action="delete">删除</button><button type="button" data-mem-action="edit">编辑记忆</button></div>`;
}

const autoMemoryKindOrder = ['对话总结', '群聊日报', '人物近况', '群内约定', '事件记录', '共同经历', '人物关系', '兴趣与偏好', '其他记录'];
const autoMemoryKindMap = { '对话总结': '对话总结', '日报': '群聊日报', '近况': '人物近况', '近况汇总': '人物近况', '约定': '群内约定', '关系': '人物关系', '经历': '共同经历', '兴趣': '兴趣与偏好', '事件沉淀': '事件记录', '事件': '事件记录' };
function normalizeAutoMemory(item) {
  if (item.humanTitle && item.summary && item.kindLabel) return item;
  const raw = String(item.rawText || item.text || '').replace(/<faceType\s*=[^>]*(?:>|$)/gi, '[表情]').replace(/\s+/g, ' ').trim();
  const kind = raw.match(/\[([^\]]+)\]/)?.[1] || '其他记录';
  const kindLabel = item.kindLabel || autoMemoryKindMap[kind] || kind;
  const body = raw.replace(/^\d{4}-\d{1,2}-\d{1,2}\s*/, '').replace(/^\[[^\]]+\]\s*/, '').trim();
  const taggedSubject = String(item.tags || '').match(/(?:^|\s)subject:([^\s]+)/)?.[1]?.replace(/_/g, ' ') || '';
  const parsedSubject = body.match(/^([^：:\s]{1,32})[：:]/)?.[1] || '';
  const subjectName = item.subjectName || taggedSubject || parsedSubject;
  return { ...item, humanTitle: item.humanTitle || [subjectName, kindLabel].filter(Boolean).join(' · '), summary: item.summary || body || '没有可显示的正文，可展开核对原始记录。', kind: item.kind || kind, kindLabel, subjectName, subjectKey: item.subjectKey || (subjectName ? `name:${subjectName}` : ''), rawText: item.rawText || item.text || '', humanTags: item.humanTags || [], technicalTags: item.technicalTags || [], source: item.source || '群聊记录', archived: item.archived || /(?:^|\s)archived(?:\s|$)/.test(String(item.tags || '')) };
}
const autoMemoryDate = (item) => item.recordDate || (item.updatedAt ? new Date(item.updatedAt).toLocaleDateString() : '');
const autoMemoryExcerpt = (item) => String(item.summary || '').replace(/^•\s*/, '').replace(/\s+/g, ' ').slice(0, 120);

function renderAutoMemories(state, q) {
  const index = $('memList');
  const person = $('memAutoPerson');
  const displayItems = state.auto.map(normalizeAutoMemory);
  const candidates = displayItems.filter((item) => state.includeArchived || !item.archived);
  const people = [...new Set(candidates.map((item) => item.subjectName).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  if (!state.messages.auto && state.person && !people.includes(state.person)) people.unshift(state.person);
  person.replaceChildren(new Option('所有人物', ''), ...people.map((name) => new Option(name, name)));
  person.value = state.person;
  person.disabled = !!state.messages.auto || !people.length;
  const list = candidates.filter((item) => !state.person || item.subjectName === state.person);
  const groups = new Map(autoMemoryKindOrder.map((label) => [label, []]));
  for (const item of list) (groups.get(item.kindLabel) || groups.get('其他记录')).push(item);
  const buckets = [...groups].filter(([, items]) => items.length);
  const item = list.find((m) => m.id === state.selected.auto) || list.find((m) => m.pinned) || buckets[0]?.[1][0];
  if (!state.messages.auto) state.selected.auto = item?.id ?? null;
  const archivesHidden = !state.includeArchived && state.auto.some((item) => item.archived && (!state.person || item.subjectName === state.person));
  const status = state.messages.auto || (!list.length ? archivesHidden ? '当前没有未归档记录。可勾选「显示已归档」查看。'
    : q || state.person ? '没有匹配的记忆。' : '这个群还没有自动记忆。' : '');
  $('memMsg').hidden = !status;
  $('memMsg').textContent = status;
  $('memCount').textContent = state.messages.auto ? '' : `${buckets.length} 类 · ${list.length} 条`;
  const scroll = index.scrollTop;
  const open = new Set([...index.querySelectorAll('.mem-list-group[open]')].map((group) => group.dataset.kind));
  index.classList.add('mem-grouped');
  index.innerHTML = buckets.map(([label, items]) => `<details class="mem-list-group" data-kind="${esc(label)}" ${open.has(label) || items.includes(item) ? 'open' : ''}>
    <summary>${esc(label)}<span class="muted">${items.length} 条</span></summary>
    ${items.map((m) => `<button type="button" class="mem-list-item" data-mem-id="${m.id}" aria-current="${m === item}">
      <strong>${esc(m.subjectName || label)}</strong><span class="mem-excerpt">${esc(autoMemoryExcerpt(m))}</span>
      <span class="mem-list-date muted">${esc(autoMemoryDate(m))}${m.pinned ? ' · 置顶' : ''}${m.archived ? ' · 已归档' : ''}</span></button>`).join('')}
    </details>`).join('');
  index.scrollTop = scroll;
  const detail = $('memDetail');
  detail.hidden = !item;
  if (!item) { detail.replaceChildren(); return; }
  const related = item.subjectKey ? list.filter((m) => m !== item && m.subjectKey === item.subjectKey)
    .sort((a, b) => (b.recordDate || b.updatedAt).localeCompare(a.recordDate || a.updatedAt)).slice(0, 4) : [];
  const meta = [['所属群', memoryGroupLabel($('memAutoGid').value)], ['来源', item.source], ['记录日期', item.recordDate],
    ['更新于', new Date(item.updatedAt).toLocaleString()], ['汇总范围', item.period]].filter(([, value]) => value);
  detail.innerHTML = `<div class="mem-meta">${memoryChip(item.kindLabel)}${item.pinned ? memoryChip('置顶') : ''}${item.archived ? memoryChip('已归档') : ''}</div>
    <h3>${esc(memoryTitle(item))}</h3>
    <section class="mem-summary"><h4>${['对话总结', '日报', '近况汇总'].includes(item.kind) ? '总结内容' : '记录内容'}</h4>
      <p class="mem-body">${esc(item.summary)}</p>${item.humanTags.length ? `<div class="mem-meta">${item.humanTags.map((tag) => memoryChip(tag)).join('')}</div>` : ''}</section>
    <section><h4>记录信息</h4><dl class="mem-meta-grid">${meta.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl></section>
    ${related.length ? `<section><h4>同一人物的近期记录</h4><ul class="mem-timeline">${related.map((m) => `<li><button type="button" class="ghost" data-related-mem="${m.id}">
      <span class="muted">${esc(autoMemoryDate(m))} · ${esc(m.kindLabel)}${m.archived ? ' · 已归档' : ''}</span><span>${esc(autoMemoryExcerpt(m).slice(0, 44))}</span></button></li>`).join('')}</ul></section>` : ''}
    <details class="mem-technical"><summary>原始记录与机器字段</summary><pre>${esc(item.rawText)}</pre>
      <p class="muted">记录编号：${item.id} · 原始标签</p><pre>${esc(item.tags || '无标签')}</pre></details>
    <div class="mem-actions"><button type="button" class="ghost danger" data-mem-action="delete">删除</button><button type="button" data-mem-action="edit">编辑记忆</button></div>`;
}

function selectedMemory() {
  const { mode, selected } = memoriesState;
  return memoriesState[mode].find((item) => item.id === selected[mode]);
}

function openMemoryEditor(item) {
  const isAuto = memoriesState.mode === 'auto';
  memoriesState.edit = { id: item?.id, mode: memoriesState.mode, gid: $('memAutoGid').value };
  $('memEditorTitle').textContent = isAuto ? '编辑群内自动记忆' : item ? '编辑记忆' : '新增记忆';
  $('memTopicField').hidden = isAuto;
  $('memEditGroup').hidden = !isAuto;
  $('memEditGroup').textContent = isAuto ? `所属群：${memoryGroupLabel(memoriesState.edit.gid)} · 仅更新此群` : '';
  $('memTopic').value = item?.topic ?? '';
  $('memText').value = item?.text ?? '';
  $('memTags').value = item?.tags ?? '';
  $('memPinned').checked = item?.pinned ?? false;
  $('memNewHint').hidden = !!item;
  $('memEditMsg').textContent = '';
  $('memBrowse').hidden = true;
  $('memEditor').hidden = false;
  $(isAuto ? 'memText' : 'memTopic').focus();
}

function closeMemoryEditor(focusSelector) {
  const focus = focusSelector ?? (memoriesState.edit?.id ? '[data-mem-action="edit"]' : '#btnMemAdd');
  memoriesState.edit = null;
  $('memEditor').hidden = true;
  $('memBrowse').hidden = false;
  document.querySelector(`#paneMemories ${focus}`)?.focus();
}

async function saveMemory() {
  const edit = memoriesState.edit;
  const text = $('memText').value.trim();
  const msg = $('memEditMsg');
  if (!edit || $('btnMemSave').disabled) return;
  if (!text) { msg.dataset.error = ''; msg.textContent = '内容不能为空。'; return; }
  delete msg.dataset.error;
  const payload = { id: edit.id, topic: $('memTopic').value.trim(), text, tags: $('memTags').value.trim(), pinned: $('memPinned').checked };
  const controls = ['btnMemSave', 'btnMemBack', 'btnMemCancel'].map($);
  controls.forEach((el) => { el.disabled = true; });
  msg.textContent = '保存中…';
  try {
    const isAuto = edit.mode === 'auto';
    if (isAuto) payload.gid = edit.gid;
    const result = await api(isAuto ? '/api/memories' : '/api/memory-library', { method: edit.id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    memoriesState.selected[edit.mode] = edit.id ?? result.id;
    if (!edit.id) { memoriesState.query.library = ''; $('memQuery').value = ''; }
    await loadMemoryList(edit.mode);
    closeMemoryEditor(edit.id ? undefined : '[data-mem-action="scope"]');
    toast('记忆已保存', 'ok');
  }
  catch (err) { msg.dataset.error = ''; msg.textContent = `保存失败：${err.message}`; }
  finally { controls.forEach((el) => { el.disabled = false; }); }
}

function updateMemoryScope() {
  const state = memoriesState.scope;
  if (!state?.ready) return;
  const chosen = [...$('memPersonaOptions').querySelectorAll('input:checked')].map((el) => el.value);
  const changed = state.legacy || chosen.length !== state.original.length || chosen.some((id) => !state.original.includes(id));
  $('btnMemScopeSave').disabled = state.saving || !changed;
  $('memScopePreview').textContent = (chosen.length ? `已选 ${chosen.length} 个人格组合。` : '未选择人格；保存后保留记忆，但不参与召回。')
    + (state.legacy ? ' 保存会替换旧版按群范围。' : '')
    + (state.missing.length ? ` 已不存在的模块：${state.missing.join('、')}。保存时将清除这些关联。` : '');
}

async function openMemoryScope(item) {
  const dialog = $('memScopeDialog');
  if (dialog.open) return;
  const state = memoriesState.scope = { id: item.id, original: item.personaIds, legacy: item.scopeType === 'legacy-groups', ready: false, saving: false };
  $('memScopeTopic').textContent = memoryTitle(item);
  $('memScopeError').textContent = '';
  $('memScopePreview').textContent = '正在读取人格组合…';
  $('memPersonaOptions').replaceChildren();
  $('btnMemScopeSave').disabled = true;
  dialog.showModal();
  try {
    const { profiles } = await api('/api/memory-library/personas');
    memoriesState.personaProfiles = profiles;
    const personaIds = profiles.map((profile) => profile.id);
    if (!dialog.open || memoriesState.scope !== state) return;
    state.missing = state.original.filter((id) => !personaIds.includes(id));
    $('memPersonaOptions').innerHTML = profiles.map((profile) => `<label class="mem-persona-option">
      <input type="checkbox" value="${esc(profile.id)}" ${state.original.includes(profile.id) ? 'checked' : ''}><span>${esc(profile.name || (Array.isArray(profile.modules) ? profile.modules.map((id) => moduleDisplay(id)).join(' · ') : '') || profile.firstModule || profile.key || '人格')}</span></label>`).join('') || '<p class="muted">暂无人格组合，请先到「人格设定」添加模块。</p>';
    state.ready = true;
    updateMemoryScope();
  }
  catch (err) {
    if (memoriesState.scope !== state || !dialog.open) return;
    $('memScopePreview').textContent = '';
    $('memScopeError').textContent = `读取失败：${err.message}`;
  }
}

async function saveMemoryScope() {
  const state = memoriesState.scope;
  if (!state?.ready || $('btnMemScopeSave').disabled) return;
  const inputs = [...$('memPersonaOptions').querySelectorAll('input')];
  const personaIds = inputs.filter((el) => el.checked).map((el) => el.value);
  const controls = [...inputs, $('btnMemScopeClose'), $('btnMemScopeCancel')];
  state.saving = true;
  controls.forEach((el) => { el.disabled = true; });
  $('btnMemScopeSave').disabled = true;
  $('memScopeError').textContent = '';
  $('memScopePreview').textContent = '保存中…';
  try {
    const result = await api('/api/memory-library/scope', { method: 'PUT', body: JSON.stringify({ id: state.id, personaIds }) });
    const item = memoriesState.library.find((m) => m.id === state.id);
    if (item) Object.assign(item, { scopeType: 'personas', personaIds: result.personaIds, groups: [] });
    $('memScopeDialog').close();
    renderMemoryWorkspace();
    $('memDetail').querySelector('[data-mem-action="scope"]')?.focus();
    toast('启用范围已保存', 'ok');
  }
  catch (err) { $('memScopeError').textContent = `保存失败：${err.message}`; }
  finally {
    state.saving = false;
    controls.forEach((el) => { el.disabled = false; });
    if ($('memScopeDialog').open) updateMemoryScope();
  }
}

async function deleteMemory(item) {
  const { mode } = memoriesState;
  const gid = $('memAutoGid').value;
  const isAuto = mode === 'auto';
  const impact = isAuto ? `仅从「${memoryGroupLabel(gid)}」删除。` : item.scopeType === 'legacy-groups'
    ? `将从 ${item.groups.length} 个旧版群范围移除。` : item.personaIds.length
      ? `将从 ${item.personaIds.length} 个人格组合的启用范围移除。` : '该记忆当前未启用。';
  if (!confirm(`删除「${memoryTitle(item)}」？${impact}删除后不可恢复。`)) return;
  try {
    const params = new URLSearchParams({ id: item.id });
    if (isAuto) params.set('gid', gid);
    await api(`${isAuto ? '/api/memories' : '/api/memory-library'}?${params}`, { method: 'DELETE' });
    await loadMemoryList(mode);
    ($('memList').querySelector('[aria-current="true"]') ?? $('memQuery')).focus();
    toast('记忆已删除', 'ok');
  }
  catch (err) { toast(`删除失败：${err.message}`, 'err'); }
}

// ─────────────────────────── 群兴趣 ───────────────────────────
const interestState = { loaded: false, data: null, gid: '', topicSort: { key: 'heat', direction: 'descending' } };

function intTime(ts) {
  const n = Number(ts) || 0;
  if (n <= 0) return '—';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} `
    + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function intNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

async function loadInterestTab(gid) {
  const target = gid ?? interestState.gid;
  const suffix = target ? `?gid=${encodeURIComponent(target)}` : '';
  const data = await api(`/api/interest${suffix}`);
  interestState.data = data;
  interestState.loaded = true;
  if (!target) {
    const first = data.groups?.[0]?.gid ?? '';
    interestState.gid = first;
    if (first) {
      await loadInterestTab(first);
      return;
    }
  }
  else {
    interestState.gid = target;
  }
  renderInterestTab();
}

function renderInterestTab() {
  const data = interestState.data;
  if (!data) return;
  const config = data.config ?? {};
  $('intEnabled').checked = config.enabled !== false;
  $('intSearchMode').value = data.searchMode === 'auto' ? 'auto' : (data.searchMode === 'off' ? 'off' : 'manual');
  $('intShareMode').value = data.shareMode === 'auto' ? 'auto' : 'off';
  $('intActiveMin').value = String(config.activeMin ?? 0.15);
  $('intSearchPerRun').value = String(config.search?.maxSearchesPerRun ?? 6);
  $('intSearchMinScore').value = String(config.search?.minScore ?? 0.45);
  $('intSummary').textContent = `${data.groups?.length ?? 0} 个群 · 活跃度快照 ${intTime(data.activityAt)}`;
  const groups = data.groups ?? [];
  const picker = $('intGroupPicker');
  picker.innerHTML = groups.map((group) => `<option value="${esc(group.gid)}">${esc(group.name || group.gid)}</option>`).join('');
  picker.value = interestState.gid;
  picker.disabled = groups.length === 0;
  $('intGroups').innerHTML = groups.map((group) => {
    const cfg = group.config ?? {};
    const search = String(cfg.searchMode ?? data.searchMode ?? 'manual');
    const share = String(cfg.shareMode ?? (data.shareMode === 'auto' ? 'auto' : 'off'));
    return `<tr>
      <td>${esc(group.name || group.gid)}</td>
      <td>${intNum(group.activity)}</td>
      <td>${Number(group.messages24h) || 0}</td>
      <td>${Number(group.topics) || 0}</td>
      <td>${Number(group.findings) || 0}</td>
      <td>${intTime(group.state?.lastObserveAt)}</td>
      <td><select data-int-search="${esc(group.gid)}">
        <option value="manual"${search === 'manual' ? ' selected' : ''}>manual</option>
        <option value="auto"${search === 'auto' ? ' selected' : ''}>auto</option>
        <option value="off"${search === 'off' ? ' selected' : ''}>off</option>
      </select></td>
      <td><select data-int-share="${esc(group.gid)}">
        <option value="off"${share === 'off' ? ' selected' : ''}>off</option>
        <option value="auto"${share === 'auto' ? ' selected' : ''}>on</option>
      </select></td>
      <td><button class="mini" data-int-view="${esc(group.gid)}">查看</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="9" class="muted">还没有群数据</td></tr>';
  const group = groups.find((item) => item.gid === interestState.gid);
  const topics = [...(data.topics ?? [])];
  const findings = data.findings ?? [];
  const topicSort = interestState.topicSort;
  const topicSortValue = (topic) => {
    if (topicSort.key === 'category' || topicSort.key === 'broad_topic') return String(topic[topicSort.key] || '');
    return Number(topic[topicSort.key]) || 0;
  };
  topics.sort((a, b) => {
    const av = topicSortValue(a);
    const bv = topicSortValue(b);
    const result = typeof av === 'string'
      ? av.localeCompare(bv, 'zh-CN')
      : av - bv;
    return (topicSort.direction === 'ascending' ? result : -result)
      || String(a.topic || '').localeCompare(String(b.topic || ''), 'zh-CN');
  });
  $('intDetailMsg').textContent = topics.length > 0
    ? ''
    : '这个群还没有话题：等它活跃一点，或先用调试脚本手动触发一次观察。';
  $('intTopics').innerHTML = topics.length > 0
    ? `<table class="matrix">
        <thead><tr><th>话题</th><th data-interest-sort="broad_topic" tabindex="0" role="button" aria-sort="${topicSort.key === 'broad_topic' ? topicSort.direction : 'none'}">主题</th><th data-interest-sort="category" tabindex="0" role="button" aria-sort="${topicSort.key === 'category' ? topicSort.direction : 'none'}">类别</th><th data-interest-sort="heat" tabindex="0" role="button" aria-sort="${topicSort.key === 'heat' ? topicSort.direction : 'none'}">热度</th><th data-interest-sort="bond" tabindex="0" role="button" aria-sort="${topicSort.key === 'bond' ? topicSort.direction : 'none'}">偏好</th><th>提及</th><th>可搜</th><th>最近出现</th></tr></thead>
        <tbody>${topics.map((topic) => `<tr>
          <td>${esc(topic.topic)}</td>
          <td>${esc(topic.broad_topic || '—')}</td>
          <td>${esc(topic.category || '')}</td>
          <td>${intNum(topic.heat)}</td>
          <td>${intNum(topic.bond)}</td>
          <td>${Number(topic.mentions) || 0}</td>
          <td>${Number(topic.searchable) === 1 ? (topic.sensitivity === 'high' ? '敏感' : '是') : '否'}</td>
          <td>${intTime(topic.last_evidence_at)}</td>
        </tr>`).join('')}</tbody>
      </table>`
    : '';
  $('intFindings').innerHTML = findings.length > 0
    ? `<div class="hint">搜索结果（只落库，不会自动发）</div>${findings.map((item) => `
      <div style="margin-top:8px">
        <div><b>${esc(item.title)}</b>
          <span class="muted" style="font-size:12px"> · ${intNum(item.score)} · ${esc(item.status)}${item.target_person_name ? ` · 接 ${esc(item.target_person_name)}` : ''}</span>
        </div>
        <div class="hint">${esc(item.summary || '')}</div>
        <div class="hint"><a href="${esc(item.url)}" target="_blank" rel="noreferrer">${esc(item.url)}</a></div>
      </div>`).join('')}`
    : '';
  const runs = data.runs ?? [];
  $('intRuns').textContent = runs.length > 0
    ? `最近运行：${runs.slice(0, 4).map((run) => `${intTime(run.started_at)} ${run.result || run.error || ''}（搜 ${Number(run.searches) || 0} 次）`).join(' · ')}`
    : '';
}

async function saveInterestConfig() {
  const msg = $('intMsg');
  msg.textContent = '保存中…';
  try {
    await api('/api/interest', {
      method: 'PUT',
      body: JSON.stringify({
        config: {
          enabled: $('intEnabled').checked,
          searchMode: $('intSearchMode').value,
          shareMode: $('intShareMode').value,
          activeMin: Number($('intActiveMin').value),
          search: {
            mode: $('intSearchMode').value,
            maxSearchesPerRun: Number($('intSearchPerRun').value),
            minScore: Number($('intSearchMinScore').value),
          },
        },
      }),
    });
    msg.textContent = '已保存，机器人热读生效';
    await loadInterestTab(interestState.gid);
  }
  catch (err) {
    msg.textContent = `保存失败：${err.message}`;
  }
}

async function saveInterestGroup(gid, patch) {
  const msg = $('intMsg');
  try {
    await api('/api/interest', {
      method: 'PUT',
      body: JSON.stringify({ gid, group: patch }),
    });
    msg.textContent = '已保存';
    await loadInterestTab(interestState.gid);
  }
  catch (err) {
    msg.textContent = `保存失败：${err.message}`;
  }
}

// ─────────────────────────── 事件绑定 ───────────────────────────
$('tabHome').onclick = () => switchTab('home');
$('tabSettings').onclick = () => switchTab('settings');
$('btnSettingsOwners').onclick = () => openSettingsUtility('owners');
$('btnSettingsTheme').onclick = () => openSettingsUtility('theme');
$('tabPersona').onclick = () => switchTab('persona');
$('tabMemories').onclick = () => switchTab('memories');
$('tabInterest').onclick = () => switchTab('interest');
$('btnIntSave').onclick = () => void saveInterestConfig();
$('intGroupPicker').onchange = (e) => {
  const gid = e.target.value;
  if (gid && gid !== interestState.gid) {
    void loadInterestTab(gid).catch((err) => {
      $('intDetailMsg').textContent = `读取失败：${err.message}`;
    });
  }
};
$('intGroups').onchange = (e) => {
  const search = e.target.closest('select[data-int-search]');
  if (search) {
    void saveInterestGroup(search.dataset.intSearch, { searchMode: search.value });
    return;
  }
  const share = e.target.closest('select[data-int-share]');
  if (share)
    void saveInterestGroup(share.dataset.intShare, { shareMode: share.value });
};
$('intTopics').onclick = (e) => {
  const header = e.target.closest('th[data-interest-sort]');
  if (!header) return;
  const key = header.dataset.interestSort;
  if (interestState.topicSort.key === key) {
    interestState.topicSort.direction = interestState.topicSort.direction === 'ascending' ? 'descending' : 'ascending';
  } else {
    interestState.topicSort = { key, direction: key === 'category' || key === 'broad_topic' ? 'ascending' : 'descending' };
  }
  renderInterestTab();
};
$('intTopics').onkeydown = (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    const header = e.target.closest('th[data-interest-sort]');
    if (header) { e.preventDefault(); header.click(); }
  }
};
$('intGroups').onclick = (e) => {
  const view = e.target.closest('button[data-int-view]');
  if (view)
    void loadInterestTab(view.dataset.intView).catch((err) => {
      $('intDetailMsg').textContent = `读取失败：${err.message}`;
    });
};
document.querySelectorAll('[data-mem-mode]').forEach((button) => {
  button.onclick = () => {
    if (memoriesState.mode === button.dataset.memMode) return;
    memoriesState.mode = button.dataset.memMode;
    $('memQuery').value = memoriesState.query[memoriesState.mode];
    void loadMemoriesTab();
  };
});
$('memSearch').onsubmit = (e) => {
  e.preventDefault();
  memoriesState.query[memoriesState.mode] = $('memQuery').value.trim();
  if (memoriesState.mode === 'auto') void loadMemoryList('auto');
  else if (memoriesState.messages.library) void loadMemoryList('library');
  else renderMemoryWorkspace();
};
$('memAutoPerson').onchange = () => {
  memoriesState.person = $('memAutoPerson').value;
  renderMemoryWorkspace();
};
$('memAutoArchive').onchange = () => {
  memoriesState.includeArchived = $('memAutoArchive').checked;
  renderMemoryWorkspace();
};
$('memAutoGid').onchange = () => {
  memoriesState.selected.auto = null;
  memoriesState.person = '';
  void loadMemoryList('auto');
};
$('memList').onclick = (e) => {
  const button = e.target.closest('[data-mem-id]');
  if (!button) return;
  memoriesState.selected[memoriesState.mode] = Number(button.dataset.memId);
  renderMemoryWorkspace();
  $('memList').querySelector('[aria-current="true"]')?.focus();
  if (matchMedia('(max-width: 760px)').matches) $('memDetail').scrollIntoView({ block: 'nearest' });
};
$('memDetail').onclick = (e) => {
  const related = e.target.closest('[data-related-mem]');
  if (related) {
    memoriesState.selected.auto = Number(related.dataset.relatedMem);
    renderMemoryWorkspace();
    const heading = $('memDetail').querySelector('h3');
    heading.tabIndex = -1;
    heading.focus();
    return;
  }
  const action = e.target.closest('[data-mem-action]')?.dataset.memAction;
  const item = selectedMemory();
  if (!item) return;
  if (action === 'edit') openMemoryEditor(item);
  if (action === 'scope') void openMemoryScope(item);
  if (action === 'delete') void deleteMemory(item);
};
$('btnMemAdd').onclick = () => openMemoryEditor();
$('btnMemBack').onclick = $('btnMemCancel').onclick = () => closeMemoryEditor();
$('memEditorForm').onsubmit = (e) => { e.preventDefault(); void saveMemory(); };
$('btnMemHelp').onclick = () => $('memHelpDialog').showModal();
$('btnMemScopeClose').onclick = $('btnMemScopeCancel').onclick = () => $('memScopeDialog').close();
$('memScopeDialog').oncancel = (e) => { if (memoriesState.scope?.saving) e.preventDefault(); };
$('memScopeDialog').onclose = () => { if (!$('memScopeDialog').open) memoriesState.scope = null; };
$('memScopeForm').onsubmit = (e) => { e.preventDefault(); void saveMemoryScope(); };
$('memPersonaOptions').onchange = updateMemoryScope;
function switchTab(which) {
  if (which === 'model' || which === 'credentials') which = 'settings';
  if (which !== 'people' && dirty.people
    && !confirm('群成员档案有未保存的修改，确定离开这个页签？')) return;
  if (which !== 'settings' && (credentialsDirty || imageGenerationDirty) && !$('paneCredentials').hidden) {
    if (!confirm('密钥 / 生图页有未保存的修改，离开会丢弃这些修改并清空密钥输入，继续？')) return;
    clearCredentialInputs(); updateCredentialSaveButton();
    imageGenerationDirty = false; imageGenerationLoaded = false; updateImageGenerationControls();
  }
  document.body.classList.toggle('settings-mode', which === 'settings');
  document.body.classList.toggle('people-mode', which === 'people');
  if (which !== 'settings') { document.body.classList.remove('settings-model-keys', 'settings-connections'); }
  const names = { home: '总览', settings: '系统设置', persona: '人格设定', people: '群成员档案', memories: '私人记忆', interest: '群兴趣', gallery: '图库', events: '事件追踪', owners: '指令权限' };
  if ($('pageCrumb')) $('pageCrumb').textContent = names[which] || '总览';
  $('tabHome').classList.toggle('active', which === 'home');
  $('tabSettings').classList.toggle('active', which === 'settings');
  $('paneHome').hidden = which !== 'home';
  $('homeProfile').hidden = which !== 'home';
  $('staticProfile').hidden = which === 'home';
  $('paneSettingsHeader').hidden = which !== 'settings';
  if (which === 'settings') setSettingsSection('modelKeys');
  else { $('paneModel').hidden = true; $('paneCredentials').hidden = true; }
  $('tabPersona').classList.toggle('active', which === 'persona');
  $('tabPeople').classList.toggle('active', which === 'people');
  $('tabMemories').classList.toggle('active', which === 'memories');
  $('tabInterest').classList.toggle('active', which === 'interest');
  $('tabGallery').classList.toggle('active', which === 'gallery');
  $('tabEvents').classList.toggle('active', which === 'events');
  if (which !== 'settings') $('paneModel').hidden = true;
  $('panePersona').hidden = which !== 'persona';
  $('panePeople').hidden = which !== 'people';
  $('paneMemories').hidden = which !== 'memories';
  $('paneInterest').hidden = which !== 'interest';
  $('paneGallery').hidden = which !== 'gallery';
  $('paneEvents').hidden = which !== 'events';
  $('paneOwners').hidden = which !== 'owners';
  if (which === 'people' && !peopleLoaded) {
    void reloadPeopleArchive();
  }
  if (which === 'interest' && !interestState.loaded) {
    void loadInterestTab().catch((err) => {
      $('intDetailMsg').textContent = `读取群兴趣失败：${err.message}`;
    });
  }
  if (which === 'memories' && !memoriesState.edit) void loadMemoriesTab();
  if (which === 'events') void showEventsPage();
  if (which === 'gallery') {
    renderGalleryFilters();
    void loadGalleryAllow();
    if (!galleryLoaded) void loadGallery();
  }
}

$('btnSaveModel').onclick = () => saveModel();
$('btnSaveRestart').onclick = () => saveModel({ restart: true });
$('btnSavePersona').onclick = savePersonas;
$('btnSaveOwners').onclick = saveOwners;

// 指令权限：增删
$('ownerIds').onclick = (e) => {
  const btn = e.target.closest('button[data-rm-id]');
  if (!btn) return;
  ownersDraft.openids = ownersDraft.openids.filter((id) => id !== btn.dataset.rmId);
  markOwnersDirty();
};
$('ownerNames').onclick = (e) => {
  const btn = e.target.closest('button[data-rm-name]');
  if (!btn) return;
  ownersDraft.names = ownersDraft.names.filter((n) => n !== btn.dataset.rmName);
  markOwnersDirty();
};
$('peoplePool').onclick = (e) => {
  const btn = e.target.closest('button[data-person]');
  if (!btn) return;
  addOwnerPerson(btn.dataset.person);
};
const bindAdd = (inputId, buttonId, apply) => {
  const submit = () => {
    const el = $(inputId);
    const value = el.value.trim();
    if (!value) return;
    apply(value);
    el.value = '';
  };
  $(buttonId).onclick = submit;
  $(inputId).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
};
bindAdd('newOwnerId', 'addOwnerId', (value) => {
  if (!ownersDraft.openids.includes(value)) ownersDraft.openids.push(value);
  markOwnersDirty();
});
bindAdd('newOwnerName', 'addOwnerName', (value) => {
  if (!ownersDraft.names.includes(value)) ownersDraft.names.push(value);
  markOwnersDirty();
});
$('btnRestart').onclick = restartBot;
$('btnReload').onclick = () => {
  if ((dirty.model || dirty.personas || dirty.owners || dirty.people || credentialsDirty || imageGenerationDirty) && !confirm('有未保存的改动，重新读取会丢弃它们，继续？')) return;
  clearCredentialInputs(); updateCredentialSaveButton();
  imageGenerationDirty = false;
  if (!$('paneCredentials').hidden) { void loadCredentials(); void loadImageGenerationSettings(); }
  else { imageGenerationLoaded = false; updateImageGenerationControls(); }
  load();
};

window.addEventListener('beforeunload', (e) => {
  if (dirty.model || dirty.personas || dirty.owners || dirty.people || credentialsDirty || imageGenerationDirty) { e.preventDefault(); e.returnValue = ''; }
});

function renderSettingsConcept() {
  const model = modelDraft || {}, body = $('settingsConcept'); if (!body) return;
  const key = (name) => credentialsState?.keys?.[name];
  const state = (name) => key(name)?.configured
    ? `<span class="sc-status">${key(name).source === 'environment' ? '已配置 · 环境变量' : '已配置 · 本地'}</span>`
    : `<span class="sc-status off">${credentialsBusy ? '读取中' : credentialsState ? '未配置' : '状态未知'}</span>`;
  body.innerHTML = `<div class="sc-label sc-label-first">当前使用</div><div class="sc-grid">
      <article class="sc-card active" data-detail="reply"><div class="sc-top"><h3>回复模型</h3><div class="sc-card-tools"><span class="sc-status">运行中</span><button class="sc-help" type="button" data-concept-help="reply" aria-label="回复模型说明">?</button></div></div><p>${esc(model.provider || '未选择')} / ${esc(model.model || '未选择')}</p><div class="sc-foot"><span>推理强度：${esc(model.reasoningEffort || '默认')}</span><span>进入配置 →</span></div></article>
      <article class="sc-card" data-detail="judge"><div class="sc-top"><h3>判断模型</h3><div class="sc-card-tools">${state('XIANGXIN_API_KEY')}<button class="sc-help" type="button" data-concept-help="judge" aria-label="判断模型说明">?</button></div></div><p>象信 AI · xiangxin-latest</p><div class="sc-foot"><span>回复门控 · 记忆门控 · 分类</span><span>进入选择 →</span></div></article></div>
    <div class="sc-label">模型服务商</div><div class="sc-list">
      <div class="sc-row"><div class="sc-logo">D</div><div><strong>DeepSeek</strong><small>API 地址、模型与 API Key</small></div><div class="right">${state('DEEPSEEK_API_KEY')}<button data-detail="provider:DeepSeek">配置</button><button data-delete-provider="DeepSeek">删除</button></div></div>
      <div class="sc-row"><div class="sc-logo">O</div><div><strong>OpenAI</strong><small>API 地址、模型与 API Key</small></div><div class="right">${state('OPENAI_API_KEY')}<button data-detail="provider:OpenAI">配置</button><button data-delete-provider="OpenAI">删除</button></div></div>
      <div class="sc-row"><div class="sc-logo">X</div><div><strong>象信 AI</strong><small>判断模型与 API Key</small></div><div class="right">${state('XIANGXIN_API_KEY')}<button data-detail="provider:象信 AI">配置</button><button data-delete-provider="象信 AI">删除</button></div></div>
      <div class="sc-add" data-detail="provider:add">＋ 添加服务商</div></div>`;
  body.querySelectorAll('[data-detail]').forEach(el => el.onclick = e => { if (e.target.closest('[data-concept-help],[data-delete-provider]')) return; openSettingsDetail(el.dataset.detail === 'judge' ? '判断模型' : el.dataset.detail === 'reply' ? '回复模型' : el.dataset.detail === 'provider:add' ? '添加服务商' : '模型服务商设置', el.dataset.detail); });
  body.querySelectorAll('[data-delete-provider]').forEach(el => el.onclick = async e => { e.stopPropagation(); if (!confirm(`清除 ${el.dataset.deleteProvider} 在面板保存的密钥副本？DSH 全局凭据和环境变量不会被删除。`)) return; const keys={DeepSeek:'DEEPSEEK_API_KEY',OpenAI:'OPENAI_API_KEY','象信 AI':'XIANGXIN_API_KEY'}; try { const result=await api('/api/credentials',{method:'PUT',body:JSON.stringify({values:{},remove:[keys[el.dataset.deleteProvider]]})}); credentialsState=result; toast(result.keys[keys[el.dataset.deleteProvider]].configured ? '面板副本已清除，其他来源的凭据仍已配置' : '面板凭据已清除', 'ok'); renderSettingsConcept(); } catch(err){ toast(`删除失败：${err.message}`,'err'); } });
  body.querySelectorAll('[data-concept-help]').forEach(el => el.onclick = e => { e.stopPropagation(); openConceptHelp(el.dataset.conceptHelp); });
}
function renderConnectionsConcept() {
  const body = $('settingsConcept'); if (!body) return;
  body.innerHTML = `<div class="sc-label sc-label-first">核心连接</div><div class="sc-grid"><article class="sc-card" data-detail="qq"><div class="sc-top"><h3>QQ 机器人</h3><span class="sc-status">连接配置</span></div><p>AppID、Client Secret 与登录连接。</p><div class="sc-foot"><span>必需</span><span>进入配置 →</span></div></article></div><div class="sc-label">可选能力</div><div class="sc-grid"><article class="sc-card" data-detail="image"><div class="sc-top"><h3>生图服务</h3><span class="sc-status">可选</span></div><p>开关、模型、尺寸与超时。</p><div class="sc-foot"><span>独立配置</span><span>进入配置 →</span></div></article><article class="sc-card" data-detail="tts"><div class="sc-top"><h3>语音合成</h3><span class="sc-status">可选</span></div><p>服务顺序与每个服务的参数。</p><div class="sc-foot"><span>三级配置</span><span>进入配置 →</span></div></article></div>`;
  body.querySelectorAll('[data-detail]').forEach(el => el.onclick = () => openSettingsDetail(el.textContent.includes('QQ') ? 'QQ 机器人连接' : el.textContent.includes('生图') ? '生图服务' : '语音合成', el.dataset.detail));
  body.querySelectorAll('[data-concept-help]').forEach(el => el.onclick = () => openConceptHelp(el.dataset.conceptHelp));
}
function providerEditor(provider, add = false) {
  const defaults = { DeepSeek: 'DEEPSEEK_API_KEY', OpenAI: 'OPENAI_API_KEY', '象信 AI': 'XIANGXIN_API_KEY' };
  const credential = credentialsState?.keys?.[defaults[provider]];
  const credentialNote = credential?.configured ? '已配置 · 已有值不回显' : credential ? '没有检测到凭据' : '凭据状态未知';
  return `<div class="sc-segment"><button class="active" data-provider-mode="catalog">第三方模型提供商</button><button data-provider-mode="custom">自定义模型 API</button></div><div class="provider-panel" data-provider-panel="catalog"><p class="hint">从目录选择服务商，API 地址、协议、模型目录和凭据可独立配置。</p><label>提供商<select id="providerName"><option>${esc(provider || 'OpenAI')}</option><option>Anthropic</option><option>Kimi</option><option>DeepSeek</option><option>Amazon Bedrock</option></select></label><label>API 地址 / Base URL<input id="providerBaseUrl" placeholder="https://api.example.com/v1"></label><label>API 密钥 <button class="sc-help inline-help" data-concept-help="provider">?</button><input id="providerApiKey" type="password" placeholder="留空使用环境认证"></label><label>默认模型<input id="providerDefaultModel" placeholder="例如 deepseek-chat"></label><p class="warn-text">${credentialNote}</p><div class="sc-collapse">自定义设置　›</div></div><div class="provider-panel" data-provider-panel="custom" hidden><p class="hint">连接中转站、自部署服务或兼容 OpenAI / Anthropic / Gemini 的接口。</p><label>Provider ID<input id="customProviderId" placeholder="acme-gateway"></label><label>显示名称<input id="customProviderLabel" placeholder="自定义服务"></label><label>API 地址<input id="customProviderBaseUrl" placeholder="https://gateway.example/v1"></label><label>API 协议<select id="customProviderProtocol"><option>OpenAI Chat Completions</option><option>Anthropic Messages</option><option>Gemini</option></select></label><label>API 密钥<input id="customProviderKey" type="password" placeholder="输入 API 密钥"></label><div class="sc-collapse">模型目录 <button class="small" type="button">获取可用模型</button><div class="empty">暂无模型目录，可直接填写模型 ID。</div><button class="small" type="button">＋ 添加模型</button></div></div><div class="sc-actions"><button class="small" id="providerCancel">取消</button><button class="small primary" id="providerSave">${add ? '添加服务商' : '保存服务商'}</button><span class="msg" id="providerMsg"></span></div>`;
}
function bindProviderEditor(provider, add) {
  const body = $('settingsDetailBody');
  body.querySelectorAll('[data-provider-mode]').forEach(btn => btn.onclick = () => { body.querySelectorAll('[data-provider-mode]').forEach(x=>x.classList.toggle('active', x===btn)); body.querySelectorAll('[data-provider-panel]').forEach(x=>x.hidden=x.dataset.providerPanel!==btn.dataset.providerMode); });
  body.querySelectorAll('[data-concept-help]').forEach(el => el.onclick = e => { e.stopPropagation(); openConceptHelp(el.dataset.conceptHelp); });
  $('providerCancel').onclick = closeSettingsDetail;
  $('providerSave').onclick = async () => { const p = body.querySelector('[data-provider-panel]:not([hidden])'); const key = provider === 'DeepSeek' ? 'DEEPSEEK_API_KEY' : provider === 'OpenAI' ? 'OPENAI_API_KEY' : provider === '象信 AI' ? 'XIANGXIN_API_KEY' : null; const value = p?.querySelector('#providerApiKey')?.value.trim() || p?.querySelector('#customProviderKey')?.value.trim(); try { const settings=await api('/api/provider-settings',{method:'PUT',body:JSON.stringify({provider:provider==='add'?(p?.querySelector('#providerName')?.value||'custom-provider'):provider,baseUrl:p?.querySelector('#providerBaseUrl')?.value||p?.querySelector('#customProviderBaseUrl')?.value,label:p?.querySelector('#customProviderLabel')?.value||provider,defaultModel:p?.querySelector('#providerDefaultModel')?.value,protocol:p?.querySelector('#customProviderProtocol')?.value})}); if (key && value) { const result=await api('/api/credentials',{method:'PUT',body:JSON.stringify({values:{[key]:value},remove:[]})}); credentialsState=result; } toast('服务商配置已保存','ok'); closeSettingsDetail(); } catch(err){ $('providerMsg').textContent=err.message; } };
}
function renderJudgeDetail(body) {
  body.innerHTML = `<form id="judgeForm" autocomplete="off">
    <div class="detail-section"><h3>判断模型</h3><label>模型<select><option>象信 AI · xiangxin-latest</option></select></label>
    <div id="judgeStatus" role="status"></div>
    <label id="judgeKeyField" hidden>象信 API Key<input id="judgeKey" type="password" maxlength="8192" autocomplete="off"></label></div>
    <div class="sc-actions"><button class="small" type="button" id="judgeClose">关闭</button><button class="small primary" id="judgeSave" disabled>保存凭据</button></div>
    </form>`;
  const form = $('judgeForm'), save = $('judgeSave'), status = $('judgeStatus');
  const key = $('judgeKey'), field = $('judgeKeyField');
  function update() {
    const credential = credentialsState?.keys?.XIANGXIN_API_KEY;
    const configured = credential?.configured;
    status.className = `sc-status${configured ? '' : ' off'}`;
    status.textContent = configured ? `已配置 · ${credential.source === 'dsh' ? 'DSH 全局凭据' : credential.source === 'local' ? '本地凭据' : '环境变量'}`
      : credential ? '未配置 API Key' : '无法读取凭据状态';
    field.hidden = save.hidden = !credential || configured;
    save.disabled = !key.value.trim();
  }
  $('judgeClose').onclick = closeSettingsDetail;
  key.oninput = () => { save.disabled = !key.value.trim(); };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (save.hidden || save.disabled) return;
    const value = key.value.trim();
    key.value = '';
    save.disabled = true;
    key.disabled = true;
    status.textContent = '保存中…';
    try {
      const result = await api('/api/credentials', { method: 'PUT', body: JSON.stringify({ values: { XIANGXIN_API_KEY: value } }) });
      showCredentialStatus(result);
      credentialsState = result;
      if (document.body.classList.contains('settings-model-keys')) renderSettingsConcept();
      if (form.isConnected) update();
      toast('象信凭据已保存，按现有启动流程重启后生效', 'ok');
    } catch {
      if (form.isConnected) status.textContent = '保存失败，请重新输入后重试';
    } finally { key.disabled = false; }
  };
  if (credentialsState && !credentialsBusy) update();
  else {
    status.textContent = '读取凭据状态…';
    void api('/api/credentials', { cache: 'no-store' }).then((result) => {
      showCredentialStatus(result);
      credentialsState = result;
      if (form.isConnected) update();
    }).catch(() => { if (form.isConnected) status.textContent = '无法读取凭据状态，请重试'; });
  }
}
function openSettingsDetail(title, kind) {
  $('settingsDetailTitle').textContent = title; const body=$('settingsDetailBody'); body.innerHTML=''; const modal=$('settingsDetailModal'); modal.querySelector('.sc-modal-box').dataset.detailKind = kind; modal.classList.add('show');
  if (kind === 'reply') { body.innerHTML = `<div class="detail-section"><h3>选择回复引擎 <button class="sc-help inline-help" data-concept-help="reply">?</button></h3><div class="detail-grid"><label>服务商<select id="detailProvider">${(OV?.providers||[]).map(p=>`<option>${esc(p)}</option>`).join('')}</select></label><label>模型<select id="detailModel"></select></label></div></div><div class="detail-section"><h3>推理强度 <button class="sc-help inline-help" data-concept-help="reasoning">?</button></h3><label>默认强度<select id="detailEffort"><option>off</option><option>low</option><option>medium</option><option>high</option><option>max</option></select></label></div><div class="sc-actions"><button class="small" id="detailCancel">取消</button><button class="small primary" id="detailSave">保存模型</button><span class="msg" id="detailMsg"></span></div>`; const p=$('detailProvider'),m=$('detailModel'),e=$('detailEffort'); p.value=modelDraft.provider; e.value=modelDraft.reasoningEffort||'low'; const fill=()=>{const route=routeOf(p.value);m.innerHTML=(route?.models||[]).map(x=>`<option value="${esc(x.id)}">${esc(x.id)} — ${esc(x.name)}</option>`).join('');m.value=modelDraft.model}; fill();p.onchange=fill; $('detailCancel').onclick=closeSettingsDetail; $('detailSave').onclick=async()=>{modelDraft.provider=p.value;modelDraft.model=m.value;modelDraft.reasoningEffort=e.value;dirty.model=true;closeSettingsDetail();await saveModel();}; }
  else if (kind === 'judge') { renderJudgeDetail(body); }
  else if (kind.startsWith('provider:')) { const provider=kind.slice(9); body.innerHTML=providerEditor(provider,provider==='add'); bindProviderEditor(provider,provider==='add'); }
  else if (kind === 'qq') { const source=$('paneCredentials'); settingsDetailSource=source;settingsDetailParent=source.parentNode;settingsDetailNext=source.nextSibling;body.appendChild(source);source.hidden=false;source.style.display='block'; }
  else if (kind === 'image' || kind === 'tts') { const source=$('paneCredentials'); settingsDetailSource=source;settingsDetailParent=source.parentNode;settingsDetailNext=source.nextSibling;body.appendChild(source);source.hidden=false;source.style.display='block'; if(kind==='image'){ $('credentialsForm').style.display='none';$('ttsForm').style.display='none'; } else {$('credentialsForm').style.display='none';$('imageGenerationForm').style.display='none';} }
  body.querySelectorAll('[data-concept-help]').forEach(el=>el.onclick=e=>{e.stopPropagation();openConceptHelp(el.dataset.conceptHelp);});
}
function openConceptHelp(kind) { $('settingsDetailTitle').textContent = kind==='judge'?'判断模型说明':kind==='reasoning'?'推理强度说明':kind==='reply'?'回复模型说明':kind==='provider'?'服务商配置说明':kind==='connections'?'连接模块说明':'系统设置说明'; $('settingsDetailBody').innerHTML=`<p class="hint">${kind==='judge'?'判断模型只负责回复门控、记忆门控和分类，不生成最终回复。':kind==='reasoning'?'不同模型支持的推理档位不同，请以服务商能力为准。':kind==='reply'?'这里选择机器人生成最终回复所使用的服务商和模型。':kind==='provider'?'API 地址、协议、模型目录和密钥都可以独立配置；密钥不会回显。':kind==='connections'?'QQ 是必需连接，生图和语音是可选能力。':kind==='tts'?'语音合成按服务顺序依次尝试，单个服务失败时自动降级到下一个；具体服务参数请点击对应卡片配置。':kind==='image'?'生图默认关闭，只有明确的生图请求才会调用所选服务；模型、尺寸、质量和超时请在配置页中调整。':'当前设置项的帮助说明。'}</p>`; $('settingsDetailModal').classList.add('show'); }
let settingsDetailSource=null,settingsDetailParent=null,settingsDetailNext=null;
let settingsSection = 'modelKeys';
let settingsUtilitySourceParent = null;
let settingsUtilitySourceNext = null;

function closeSettingsUtility() {
  const source = $('paneOwners');
  if (settingsUtilitySourceParent) {
    source.hidden = true;
    source.classList.remove('settings-utility-owned');
    settingsUtilitySourceParent.insertBefore(source, settingsUtilitySourceNext && settingsUtilitySourceNext.parentNode === settingsUtilitySourceParent ? settingsUtilitySourceNext : null);
    settingsUtilitySourceParent = null;
    settingsUtilitySourceNext = null;
  }
  $('settingsThemePanel').hidden = true;
  $('settingsOwnersPanel').hidden = true;
  $('settingsUtilityModal').classList.remove('show');
}

function openSettingsUtility(kind) {
  const modal = $('settingsUtilityModal');
  const theme = $('settingsThemePanel');
  const owners = $('settingsOwnersPanel');
  const source = $('paneOwners');
  theme.hidden = kind !== 'theme';
  owners.hidden = kind !== 'owners';
  $('settingsUtilityTitle').textContent = kind === 'owners' ? '权限管理' : '界面配色';
  if (kind === 'owners') {
    if (!settingsUtilitySourceParent) {
      settingsUtilitySourceParent = source.parentNode;
      settingsUtilitySourceNext = source.nextSibling;
    }
    owners.appendChild(source);
    source.hidden = false;
    source.classList.add('settings-utility-owned');
    renderOwners();
  }
  modal.classList.add('show');
}
function closeSettingsDetail(){if(settingsDetailSource&&settingsDetailParent){settingsDetailSource.hidden=true;settingsDetailSource.style.display='';settingsDetailParent.insertBefore(settingsDetailSource,settingsDetailNext&&settingsDetailNext.parentNode===settingsDetailParent?settingsDetailNext:null);settingsDetailSource=null;settingsDetailParent=null;settingsDetailNext=null;} const box=$('settingsDetailModal').querySelector('.sc-modal-box'); delete box.dataset.detailKind; $('settingsDetailModal').classList.remove('show'); if(settingsSection==='connections') renderConnectionsConcept(); else renderSettingsConcept();}
function setSettingsSection(section = 'modelKeys') {
  settingsSection = section;
  const modelKeys = section === 'modelKeys';
  if (modelKeys) renderSettingsConcept(); else renderConnectionsConcept();
  document.body.classList.toggle('settings-model-keys', modelKeys);
  document.body.classList.toggle('settings-connections', !modelKeys);
  $('paneModel').hidden = true;
  $('paneCredentials').hidden = true;
  document.querySelectorAll('[data-settings-anchor]').forEach((el) => el.classList.toggle('active', el.dataset.settingsAnchor === section));
  if (!credentialsLoaded) void loadCredentials();
  if (!imageGenerationLoaded) void loadImageGenerationSettings();
}
$('settingsDetailClose').onclick = closeSettingsDetail;
$('settingsUtilityClose').onclick = closeSettingsUtility;
$('settingsUtilityModal').onclick = (e) => { if (e.target.id === 'settingsUtilityModal') closeSettingsUtility(); };
$('ttsProviderClose').onclick = closeTtsProviderEditor;
$('ttsProviderModal').onclick = (e) => { if (e.target.id === 'ttsProviderModal') closeTtsProviderEditor(); };
$('settingsDetailModal').onclick = (e) => { if (e.target.id === 'settingsDetailModal') closeSettingsDetail(); };

document.querySelectorAll('[data-settings-anchor]').forEach((el) => {
  el.onclick = () => setSettingsSection(el.dataset.settingsAnchor);
});
function initHomeDisplayName() {
  const key = 'qqbot-home-display-name', defaultName = 'Icewind';
  const dialog = $('homeNameDialog'), input = $('homeNameInput');
  let name = defaultName;
  try { name = localStorage.getItem(key)?.trim().slice(0, input.maxLength) || defaultName; } catch {}
  const render = () => {
    $('homeHeaderName').textContent = $('homeGreetingName').textContent = name;
    $('homeNameAvatar').textContent = Array.from(name)[0].toUpperCase();
  };
  render();
  $('homeNameButton').onclick = () => {
    input.setCustomValidity('');
    input.value = name;
    dialog.showModal();
    input.select();
  };
  input.oninput = () => input.setCustomValidity('');
  $('homeNameDefault').onclick = () => {
    input.value = defaultName;
    input.setCustomValidity('');
    input.focus();
  };
  $('homeNameCancel').onclick = () => dialog.close();
  $('homeNameForm').onsubmit = (event) => {
    event.preventDefault();
    const next = input.value.trim();
    if (!next) {
      input.setCustomValidity('请输入显示名称');
      input.reportValidity();
      return;
    }
    name = next;
    try { localStorage.setItem(key, name); } catch {}
    render();
    dialog.close();
  };
}
initPalette();
load();
startDashboardRefresh();
$('btnHealthRefresh').onclick = () => void loadDashboard();
initHomeDisplayName();
switchTab('home');
$('btnDashboardEvents').onclick = () => switchTab('events');
$('btnDashboardAllEvents').onclick = () => switchTab('events');
document.querySelectorAll('[data-dashboard-tab]').forEach((el) => { el.onclick = () => switchTab(el.dataset.dashboardTab); });
// 页面常开时也要能看到模型状态变化（出错/恢复）
setInterval(() => { if (!document.hidden) void refreshBot(); }, 30000);

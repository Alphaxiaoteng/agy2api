let catalogCache = null;
let catalogFilter = { provider: 'all', kind: 'all', q: '' };

function catalogAuthHeader() {
  const token = (() => {
    try {
      return localStorage.getItem('authToken') || document.cookie.match(/authToken=([^;]+)/)?.[1] || '';
    } catch {
      return '';
    }
  })();
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  return headers;
}

function probeMap(probes = []) {
  const map = {};
  for (const p of probes) map[p.providerId] = p;
  return map;
}

function renderCatalogProviders(data) {
  const root = document.getElementById('catalogProviders');
  if (!root) return;
  const probes = probeMap(data.probes || []);
  root.innerHTML = (data.providers || []).map((p) => {
    const probe = probes[p.id] || {};
    let probeClass = 'skip';
    let probeText = '未探测';
    if (probe.skipped) {
      probeClass = 'skip';
      probeText = '已禁用';
    } else if (probe.ok) {
      probeClass = 'ok';
      probeText = `在线 · ${probe.modelCount ?? '-'} · ${probe.ms || 0}ms`;
    } else if (probe.error) {
      probeClass = 'bad';
      probeText = `离线 · ${probe.error}`;
    }
    const endpoint = p.baseURL || (p.host ? `${p.host}:${p.port || ''}` : '—');
    return `<div class="catalog-provider">
      <div class="name">${escapeHtml(p.name || p.id)}</div>
      <div class="meta">${escapeHtml(p.id)} · ${escapeHtml(String(p.modelCount || 0))} 模型</div>
      <div class="meta">${escapeHtml(endpoint)}</div>
      <div class="probe ${probeClass}">${escapeHtml(probeText)}</div>
    </div>`;
  }).join('');
}

function filteredModels(data) {
  const q = (catalogFilter.q || '').trim().toLowerCase();
  return (data.models || []).filter((m) => {
    if (catalogFilter.provider !== 'all' && m.providerId !== catalogFilter.provider) return false;
    if (catalogFilter.kind !== 'all' && m.kind !== catalogFilter.kind) return false;
    if (!q) return true;
    const hay = `${m.ref || ''} ${m.name || ''} ${m.id || ''} ${m.family || ''}`.toLowerCase();
    return hay.includes(q);
  });
}

function renderCatalogTable(data) {
  const tbody = document.getElementById('catalogTableBody');
  if (!tbody) return;
  const rows = filteredModels(data);
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6">没有匹配的模型</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((m) => {
    const pills = [
      `<span class="catalog-pill ${escapeHtml(m.kind)}">${escapeHtml(m.kind)}</span>`,
      `<span class="catalog-pill ${escapeHtml(m.family)}">${escapeHtml(m.family)}</span>`
    ];
    if (m.gatewayLive === true) pills.push('<span class="catalog-pill">gateway live</span>');
    if (m.gatewayLive === false) pills.push('<span class="catalog-pill">declared only</span>');
    if (m.source === 'agy-live') pills.push('<span class="catalog-pill">agy extra</span>');
    return `<tr>
      <td class="catalog-ref">${escapeHtml(m.ref || m.id)}</td>
      <td>${escapeHtml(m.name || m.id)}</td>
      <td>${escapeHtml(m.providerName || m.providerId || '')}</td>
      <td>${pills.join('')}</td>
      <td>${escapeHtml(m.host ? `${m.host}:${m.port || ''}` : (m.baseURL || '—'))}</td>
      <td>${m.limit?.context ? escapeHtml(String(m.limit.context)) : '—'}</td>
    </tr>`;
  }).join('');
}

function fillCatalogFilters(data) {
  const select = document.getElementById('catalogProviderFilter');
  if (!select) return;
  const current = catalogFilter.provider;
  const options = ['<option value="all">全部 Provider</option>']
    .concat((data.providers || []).map((p) =>
      `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || p.id)}</option>`
    ));
  select.innerHTML = options.join('');
  select.value = current;
}

function renderCatalogSummary(data) {
  const meta = document.getElementById('catalogMeta');
  const stats = document.getElementById('catalogStats');
  if (meta) {
    const src = data.source?.path || '';
    const gw = data.gateway
      ? `${data.gateway.publicHost || data.gateway.host}:${data.gateway.publicPort || data.gateway.port}`
      : '';
    meta.textContent = `OpenCode: ${src} · 对外 ${gw} · 默认 ${data.source?.defaultModel || '—'} · small ${data.source?.smallModel || '—'}`;
  }
  if (stats) {
    const t = data.totals || {};
    stats.innerHTML = `
      <span class="catalog-stat"><b>${t.providers || 0}</b> Provider</span>
      <span class="catalog-stat"><b>${t.models || 0}</b> 模型</span>
      <span class="catalog-stat"><b>${t.chat || 0}</b> 对话</span>
      <span class="catalog-stat"><b>${t.image || 0}</b> 图片</span>
      <span class="catalog-stat"><b>${(t.byFamily && t.byFamily.gpt) || 0}</b> GPT</span>
      <span class="catalog-stat"><b>${(t.byFamily && t.byFamily.gemini) || 0}</b> Gemini</span>
    `;
  }
}

async function loadCatalog(forceProbe = true) {
  const status = document.getElementById('catalogLoadStatus');
  if (status) status.textContent = '加载中…';
  try {
    const res = await fetch(`/admin/catalog?probe=${forceProbe ? '1' : '0'}`, {
      headers: catalogAuthHeader()
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.message || ('HTTP ' + res.status));
    catalogCache = data.data;
    renderCatalogSummary(catalogCache);
    fillCatalogFilters(catalogCache);
    renderCatalogProviders(catalogCache);
    renderCatalogTable(catalogCache);
    if (status) status.textContent = `已更新 · ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    if (status) status.textContent = '失败: ' + error.message;
    if (typeof showToast === 'function') showToast(error.message, 'error');
  }
}

function onCatalogFilterChange() {
  catalogFilter.provider = document.getElementById('catalogProviderFilter')?.value || 'all';
  catalogFilter.kind = document.getElementById('catalogKindFilter')?.value || 'all';
  catalogFilter.q = document.getElementById('catalogSearch')?.value || '';
  if (catalogCache) renderCatalogTable(catalogCache);
}

function initCatalogPage() {
  loadCatalog(true);
}

window.initCatalogPage = initCatalogPage;
window.loadCatalog = loadCatalog;
window.onCatalogFilterChange = onCatalogFilterChange;

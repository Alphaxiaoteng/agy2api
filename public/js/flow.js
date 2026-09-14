/**
 * Google Flow API 能力管理页
 * 纯只读监控与 API 端点文档，绝不执行真实生成
 */

let flowStatusLoading = false;

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * 加载管理端只读状态
 * @param {boolean} manual 是否手动刷新
 */
async function loadFlowAdminStatus(manual = false) {
  if (flowStatusLoading) return;
  flowStatusLoading = true;

  const lastUpdatedEl = document.getElementById('flowLastUpdated');
  if (lastUpdatedEl && manual) {
    lastUpdatedEl.textContent = '正在刷新状态...';
  }

  try {
    const res = await fetch('/admin/flow/status', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const json = await res.json();
    if (!json.success || !json.data) {
      throw new Error(json.message || '获取状态数据失败');
    }

    const { queue, models, accountBridge } = json.data;

    // 1. 更新队列指标
    if (queue) {
      const concurrencyEl = document.getElementById('flowConcurrency');
      const activeEl = document.getElementById('flowActiveCount');
      const queuedEl = document.getElementById('flowQueuedCount');
      const completedEl = document.getElementById('flowCompletedCount');

      if (concurrencyEl) concurrencyEl.textContent = queue.concurrency ?? 1;
      if (activeEl) activeEl.textContent = queue.activeCount ?? 0;
      if (queuedEl) queuedEl.textContent = `${queue.queuedCount ?? 0} / ${queue.maxQueue ?? 10}`;
      if (completedEl) completedEl.textContent = queue.totalCompleted ?? 0;
    }

    // 2. 更新模型矩阵表格
    if (Array.isArray(models)) {
      renderFlowModelsTable(models);
    }
    renderFlowAccounts(accountBridge);

    // 3. 更新最后更新时间
    if (lastUpdatedEl) {
      const now = new Date();
      lastUpdatedEl.textContent = `已连接 · ${now.toLocaleTimeString()}`;
    }

    if (manual && typeof showToast === 'function') {
      showToast('Flow 状态已刷新', 'success');
    }
  } catch (err) {
    if (lastUpdatedEl) {
      lastUpdatedEl.textContent = `连接异常 (${err.message})`;
    }
    if (manual && typeof showToast === 'function') {
      showToast(`刷新失败: ${err.message}`, 'error');
    }
  } finally {
    flowStatusLoading = false;
  }
}

function renderFlowAccounts(bridge) {
  const status = document.getElementById('flowAccountBridgeStatus');
  const list = document.getElementById('flowAccountsList');
  if (!status || !list) return;
  if (!bridge?.configured) {
    status.textContent = '未配置 Alpha Nexus transport token · 使用默认 ego-browser 登录态';
    list.innerHTML = '<span class="flow-account-empty">固定 Space: <code>flow-default</code> · 单标签复用</span>';
    return;
  }
  const accounts = Array.isArray(bridge.accounts) ? bridge.accounts : [];
  status.textContent = `已连接 Alpha Nexus · ${accounts.length} 个可用隔离身份`;
  if (!accounts.length) {
    list.innerHTML = '<span class="flow-account-empty">暂无 enabled + logged_in 的账号身份</span>';
    return;
  }
  list.innerHTML = accounts.map(account => `
    <span class="flow-account-chip">
      <strong>${escapeHtml(account.name)}</strong>
      <code>account_id=${Number(account.account_id)}</code>
      ${account.space_id ? `<span>Space ${Number(account.space_id)}</span>` : '<span>Space 待创建</span>'}
    </span>
  `).join('');
}

/**
 * 渲染模型矩阵表格
 * @param {Array} models 
 */
function renderFlowModelsTable(models) {
  const tbody = document.getElementById('flowModelsTableBody');
  if (!tbody) return;

  if (!models || models.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--muted);">暂无可用模型数据</td></tr>';
    return;
  }

  tbody.innerHTML = models.map(m => {
    const typePill = m.type === 'video'
      ? '<span class="flow-type-pill video">视频</span>'
      : '<span class="flow-type-pill image">图像</span>';

    const ratios = (m.supported_aspect_ratios || []).map(r => `<code>${escapeHtml(r)}</code>`).join(' ');
    const counts = (m.supported_counts || []).join(', ');
    
    let modeDurationText = '-';
    if (m.type === 'video') {
      const modes = (m.supported_modes || []).join(', ');
      const durations = m.allows_duration && m.supported_durations?.length
        ? m.supported_durations.map(d => `${d}s`).join('/')
        : '默认 6s';
      modeDurationText = `模式: [${modes}] · 时长: [${durations}]`;
    }

    return `
      <tr>
        <td><strong>${escapeHtml(m.display_name || m.id)}</strong></td>
        <td><code>${escapeHtml(m.id)}</code></td>
        <td>${typePill}</td>
        <td>${ratios || '-'}</td>
        <td><code>${counts || '1'}</code></td>
        <td style="color:var(--muted); font-size:11px;">${escapeHtml(modeDurationText)}</td>
      </tr>
    `;
  }).join('');
}

/**
 * 打开官方 Flow Web 页面（直接跳转官方，不走本地 /fx 反代）
 */
function openOfficialFlow() {
  window.open('https://labs.google/fx/zh/tools/flow/', '_blank', 'noopener,noreferrer');
}

/**
 * 复制指定端点的 cURL 示例
 * @param {'image'|'video'} type 
 */
async function copyFlowCurl(type) {
  const codeElId = type === 'image' ? 'curlImageCode' : 'curlVideoCode';
  const codeEl = document.getElementById(codeElId);
  if (!codeEl) return;

  const text = codeEl.textContent || codeEl.innerText;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    if (typeof showToast === 'function') {
      showToast(`${type === 'image' ? '图像' : '视频'} cURL 示例已复制到剪贴板`, 'success');
    }
  } catch (err) {
    if (typeof showToast === 'function') {
      showToast(`复制失败: ${err.message}`, 'error');
    }
  }
}

/**
 * 初始化 Flow 管理页面
 */
function initFlowPage() {
  loadFlowAdminStatus(false);
}

// 挂载到全局 window 对象供 HTML inline 事件与 switchTab 调用
window.initFlowPage = initFlowPage;
window.loadFlowAdminStatus = loadFlowAdminStatus;
window.openOfficialFlow = openOfficialFlow;
window.copyFlowCurl = copyFlowCurl;

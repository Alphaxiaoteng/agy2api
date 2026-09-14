// IP封禁管理

async function loadBlockedIPs() {
  try {
    const response = await authFetch('/admin/blocked-ips');
    
    if (!response.ok) throw new Error('获取封禁列表失败');
    
    const data = await response.json();
    renderBlockedIPs(data.data);
  } catch (error) {
    console.error('加载封禁列表失败:', error);
    showToast('加载封禁列表失败', 'error');
  }
}

function renderBlockedIPs(blockedIPs) {
  const container = document.getElementById('blockedIPsList');
  
  if (!blockedIPs || blockedIPs.length === 0) {
    container.innerHTML = '<div class="empty-state-small">暂无封禁IP</div>';
    return;
  }
  
  container.innerHTML = blockedIPs.map(item => {
    const isPermanent = item.permanent;
    const expiresAt = item.expiresAt ? new Date(item.expiresAt).toLocaleString('zh-CN') : '';
    const tempBlockCount = item.tempBlockCount || 0;
    
    return `
      <div class="blocked-ip-item ${isPermanent ? 'permanent' : 'temporary'}">
        <div class="blocked-ip-header">
          <span class="blocked-ip-address">${item.ip}</span>
          <span class="blocked-ip-type ${isPermanent ? 'permanent' : 'temporary'}">
            ${isPermanent ? '永久封禁' : '临时封禁'}
          </span>
        </div>
        <div class="blocked-ip-info">
          ${!isPermanent && expiresAt ? `<div>⏰ 解封时间: ${expiresAt}</div>` : ''}
          <div>🔢 累计封禁: ${tempBlockCount} 次</div>
        </div>
        <div class="blocked-ip-actions">
          <button class="btn btn-sm btn-warning" onclick="unblockIP('${item.ip}')">
            🔓 解除封禁
          </button>
        </div>
      </div>
    `;
  }).join('');
}

async function unblockIP(ip) {
  if (!confirm(`确定要解除 ${ip} 的封禁吗？`)) return;
  
  try {
    const response = await authFetch('/admin/unblock-ip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip })
    });
    
    const data = await response.json();
    
    if (data.success) {
      showToast(data.message || 'IP已解除封禁', 'success');
      loadBlockedIPs();
    } else {
      showToast(data.message || '解除封禁失败', 'error');
    }
  } catch (error) {
    console.error('解除封禁失败:', error);
    showToast('解除封禁失败', 'error');
  }
}

// 白名单管理
async function loadWhitelistIPs() {
  try {
    const response = await authFetch('/admin/security-config');
    const data = await response.json();
    
    if (data.success) {
      // 更新临时列表
      tempWhitelistIPs = [...(data.data.whitelist.ips || [])];
      renderWhitelistIPs(tempWhitelistIPs);
      
      // 更新封禁开关状态
      const checkbox = document.getElementById('blockingEnabled');
      if (checkbox) checkbox.checked = data.data.blocking.enabled;
    }
  } catch (error) {
    console.error('加载白名单失败:', error);
  }
}

function renderWhitelistIPs(ips) {
  const container = document.getElementById('whitelistIPsList');
  
  if (!ips || ips.length === 0) {
    container.innerHTML = '<div class="empty-state-small">暂无白名单IP</div>';
    return;
  }
  
  container.innerHTML = ips.map(ip => `
    <div class="whitelist-ip-tag">
      <span>${ip}</span>
      <button onclick="removeWhitelistIP('${ip}')" title="移除">✕</button>
    </div>
  `).join('');
}

// 临时存储白名单IP列表（未保存状态）
let tempWhitelistIPs = [];

function addWhitelistIP() {
  const input = document.getElementById('whitelistIPInput');
  const ip = input.value.trim();
  
  if (!ip) {
    showToast('请输入IP地址', 'warning');
    return;
  }
  
  // 简单的IP格式验证
  const ipPattern = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
  if (!ipPattern.test(ip)) {
    showToast('IP地址格式不正确', 'warning');
    return;
  }
  
  // 检查是否已存在
  if (tempWhitelistIPs.includes(ip)) {
    showToast('该IP已在白名单中', 'warning');
    return;
  }
  
  // 添加到临时列表
  tempWhitelistIPs.push(ip);
  input.value = '';
  
  // 更新显示
  renderWhitelistIPs(tempWhitelistIPs);
  //showToast('已添加，请点击保存配置按钮保存', 'info');
}

function removeWhitelistIP(ip) {
  // 从临时列表中移除
  tempWhitelistIPs = tempWhitelistIPs.filter(item => item !== ip);
  
  // 更新显示
  renderWhitelistIPs(tempWhitelistIPs);
  //showToast('已移除，请点击保存配置按钮保存', 'info');
}

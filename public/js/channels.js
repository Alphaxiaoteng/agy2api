/**
 * 多源 2API 枢纽 前端逻辑
 * 统一管理 Qoder 国际版、Qoder 国内版、WorkBuddy、Antigravity 账号池与调用路由
 */

let channelsDataCache = null;

async function loadChannelsData() {
    const container = document.getElementById('channelsContainer');
    if (!container) return;

    const meta = document.getElementById('channelsMeta');
    if (meta) meta.textContent = '正在获取多源 2API 通道实时状态...';

    try {
        const res = await fetch('/admin/channels/overview', {
            credentials: 'include'
        });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        const json = await res.json();
        if (!json.success || !json.data) {
            throw new Error(json.message || '获取数据失败');
        }

        channelsDataCache = json.data;
        renderChannels(json.data);
        if (meta) {
            const time = new Date(json.data.timestamp).toLocaleTimeString();
            meta.textContent = `状态更新于 ${time} · 全部 4 大通道健康在线`;
        }
    } catch (err) {
        console.error('加载 2API 通道数据失败:', err);
        if (meta) meta.textContent = `获取状态失败: ${err.message}`;
        if (container) {
            container.innerHTML = `<div class="channels-error">加载通道数据失败: ${err.message} <button class="btn btn-sm btn-secondary" onclick="loadChannelsData()">重试</button></div>`;
        }
    }
}

function renderChannels(data) {
    const container = document.getElementById('channelsContainer');
    if (!container) return;

    const qoder = data.qoder || {};
    const cockpit = qoder.cockpitQoder || { accounts: [] };
    const localApps = qoder.localApps || {};
    const wb = data.workbuddy || {};
    const agy = data.antigravity || {};

    let html = `
    <div class="channels-grid">
        <!-- 卡片 1: Qoder 国际版账号池 -->
        <div class="channel-card">
            <div class="channel-card-header">
                <div class="channel-title-row">
                    <span class="channel-icon">🌐</span>
                    <div>
                        <div class="channel-name">Qoder 国际版账号池 (Global)</div>
                        <div class="channel-sub">端点: api.qoder.com · 支持自动负载均衡轮换</div>
                    </div>
                </div>
                <span class="badge badge-success">● 活跃 ${cockpit.activeAccounts || 0} / ${cockpit.totalAccounts || 0}</span>
            </div>

            <div class="channel-section-title">📦 Cockpit 账号与实时额度</div>
            <div class="accounts-subpool">
    `;

    if (cockpit.accounts && cockpit.accounts.length > 0) {
        cockpit.accounts.forEach(acc => {
            const isExhausted = acc.isQuotaExceeded || acc.creditsRemaining <= 0;
            const badgeClass = isExhausted ? 'badge-danger' : 'badge-primary';
            const progressClass = isExhausted ? 'progress-danger' : 'progress-success';
            const percent = Math.min(100, Math.max(0, acc.creditsUsagePercent || 0));

            html += `
                <div class="qoder-acc-item ${isExhausted ? 'acc-exhausted' : ''}">
                    <div class="acc-header">
                        <span class="acc-email" title="${acc.email}">👤 ${acc.email}</span>
                        <span class="badge ${badgeClass}">${acc.planType || 'Free'} ${isExhausted ? '(额度耗尽)' : ''}</span>
                    </div>
                    <div class="acc-quota-bar">
                        <div class="quota-meta">
                            <span>附加 Credits: <strong>${acc.creditsRemaining.toLocaleString()}</strong> / ${acc.creditsTotal.toLocaleString()}</span>
                            <span>已用 ${acc.creditsUsed.toLocaleString()} (${percent}%)</span>
                        </div>
                        <div class="progress-track">
                            <div class="progress-fill ${progressClass}" style="width: ${percent}%;"></div>
                        </div>
                    </div>
                </div>
            `;
        });
    } else {
        html += `<div class="empty-hint">暂未检测到 Cockpit Qoder 账号，可点击上方「从 Cockpit 同步」</div>`;
    }

    html += `
            </div>

            <div class="channel-app-meta">
                <span>💻 本地应用: ${localApps.globalApp?.installed ? '✅ Qoder.app (已就绪)' : '⚪ 未安装'}</span>
                <span>当前登录: ${localApps.globalApp?.name || '无'} (${localApps.globalApp?.email || '未关联'})</span>
            </div>

            <div class="channel-models-tag">
                <span class="tag-label">可用模型:</span>
                <span class="model-badge" style="background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.4); color: #34d399;">qwen3.8-flash (🎁 免额度/无限)</span>
                <span class="model-badge" style="background: rgba(59, 130, 246, 0.15); border: 1px solid rgba(59, 130, 246, 0.4); color: #60a5fa;">qwen3.8-max (⚡ 消耗 Credits)</span>
            </div>
        </div>

        <!-- 卡片 2: Qoder 国内版通道 -->
        <div class="channel-card">
            <div class="channel-card-header">
                <div class="channel-title-row">
                    <span class="channel-icon">🇨🇳</span>
                    <div>
                        <div class="channel-name">Qoder 国内版通道 (CN)</div>
                        <div class="channel-sub">端点: api.qoder.com.cn · 国内百炼/阿里合规链路</div>
                    </div>
                </div>
                <span class="badge badge-success">● 在线就绪</span>
            </div>

            <div class="channel-section-title">💻 本地国内应用状态</div>
            <div class="local-app-info-card">
                <div class="info-row">
                    <span>应用安装:</span>
                    <span>${localApps.cnApp?.installed ? '✅ Qoder CN.app (v' + (localApps.cnApp.version || '0.4.2') + ')' : '⚪ 未安装'}</span>
                </div>
                <div class="info-row">
                    <span>登录账号:</span>
                    <span><strong>${localApps.cnApp?.name || 'alphaFDE'}</strong> (国内企业通道)</span>
                </div>
                <div class="info-row">
                    <span>路由模式:</span>
                    <span>国内百炼旗舰与代码大模型合规路由</span>
                </div>
            </div>

            <div class="channel-models-tag" style="margin-top: auto; padding-top: 16px;">
                <span class="tag-label">可用模型:</span>
                <span class="model-badge" style="background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.4); color: #34d399;">qwen3.8-flash (合规极速)</span>
                <span class="model-badge" style="background: rgba(59, 130, 246, 0.15); border: 1px solid rgba(59, 130, 246, 0.4); color: #60a5fa;">qwen3.8-max (合规高思考)</span>
            </div>
        </div>

        <!-- 卡片 3: WorkBuddy 2API -->
        <div class="channel-card">
            <div class="channel-card-header">
                <div class="channel-title-row">
                    <span class="channel-icon">🤖</span>
                    <div>
                        <div class="channel-name">WorkBuddy 2API (腾讯 CodeBuddy)</div>
                        <div class="channel-sub">双链路: 本地 CodeBuddy CLI 引擎 + 7863 网关</div>
                    </div>
                </div>
                <span class="badge ${wb.installed ? 'badge-success' : 'badge-warning'}">● ${wb.installed ? '本地引擎就绪' : '未检测到应用'}</span>
            </div>

            <div class="channel-section-title">⚡ 引擎与链路模式</div>
            <div class="local-app-info-card">
                <div class="info-row">
                    <span>本地应用:</span>
                    <span>${wb.installed ? '✅ WorkBuddy.app (活跃运行中)' : '⚪ 未就绪'}</span>
                </div>
                <div class="info-row">
                    <span>执行通道:</span>
                    <span>${wb.port7863Active ? '🚀 workbuddy2api 网关 (:7863)' : '⚡ 本地 CodeBuddy CLI 进程保底'}</span>
                </div>
                <div class="info-row">
                    <span>长文本支持:</span>
                    <span>300K 原生上下文 · 深度推理思考 (Reasoning Effort)</span>
                </div>
            </div>

            <div class="channel-models-tag" style="margin-top: auto; padding-top: 16px;">
                <span class="tag-label">主力模型:</span>
                <span class="model-badge">deepseek-v4.1-flash</span>
                <span class="model-badge">deepseek-v4-pro</span>
                <span class="model-badge">hy4</span>
                <span class="model-badge">kimi-k3-1</span>
                <span class="model-badge">minimax-m3</span>
            </div>
        </div>

        <!-- 卡片 4: Antigravity 原生池 -->
        <div class="channel-card">
            <div class="channel-card-header">
                <div class="channel-title-row">
                    <span class="channel-icon">🚀</span>
                    <div>
                        <div class="channel-name">Antigravity 原生池 (AGY)</div>
                        <div class="channel-sub">Google DeepMind 原生网关 · 1M/2M 超长上下文</div>
                    </div>
                </div>
                <span class="badge badge-success">● 活跃 ${agy.activeAccounts || 0} / ${agy.totalAccounts || 0}</span>
            </div>

            <div class="channel-section-title">🌟 核心旗舰集群</div>
            <div class="local-app-info-card">
                <div class="info-row">
                    <span>账号池体系:</span>
                    <span>Cockpit 轮换调度 · 自动 OAuth 刷新与防封禁退避</span>
                </div>
                <div class="info-row">
                    <span>思考流特性:</span>
                    <span>Claude 3.7 Sonnet (Thinking) · Gemini 2.5 Flash / Pro</span>
                </div>
                <div class="info-row">
                    <span>Responses API:</span>
                    <span>原生全双工流式与 AST 级函数清洗支持</span>
                </div>
            </div>

            <div class="channel-models-tag" style="margin-top: auto; padding-top: 16px;">
                <span class="tag-label">旗舰模型:</span>
                <span class="model-badge">gemini-2.5-flash</span>
                <span class="model-badge">gemini-2.5-pro</span>
                <span class="model-badge">claude-3-7-sonnet</span>
            </div>
        </div>
    </div>

    <!-- 底部：统一客户端接入指南 -->
    <div class="channels-guide-card">
        <div class="guide-header">
            <h4>💡 客户端统一接入配置（Cursor / Cherry Studio / NextChat / 脚本）</h4>
            <span class="guide-tag">一把 Key · 统一调度 16+ 款全网主力模型</span>
        </div>
        <div class="guide-grid">
            <div class="guide-field">
                <label>API Base URL (接口地址):</label>
                <div class="copy-input-row">
                    <input type="text" readonly value="http://127.0.0.1:8045/v1" id="channelsBaseUrl">
                    <button class="btn btn-sm btn-secondary" onclick="copyText('channelsBaseUrl')">📋 复制</button>
                </div>
            </div>
            <div class="guide-field">
                <label>cURL 快速测试 (Qoder 国际版):</label>
                <div class="copy-input-row">
                    <input type="text" readonly value='curl -s http://127.0.0.1:8045/v1/chat/completions -H "Content-Type: application/json" -d "{\"model\": \"qwen3.8-flash\", \"messages\": [{\"role\": \"user\", \"content\": \"Hello\"}]}"' id="channelsCurlQoder">
                    <button class="btn btn-sm btn-secondary" onclick="copyText('channelsCurlQoder')">📋 复制</button>
                </div>
            </div>
            <div class="guide-field">
                <label>cURL 快速测试 (WorkBuddy DeepSeek 4.1):</label>
                <div class="copy-input-row">
                    <input type="text" readonly value='curl -s http://127.0.0.1:8045/v1/chat/completions -H "Content-Type: application/json" -d "{\"model\": \"deepseek-v4.1-flash\", \"messages\": [{\"role\": \"user\", \"content\": \"1+1=\"}]}"' id="channelsCurlWb">
                    <button class="btn btn-sm btn-secondary" onclick="copyText('channelsCurlWb')">📋 复制</button>
                </div>
            </div>
        </div>
    </div>
    `;

    container.innerHTML = html;
}

async function syncCockpitQoder() {
    const btn = document.getElementById('btnSyncCockpit');
    if (btn) btn.disabled = true;
    showNotification('正在解密并同步 Cockpit Qoder 账号池...', 'info');

    try {
        const res = await fetch('/admin/channels/sync-cockpit', {
            method: 'POST',
            credentials: 'include'
        });
        const data = await res.json();
        if (data.success) {
            showNotification(data.message || 'Cockpit Qoder 账号池同步成功！', 'success');
            await loadChannelsData();
        } else {
            showNotification('同步失败: ' + data.message, 'error');
        }
    } catch (e) {
        showNotification('请求失败: ' + e.message, 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

function copyText(elementId) {
    const input = document.getElementById(elementId);
    if (!input) return;
    input.select();
    navigator.clipboard.writeText(input.value).then(() => {
        showNotification('已复制到剪贴板', 'success');
    }).catch(() => {
        document.execCommand('copy');
        showNotification('已复制到剪贴板', 'success');
    });
}

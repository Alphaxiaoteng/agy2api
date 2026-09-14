// 认证相关：登录、登出、OAuth

// 不再使用 localStorage 存储 token，改用 HttpOnly Cookie
let isLoggedIn = false;

// 封装fetch，自动处理401，使用 credentials: 'include' 发送 Cookie
const authFetch = async (url, options = {}) => {
    const response = await fetch(url, {
        ...options,
        credentials: 'include'
    });
    if (response.status === 401) {
        silentLogout();
        showToast('登录已过期，请重新登录', 'warning');
        throw new Error('Unauthorized');
    }
    return response;
};

function showMainContent() {
    isLoggedIn = true;
    document.documentElement.classList.add('logged-in');
    document.getElementById('loginForm').classList.add('hidden');
    document.getElementById('mainContent').classList.remove('hidden');
}

function silentLogout() {
    isLoggedIn = false;
    // 清除旧版本的 localStorage token（如果存在）
    localStorage.removeItem('authToken');
    document.documentElement.classList.remove('logged-in');
    document.getElementById('loginForm').classList.remove('hidden');
    document.getElementById('mainContent').classList.add('hidden');
}

async function logout() {
    const confirmed = await showConfirm('确定要退出登录吗？', '退出确认');
    if (!confirmed) return;

    try {
        // 调用后端登出接口清除 Cookie
        await fetch('/admin/logout', {
            method: 'POST',
            credentials: 'include'
        });
    } catch (e) {
        // 忽略错误
    }

    silentLogout();
    showToast('已退出登录', 'info');
}

function showOAuthModal() {
    const modal = document.createElement('div');
    modal.className = 'modal form-modal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-title">🔐 OAuth授权登录</div>
            <div class="oauth-steps">
                <p><strong>📝 授权流程：</strong></p>
                <p>1️⃣ 点击下方按钮打开Google授权页面</p>
                <p>2️⃣ 完成授权后等待本页面确认结果</p>
            </div>
            <button type="button" onclick="startOAuthFlow(this)" class="btn btn-success">🔐 打开授权页面</button>
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">取消</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
}

async function startOAuthFlow(button) {
    button.disabled = true;
    showLoading('正在启动授权...');
    try {
        const response = await authFetch('/admin/oauth/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'antigravity' }) });
        const result = await response.json();
        if (!result.success) throw new Error(result.message || '启动失败');
        const flow = result.data;
        window.open(flow.authUrl, '_blank', 'noopener');
        await pollOAuthStatus(flow.id);
    } catch (error) {
        showToast('OAuth启动失败: ' + error.message, 'error');
    } finally {
        hideLoading();
        button.disabled = false;
    }
}

async function pollOAuthStatus(flowId) {
    for (let attempt = 0; attempt < 120; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const response = await authFetch(`/admin/oauth/status/${encodeURIComponent(flowId)}`);
        const result = await response.json();
        const status = result.data;
        if (status.status === 'success') {
            document.querySelector('.form-modal')?.remove();
            showToast(status.message || 'Token添加成功', 'success');
            loadTokens();
            return;
        }
        if (status.status === 'failed' || status.status === 'not_found') throw new Error(status.message || 'OAuth失败');
    }
    throw new Error('OAuth等待超时');
}

// 检查登录状态（通过尝试访问需要认证的接口）
async function checkLoginStatus() {
    try {
        const response = await fetch('/admin/tokens', {
            credentials: 'include'
        });
        if (response.status === 200) return true;
        if (response.status === 401) {
            // 本机免登录：自动登录一次
            const loginRes = await fetch('/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ username: '', password: '' })
            });
            if (loginRes.ok) return true;
        }
        return false;
    } catch (e) {
        return false;
    }
}

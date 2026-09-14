/**
 * Options script for Flow API Bridge
 */

import { DEFAULT_CONFIG, validateBridgeWsUrl } from './config.js';

function showToast(message, isSuccess = true) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = isSuccess ? 'success' : 'error';
  setTimeout(() => {
    toast.style.display = 'none';
    toast.className = '';
  }, 3000);
  toast.style.display = 'block';
}

async function loadSettings() {
  const data = await chrome.storage.local.get(['bridgeWsUrl', 'flowExtensionToken', 'clientId', 'accountLabel']);
  document.getElementById('bridgeWsUrl').value = data.bridgeWsUrl || DEFAULT_CONFIG.BRIDGE_WS_URL;
  document.getElementById('flowExtensionToken').value = data.flowExtensionToken || '';
  document.getElementById('clientId').value = data.clientId || '';
  const labelEl = document.getElementById('accountLabel');
  if (labelEl) {
    labelEl.value = data.accountLabel || '';
  }
  refreshStatus();
}

async function saveSettings() {
  const bridgeWsUrl = document.getElementById('bridgeWsUrl').value.trim() || DEFAULT_CONFIG.BRIDGE_WS_URL;
  const flowExtensionToken = document.getElementById('flowExtensionToken').value.trim();
  const clientId = document.getElementById('clientId').value.trim();
  const labelEl = document.getElementById('accountLabel');
  const accountLabel = labelEl ? labelEl.value.trim() : '';

  // Validate clientId format if provided
  if (clientId && !/^[a-zA-Z0-9_-]{1,64}$/.test(clientId)) {
    showToast('Client ID must only contain letters, numbers, hyphens, and underscores (max 64 chars)', false);
    return;
  }

  // Validate accountLabel if provided (1..64 safe characters)
  if (accountLabel && (accountLabel.length > 64 || !/^[\w\s.\u4e00-\u9fa5-]+$/i.test(accountLabel))) {
    showToast('Account label contains invalid characters or exceeds 64 chars', false);
    return;
  }

  // Validate Bridge WebSocket URL with strict security rules
  const valResult = validateBridgeWsUrl(bridgeWsUrl);
  if (!valResult.valid) {
    showToast(`Invalid Bridge URL: ${valResult.error}`, false);
    return;
  }

  const updates = {
    bridgeWsUrl,
    flowExtensionToken,
    accountLabel: accountLabel.slice(0, 64),
  };
  if (clientId) {
    updates.clientId = clientId;
  }

  await chrome.storage.local.set(updates);

  // Notify background service worker to reconnect
  chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED' }, (response) => {
    showToast('Settings saved & reconnecting bridge');
    setTimeout(refreshStatus, 1000);
  });
}

function refreshStatus() {
  chrome.runtime.sendMessage({ type: 'GET_EXTENSION_STATUS' }, (res) => {
    if (chrome.runtime.lastError || !res) {
      document.getElementById('statusConnected').textContent = 'Offline';
      document.getElementById('statusConnected').className = 'status-val bad';
      return;
    }

    const connEl = document.getElementById('statusConnected');
    if (res.connected) {
      connEl.textContent = 'Connected (' + (res.state || 'idle') + ')';
      connEl.className = 'status-val ok';
    } else {
      connEl.textContent = 'Disconnected';
      connEl.className = 'status-val bad';
    }

    const tokenEl = document.getElementById('statusToken');
    if (res.tokenPresent) {
      const ageMinutes = res.tokenAgeMs ? Math.round(res.tokenAgeMs / 60000) : 0;
      tokenEl.textContent = `Present (in-memory, age: ${ageMinutes}m)`;
      tokenEl.className = 'status-val ok';
    } else {
      tokenEl.textContent = 'Not present (open labs.google/fx/tools/flow to capture)';
      tokenEl.className = 'status-val bad';
    }

    const apiKeyEl = document.getElementById('statusApiKey');
    if (apiKeyEl) {
      if (res.apiKeyPresent) {
        apiKeyEl.textContent = 'Captured (in-memory)';
        apiKeyEl.className = 'status-val ok';
      } else {
        apiKeyEl.textContent = 'Not Captured (open Flow page)';
        apiKeyEl.className = 'status-val bad';
      }
    }

    const projEl = document.getElementById('statusProjectId');
    projEl.textContent = res.projectId || 'None discovered yet';
  });
}

document.getElementById('btnSave').addEventListener('click', saveSettings);
document.getElementById('btnReconnect').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'RECONNECT_BRIDGE' }, () => {
    showToast('Reconnect requested');
    setTimeout(refreshStatus, 800);
  });
});

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  setInterval(refreshStatus, 3000);
});

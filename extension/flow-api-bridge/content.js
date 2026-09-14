/**
 * Content Script - Flow API Bridge
 *
 * Runs in isolated world on https://labs.google/fx/tools/flow*
 * Injects injected.js into MAIN world to access window.grecaptcha and projectId discovery.
 * Validates window event types with strict prefix checking.
 */
if (!globalThis.__FLOW_API_BRIDGE_CONTENT_LOADED__) {
  globalThis.__FLOW_API_BRIDGE_CONTENT_LOADED__ = true;

  const EVENT_PREFIX = '__FLOW_BRIDGE_';

  // Inject injected.js into the main execution world
  (function injectMainScript() {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('injected.js');
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  })();

  // Listen for discovered projectId from injected.js
  window.addEventListener(EVENT_PREFIX + 'PROJECT_DISCOVERED', (event) => {
    const projectId = event.detail?.projectId;
    if (projectId && typeof projectId === 'string') {
      chrome.runtime.sendMessage({
        type: 'FLOW_PROJECT_DISCOVERED',
        projectId,
      }).catch(() => {});
    }
  });

  // Relay CAPTCHA requests from background.js to injected.js
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    if (msg?.type !== 'SOLVE_CAPTCHA') return;

    const { requestId, pageAction } = msg;
    if (!requestId) {
      sendResponse({ error: 'MISSING_REQUEST_ID' });
      return;
    }

    const handler = (e) => {
      if (e.detail?.requestId === requestId) {
        window.removeEventListener(EVENT_PREFIX + 'CAPTCHA_RESULT', handler);
        clearTimeout(timer);
        sendResponse({
          token: e.detail.token || null,
          error: e.detail.error || null,
        });
      }
    };

    const timer = setTimeout(() => {
      window.removeEventListener(EVENT_PREFIX + 'CAPTCHA_RESULT', handler);
      sendResponse({ error: 'CONTENT_CAPTCHA_TIMEOUT' });
    }, 25000);

    window.addEventListener(EVENT_PREFIX + 'CAPTCHA_RESULT', handler);

    window.dispatchEvent(new CustomEvent(EVENT_PREFIX + 'GET_CAPTCHA', {
      detail: { requestId, pageAction: pageAction || 'IMAGE_GENERATION' },
    }));

    return true; // Keep message channel open for async response
  });
}

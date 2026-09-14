/**
 * Injected into MAIN world on https://labs.google/*
 *
 * Responsibilities:
 * 1. Solves grecaptcha enterprise tokens when requested via window custom events.
 * 2. Extracts Flow projectId from URLs/location and dispatches PROJECT_DISCOVERED.
 * 3. NEVER handles, intercepts or dispatches Bearer tokens via CustomEvents.
 * 4. NEVER logs tokens, never writes cookies, never communicates with external tracking.
 */
(() => {
  if (window.__FLOW_API_BRIDGE_MAIN_INJECTED__) return;
  window.__FLOW_API_BRIDGE_MAIN_INJECTED__ = true;

  const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
  const EVENT_PREFIX = '__FLOW_BRIDGE_';

  // Helper to safely extract projectId from URL string or query parameters
  function extractProjectIdFromUrl(urlString) {
    if (!urlString || typeof urlString !== 'string') return null;
    // Pattern 1: /fx/tools/flow/projects/{uuid} or /v1/projects/{uuid}
    const match = urlString.match(/\/(?:projects|project)\/([0-9a-fA-F-]{8,64})/i);
    if (match) return match[1];
    // Pattern 2: URL query param projectId=...
    try {
      const url = new URL(urlString, window.location.origin);
      const qp = url.searchParams.get('projectId') || url.searchParams.get('project_id');
      if (qp && /^[0-9a-fA-F-]{8,64}$/.test(qp)) return qp;
    } catch (_) {}
    return null;
  }

  // Intercept window.fetch only to capture project ID
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    try {
      const resource = args[0];
      let urlString = '';
      if (typeof resource === 'string') {
        urlString = resource;
      } else if (resource && typeof resource.url === 'string') {
        urlString = resource.url;
      }

      // Check URL for projectId
      const pId = extractProjectIdFromUrl(urlString) || extractProjectIdFromUrl(window.location.href);
      if (pId) {
        window.dispatchEvent(new CustomEvent(EVENT_PREFIX + 'PROJECT_DISCOVERED', {
          detail: { projectId: pId }
        }));
      }
    } catch (_) {
      // Ignore interception errors to not disrupt host page
    }

    return originalFetch.apply(this, args);
  };

  // Intercept XMLHttpRequest only to capture project ID
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__flow_url = url;
    const pId = extractProjectIdFromUrl(url) || extractProjectIdFromUrl(window.location.href);
    if (pId) {
      window.dispatchEvent(new CustomEvent(EVENT_PREFIX + 'PROJECT_DISCOVERED', {
        detail: { projectId: pId }
      }));
    }
    return originalXhrOpen.call(this, method, url, ...rest);
  };

  // Initial check on current page location
  const initialPid = extractProjectIdFromUrl(window.location.href);
  if (initialPid) {
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent(EVENT_PREFIX + 'PROJECT_DISCOVERED', {
        detail: { projectId: initialPid }
      }));
    }, 500);
  }

  const ALLOWED_CAPTCHA_ACTIONS = new Set([
    'IMAGE_GENERATION',
    'VIDEO_GENERATION',
  ]);

  // Handle reCAPTCHA execution requests
  window.addEventListener(EVENT_PREFIX + 'GET_CAPTCHA', async (event) => {
    const detail = event.detail || {};
    const { requestId, pageAction } = detail;
    if (!requestId) return;

    if (!pageAction || typeof pageAction !== 'string' || !ALLOWED_CAPTCHA_ACTIONS.has(pageAction.trim())) {
      window.dispatchEvent(new CustomEvent(EVENT_PREFIX + 'CAPTCHA_RESULT', {
        detail: { requestId, error: `DISALLOWED_CAPTCHA_ACTION: ${pageAction}` },
      }));
      return;
    }

    try {
      await waitForGrecaptcha();
      const token = await window.grecaptcha.enterprise.execute(SITE_KEY, {
        action: pageAction.trim(),
      });
      window.dispatchEvent(new CustomEvent(EVENT_PREFIX + 'CAPTCHA_RESULT', {
        detail: { requestId, token },
      }));
    } catch (err) {
      window.dispatchEvent(new CustomEvent(EVENT_PREFIX + 'CAPTCHA_RESULT', {
        detail: { requestId, error: err?.message || 'CAPTCHA_EXECUTE_FAILED' },
      }));
    }
  });

  function waitForGrecaptcha(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      if (window.grecaptcha?.enterprise?.execute) return resolve();
      const start = Date.now();
      const timer = setInterval(() => {
        if (window.grecaptcha?.enterprise?.execute) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          reject(new Error('GRECAPTCHA_ENTERPRISE_NOT_READY'));
        }
      }, 100);
    });
  }
})();

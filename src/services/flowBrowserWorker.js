/**
 * Google Flow Browser Worker
 * 职责：
 * 1. 构建确定性 Worker 状态机驱动 official Flow：
 *    acquire taskspace -> open official Flow -> login check -> create fresh project ->
 *    collect baseline asset edit hrefs -> set media type -> set video submode ->
 *    set exact model displayName -> set aspect -> set duration only when capability supported ->
 *    set count (n) -> verify active values -> upload local asset IDs or return 501 ->
 *    fill Slate prompt (focus + selectAll + Input.insertText) & verify ->
 *    locate submit -> mark FLOW_EVENT submitted -> click submit ->
 *    wait new edit hrefs not in baseline (count >= n) & wait loading disappear ->
 *    open each new detail URL -> click download via CDP -> wait size stability & infer MIME -> output metadata.
 * 2. 避免 Base64：通过 CDP Browser.setDownloadBehavior / Page.setDownloadBehavior 直接落盘；若不可用抛出 flow_download_transport_unavailable。
 * 3. 错误与状态协议：stdout 输出 FLOW_EVENT:{json} 与最终 FLOW_RESULT:{json}，父进程实时解析并更新 storage manifest。
 * 4. 每个 Alpha identity 复用持久 Space；默认模式复用 flow-default。每个 Space 最多保留一个 Flow 标签。
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const EGO_BROWSER_BIN = process.env.EGO_BROWSER_BIN || path.join(os.homedir(), '.local/bin/ego-browser');
export const MAX_WORKER_TIMEOUT_MS = 600000; // 10 minutes hard timeout
export const MAX_BUFFER_SIZE_BYTES = 5 * 1024 * 1024; // 5MB stdout/stderr buffer limit

/**
 * 构造注入到 ego-browser nodejs 会话的完整状态机工作脚本
 */
export function buildWorkerScript(job, targetDir) {
  const { jobId, type, params } = job;
  const serializedConfig = JSON.stringify({
    jobId,
    type,
    modelId: params.model,
    displayName: params.displayName,
    prompt: params.prompt,
    aspect: params.aspect,
    count: params.count,
    mode: params.mode,
    duration: params.duration,
    inputAssetIds: params.inputAssetIds || [],
    accountId: params.accountId || null,
    identityId: params.identityId || null,
    spaceId: params.spaceId || null,
    taskId: params.taskId || '',
    targetDir
  });

  return `
(async () => {
  const config = ${serializedConfig};
  const taskSpaceRef = config.spaceId || 'flow-default';
  const results = [];
  let currentTask = null;

  try {
    cliLog('[Worker] Acquiring persistent Flow Space');
    cliLog('FLOW_EVENT:' + JSON.stringify({ type: 'configuring', jobId: config.jobId, timestamp: new Date().toISOString() }));
    const spaces = await listTaskSpaces();
    const existingSpace = (spaces || []).find(item => config.spaceId
      ? Number(item.id) === Number(config.spaceId)
      : item.name === 'flow-default' || item.taskId === 'flow-default');
    if (config.spaceId && !existingSpace) {
      throw new Error('flow_account_space_missing: Alpha Nexus Space is not available in ego-browser');
    }
    if (existingSpace && (existingSpace.ownership === 'user' || existingSpace.ownership === 'agentDelegatedToUser')) {
      const takeover = await takeOverTaskSpace(existingSpace.id);
      if (takeover && takeover.done === false) throw new Error('flow_account_space_unavailable: Could not take over account Space');
      currentTask = existingSpace;
    } else {
      currentTask = await useOrCreateTaskSpace(config.spaceId ? Number(config.spaceId) : 'flow-default');
    }

    // 1. 每个账号 Space 只保留一个 Flow 标签，并持续复用
    cliLog('[Worker] Reusing the single Flow tab...');
    const tabs = await listTabs();
    const flowTabs = (tabs || []).filter(tab => {
      try { return new URL(tab.url || '').hostname === 'labs.google'; } catch (_) { return false; }
    });
    const keepTab = flowTabs[0] || null;
    for (const tab of tabs || []) {
      const tabId = tab.targetId ?? tab.id;
      const keepId = keepTab ? (keepTab.targetId ?? keepTab.id) : null;
      if (!keepTab || tabId !== keepId) {
        try { await closeTab(tabId); } catch (_) {}
      }
    }
    if (keepTab) {
      await switchTab(keepTab.targetId ?? keepTab.id);
      await gotoAndWait('https://labs.google/fx/zh/tools/flow', { timeout: 45 });
    } else {
      await openOrReuseTab('https://labs.google/fx/zh/tools/flow', { wait: true, timeout: 45 });
    }
    await wait(3);

    // 2. 检查是否在登录页或受限页
    cliLog('[Worker] Checking authentication status...');
    const authState = await js(String.raw\`(() => {
      const isLoginInput = !!document.querySelector('input[type="email"]');
      const isLoginLink = !!document.querySelector('a[href*="accounts.google.com"]');
      const hasCreateBtn = !!Array.from(document.querySelectorAll('button, a')).find(el => {
        const t = (el.innerText || el.getAttribute('aria-label') || '').trim();
        return t.includes('新建') || t.includes('New project') || t.includes('创建') || t.includes('New');
      });
      const hasExistingProjects = !!document.querySelector('a[href*="/project/"], div[data-project-id]');
      return {
        isLogin: (isLoginInput || isLoginLink) && !hasCreateBtn && !hasExistingProjects,
        url: window.location.href
      };
    })()\`);

    if (authState.isLogin) {
      throw new Error('flow_auth_required: Google Flow is not authenticated in browser session');
    }

    // 3. 点击新建项目并进入项目画布
    cliLog('[Worker] Creating fresh project...');
    const createResult = await js(String.raw\`(() => {
      const buttons = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
      const newBtn = buttons.find(el => {
        const t = (el.innerText || el.getAttribute('aria-label') || '').trim();
        return t === '新建项目' || t === '新建' || t === 'New project' || t === 'New Project' || t === '创建项目' || t === 'Create project' || t.includes('新建项目') || t.includes('New project');
      });
      if (newBtn) {
        newBtn.click();
        return { clicked: true };
      }
      return { clicked: false };
    })()\`);

    if (!createResult.clicked) {
      throw new Error('flow_project_creation_failed: Could not locate New Project button');
    }

    await wait(4);
    const projectInfo = await js(String.raw\`(() => {
      const url = window.location.href;
      const inProject = url.includes('/project/');
      return { url, inProject };
    })()\`);

    if (!projectInfo.inProject) {
      throw new Error('flow_project_creation_failed: Could not enter fresh project canvas (URL: ' + projectInfo.url + ')');
    }
    cliLog('[Worker] Successfully entered project canvas: ' + projectInfo.url);

    // 等待 DOM / Network 稳定后再采集 baseline，进行两次采样对比
    await wait(2);
    cliLog('[Worker] Collecting baseline asset edit hrefs with dual sampling...');
    let baselineSample1 = await js(String.raw\`(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/project/"][href*="/edit/"]'));
      return links.map(a => a.href || a.getAttribute('href')).filter(Boolean);
    })()\`);
    await wait(1.5);
    let baselineSample2 = await js(String.raw\`(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/project/"][href*="/edit/"]'));
      return links.map(a => a.href || a.getAttribute('href')).filter(Boolean);
    })()\`);
    const baselineEditHrefs = Array.from(new Set([...(baselineSample1 || []), ...(baselineSample2 || [])]));
    cliLog('[Worker] Baseline asset count: ' + baselineEditHrefs.length);

    // 5. 设置媒体类型 (IMAGE / VIDEO)
    cliLog('[Worker] Setting media type: ' + config.type);
    const setMediaTypeResult = await js(String.raw\`((type) => {
      const targetSuffix = type === 'image' ? '-trigger-IMAGE' : '-trigger-VIDEO';
      let tab = document.querySelector('[id$="' + targetSuffix + '"]');
      if (!tab) {
        const tabs = Array.from(document.querySelectorAll('[role="tab"], button'));
        tab = tabs.find(el => {
          const id = el.id || '';
          const t = (el.innerText || el.getAttribute('aria-label') || '').toUpperCase();
          return id.endsWith(targetSuffix) || (type === 'image' && (t.includes('IMAGE') || t.includes('图片') || t.includes('图像'))) || (type === 'video' && (t.includes('VIDEO') || t.includes('视频')));
        });
      }
      if (!tab) return { error: 'Media type tab not found for ' + type };
      const isActive = tab.getAttribute('data-state') === 'active' || tab.getAttribute('aria-selected') === 'true';
      if (!isActive) tab.click();
      return { success: true };
    })(\${JSON.stringify(config.type)})\`);

    if (setMediaTypeResult.error) {
      throw new Error('flow_ui_contract_changed: ' + setMediaTypeResult.error);
    }
    await wait(0.5);

    const mediaTypeActive = await js(String.raw\`((type) => {
      const targetSuffix = type === 'image' ? '-trigger-IMAGE' : '-trigger-VIDEO';
      let tab = document.querySelector('[id$="' + targetSuffix + '"]');
      if (!tab) {
        const tabs = Array.from(document.querySelectorAll('[role="tab"], button'));
        tab = tabs.find(el => {
          const id = el.id || '';
          const t = (el.innerText || el.getAttribute('aria-label') || '').toUpperCase();
          return id.endsWith(targetSuffix) || (type === 'image' && (t.includes('IMAGE') || t.includes('图片') || t.includes('图像'))) || (type === 'video' && (t.includes('VIDEO') || t.includes('视频')));
        });
      }
      if (!tab) return false;
      return tab.getAttribute('data-state') === 'active' || tab.getAttribute('aria-selected') === 'true';
    })(\${JSON.stringify(config.type)})\`);

    if (!mediaTypeActive) {
      throw new Error('flow_ui_contract_changed: Failed to activate media type tab ' + config.type);
    }

    // 6. 设置视频子模式 (frames / ingredients)
    if (config.type === 'video') {
      cliLog('[Worker] Setting video submode: ' + config.mode);
      const submodeResult = await js(String.raw\`((mode) => {
        const targetSuffix = mode === 'frames' ? '-trigger-VIDEO_FRAMES' : '-trigger-VIDEO_REFERENCES';
        let tab = document.querySelector('[id$="' + targetSuffix + '"]');
        if (!tab) {
          const tabs = Array.from(document.querySelectorAll('[role="tab"], button'));
          tab = tabs.find(el => {
            const id = el.id || '';
            const t = (el.innerText || el.getAttribute('aria-label') || '').toLowerCase();
            return id.endsWith(targetSuffix) || (mode === 'frames' && (t.includes('frame') || t.includes('帧'))) || (mode === 'ingredients' && (t.includes('reference') || t.includes('ingredient') || t.includes('参考')));
          });
        }
        if (!tab) return { error: 'Video submode tab not found for ' + mode };
        const isActive = tab.getAttribute('data-state') === 'active' || tab.getAttribute('aria-selected') === 'true';
        if (!isActive) tab.click();
        return { success: true };
      })(\${JSON.stringify(config.mode)})\`);

      if (submodeResult.error) {
        throw new Error('flow_ui_contract_changed: ' + submodeResult.error);
      }
      await wait(0.5);

      const submodeActive = await js(String.raw\`((mode) => {
        const targetSuffix = mode === 'frames' ? '-trigger-VIDEO_FRAMES' : '-trigger-VIDEO_REFERENCES';
        let tab = document.querySelector('[id$="' + targetSuffix + '"]');
        if (!tab) {
          const tabs = Array.from(document.querySelectorAll('[role="tab"], button'));
          tab = tabs.find(el => {
            const id = el.id || '';
            const t = (el.innerText || el.getAttribute('aria-label') || '').toLowerCase();
            return id.endsWith(targetSuffix) || (mode === 'frames' && (t.includes('frame') || t.includes('帧'))) || (mode === 'ingredients' && (t.includes('reference') || t.includes('ingredient') || t.includes('参考')));
          });
        }
        if (!tab) return false;
        return tab.getAttribute('data-state') === 'active' || tab.getAttribute('aria-selected') === 'true';
      })(\${JSON.stringify(config.mode)})\`);

      if (!submodeActive) {
        throw new Error('flow_ui_contract_changed: Failed to activate video submode ' + config.mode);
      }
    }

    // 7. 设置精确模型 displayName
    cliLog('[Worker] Setting model displayName: ' + config.displayName);
    const modelSelectResult = await js(String.raw\`((targetDisplayName) => {
      function normalize(s) {
        return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      }
      const normTarget = normalize(targetDisplayName);

      const buttons = Array.from(document.querySelectorAll('button[aria-haspopup="menu"], button[aria-expanded]'));
      let modelBtn = buttons.find(b => {
        const text = b.innerText || '';
        const aria = b.getAttribute('aria-label') || '';
        return normalize(text).includes(normTarget) || aria.includes('模型') || aria.includes('Model') || text.includes('Banana') || text.includes('Veo') || text.includes('Omni');
      });

      if (!modelBtn && buttons.length > 0) {
        modelBtn = buttons[0];
      }

      if (!modelBtn) {
        return { error: 'Model selection menu button not found' };
      }

      if (normalize(modelBtn.innerText).includes(normTarget)) {
        return { success: true, alreadySelected: true };
      }

      modelBtn.click();
      return { opened: true };
    })(\${JSON.stringify(config.displayName)})\`);

    if (modelSelectResult.error) {
      throw new Error('flow_ui_contract_changed: ' + modelSelectResult.error);
    }

    if (!modelSelectResult.alreadySelected) {
      await wait(0.5);
      const menuItemClickResult = await js(String.raw\`((targetDisplayName) => {
        function normalize(s) {
          return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        }
        const normTarget = normalize(targetDisplayName);

        const menuItems = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], div[role="menu"] button'));
        const item = menuItems.find(el => {
          const t = el.innerText || el.getAttribute('aria-label') || '';
          return normalize(t).includes(normTarget);
        });

        if (!item) {
          return { error: 'Model menu item not found for ' + targetDisplayName + ' (available: ' + menuItems.map(m => m.innerText).join(', ') + ')' };
        }

        item.click();
        return { success: true };
      })(\${JSON.stringify(config.displayName)})\`);

      if (menuItemClickResult.error) {
        throw new Error('flow_ui_contract_changed: ' + menuItemClickResult.error);
      }
      await wait(0.5);
    }

    const modelVerified = await js(String.raw\`((targetDisplayName) => {
      function normalize(s) {
        return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      }
      const normTarget = normalize(targetDisplayName);
      const buttons = Array.from(document.querySelectorAll('button[aria-haspopup="menu"], button[aria-expanded]'));
      return buttons.some(b => normalize(b.innerText).includes(normTarget));
    })(\${JSON.stringify(config.displayName)})\`);

    if (!modelVerified) {
      throw new Error('flow_ui_contract_changed: Failed to verify selected model ' + config.displayName);
    }

    // 8. 设置宽高比 aspect ratio
    cliLog('[Worker] Setting aspect ratio: ' + config.aspect);
    const aspectResult = await js(String.raw\`((aspect) => {
      const elements = Array.from(document.querySelectorAll('[role="tab"], button, div[role="radio"]'));
      const aspectEl = elements.find(el => {
        const t = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('data-value') || '').trim();
        return t === aspect || t.includes(aspect);
      });

      if (!aspectEl) {
        return { error: 'Aspect ratio control not found for ' + aspect };
      }

      const isActive = aspectEl.getAttribute('data-state') === 'active' || aspectEl.getAttribute('aria-selected') === 'true' || aspectEl.getAttribute('aria-checked') === 'true';
      if (!isActive) {
        aspectEl.click();
      }
      return { success: true };
    })(\${JSON.stringify(config.aspect)})\`);

    if (aspectResult.error) {
      throw new Error('flow_ui_contract_changed: ' + aspectResult.error);
    }
    await wait(0.5);

    const aspectActive = await js(String.raw\`((aspect) => {
      const elements = Array.from(document.querySelectorAll('[role="tab"], button, div[role="radio"]'));
      const aspectEl = elements.find(el => {
        const t = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('data-value') || '').trim();
        return t === aspect || t.includes(aspect);
      });
      if (!aspectEl) return false;
      return aspectEl.getAttribute('data-state') === 'active' || aspectEl.getAttribute('aria-selected') === 'true' || aspectEl.getAttribute('aria-checked') === 'true';
    })(\${JSON.stringify(config.aspect)})\`);

    if (!aspectActive) {
      throw new Error('flow_ui_contract_changed: Failed to activate aspect ratio ' + config.aspect);
    }

    // 9. 设置时长 duration (仅能力支持时配置)
    if (config.duration) {
      cliLog('[Worker] Setting duration: ' + config.duration + 's');
      const durationResult = await js(String.raw\`((duration) => {
        const durStr = String(duration);
        const elements = Array.from(document.querySelectorAll('[role="tab"], button, div[role="radio"]'));
        const durEl = elements.find(el => {
          const t = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('data-value') || '').trim();
          return t === durStr + 's' || t === durStr || t.includes(durStr + 's') || t.includes(durStr + '秒');
        });

        if (!durEl) {
          return { error: 'Duration control not found for ' + duration + 's' };
        }

        const isActive = durEl.getAttribute('data-state') === 'active' || durEl.getAttribute('aria-selected') === 'true' || durEl.getAttribute('aria-checked') === 'true';
        if (!isActive) {
          durEl.click();
        }
        return { success: true };
      })(\${JSON.stringify(config.duration)})\`);

      if (durationResult.error) {
        throw new Error('flow_ui_contract_changed: ' + durationResult.error);
      }
      await wait(0.5);

      const durationActive = await js(String.raw\`((duration) => {
        const durStr = String(duration);
        const elements = Array.from(document.querySelectorAll('[role="tab"], button, div[role="radio"]'));
        const durEl = elements.find(el => {
          const t = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('data-value') || '').trim();
          return t === durStr + 's' || t === durStr || t.includes(durStr + 's') || t.includes(durStr + '秒');
        });
        if (!durEl) return false;
        return durEl.getAttribute('data-state') === 'active' || durEl.getAttribute('aria-selected') === 'true' || durEl.getAttribute('aria-checked') === 'true';
      })(\${JSON.stringify(config.duration)})\`);

      if (!durationActive) {
        throw new Error('flow_ui_contract_changed: Failed to activate duration ' + config.duration + 's');
      }
    }

    // 10. 设置生成张数 / 数量 (n)
    if (config.count) {
      cliLog('[Worker] Setting count (n): ' + config.count);
      const countResult = await js(String.raw\`((count) => {
        const countStr = String(count);
        const elements = Array.from(document.querySelectorAll('[role="tab"], button, div[role="radio"]'));
        const countEl = elements.find(el => {
          const t = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('data-value') || '').trim();
          return t === countStr || t === countStr + '张' || t === countStr + '个' || t.includes(countStr + ' output');
        });

        if (!countEl) {
          if (count === 1) return { success: true, defaulted: true };
          return { error: 'Count control not found for count ' + count };
        }

        const isActive = countEl.getAttribute('data-state') === 'active' || countEl.getAttribute('aria-selected') === 'true' || countEl.getAttribute('aria-checked') === 'true';
        if (!isActive) {
          countEl.click();
        }
        return { success: true };
      })(\${JSON.stringify(config.count)})\`);

      if (countResult.error) {
        throw new Error('flow_ui_contract_changed: ' + countResult.error);
      }
      await wait(0.5);

      if (!countResult.defaulted) {
        const countActive = await js(String.raw\`((count) => {
          const countStr = String(count);
          const elements = Array.from(document.querySelectorAll('[role="tab"], button, div[role="radio"]'));
          const countEl = elements.find(el => {
            const t = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('data-value') || '').trim();
            return t === countStr || t === countStr + '张' || t === countStr + '个' || t.includes(countStr + ' output');
          });
          if (!countEl) return false;
          return countEl.getAttribute('data-state') === 'active' || countEl.getAttribute('aria-selected') === 'true' || countEl.getAttribute('aria-checked') === 'true';
        })(\${JSON.stringify(config.count)})\`);

        if (!countActive) {
          throw new Error('flow_ui_contract_changed: Failed to activate count ' + config.count);
        }
      }
    }

    // 11. 输入资产校验 (若当前 route 未开放资产上传，返回 501 before submit)
    if (config.inputAssetIds && config.inputAssetIds.length > 0) {
      throw new Error('flow_asset_upload_not_implemented: Asset upload is not yet implemented (501)');
    }

    // 12. 聚焦并写入 Slate Prompt (focus + selectAll + Input.insertText & verify)
    cliLog('[Worker] Filling Slate prompt editor...');
    const focusResult = await js(String.raw\`(() => {
      const editor = document.querySelector('div[role="textbox"][data-slate-editor="true"]') ||
                     document.querySelector('[data-slate-editor="true"]') ||
                     document.querySelector('div[role="textbox"][contenteditable="true"]');
      if (!editor) return { error: 'Slate prompt editor element not found' };
      editor.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      return { success: true };
    })()\`);

    if (focusResult.error) {
      throw new Error('flow_ui_contract_changed: ' + focusResult.error);
    }
    await wait(0.2);

    if (typeof cdp === 'function') {
      await cdp('Input.insertText', { text: config.prompt });
    }
    await wait(0.5);

    const verifiedPrompt = await js(String.raw\`(() => {
      const editor = document.querySelector('div[role="textbox"][data-slate-editor="true"]') ||
                     document.querySelector('[data-slate-editor="true"]') ||
                     document.querySelector('div[role="textbox"][contenteditable="true"]');
      if (!editor) return '';
      return (editor.innerText || editor.textContent || '').trim();
    })()\`);

    if (verifiedPrompt !== config.prompt.trim()) {
      cliLog('[Worker] Prompt text verification mismatch, performing fallback Slate input...');
      const fallbackResult = await js(String.raw\`((text) => {
        const editor = document.querySelector('div[role="textbox"][data-slate-editor="true"]') ||
                       document.querySelector('[data-slate-editor="true"]');
        if (!editor) return false;
        editor.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, text);
        return (editor.innerText || editor.textContent || '').trim() === text.trim();
      })(\${JSON.stringify(config.prompt)})\`);

      if (!fallbackResult) {
        throw new Error('flow_ui_contract_changed: Failed to verify prompt input content');
      }
    }
    cliLog('[Worker] Slate prompt verified successfully.');

    // 13. 定位提交按钮并触发提交
    cliLog('[Worker] Locating submit button...');
    const submitLocateResult = await js(String.raw\`(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const submitBtn = buttons.find(b => {
        const t = (b.innerText || b.getAttribute('aria-label') || '').trim();
        const type = b.getAttribute('type');
        return type === 'submit' || t === '生成' || t === 'Generate' || t === '创建' || t === 'Create' || b.getAttribute('aria-label') === 'Generate' || b.getAttribute('aria-label') === '生成' || b.querySelector('svg[data-icon="arrow-up"], svg[data-icon="send"]');
      });

      if (!submitBtn) return { error: 'Submit button not found' };
      if (submitBtn.disabled || submitBtn.getAttribute('aria-disabled') === 'true') {
        return { error: 'Submit button is disabled' };
      }
      return { success: true };
    })()\`);

    if (submitLocateResult.error) {
      throw new Error('flow_ui_contract_changed: ' + submitLocateResult.error);
    }

    const submitClickResult = await js(String.raw\`(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const submitBtn = buttons.find(b => {
        const t = (b.innerText || b.getAttribute('aria-label') || '').trim();
        const type = b.getAttribute('type');
        return type === 'submit' || t === '生成' || t === 'Generate' || t === '创建' || t === 'Create' || b.getAttribute('aria-label') === 'Generate' || b.getAttribute('aria-label') === '生成' || b.querySelector('svg[data-icon="arrow-up"], svg[data-icon="send"]');
      });
      if (submitBtn) {
        submitBtn.click();
        return { clicked: true };
      }
      return { clicked: false, error: 'Submit button missing at click time' };
    })()\`);

    if (!submitClickResult.clicked) {
      throw new Error('flow_ui_contract_changed: ' + (submitClickResult.error || 'Failed to click submit button'));
    }

    // 只有在点击成功后才 emit submitted 事件
    cliLog('FLOW_EVENT:' + JSON.stringify({ type: 'submitted', jobId: config.jobId, timestamp: new Date().toISOString() }));
    cliLog('FLOW_EVENT:' + JSON.stringify({ type: 'generating', jobId: config.jobId, timestamp: new Date().toISOString() }));

    // 14. 轮询等待新资产产生并等待生成加载状态消失
    cliLog('[Worker] Waiting for generation completion (target count: ' + config.count + ')...');
    const maxWaitSeconds = config.type === 'video' ? 300 : 180;
    const startTime = Date.now();
    let newEditHrefs = [];

    while ((Date.now() - startTime) < maxWaitSeconds * 1000) {
      await wait(3);

      const checkResult = await js(String.raw\`((baselineList) => {
        const baselineSet = new Set(baselineList);
        const allLinks = Array.from(document.querySelectorAll('a[href*="/project/"][href*="/edit/"]'));
        const hrefs = allLinks.map(a => a.href || a.getAttribute('href')).filter(Boolean);
        const freshHrefs = hrefs.filter(h => !baselineSet.has(h));

        const isGenerating = !!document.querySelector('[data-status="generating"], [aria-busy="true"], .generating-indicator, .loading-spinner, div[class*="skeleton"], div[class*="loading"]');

        return {
          freshHrefs: Array.from(new Set(freshHrefs)),
          isGenerating
        };
      })(\${JSON.stringify(baselineEditHrefs)})\`);

      newEditHrefs = checkResult.freshHrefs || [];
      if (newEditHrefs.length >= config.count && !checkResult.isGenerating) {
        cliLog('[Worker] Found ' + newEditHrefs.length + ' new generated assets, generating finished.');
        break;
      }
    }

    if (newEditHrefs.length < config.count) {
      throw new Error('flow_generation_timeout: Timeout waiting for ' + config.count + ' generated assets (found ' + newEditHrefs.length + ')');
    }

    const targetEditHrefs = newEditHrefs.slice(0, config.count);

    // 15. 配置 CDP 下载行为并下载每个新生成资产
    cliLog('[Worker] Setting up CDP download behavior...');
    let cdpDownloadConfigured = false;
    if (typeof cdp === 'function') {
      try {
        await cdp('Browser.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: config.targetDir,
          eventsEnabled: true
        });
        cdpDownloadConfigured = true;
      } catch (e1) {
        try {
          await cdp('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: config.targetDir
          });
          cdpDownloadConfigured = true;
        } catch (e2) {
          throw new Error('flow_download_transport_unavailable: Neither Browser.setDownloadBehavior nor Page.setDownloadBehavior is available');
        }
      }
    } else {
      throw new Error('flow_download_transport_unavailable: CDP transport is not available in current runtime');
    }

    cliLog('FLOW_EVENT:' + JSON.stringify({ type: 'downloading', jobId: config.jobId, timestamp: new Date().toISOString() }));

    const fs = require('fs');
    const path = require('path');
    const crypto = require('crypto');

    function inferMimeAndExt(filePath) {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(16);
      fs.readSync(fd, buf, 0, 16, 0);
      fs.closeSync(fd);

      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
        return { mimeType: 'image/png', ext: 'png' };
      }
      if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
        return { mimeType: 'image/jpeg', ext: 'jpg' };
      }
      if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
          buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
        return { mimeType: 'image/webp', ext: 'webp' };
      }
      if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
        return { mimeType: 'image/gif', ext: 'gif' };
      }
      if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
        return { mimeType: 'video/mp4', ext: 'mp4' };
      }
      return config.type === 'video' ? { mimeType: 'video/mp4', ext: 'mp4' } : { mimeType: 'image/png', ext: 'png' };
    }

    for (let i = 0; i < targetEditHrefs.length; i++) {
      const editHref = targetEditHrefs[i];
      cliLog('[Worker] Opening detail page ' + (i + 1) + '/' + targetEditHrefs.length + ': ' + editHref);

      // 每张图/视频下载前拍照快照，确保隔离
      const beforeFiles = new Set(fs.existsSync(config.targetDir) ? fs.readdirSync(config.targetDir) : []);

      await gotoAndWait(editHref, { timeout: 30 });
      await wait(2);

      const downloadBtnFound = await js(String.raw\`(() => {
        const elements = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
        const dlBtn = elements.find(el => {
          const t = (el.innerText || el.getAttribute('aria-label') || '').trim();
          const hasDlSymbol = !!el.querySelector('.google-symbols, [data-icon="download"]') || (el.innerText || '').includes('download');
          return t === '下载' || t === 'Download' || t.includes('下载') || t.includes('Download') || hasDlSymbol || el.getAttribute('aria-label') === '下载' || el.getAttribute('aria-label') === 'Download';
        });
        return !!dlBtn;
      })()\`);

      if (!downloadBtnFound) {
        throw new Error('flow_ui_contract_changed: Download button not found on detail page ' + editHref);
      }

      await js(String.raw\`(() => {
        const elements = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
        const dlBtn = elements.find(el => {
          const t = (el.innerText || el.getAttribute('aria-label') || '').trim();
          const hasDlSymbol = !!el.querySelector('.google-symbols, [data-icon="download"]') || (el.innerText || '').includes('download');
          return t === '下载' || t === 'Download' || t.includes('下载') || t.includes('Download') || hasDlSymbol || el.getAttribute('aria-label') === '下载' || el.getAttribute('aria-label') === 'Download';
        });
        if (dlBtn) dlBtn.click();
      })()\`);

      cliLog('[Worker] Waiting for file download to complete...');
      let downloadedFilename = null;
      let lastSize = -1;
      let stableRounds = 0;
      const dlStartTime = Date.now();
      const singleFileTimeoutMs = 60000;

      while ((Date.now() - dlStartTime) < singleFileTimeoutMs) {
        await wait(2.0); // 间隔 2s
        if (!fs.existsSync(config.targetDir)) continue;

        const currentFiles = fs.readdirSync(config.targetDir);
        // 排除临时下载扩展名
        const tempExts = ['.crdownload', '.tmp', '.partial', '.download', '.swp'];
        const candidates = currentFiles.filter(f => {
          if (beforeFiles.has(f)) return false;
          if (f.startsWith('manifest.') || f.startsWith('.')) return false;
          return !tempExts.some(ext => f.toLowerCase().endsWith(ext));
        });

        if (candidates.length > 0) {
          const candidatePath = path.join(config.targetDir, candidates[0]);
          try {
            const stat = fs.statSync(candidatePath);
            if (stat.size > 0) {
              if (stat.size === lastSize) {
                stableRounds++;
                // 必须连续 3 次采样大小一致 (采样间隔 2s，总稳定观察时间 >= 6s)
                if (stableRounds >= 3) {
                  downloadedFilename = candidates[0];
                  break;
                }
              } else {
                lastSize = stat.size;
                stableRounds = 0;
              }
            }
          } catch (_) {}
        }
      }

      if (!downloadedFilename) {
        throw new Error('flow_download_transport_unavailable: Timed out waiting for downloaded file to stabilize in targetDir');
      }

      const downloadedPath = path.join(config.targetDir, downloadedFilename);
      const { mimeType, ext } = inferMimeAndExt(downloadedPath);
      const safeFilename = 'output_' + (i + 1) + '_' + Date.now() + '.' + ext;
      const finalPath = path.join(config.targetDir, safeFilename);
      fs.renameSync(downloadedPath, finalPath);

      const finalStat = fs.statSync(finalPath);
      const rawMedia = config.jobId + '-' + i + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
      const mediaId = 'media_' + crypto.createHash('sha256').update(rawMedia).digest('hex').slice(0, 16);

      results.push({
        mediaId,
        filename: safeFilename,
        mimeType,
        sizeBytes: finalStat.size,
        sourceEditHref: editHref
      });
      cliLog('[Worker] Downloaded and processed asset ' + (i + 1) + ': ' + safeFilename + ' (' + finalStat.size + ' bytes)');
    }

    const summary = {
      jobId: config.jobId,
      status: 'completed',
      type: config.type,
      model: config.modelId,
      outputs: results
    };
    cliLog('FLOW_RESULT:' + JSON.stringify(summary));
    cliLog('__FLOW_WORKER_RESULT_START__' + JSON.stringify(summary) + '__FLOW_WORKER_RESULT_END__');
  } catch (err) {
    cliLog('FLOW_EVENT:' + JSON.stringify({ type: 'failed', jobId: config.jobId, error: err.message || String(err), timestamp: new Date().toISOString() }));
    const errPayload = {
      jobId: config.jobId,
      status: 'failed',
      error: err.message || String(err)
    };
    cliLog('FLOW_RESULT:' + JSON.stringify(errPayload));
    cliLog('__FLOW_WORKER_ERROR_START__' + JSON.stringify(errPayload) + '__FLOW_WORKER_ERROR_END__');
    throw err;
  } finally {
    if (currentTask || taskSpaceRef) {
      try {
        cliLog('[Worker] Returning persistent Flow Space to user control');
        await handOffTaskSpace(currentTask?.id ?? taskSpaceRef);
      } catch (cleanupErr) {
        cliLog('[Worker] Space handoff error: ' + (cleanupErr.message || cleanupErr));
      }
    }
  }
})();
`;
}

/**
 * 执行 Flow Browser Worker
 * @param {object} job
 * @param {import('../utils/flowStorage.js').FlowStorage} storage
 * @returns {Promise<object>}
 */
export async function runFlowBrowserWorker(job, storage) {
  const targetDir = storage.createJobDir(job.jobId);
  const scriptContent = buildWorkerScript(job, targetDir);

  return new Promise((resolve, reject) => {
    if (!fs.existsSync(EGO_BROWSER_BIN)) {
      const err = new Error(`ego-browser binary not found at '${EGO_BROWSER_BIN}'`);
      err.code = 'ego_browser_not_found';
      return reject(err);
    }

    const childEnv = { ...process.env };
    delete childEnv.ALPHA_NEXUS_TRANSPORT_TOKEN;
    const child = spawn(EGO_BROWSER_BIN, ['nodejs'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let settled = false;
    let resultPayload = null;
    let errorPayload = null;

    // Hard timeout timer: 等待 child 退出并异步归还持久 Space，避免 double-reject
    let hardTimeoutTriggered = false;
    const taskSpaceRef = job.params?.spaceId || 'flow-default';

    const hardTimeoutTimer = setTimeout(() => {
      if (!settled) {
        hardTimeoutTriggered = true;
        settled = true;

        const isAfterSubmit = !!job.submittedToBrowser;
        const errCode = isAfterSubmit ? 'flow_timeout_after_submit' : 'flow_worker_timeout';
        const timeoutErr = new Error(`flow_worker_timeout: Execution exceeded maximum allowed time (${MAX_WORKER_TIMEOUT_MS}ms)`);
        timeoutErr.status = 504;
        timeoutErr.code = errCode;
        timeoutErr.submitted = isAfterSubmit;

        if (storage) {
          try {
            storage.writeManifest(job.jobId, {
              jobId: job.jobId,
              type: job.type,
              status: isAfterSubmit ? 'unknown' : 'failed',
              params: job.params,
              createdAt: job.createdAt,
              startedAt: job.startedAt,
              failedAt: new Date().toISOString(),
              error: timeoutErr.message,
              outputs: []
            });
          } catch (_) {}
        }

        // 先发送 SIGTERM，并在必要时强杀
        try { child.kill('SIGTERM'); } catch (_) {}
        const killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch (_) {}
        }, 3000);
        killTimer.unref();

        // 尝试通过独立 worker 归还持久 Space，不删除账号会话
        try {
          const cleanupProc = spawn(EGO_BROWSER_BIN, ['nodejs'], { stdio: ['pipe', 'ignore', 'ignore'] });
          cleanupProc.stdin.write(`(async () => { try { await handOffTaskSpace(${JSON.stringify(taskSpaceRef)}); } catch (_) {} })()`);
          cleanupProc.stdin.end();
        } catch (_) {}

        reject(timeoutErr);
      }
    }, MAX_WORKER_TIMEOUT_MS);

    // 客户端断开连接时，若尚未提交（pre-submit）允许及时撤销并终止子进程
    let onJobSignalAbort = null;
    if (job.signal) {
      onJobSignalAbort = () => {
        if (!job.submittedToBrowser && !settled) {
          settled = true;
          clearTimeout(hardTimeoutTimer);
          try { child.kill('SIGTERM'); } catch (_) {}
          setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (_) {}
          }, 2000).unref();

          try {
            const cleanupProc = spawn(EGO_BROWSER_BIN, ['nodejs'], { stdio: ['pipe', 'ignore', 'ignore'] });
            cleanupProc.stdin.write(`(async () => { try { await handOffTaskSpace(${JSON.stringify(taskSpaceRef)}); } catch (_) {} })()`);
            cleanupProc.stdin.end();
          } catch (_) {}

          const cancelErr = new Error('Job aborted by client before browser submission');
          cancelErr.code = 'job_canceled_pre_submit';
          cancelErr.status = 499;
          reject(cancelErr);
        }
      };
      job.signal.addEventListener('abort', onJobSignalAbort, { once: true });
    }

    function cleanupListeners() {
      if (job.signal && onJobSignalAbort) {
        try {
          job.signal.removeEventListener('abort', onJobSignalAbort);
        } catch (_) {}
      }
    }

    function processLine(line) {
      const trimmed = line.trim();
      if (!trimmed) return;

      // 1. FLOW_EVENT protocol
      if (trimmed.startsWith('FLOW_EVENT:')) {
        try {
          const eventJson = JSON.parse(trimmed.slice('FLOW_EVENT:'.length));
          if (eventJson.type === 'submitted') {
            job.submittedToBrowser = true;
          }
          if (storage && eventJson.type) {
            const currentManifest = storage.readManifest(job.jobId) || {
              jobId: job.jobId,
              type: job.type,
              params: job.params,
              createdAt: job.createdAt,
              startedAt: job.startedAt,
              outputs: []
            };
            currentManifest.status = eventJson.type;
            if (eventJson.error) currentManifest.error = eventJson.error;
            storage.writeManifest(job.jobId, currentManifest);
          }
        } catch (_) {}
      }

      // 2. FLOW_RESULT protocol
      if (trimmed.startsWith('FLOW_RESULT:')) {
        try {
          const resJson = JSON.parse(trimmed.slice('FLOW_RESULT:'.length));
          if (resJson.status === 'completed') {
            resultPayload = resJson;
          } else if (resJson.status === 'failed') {
            errorPayload = resJson;
          }
        } catch (_) {}
      }
    }

    let lineRemainder = '';
    child.stdout.on('data', (chunk) => {
      const str = chunk.toString();
      stdoutBuffer += str;
      if (stdoutBuffer.length > MAX_BUFFER_SIZE_BYTES) {
        stdoutBuffer = stdoutBuffer.slice(-MAX_BUFFER_SIZE_BYTES);
      }

      const combined = lineRemainder + str;
      const lines = combined.split('\n');
      lineRemainder = lines.pop();
      for (const line of lines) {
        processLine(line);
      }
    });

    child.stderr.on('data', (chunk) => {
      const str = chunk.toString();
      stderrBuffer += str;
      if (stderrBuffer.length > MAX_BUFFER_SIZE_BYTES) {
        stderrBuffer = stderrBuffer.slice(-MAX_BUFFER_SIZE_BYTES);
      }
    });

    child.on('error', (err) => {
      cleanupListeners();
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeoutTimer);
      reject(err);
    });

    child.on('close', (code) => {
      cleanupListeners();
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeoutTimer);

      if (lineRemainder) {
        processLine(lineRemainder);
      }

      // 提取 Legacy 或者协议结果
      const resultMatch = stdoutBuffer.match(/__FLOW_WORKER_RESULT_START__(.*?)__FLOW_WORKER_RESULT_END__/);
      const errorMatch = stdoutBuffer.match(/__FLOW_WORKER_ERROR_START__(.*?)__FLOW_WORKER_ERROR_END__/);

      if (errorPayload) {
        return reject(new Error(errorPayload.error || 'Worker execution failed'));
      }

      if (errorMatch) {
        try {
          const errObj = JSON.parse(errorMatch[1]);
          return reject(new Error(errObj.error || 'Worker execution failed'));
        } catch (_) {
          return reject(new Error(`Worker execution failed: ${errorMatch[1]}`));
        }
      }

      if (resultPayload && resultPayload.status === 'completed') {
        const manifest = {
          jobId: job.jobId,
          type: job.type,
          status: 'completed',
          params: job.params,
          createdAt: job.createdAt,
          startedAt: job.startedAt,
          completedAt: new Date().toISOString(),
          outputs: resultPayload.outputs || []
        };
        storage.writeManifest(job.jobId, manifest);
        return resolve(manifest);
      }

      if (resultMatch) {
        try {
          const parsed = JSON.parse(resultMatch[1]);
          const manifest = {
            jobId: job.jobId,
            type: job.type,
            status: 'completed',
            params: job.params,
            createdAt: job.createdAt,
            startedAt: job.startedAt,
            completedAt: new Date().toISOString(),
            outputs: parsed.outputs || []
          };
          storage.writeManifest(job.jobId, manifest);
          return resolve(manifest);
        } catch (err) {
          return reject(new Error(`Failed to parse worker output: ${err.message}`));
        }
      }

      if (code !== 0) {
        return reject(new Error(`ego-browser exited with code ${code}. Stderr: ${stderrBuffer.slice(-500)}`));
      }

      // 如果 exit 0 但无显式结果协议/标记，必须报错 flow_worker_missing_result，绝不可伪造空结果静默 resolve
      const missingResErr = new Error('flow_worker_missing_result: Worker exited with 0 but produced no FLOW_RESULT or completion payload');
      missingResErr.code = 'flow_worker_missing_result';
      missingResErr.status = 500;
      if (storage) {
        try {
          storage.writeManifest(job.jobId, {
            jobId: job.jobId,
            type: job.type,
            status: 'failed',
            params: job.params,
            createdAt: job.createdAt,
            startedAt: job.startedAt,
            failedAt: new Date().toISOString(),
            error: missingResErr.message,
            outputs: []
          });
        } catch (_) {}
      }
      reject(missingResErr);
    });

    // 写入脚本并结束 stdin
    child.stdin.write(scriptContent);
    child.stdin.end();
  });
}

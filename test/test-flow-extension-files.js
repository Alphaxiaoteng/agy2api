/**
 * Static Assertions & Contract Tests for Flow Extension Files
 *
 * Checks:
 * 1. Manifest version is MV3 and host_permissions only allow labs.google, aisandbox-pa, storage, local loopback
 * 2. No telemetry / tracking domains (flow.kodelyx.in, batchLog, etc.)
 * 3. No local persistence of Google Flow Bearer tokens (only session / memory)
 * 4. Operation allowlist matches ALLOWED_OPERATIONS in flowExtensionBridge.js
 * 5. Target endpoint path allowlist matches Google Flow private API contract
 * 6. Content script uses strict window event type prefix / validation
 * 7. Message contract between extension and Node bridge (protocolVersion 1, hello handshake, operation_request)
 * 8. Download operations have strict size limits and origin restrictions
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_OPERATIONS } from '../src/services/flowExtensionBridge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXT_DIR = path.resolve(__dirname, '../extension/flow-api-bridge');

console.log('=== Starting Flow Extension File & Contract Tests ===\n');

// -------------------------------------------------------------
// Test 1: Manifest Permissions & Host Boundary
// -------------------------------------------------------------
console.log('1. Testing manifest.json permissions and host boundary...');
{
  const manifestPath = path.join(EXT_DIR, 'manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'manifest.json must exist');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.manifest_version, 3, 'Must be Manifest V3');

  // Verify background is ESM module
  assert.ok(manifest.background, 'manifest.background must be present');
  assert.equal(manifest.background.service_worker, 'background.js', "manifest.background.service_worker must be 'background.js'");
  assert.equal(manifest.background.type, 'module', "manifest.background.type must be 'module'");

  // Verify permissions
  const expectedPermissions = ['storage', 'alarms', 'tabs', 'webRequest', 'scripting', 'declarativeNetRequest'];
  for (const perm of expectedPermissions) {
    assert.ok(manifest.permissions.includes(perm), `Permission '${perm}' should be present`);
  }
  // Disallowed dangerous permissions
  assert.equal(manifest.permissions.includes('cookies'), false, 'cookies permission must NOT be requested');

  // Verify options_page and HTML module script loading
  assert.equal(manifest.options_page, 'options.html', "manifest.options_page must be 'options.html'");
  const optionsHtml = fs.readFileSync(path.join(EXT_DIR, 'options.html'), 'utf8');
  assert.ok(optionsHtml.includes('<script type="module" src="options.js"></script>'), 'options.html must load options.js with type="module"');
  assert.equal(optionsHtml.includes('<script src="config.js"></script>'), false, 'options.html must not load config.js as a classic script');
  assert.equal(optionsHtml.includes('config.js'), false, 'options.html must not include separate config.js script tag');

  // Verify host permissions
  const hostPermissions = manifest.host_permissions || [];
  const allowedHostPatterns = [
    'https://labs.google/*',
    'https://aisandbox-pa.googleapis.com/*',
    'https://storage.googleapis.com/*',
    'https://*.googleusercontent.com/*',
    'http://127.0.0.1:8045/*',
    'http://localhost:8045/*',
  ];

  for (const host of hostPermissions) {
    assert.ok(allowedHostPatterns.includes(host), `Unexpected host permission: ${host}`);
  }

  // Ensure no third-party hosts
  assert.equal(hostPermissions.some(h => h.includes('kodelyx.in')), false, 'flow.kodelyx.in must NOT be in host_permissions');
  assert.equal(hostPermissions.some(h => h.includes('8001')), false, 'Port 8001 must NOT be in host_permissions');
  // Verify DNR rules use requestDomains on aisandbox-pa.googleapis.com
  const rulesJsonPath = path.join(EXT_DIR, 'rules.json');
  assert.ok(fs.existsSync(rulesJsonPath), 'rules.json must exist');
  const rules = JSON.parse(fs.readFileSync(rulesJsonPath, 'utf8'));
  assert.equal(rules.length >= 1, true, 'rules.json must contain at least 1 rule');
  assert.deepEqual(rules[0].condition.requestDomains, ['aisandbox-pa.googleapis.com'], 'rules.json must use exact requestDomains on aisandbox-pa.googleapis.com');
  assert.equal(rules[0].condition.urlFilter, undefined, 'rules.json must NOT use substring urlFilter');
}
console.log('✓ Manifest permissions tests passed');

// -------------------------------------------------------------
// Test 2: No Telemetry, Remote Callbacks, or Hardcoded Keys
// -------------------------------------------------------------
console.log('2. Testing absence of telemetry, remote callbacks, and persistent tokens...');
{
  const backgroundJs = fs.readFileSync(path.join(EXT_DIR, 'background.js'), 'utf8');
  const injectedJs = fs.readFileSync(path.join(EXT_DIR, 'injected.js'), 'utf8');
  const contentJs = fs.readFileSync(path.join(EXT_DIR, 'content.js'), 'utf8');
  const configJs = fs.readFileSync(path.join(EXT_DIR, 'config.js'), 'utf8');
  const optionsJs = fs.readFileSync(path.join(EXT_DIR, 'options.js'), 'utf8');

  const allCode = `${backgroundJs}\n${injectedJs}\n${contentJs}\n${configJs}\n${optionsJs}`;

  // Check for forbidden strings
  assert.equal(allCode.includes('kodelyx.in'), false, 'kodelyx.in must not appear anywhere in extension files');
  assert.equal(allCode.includes('batchLogFrontendEvents'), false, 'Human telemetry batchLogFrontendEvents must not be present');
  assert.equal(allCode.includes('batchLog'), false, 'Human telemetry batchLog must not be present');
  assert.equal(allCode.includes('/api/ext/callback'), false, 'Remote HTTP callback endpoint must not be present');
  assert.equal(allCode.includes('document.cookie ='), false, 'Extension must not write cookies');
  assert.equal(backgroundJs.includes('importScripts'), false, 'background.js must NOT use importScripts');
  assert.equal(backgroundJs.includes('window.'), false, 'background service worker must NOT reference window');
  assert.equal(backgroundJs.includes('document.'), false, 'background service worker must NOT reference document');
  assert.equal(backgroundJs.includes('module.exports'), false, 'background.js must NOT use CommonJS module.exports');
  assert.equal(configJs.includes('module.exports'), false, 'config.js must NOT use CommonJS module.exports');
  assert.equal(contentJs.includes('export '), false, 'content.js must remain classic script without exports');
  assert.equal(injectedJs.includes('export '), false, 'injected.js must remain classic script without exports');

  // Strict token passing isolation: NO AUTH_CAPTURED in injected.js or content.js or background.js
  assert.equal(injectedJs.includes('AUTH_CAPTURED'), false, 'injected.js must NOT dispatch AUTH_CAPTURED');
  assert.equal(contentJs.includes('AUTH_CAPTURED'), false, 'content.js must NOT listen for AUTH_CAPTURED');
  assert.equal(backgroundJs.includes('FLOW_AUTH_CAPTURED'), false, 'background.js must NOT handle FLOW_AUTH_CAPTURED runtime message');

  // webRequest listener strictly restricted to aisandbox-pa.googleapis.com
  assert.ok(backgroundJs.includes("urls: ['https://aisandbox-pa.googleapis.com/*']"), 'webRequest must strictly filter aisandbox-pa.googleapis.com');
  assert.equal(backgroundJs.includes("urls: ['https://aisandbox-pa.googleapis.com/*', 'https://labs.google/*']"), false, 'webRequest must NOT listen to labs.google to prevent token leakage');

  // Check that Google bearer token is NEVER written to chrome.storage.local
  const localSetMatches = allCode.match(/chrome\.storage\.local\.set\(\s*\{([^}]+)\}/g) || [];
  for (const match of localSetMatches) {
    assert.equal(match.includes('flowBearerToken'), false, 'flowBearerToken must NEVER be written to chrome.storage.local');
    assert.equal(match.includes('flowApiKey'), false, 'flowApiKey must NEVER be written to chrome.storage.local');
    assert.equal(match.includes('flowKey'), false, 'flowKey must NEVER be written to chrome.storage.local');
    assert.equal(match.includes('bearerToken'), false, 'bearerToken must NEVER be written to chrome.storage.local');
  }

  // Check that uploadImage uses imageBytes and does NOT use rawImageBytes
  assert.ok(backgroundJs.includes('imageBytes: imageBase64'), 'upload_image must use imageBytes in request body');
  assert.equal(backgroundJs.includes('rawImageBytes'), false, 'upload_image must NOT use unconfirmed rawImageBytes');
}
console.log('✓ Telemetry and security checks passed');

// -------------------------------------------------------------
// Test 3: Operation Allowlist & Message Contracts
// -------------------------------------------------------------
console.log('3. Testing operation allowlist and message contract compatibility...');
{
  const backgroundJs = fs.readFileSync(path.join(EXT_DIR, 'background.js'), 'utf8');

  // Verify all operations in ALLOWED_OPERATIONS are handled in background.js
  for (const op of ALLOWED_OPERATIONS) {
    assert.ok(
      backgroundJs.includes(`case '${op}':`),
      `background.js must handle allowlisted operation '${op}'`
    );
  }

  // Verify protocolVersion 1, reqId validation and hello handshake
  assert.ok(backgroundJs.includes('protocolVersion: 1'), 'background.js must send protocolVersion: 1');
  assert.ok(backgroundJs.includes('protocolVersion !== 1'), 'background.js must reject protocolVersion !== 1');
  assert.ok(backgroundJs.includes('REQ_ID_REGEX'), 'background.js must validate reqId format');
  assert.ok(backgroundJs.includes("type: 'hello'"), "background.js must send type: 'hello'");
  assert.ok(backgroundJs.includes("type: 'status_update'"), "background.js must support status_update");
  assert.ok(backgroundJs.includes("type: 'ping'"), "background.js must support ping/pong keepalive");
}
console.log('✓ Operation allowlist & message contract tests passed');

// -------------------------------------------------------------
// Test 4: Endpoint Path Allowlists and Resource Limits
// -------------------------------------------------------------
console.log('4. Testing endpoint path allowlist, download size limits, and 401 handling...');
{
  const backgroundJs = fs.readFileSync(path.join(EXT_DIR, 'background.js'), 'utf8');

  // Check that endpoints are validated with ALLOWED_API_PATHS
  assert.ok(backgroundJs.includes('ALLOWED_API_PATHS'), 'background.js must define ALLOWED_API_PATHS');
  assert.ok(backgroundJs.includes('ALLOWED_IMAGE_HOSTS'), 'background.js must define ALLOWED_IMAGE_HOSTS');
  assert.ok(backgroundJs.includes('MAX_DOWNLOAD_SIZE_BYTES'), 'background.js must enforce MAX_DOWNLOAD_SIZE_BYTES');

  // Check 401 token invalidation logic
  assert.ok(backgroundJs.includes('resp.status === 401'), 'background.js must detect 401 status');
  assert.ok(backgroundJs.includes('flowBearerToken = null'), 'background.js must clear flowBearerToken on 401');

  // Content script prefix verification
  const contentJs = fs.readFileSync(path.join(EXT_DIR, 'content.js'), 'utf8');
  assert.ok(contentJs.includes('__FLOW_BRIDGE_'), 'content.js must use strictly prefixed custom events');
}
console.log('✓ Endpoint path and safety boundary tests passed');

console.log('\n=== All Flow Extension File & Contract Tests Passed Successfully! ===');

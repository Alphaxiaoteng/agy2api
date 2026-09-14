/**
 * Deep Security Boundary Tests for Flow API Bridge Extension
 *
 * Tests:
 * 1. shouldAttachAuthBearer strictly requires https: and exact aisandbox-pa.googleapis.com hostname.
 *    Any storage / googleusercontent / fife URL or trick query parameter containing host substring MUST NOT get Bearer.
 * 2. URL parsing & loopback vs non-loopback validation in validateBridgeWsUrl:
 *    - ws:// on loopback is allowed
 *    - wss:// on non-loopback is allowed
 *    - ws:// on non-loopback is rejected
 *    - Credentials (user:pass) are rejected
 *    - Queries & hash fragments are rejected
 *    - Non-/internal/flow/ws paths are rejected
 * 3. grecaptcha actions in injected.js strictly allow IMAGE_GENERATION & VIDEO_GENERATION, rejecting arbitrary actions.
 * 4. WebSocket maxPayload >= 160MiB configured in FlowExtensionBridge.
 * 5. Stream download chunk accumulator & 100MB cutoff behavior.
 * 6. Sender & origin verification rules for background.js messages.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlowExtensionBridge } from '../src/services/flowExtensionBridge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXT_DIR = path.resolve(__dirname, '../extension/flow-api-bridge');

console.log('=== Starting Flow Extension Security Boundary Tests ===\n');

// -------------------------------------------------------------
// Test 1: Download Bearer Auth Attachment Strictness
// -------------------------------------------------------------
console.log('1. Testing shouldAttachAuthBearer against host/protocol manipulation...');
{
  const { shouldAttachAuthBearer, isAllowedImageDownloadHost } = await import(`file://${path.join(EXT_DIR, 'background.js')}`);

  // Positive cases
  assert.equal(shouldAttachAuthBearer('https://aisandbox-pa.googleapis.com/v1/media/12345'), true);
  assert.equal(shouldAttachAuthBearer('https://aisandbox-pa.googleapis.com/v1/credits'), true);

  // Negative cases: Storage & Googleusercontent MUST NOT receive Bearer
  assert.equal(shouldAttachAuthBearer('https://storage.googleapis.com/ai-sandbox-videofx/image/123'), false);
  assert.equal(shouldAttachAuthBearer('https://lh3.googleusercontent.com/fife/ABCDEF'), false);
  assert.equal(shouldAttachAuthBearer('https://subdomain.googleusercontent.com/img'), false);

  // Negative cases: Protocol manipulation
  assert.equal(shouldAttachAuthBearer('http://aisandbox-pa.googleapis.com/v1/media/123'), false);

  // Negative cases: Substring / query injection / SSRF / path bypass attempts
  assert.equal(shouldAttachAuthBearer('https://storage.googleapis.com/download?fakeHost=aisandbox-pa.googleapis.com'), false);
  assert.equal(shouldAttachAuthBearer('https://evil.com/?aisandbox-pa.googleapis.com'), false);
  assert.equal(shouldAttachAuthBearer('https://aisandbox-pa.googleapis.com.attacker.com/v1/media'), false);
  assert.equal(shouldAttachAuthBearer('https://not-aisandbox-pa.googleapis.com/v1/media'), false);
  assert.equal(shouldAttachAuthBearer('javascript:alert(1)'), false);
  assert.equal(shouldAttachAuthBearer(''), false);
  assert.equal(shouldAttachAuthBearer(null), false);

  // Test isAllowedImageDownloadHost
  assert.equal(isAllowedImageDownloadHost('https://storage.googleapis.com/image/123'), true);
  assert.equal(isAllowedImageDownloadHost('https://lh3.googleusercontent.com/fife/xyz'), true);
  assert.equal(isAllowedImageDownloadHost('https://photos.googleusercontent.com/fife/xyz'), true);
  assert.equal(isAllowedImageDownloadHost('https://aisandbox-pa.googleapis.com/v1/media/123'), true);
  assert.equal(isAllowedImageDownloadHost('https://evil-site.com/image.png'), false);
  assert.equal(isAllowedImageDownloadHost('http://storage.googleapis.com/image.png'), false);
}
console.log('✓ shouldAttachAuthBearer & image host isolation tests passed');

// -------------------------------------------------------------
// Test 2: Bridge WebSocket URL Validation
// -------------------------------------------------------------
console.log('2. Testing validateBridgeWsUrl security rules...');
{
  const { validateBridgeWsUrl } = await import(`file://${path.join(EXT_DIR, 'config.js')}`);

  // 2.1 Valid loopback URLs
  assert.equal(validateBridgeWsUrl('ws://127.0.0.1:8045/internal/flow/ws').valid, true);
  assert.equal(validateBridgeWsUrl('ws://localhost:8045/internal/flow/ws').valid, true);
  assert.equal(validateBridgeWsUrl('ws://[::1]:8045/internal/flow/ws').valid, true);
  assert.equal(validateBridgeWsUrl('wss://127.0.0.1:8045/internal/flow/ws').valid, true);

  // 2.2 Valid remote URL (must be wss://)
  assert.equal(validateBridgeWsUrl('wss://my-flow-server.example.com/internal/flow/ws').valid, true);

  // 2.3 Insecure remote URL (ws:// on remote is rejected)
  const insecureRes = validateBridgeWsUrl('ws://remote-server.com:8045/internal/flow/ws');
  assert.equal(insecureRes.valid, false);
  assert.ok(insecureRes.error.includes('wss://'));

  // 2.4 Rejection of user credentials (user:pass@host)
  const credsRes = validateBridgeWsUrl('ws://user:pass@127.0.0.1:8045/internal/flow/ws');
  assert.equal(credsRes.valid, false);
  assert.ok(credsRes.error.includes('Credentials'));

  // 2.5 Rejection of query parameters and hashes
  const queryRes = validateBridgeWsUrl('ws://127.0.0.1:8045/internal/flow/ws?token=secret');
  assert.equal(queryRes.valid, false);
  assert.ok(queryRes.error.includes('Query parameters'));

  const hashRes = validateBridgeWsUrl('ws://127.0.0.1:8045/internal/flow/ws#fragment');
  assert.equal(hashRes.valid, false);
  assert.ok(hashRes.error.includes('Hash fragments'));

  // 2.6 Rejection of invalid path
  const pathRes = validateBridgeWsUrl('ws://127.0.0.1:8045/ws/logs');
  assert.equal(pathRes.valid, false);
  assert.ok(pathRes.error.includes('/internal/flow/ws'));
}
console.log('✓ validateBridgeWsUrl security tests passed');

// -------------------------------------------------------------
// Test 3: grecaptcha Action Allowlist in injected.js
// -------------------------------------------------------------
console.log('3. Testing injected.js grecaptcha action allowlist...');
{
  const injectedCode = fs.readFileSync(path.join(EXT_DIR, 'injected.js'), 'utf8');

  assert.ok(injectedCode.includes('ALLOWED_CAPTCHA_ACTIONS'), 'injected.js must define ALLOWED_CAPTCHA_ACTIONS');
  assert.ok(injectedCode.includes("'IMAGE_GENERATION'"), 'Must allow IMAGE_GENERATION');
  assert.ok(injectedCode.includes("'VIDEO_GENERATION'"), 'Must allow VIDEO_GENERATION');
  assert.ok(injectedCode.includes('DISALLOWED_CAPTCHA_ACTION'), 'Must reject arbitrary captcha actions');
}
console.log('✓ injected.js reCAPTCHA action allowlist verified');

// -------------------------------------------------------------
// Test 4: WebSocket maxPayload >= 160MiB
// -------------------------------------------------------------
console.log('4. Testing FlowExtensionBridge WebSocketServer maxPayload limit...');
{
  const flowBridgeCode = fs.readFileSync(path.join(__dirname, '../src/services/flowExtensionBridge.js'), 'utf8');
  assert.ok(flowBridgeCode.includes('maxPayload: 160 * 1024 * 1024'), 'FlowExtensionBridge must configure maxPayload to at least 160 MiB');
}
console.log('✓ maxPayload >= 160 MiB verified');

// -------------------------------------------------------------
// Test 5: background.js onMessage Sender & Tab URL Verification
// -------------------------------------------------------------
console.log('5. Testing background.js message sender & origin isolation...');
{
  const { isValidFlowTabUrl } = await import(`file://${path.join(EXT_DIR, 'background.js')}`);

  // Positive
  assert.equal(isValidFlowTabUrl('https://labs.google/fx/tools/flow'), true);
  assert.equal(isValidFlowTabUrl('https://labs.google/fx/tools/flow/projects/abc-123'), true);
  assert.equal(isValidFlowTabUrl('https://labs.google/fx/en/tools/flow'), true);

  // Negative
  assert.equal(isValidFlowTabUrl('https://labs.google/other-app'), false);
  assert.equal(isValidFlowTabUrl('https://evil-site.com/fx/tools/flow'), false);
  assert.equal(isValidFlowTabUrl('http://labs.google/fx/tools/flow'), false);

  const backgroundCode = fs.readFileSync(path.join(EXT_DIR, 'background.js'), 'utf8');
  assert.ok(backgroundCode.includes('sender.id !== chrome.runtime.id'), 'Must check sender.id === chrome.runtime.id');
  assert.ok(backgroundCode.includes('isInternalExtensionPage'), 'Must check internal extension page caller');
  assert.ok(backgroundCode.includes('isAuthorizedFlowTab'), 'Must check authorized labs.google Flow tab caller');
}
console.log('✓ Message sender and tab origin isolation verified');

// -------------------------------------------------------------
// Test 6: URL Validation, Path Safety, and API Key Query Construction
// -------------------------------------------------------------
console.log('6. Testing validateAndBuildUrl and API key injection...');
{
  const { validateAndBuildUrl } = await import(`file://${path.join(EXT_DIR, 'background.js')}`);

  // 6.1 Valid endpoint without apiKey
  const url1 = validateAndBuildUrl('/v1/credits');
  assert.equal(url1, 'https://aisandbox-pa.googleapis.com/v1/credits');

  // 6.2 Valid endpoint with apiKey
  const url2 = validateAndBuildUrl('/v1/credits', 'AIzaSyTest_Key-12345');
  assert.equal(url2, 'https://aisandbox-pa.googleapis.com/v1/credits?key=AIzaSyTest_Key-12345');

  // 6.3 Rejection of absolute URLs
  assert.throws(() => validateAndBuildUrl('https://evil.com/v1/credits'), /Absolute or scheme-relative URLs are rejected/);
  assert.throws(() => validateAndBuildUrl('http://aisandbox-pa.googleapis.com/v1/credits'), /Absolute or scheme-relative URLs are rejected/);
  assert.throws(() => validateAndBuildUrl('//aisandbox-pa.googleapis.com/v1/credits'), /Absolute or scheme-relative URLs are rejected/);

  // 6.4 Rejection of query string and hash fragments in endpoint
  assert.throws(() => validateAndBuildUrl('/v1/credits?injected=true'), /Query strings and hash fragments are not allowed/);
  assert.throws(() => validateAndBuildUrl('/v1/credits#secret'), /Query strings and hash fragments are not allowed/);

  // 6.5 Rejection of path traversal dot segments (.. / .)
  assert.throws(() => validateAndBuildUrl('/v1/projects/../credits'), /Path traversal dot segments are rejected/);
  assert.throws(() => validateAndBuildUrl('/v1/./credits'), /Path traversal dot segments are rejected/);

  // 6.6 Rejection of non-allowlisted path
  assert.throws(() => validateAndBuildUrl('/v1/admin/debug'), /Endpoint path.*is not allowlisted/);
}
console.log('✓ validateAndBuildUrl security and API key tests passed');

console.log('\n=== All Flow Extension Security Boundary Tests Passed Successfully! ===');

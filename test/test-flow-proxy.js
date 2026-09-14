import assert from 'node:assert/strict';
import {
  isAllowedProxyHost,
  rewriteLocation,
  rewriteHtml,
  wrapBrowserUrl,
  parseUpstreamPath,
  parseEgoCookiePayload
} from '../src/utils/flowProxyRewrite.js';
import { CookieJar } from '../src/utils/flowCookieJar.js';

assert.equal(isAllowedProxyHost('labs.google'), true);
assert.equal(isAllowedProxyHost('aisandbox-pa.googleapis.com'), true);
assert.equal(isAllowedProxyHost('firebaseinstallations.googleapis.com'), true);
assert.equal(isAllowedProxyHost('lh3.googleusercontent.com'), true);
assert.equal(isAllowedProxyHost('storage.googleapis.com'), true);
assert.equal(isAllowedProxyHost('169.254.169.254'), false);
assert.equal(isAllowedProxyHost('127.0.0.1'), false);
assert.equal(isAllowedProxyHost('evil.com'), false);
assert.equal(isAllowedProxyHost('accounts.google.com'), false);
assert.equal(isAllowedProxyHost('labs.google.evil.com'), false);

assert.equal(
  rewriteLocation('https://labs.google/fx/tools/flow', 'https://labs.google'),
  '/fx/tools/flow'
);
assert.equal(
  rewriteLocation('https://aisandbox-pa.googleapis.com/v1/flow:batchLog', 'https://labs.google'),
  '/__flow/u/aisandbox-pa.googleapis.com/v1/flow:batchLog'
);
assert.equal(
  rewriteLocation('https://accounts.google.com/o/oauth2/v2/auth?x=1', 'https://labs.google'),
  'https://accounts.google.com/o/oauth2/v2/auth?x=1'
);

const html = rewriteHtml(
  '<head></head><a href="https://labs.google/fx/tools/flow">Flow</a><script src="/fx/_next/static/x.js"></script>'
);
assert.match(html, /<script>\/\*agy-flow-proxy\*\//);
assert.match(html, /href="\/fx\/tools\/flow"/);
assert.match(html, /src="\/fx\/_next\/static\/x\.js"/);

assert.equal(
  wrapBrowserUrl('https://aisandbox-pa.googleapis.com/v1/x', 'http://127.0.0.1:8045'),
  'http://127.0.0.1:8045/__flow/u/aisandbox-pa.googleapis.com/v1/x'
);
assert.equal(
  wrapBrowserUrl('https://labs.google/fx/api/auth/session', 'http://127.0.0.1:8045'),
  'http://127.0.0.1:8045/fx/api/auth/session'
);
assert.equal(
  wrapBrowserUrl('/fx/_next/static/a.js', 'http://127.0.0.1:8045'),
  '/fx/_next/static/a.js'
);
assert.equal(
  wrapBrowserUrl('https://www.gstatic.com/foo.js', 'http://127.0.0.1:8045'),
  'https://www.gstatic.com/foo.js'
);

assert.deepEqual(parseUpstreamPath('/__flow/u/aisandbox-pa.googleapis.com/v1/foo?x=1'), {
  host: 'aisandbox-pa.googleapis.com',
  path: '/v1/foo?x=1'
});
assert.equal(parseUpstreamPath('/__flow/u/evil.com/x'), null);
assert.equal(parseUpstreamPath('/__flow/u/169.254.169.254/latest'), null);
assert.equal(parseUpstreamPath('/__flow/u/aisandbox-pa.googleapis.com@evil.com/x'), null);

const jar = new CookieJar();
jar.ingest(
  [
    '__Host-next-auth.csrf-token=abc; Path=/; HttpOnly; Secure; SameSite=Lax',
    '__Secure-next-auth.session-token=sess; Path=/; HttpOnly; Secure; SameSite=Lax'
  ],
  'https://labs.google/fx/tools/flow'
);
const cookieHeader = jar.headerFor('https://labs.google/fx/api/auth/session');
assert.match(cookieHeader, /__Host-next-auth\.csrf-token=abc/);
assert.match(cookieHeader, /__Secure-next-auth\.session-token=sess/);
assert.equal(jar.headerFor('https://aisandbox-pa.googleapis.com/v1/x').includes('session-token'), false);

jar.ingestCdpCookies([
  { name: 'SID', value: 'sid-value', domain: '.google.com', path: '/', expires: -1, secure: true },
  { name: 'other', value: 'nope', domain: 'github.com', path: '/', expires: -1 }
]);
assert.match(jar.headerFor('https://accounts.google.com/'), /SID=sid-value/);
assert.equal(jar.headerFor('https://github.com/').includes('other='), false);

const stats = jar.stats();
assert.equal(typeof stats.count, 'number');
assert.ok(stats.count >= 3);
assert.ok(stats.names.includes('SID'));
assert.equal(JSON.stringify(stats).includes('sid-value'), false);
assert.equal(JSON.stringify(stats).includes('"abc"'), false);
assert.equal(JSON.stringify(stats).includes('session-token=sess'), false);

const cookies = parseEgoCookiePayload(
  'task space id: 1\nFLOW_COOKIES_JSON:{"cookies":[{"name":"SID","value":"x","domain":".google.com","path":"/"}]}\n'
);
assert.equal(cookies.length, 1);
assert.equal(cookies[0].name, 'SID');

const lined = parseEgoCookiePayload(
  'FLOW_COOKIE:{"name":"SID","value":"x","domain":".google.com","path":"/"}\nFLOW_COOKIES_END:1\n'
);
assert.equal(lined.length, 1);
assert.equal(lined[0].name, 'SID');

console.log('flow proxy rewrite/cookie tests passed');
process.exit(0);

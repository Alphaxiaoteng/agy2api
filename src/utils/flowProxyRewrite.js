const PROXY_HOSTS = new Set([
  'labs.google',
  'aisandbox-pa.googleapis.com',
  'content-aisandbox-pa.googleapis.com',
  'firebaseinstallations.googleapis.com',
  'firebaseremoteconfig.googleapis.com',
  'firebaselogging.googleapis.com',
  'firebaselogging-pa.googleapis.com',
  'storage.googleapis.com',
  'lh3.googleusercontent.com'
]);

export function isAllowedProxyHost(host) {
  if (!host || typeof host !== 'string') return false;
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h.includes(':') || h.includes('/') || h.includes('@') || h.includes('\\')) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return false;
  if (PROXY_HOSTS.has(h)) return true;
  return h.endsWith('.googleusercontent.com') && h.split('.').length >= 3 && !h.startsWith('.');
}

export function wrapBrowserUrl(input, origin) {
  try {
    const base = String(origin || '').replace(/\/$/, '');
    const u = new URL(input, base || 'http://127.0.0.1');
    if (u.hostname === 'labs.google') {
      return `${base}${u.pathname}${u.search}${u.hash}`;
    }
    if (isAllowedProxyHost(u.hostname)) {
      return `${base}/__flow/u/${u.hostname}${u.pathname}${u.search}${u.hash}`;
    }
  } catch {
    return input;
  }
  return input;
}

export function rewriteLocation(location, _upstreamOrigin) {
  if (!location) return location;
  try {
    const u = new URL(location, 'https://labs.google');
    if (u.hostname === 'labs.google') {
      return `${u.pathname}${u.search}${u.hash}` || '/';
    }
    if (isAllowedProxyHost(u.hostname)) {
      return `/__flow/u/${u.hostname}${u.pathname}${u.search}${u.hash}`;
    }
    return location;
  } catch {
    return location;
  }
}

export function parseUpstreamPath(originalUrl) {
  try {
    const u = new URL(originalUrl, 'http://127.0.0.1');
    const parts = u.pathname.split('/');
    if (parts[1] !== '__flow' || parts[2] !== 'u' || !parts[3]) return null;
    const host = parts[3].toLowerCase();
    if (!isAllowedProxyHost(host)) return null;
    const rest = parts.slice(4).join('/');
    const path = `/${rest}${u.search}`;
    return { host, path: rest ? path : `/${u.search}` };
  } catch {
    return null;
  }
}

export function parseEgoCookiePayload(raw) {
  const text = String(raw || '');
  const fromLines = [];
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf('FLOW_COOKIE:');
    if (idx < 0) continue;
    try {
      fromLines.push(JSON.parse(line.slice(idx + 'FLOW_COOKIE:'.length)));
    } catch {
      /* skip malformed line */
    }
  }
  if (fromLines.length) return fromLines;
  const marker = 'FLOW_COOKIES_JSON:';
  const i = text.indexOf(marker);
  if (i < 0) return [];
  const json = text.slice(i + marker.length).trim().split('\n')[0];
  const data = JSON.parse(json);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.cookies)) return data.cookies;
  if (Array.isArray(data?.result?.cookies)) return data.result.cookies;
  return [];
}

export function buildInjectScript() {
  return `<script>/*agy-flow-proxy*/(()=>{
var P=location.origin;
function allow(h){
  h=(h||'').toLowerCase();
  if(!h||h.indexOf(':')>=0||h.indexOf('@')>=0) return false;
  if(/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(h)) return false;
  if(h==='labs.google'||h==='aisandbox-pa.googleapis.com'||h==='content-aisandbox-pa.googleapis.com'||h==='firebaseinstallations.googleapis.com'||h==='firebaseremoteconfig.googleapis.com'||h==='firebaselogging.googleapis.com'||h==='firebaselogging-pa.googleapis.com'||h==='storage.googleapis.com'||h==='lh3.googleusercontent.com') return true;
  return h.length>22 && h.slice(-22)==='.googleusercontent.com';
}
function wrap(u){
  try{
    var x=new URL(u,P);
    if(x.hostname==='labs.google') return P+x.pathname+x.search+x.hash;
    if(allow(x.hostname)) return P+'/__flow/u/'+x.hostname+x.pathname+x.search+x.hash;
  }catch(e){}
  return u;
}
var of=window.fetch;
window.fetch=function(i,n){
  if(typeof i==='string') return of(wrap(i),n);
  if(i&&typeof i==='object'&&i.url){
    var w=wrap(i.url);
    if(w!==i.url) return of(new Request(w,i),n);
  }
  return of(i,n);
};
var xo=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){
  arguments[1]=wrap(u);
  return xo.apply(this,arguments);
};
if(navigator.sendBeacon){
  var sb=navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon=function(u,d){ return sb(wrap(u),d); };
}
if(navigator.serviceWorker&&navigator.serviceWorker.register){
  navigator.serviceWorker.register=function(){ return Promise.reject(new Error('blocked')); };
}
document.addEventListener('click',function(e){
  var a=e.target&&e.target.closest&&e.target.closest('a[href]');
  if(!a) return;
  var w=wrap(a.href);
  if(w!==a.href&&w.indexOf(P)===0) a.href=w;
},true);
var obs=new MutationObserver(function(ms){
  for(var i=0;i<ms.length;i++){
    var n=ms[i].addedNodes;
    for(var j=0;j<n.length;j++){
      var el=n[j];
      if(!el||el.nodeType!==1) continue;
      var nodes=(el.matches&&el.matches('img,video,source,script,link,iframe'))?[el]:[];
      if(el.querySelectorAll) nodes=nodes.concat(Array.prototype.slice.call(el.querySelectorAll('img,video,source,script,link,iframe')));
      for(var k=0;k<nodes.length;k++){
        var t=nodes[k];
        ['src','href'].forEach(function(attr){
          var v=t.getAttribute&&t.getAttribute(attr);
          if(!v) return;
          var w=wrap(v);
          if(w!==v) t.setAttribute(attr,w);
        });
      }
    }
  }
});
try{ obs.observe(document.documentElement,{childList:true,subtree:true}); }catch(e){}
})();</script>`;
}

export function rewriteHtml(html) {
  const inject = buildInjectScript();
  let out = String(html || '').replace(/https:\/\/labs\.google\//g, '/');
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, (m) => m + inject);
  } else {
    out = inject + out;
  }
  return out;
}

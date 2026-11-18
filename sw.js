self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', ev => ev.waitUntil(self.clients.claim()));
async function storeTab(tabId, clientId) {
  let cache = await caches.open('webfoundry-tabs');
  await cache.put(tabId, new Response(clientId));
}
async function getTab(tabId) {
  let cache = await caches.open('webfoundry-tabs');
  let res = await cache.match(tabId);
  return res && await res.text();
}
// Hardened isolation (Settings → "Hardened isolation"): when on, documents get
// COOP/COEP so pages are cross-origin isolated (SharedArrayBuffer, Atomics.wait).
// The flag lives in the Cache API because a service worker can't read
// localStorage. Preview iframes on project origins opt in with ?coi=1 instead,
// since each origin has its own service worker and caches.
let coiFlag = null;
async function coiEnabled() {
  if (coiFlag != null) return coiFlag;
  try {
    let res = await (await caches.open('webfoundry-settings')).match('/__wf/coi');
    coiFlag = res ? (await res.text()) === '1' : false;
  } catch {
    coiFlag = false;
  }
  return coiFlag;
}
// Load the flag as soon as the worker starts: the fetch handler needs it synchronously.
coiEnabled();
async function setCoi(on) {
  coiFlag = !!on;
  await (await caches.open('webfoundry-settings')).put('/__wf/coi', new Response(on ? '1' : '0'));
}
// Safari has no COEP credentialless; require-corp still isolates but blocks hotlinks without CORP.
let coepValue = /Safari\//.test(navigator.userAgent) && !/Chrome\/|Chromium\/|Firefox\//.test(navigator.userAgent) ? 'require-corp' : 'credentialless';
function coiHeaders(headers) {
  let h = new Headers(headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', coepValue);
  h.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return h;
}
function withCoi(res) {
  if (!res || res.type === 'opaqueredirect' || res.type === 'opaque' || res.status === 0) return res;
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: coiHeaders(res.headers) });
}
async function wantsCoi(url, clientId) {
  if (url.searchParams.get('coi') === '1' || (await coiEnabled())) return true;
  if (!clientId) return false;
  let client = await self.clients.get(clientId).catch(() => null);
  return !!client && new URL(client.url).searchParams.get('coi') === '1';
}
function isCacheableResponse(res) {
  return (
    res &&
    res.type !== 'opaqueredirect' &&
    (res.ok || res.type === 'opaque') &&
    res.headers.get('Vary') !== '*'
  );
}
function isUsableCachedResponse(res) {
  return res && (res.ok || res.type === 'opaque');
}
self.addEventListener('message', async ev => {
  let { data } = ev;
  if (data?.type === 'webfoundry-coi') {
    await setCoi(data.on);
    ev.ports?.[0]?.postMessage({ type: 'webfoundry-coi:ok', on: coiFlag });
    return;
  }
  if (data?.type !== 'webfoundry-register-tab') return;
  await storeTab(data.tabId, ev.source.id);
});
self.addEventListener('fetch', ev => {
  let url = new URL(ev.request.url);
  if (ev.request.mode === 'navigate') {
    ev.respondWith((async () => {
      let cache = await caches.open('webfoundry-pages');
      // Project preview frames (?isolate=…) carry the editor's mode as ?coi=1; remember it for
      // this origin so subresource requests can be routed synchronously.
      if (url.searchParams.get('isolate') != null && coiFlag !== (url.searchParams.get('coi') === '1')) {
        await setCoi(url.searchParams.get('coi') === '1');
      }
      let coi = await wantsCoi(url);
      try {
        let res = await fetch(ev.request);
        if (ev.request.method === 'GET' && isCacheableResponse(res)) {
          try { await cache.put(url.href, res.clone()); } catch (_) {}
        }
        return coi ? withCoi(res) : res;
      } catch (err) {
        let cached = await cache.match(url.href);
        if (isUsableCachedResponse(cached)) return coi ? withCoi(cached) : cached;
        throw err;
      }
    })());
    return;
  }
  if (url.searchParams.get('isolate') != null) return;
  if (url.origin !== self.location.origin) {
    // Hardened isolation: let the browser fetch cross-origin resources itself. Firefox rejects
    // fetch(event.request) from isolated clients (InvalidStateError), and the browser applies
    // COEP credentialless correctly only to its own fetches. Unknown flag (worker just started) → same.
    if (coiFlag !== false) return;
    // Never cache Netlify API responses; they are dynamic and polled for freshness
    if (url.hostname === 'api.netlify.com') {
      ev.respondWith(fetch(ev.request));
      return;
    }
    ev.respondWith((async () => {
      let cache = await caches.open('webfoundry-external');
      // An opaque (no-cors) cached copy can't answer a CORS request (e.g. <link crossorigin>).
      let fits = res => isUsableCachedResponse(res) && !(ev.request.mode !== 'no-cors' && res.type === 'opaque');
      // Chrome resolves a module's relative imports against the request URL when the SW hands
      // back a redirected response (esm.run -> jsDelivr), so redirect the page to the final URL.
      let follow = ev.request.method === 'GET' && ev.request.redirect === 'follow';
      if (ev.request.method === 'GET') {
        let cached = await cache.match(ev.request);
        if (fits(cached)) {
          if (follow && cached.redirected && cached.url && cached.url !== ev.request.url) return Response.redirect(cached.url, 302);
          return cached;
        }
      }
      try {
        let res = await fetch(ev.request);
        let cacheable = ev.request.method === 'GET' && isCacheableResponse(res);
        if (cacheable) await cache.put(ev.request, res.clone());
        if (follow && res.redirected && res.url && res.url !== ev.request.url) {
          if (cacheable) await cache.put(res.url, res.clone());
          return Response.redirect(res.url, 302);
        }
        return res;
      } catch (err) {
        if (ev.request.method === 'GET') {
          let fallback = await cache.match(ev.request);
          if (fits(fallback)) return fallback;
        }
        if (url.origin.includes('clarity.ms')) return new Response('');
        throw err;
      }
    })());
    return;
  }
  let pathname = url.pathname;
  if (url.port && pathname.endsWith('.html')) return;
  let prefix = null;
  if (pathname.startsWith('/files/')) prefix = '/files/';
  else if (pathname.startsWith('/preview/')) prefix = '/preview/';
  if (!prefix && ev.request.method === 'GET') {
    ev.respondWith((async () => {
      const cache = await caches.open('webfoundry-internal');
      try {
        const res = await fetch(ev.request);
        if (isCacheableResponse(res)) {
          // Not awaited: cache.put reads the whole body first, which would stall
          // streamed downloads (e.g. the 100+ MB native runtime bundles) until done.
          ev.waitUntil(cache.put(url.href, res.clone()).catch(() => {}));
        }
        return res;
      } catch (err) {
        const cached = await cache.match(url.href);
        if (isUsableCachedResponse(cached)) return cached;
        throw err;
      }
    })());
    return;
  }
  if (prefix) {
    let parts = pathname.slice(prefix.length).split('/');
    let tabId = parts.shift();
    let project = parts.shift();
    let isPreview = prefix === '/preview/';
    let path = isPreview && pathname.endsWith('.html') ? 'index.html' : parts.join('/');
    ev.respondWith(new Promise(async (resolve, reject) => {
      let channel = new MessageChannel();
      let timeout = setTimeout(() => reject(new Error('Request timeout')), 30000);
      // Project files fetched by an isolated page (e.g. Worker scripts) carry COEP/CORP too.
      let coi = await wantsCoi(url, ev.clientId);
      channel.port1.onmessage = e => {
        clearTimeout(timeout);
        let { status, error, data } = e.data || {};
        let headers = coi ? coiHeaders() : undefined;
        if (error) return resolve(new Response(error, { status, headers }));
        resolve(new Response(data, { status, headers }));
      };
      let client = await self.clients.get(await getTab(tabId));
      if (!client) return fetch(ev.request);
      client.postMessage({ type: 'fetch', project, path }, [channel.port2]);
    }).catch(err => new Response(err.message, { status: 503 })));
    return;
  }
  /*
  ev.respondWith((async () => {
    let cache = await caches.open('webfoundry-dynamic');
    try {
      let res = await fetch(ev.request);
      if (res?.type === 'opaque' || res?.type === 'cors' || res?.ok) cache.put(url.href, res.clone());
      return res;
    } catch (err) {
      console.error(err);
      let cached = await cache.match(url.href);
      if (cached) return cached;
      return new Response('Offline and not cached', { status: 503 });
    }
  })());
  */
});

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
self.addEventListener('message', async ev => {
  let { data } = ev;
  if (data.type !== 'webfoundry-register-tab') return;
  await storeTab(data.tabId, ev.source.id);
});
self.addEventListener('fetch', ev => {
  let url = new URL(ev.request.url);
  if (ev.request.mode === 'navigate') {
    ev.respondWith((async () => {
      let cache = await caches.open('webfoundry-pages');
      try {
        let res = await fetch(ev.request);
        ev.request.method === 'GET' && cache.put(url.href, res.clone());
        return res;
      } catch (err) {
        let cached = await cache.match(url.href);
        if (cached) return cached;
        throw err;
      }
    })());
    return;
  }
  if (url.searchParams.get('isolate') != null) return;
  if (url.origin !== self.location.origin) {
    ev.respondWith((async () => {
      let cache = await caches.open('webfoundry-external');
      if (ev.request.method === 'GET') {
        let cached = await cache.match(ev.request);
        if (cached) return cached;
      }
      try {
        let res = await fetch(ev.request);
        if (
          ev.request.method === 'GET' &&
          res && (res.ok || res.type === 'cors' || res.type === 'opaque')
        ) {
          await cache.put(ev.request, res.clone());
        }
        return res;
      } catch (err) {
        if (ev.request.method === 'GET') {
          let fallback = await cache.match(ev.request);
          if (fallback) return fallback;
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
        cache.put(url.href, res.clone());
        return res;
      } catch (err) {
        const cached = await cache.match(url.href);
        if (cached) return cached;
        throw err;
      }
    })());
    return;
  }
  if (prefix) {
    let securityResponse = (body, init = {}) => {
      let headers = new Headers(init.headers || {});
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      return new Response(body, { ...init, headers });
    };
    let parts = pathname.slice(prefix.length).split('/');
    let tabId = parts.shift();
    let project = parts.shift();
    let isPreview = prefix === '/preview/';
    let path = isPreview && pathname.endsWith('.html') ? 'index.html' : parts.join('/');
    ev.respondWith(new Promise(async (resolve, reject) => {
      let channel = new MessageChannel();
      let timeout = setTimeout(() => reject(new Error('Request timeout')), 30000);
      channel.port1.onmessage = e => {
        clearTimeout(timeout);
        let { status, error, data } = e.data || {};
        if (error) return resolve(securityResponse(error, { status }));
        resolve(securityResponse(data, { status }));
      };
      let client = await self.clients.get(await getTab(tabId));
      if (!client) return fetch(ev.request);
      client.postMessage({ type: 'fetch', project, path }, [channel.port2]);
    }).catch(err => securityResponse(err.message, { status: 503 })));
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

// Runs in the Webfoundry editor page. Relays between the editor and the background script.
// Payloads cross worlds as JSON strings, so no Xray-wrapped objects leak either way.
(() => {
  let { hostname } = location;
  let isWebfoundry = hostname === 'localhost' ||
    hostname === 'webfoundry.app' ||
    hostname.endsWith('.webfoundry.app') ||
    /^([a-z0-9-]+--)?webfoundry\d+\.netlify\.app$/.test(hostname);
  if (!isWebfoundry) return;

  let toPage = data => window.postMessage({ wfDecorateBridge: true, ...data }, location.origin);

  window.addEventListener('message', async ev => {
    if (ev.source !== window || ev.origin !== location.origin || !ev.data?.wfDecorateBridge) return;
    let { type, rpcid, origin, isolated, json } = ev.data;
    if (type === 'register') {
      try {
        let res = await browser.runtime.sendMessage({ kind: 'register', origin: String(origin), isolated: !!isolated });
        toPage({ type: 'registered', rpcid: String(rpcid), ok: !!res?.ok, version: res?.version });
      } catch (err) {
        toPage({ type: 'registered', rpcid: String(rpcid), ok: false, error: String(err) });
      }
    } else if (type === 'down') {
      browser.runtime.sendMessage({ kind: 'down', json: String(json) });
    }
  });

  browser.runtime.onMessage.addListener(message => {
    if (message.kind === 'up') toPage({ type: 'up', json: message.json, url: message.url });
  });
})();

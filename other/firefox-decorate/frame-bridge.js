// Runs in every iframe at document_start, so it fires on each page load inside the editor's
// frame. Frames the background script didn't grant stop at the first check.
(async () => {
  if (window === window.top) return;
  let grant = await browser.runtime.sendMessage({ kind: 'hello' });
  if (!grant?.wfOrigin) return;

  window.addEventListener('message', ev => {
    if (ev.source !== window || ev.data?.wfDecorate !== 'up') return;
    browser.runtime.sendMessage({ kind: 'up', json: String(ev.data.json) });
  });
  browser.runtime.onMessage.addListener(message => {
    if (message.kind === 'down') window.postMessage({ wfDecorate: 'down', json: message.json }, location.origin);
  });

  // Tells Webfoundry's runtime it's decorating, and which editor it answers to.
  document.documentElement.setAttribute('data-wf-decorating', grant.wfOrigin);

  // Runs in the page: turns the fetched sources into blob: modules wired to each other.
  let boot = sources => {
    let urls = {};
    for (let [name, source] of Object.entries(sources)) {
      for (let [dep, url] of Object.entries(urls)) source = source.split(`./${dep}`).join(url);
      urls[name] = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    }
    return import(urls['ifdesigner.js']);
  };
  // A module <script src> created here would load under the extension's principal and
  // silently never run. An inline script runs as the page.
  let script = document.createElement('script');
  script.textContent = `(${boot})(${JSON.stringify(grant.sources)})`;
  (document.head || document.documentElement).append(script);
  script.remove();
})();

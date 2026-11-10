// Tracks which tabs run a Webfoundry editor and which of their iframes may be decorated.
// Everything here is scoped per tab: a site is only unframed/injected while it is the
// direct child of an editor that registered its origin. Ordinary browsing is untouched.

// tabId -> { wfOrigin, wfFrameId, isolated, targets: Set<origin>, frameIds: Set<frameId>, activeFrameId }
let sessions = new Map();

// In dependency order: frame-bridge.js rewrites each file's imports of the earlier ones.
let RUNTIME_FILES = ['bimap.js', 'dominant.js', 'tailplay4.dafuq.js', 'ifdecorate.js', 'ifdesigner.js'];

// Fetched here because a public site can't load from a localhost editor (Firefox's Local
// Network Access blocks it), and extension requests are exempt.
async function loadRuntime(wfOrigin) {
  let sources = {};
  await Promise.all(RUNTIME_FILES.map(async name => {
    let res = await fetch(`${wfOrigin}/webfoundry/${name}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Failed to load webfoundry/${name}: ${res.status}`);
    sources[name] = await res.text();
  }));
  return Object.fromEntries(RUNTIME_FILES.map(name => [name, sources[name]]));
}

let baseHost = host => host.replace(/^www\./, '');

// The registered origin, or a redirect within the same site (example.com <-> www.example.com).
function isAllowedTarget(session, url) {
  let u;
  try { u = new URL(url) } catch { return false }
  for (let origin of session.targets) {
    let t = new URL(origin);
    if (u.protocol !== t.protocol) continue;
    let [a, b] = [baseHost(u.hostname), baseHost(t.hostname)];
    if (a === b || a.endsWith(`.${b}`)) return true;
  }
  return false;
}

let originOf = url => {
  try { return new URL(url).origin } catch { return null }
};

let setHeader = (headers, name, value) => {
  let lower = name.toLowerCase();
  return [...headers.filter(h => h.name.toLowerCase() !== lower), { name, value }];
};

let FRAME_BLOCKING_HEADERS = /^(x-frame-options|content-security-policy|cross-origin-opener-policy|cross-origin-embedder-policy|cross-origin-resource-policy)$/i;

// A production editor is cross-origin isolated (COEP: require-corp), so anything it embeds
// must opt in as well, or Firefox refuses to load the frame.
function withIsolationHeaders(session, headers) {
  if (!session.isolated) return headers;
  headers = setHeader(headers, 'Cross-Origin-Embedder-Policy', 'credentialless');
  return setHeader(headers, 'Cross-Origin-Resource-Policy', 'cross-origin');
}

browser.webRequest.onHeadersReceived.addListener(details => {
  let session = sessions.get(details.tabId);
  if (!session) return;

  let ancestors = details.frameAncestors || [];
  let parent = ancestors[0];
  let isDirectChild = parent && parent.frameId === session.wfFrameId && originOf(parent.url) === session.wfOrigin;
  if (isDirectChild) {
    if (!isAllowedTarget(session, details.url)) {
      session.frameIds.delete(details.frameId);
      return;
    }
    session.frameIds.add(details.frameId);
    let headers = details.responseHeaders.filter(h => !FRAME_BLOCKING_HEADERS.test(h.name));
    return { responseHeaders: withIsolationHeaders(session, headers) };
  }

  // Frames nested inside a decorated site aren't decorated, but they must still pass COEP.
  if (ancestors.some(x => session.frameIds.has(x.frameId))) {
    return { responseHeaders: withIsolationHeaders(session, details.responseHeaders) };
  }
}, { urls: ['<all_urls>'], types: ['sub_frame'] }, ['blocking', 'responseHeaders']);

browser.runtime.onMessage.addListener((message, sender) => {
  let tabId = sender.tab?.id;
  if (tabId == null) return;
  let session = sessions.get(tabId);

  switch (message.kind) {
    case 'register': {
      let wfOrigin = originOf(sender.url);
      if (!session || session.wfFrameId !== sender.frameId || session.wfOrigin !== wfOrigin) {
        session = { wfOrigin, wfFrameId: sender.frameId, isolated: false, targets: new Set(), frameIds: new Set(), activeFrameId: null };
        sessions.set(tabId, session);
      }
      session.isolated = !!message.isolated;
      session.targets.add(new URL(message.origin).origin);
      return Promise.resolve({ ok: true, version: browser.runtime.getManifest().version });
    }

    case 'hello':
      if (!session?.frameIds.has(sender.frameId)) return Promise.resolve(null);
      session.activeFrameId = sender.frameId;
      return loadRuntime(session.wfOrigin).then(sources => ({ wfOrigin: session.wfOrigin, sources }));

    case 'up':
      if (!session?.frameIds.has(sender.frameId)) return;
      browser.tabs.sendMessage(tabId, { kind: 'up', json: message.json, url: sender.url }, { frameId: session.wfFrameId }).catch(() => {});
      return;

    case 'down':
      if (!session || sender.frameId !== session.wfFrameId || session.activeFrameId == null) return;
      browser.tabs.sendMessage(tabId, { kind: 'down', json: message.json }, { frameId: session.activeFrameId }).catch(() => {});
      return;
  }
});

browser.tabs.onRemoved.addListener(tabId => sessions.delete(tabId));

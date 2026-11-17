/**
 * Browser API shims for running Webfoundry's app.js under Nasty.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nastyApi from 'nasty';
import {
  defineGlobal,
  installWindowGlobalsProxy,
} from './wf-globals.mjs';

const {
  Attr: NastyAttr,
  Comment: NastyComment,
  Document: NastyDocument,
  Element: NastyElement,
  MutationObserver: NastyMutationObserver,
  ResizeObserver: NastyResizeObserver,
  Text: NastyText,
} = nastyApi;

/**
 * Nasty Element/Text/Comment/Document extend EventTarget, not a shared Node base.
 * Dominant and other browser code use `instanceof Node`; provide a constructor
 * whose Symbol.hasInstance covers the Nasty DOM node types.
 */
function installDomConstructors() {
  class Node {
    static [Symbol.hasInstance](instance) {
      return (
        instance instanceof NastyElement
        || instance instanceof NastyText
        || (!!NastyComment && instance instanceof NastyComment)
        || instance instanceof NastyDocument
        || instance instanceof NastyAttr
      );
    }
  }
  // Webfoundry compile() matches `n.nodeType === Node.TEXT_NODE` to rewrite
  // `{{expr}}` interpolations. Without these constants every text node is skipped
  // and mustaches render literally (e.g. Super TodoMVC footer item counts).
  Object.assign(Node, {
    ELEMENT_NODE: 1,
    ATTRIBUTE_NODE: 2,
    TEXT_NODE: 3,
    CDATA_SECTION_NODE: 4,
    ENTITY_REFERENCE_NODE: 5,
    ENTITY_NODE: 6,
    PROCESSING_INSTRUCTION_NODE: 7,
    COMMENT_NODE: 8,
    DOCUMENT_NODE: 9,
    DOCUMENT_TYPE_NODE: 10,
    DOCUMENT_FRAGMENT_NODE: 11,
    NOTATION_NODE: 12,
    DOCUMENT_POSITION_DISCONNECTED: 0x01,
    DOCUMENT_POSITION_PRECEDING: 0x02,
    DOCUMENT_POSITION_FOLLOWING: 0x04,
    DOCUMENT_POSITION_CONTAINS: 0x08,
    DOCUMENT_POSITION_CONTAINED_BY: 0x10,
    DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC: 0x20,
  });

  class HTMLElement {
    static [Symbol.hasInstance](instance) {
      return instance instanceof NastyElement;
    }
  }

  defineGlobal('Node', Node);
  defineGlobal('Element', NastyElement);
  defineGlobal('HTMLElement', HTMLElement);
  defineGlobal('Text', NastyText);
  if (NastyComment) defineGlobal('Comment', NastyComment);
  defineGlobal('Document', NastyDocument);
  defineGlobal('Attr', NastyAttr);
  // Dominant registers portals/if/map via MutationObserver on document.
  if (NastyMutationObserver) defineGlobal('MutationObserver', NastyMutationObserver);
  if (NastyResizeObserver) defineGlobal('ResizeObserver', NastyResizeObserver);

  for (const [name, value] of [
    ['Node', Node],
    ['Element', NastyElement],
    ['HTMLElement', HTMLElement],
    ['Text', NastyText],
    ...(NastyComment ? [['Comment', NastyComment]] : []),
    ['Document', NastyDocument],
    ['Attr', NastyAttr],
    ...(NastyMutationObserver ? [['MutationObserver', NastyMutationObserver]] : []),
    ...(NastyResizeObserver ? [['ResizeObserver', NastyResizeObserver]] : []),
  ]) {
    try {
      Object.defineProperty(globalThis, name, {
        value,
        configurable: true,
        writable: true,
        enumerable: false,
      });
    } catch {
      globalThis[name] = value;
    }
  }
}

export function installShims({ appRoot, win, doc }) {
  installDomConstructors();
  const storage = new Map();
  const localStorage = {
    getItem: (k) => (storage.has(String(k)) ? storage.get(String(k)) : null),
    setItem: (k, v) => storage.set(String(k), String(v)),
    removeItem: (k) => storage.delete(String(k)),
    clear: () => storage.clear(),
    key: (i) => [...storage.keys()][i] ?? null,
    get length() { return storage.size; },
  };

  // Use an http(s)-shaped location so `new URL(location.href).pathname` is a
  // web path (e.g. "/" → pages/index.html). A file:///…/cache/… href made
  // App.update() treat the filesystem path as the route and call alert(404).
  let pathName = '/';
  let search = '';
  let hash = '';
  const origin = 'http://localhost';

  function applyUrl(urlLike) {
    if (urlLike == null || urlLike === '') return;
    const raw = String(urlLike);
    let next;
    try {
      next = new URL(raw, origin + pathName);
    } catch {
      pathName = raw.startsWith('/') ? raw : `/${raw}`;
      return;
    }
    pathName = next.pathname || '/';
    search = next.search || '';
    hash = next.hash || '';
  }

  const location = {
    get href() { return `${origin}${pathName}${search}${hash}`; },
    get pathname() { return pathName; },
    set pathname(v) { pathName = String(v || '/'); },
    get origin() { return origin; },
    get protocol() { return 'http:'; },
    get host() { return 'localhost'; },
    get hostname() { return 'localhost'; },
    get port() { return ''; },
    get search() { return search; },
    set search(v) { search = String(v || ''); },
    get hash() { return hash; },
    set hash(v) { hash = String(v || ''); },
    assign(url) { applyUrl(url); },
    replace(url) { applyUrl(url); },
    reload() {},
    toString() { return this.href; },
  };

  const history = {
    state: null,
    pushState(state, _title, url) {
      this.state = state;
      if (url != null) applyUrl(url);
      win.dispatchEvent?.(new Event('popstate'));
    },
    replaceState(state, _title, url) {
      this.state = state;
      if (url != null) applyUrl(url);
    },
    back() {},
    forward() {},
    go() {},
  };

  const realFetch = globalThis.fetch.bind(globalThis);
  async function fetchShim(input, init) {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (/^https?:\/\//i.test(url) || url.startsWith('data:')) {
      return realFetch(input, init);
    }
    let filePath = null;
    if (url.startsWith('file:')) {
      filePath = fileURLToPath(url);
    } else {
      let rel = url.replace(/^\.\//, '');
      if (rel.startsWith('/')) rel = rel.slice(1);
      const candidates = [join(appRoot, rel), join(appRoot, 'webfoundry', rel)];
      filePath = candidates.find(existsSync) || join(appRoot, rel);
    }
    if (filePath && existsSync(filePath)) {
      const body = readFileSync(filePath);
      const type = filePath.endsWith('.json')
        ? 'application/json'
        : filePath.endsWith('.html')
          ? 'text/html'
          : 'application/octet-stream';
      return new Response(body, { status: 200, headers: { 'content-type': type } });
    }
    return realFetch(input, init);
  }

  const navigator = {
    userAgent: 'Nasty/Webfoundry',
    language: 'en-US',
    languages: ['en-US'],
    platform: process.platform,
    serviceWorker: undefined,
  };

  defineGlobal('document', doc);
  defineGlobal('localStorage', localStorage);
  defineGlobal('sessionStorage', localStorage);
  defineGlobal('location', location);
  defineGlobal('history', history);
  defineGlobal('fetch', fetchShim);
  defineGlobal('navigator', navigator);
  defineGlobal('rootPrefix', '.');

  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: localStorage, configurable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: localStorage, configurable: true });
  Object.defineProperty(globalThis, 'location', { value: location, configurable: true });
  Object.defineProperty(globalThis, 'history', { value: history, configurable: true });
  Object.defineProperty(globalThis, 'fetch', { value: fetchShim, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: navigator, configurable: true });
  Object.defineProperty(globalThis, 'rootPrefix', { value: '.', configurable: true, writable: true });

  const proxy = installWindowGlobalsProxy(win);

  if (!HTMLDialogElementShimInstalled) {
    installDialogShim(doc);
  }

  return { localStorage, location, history, window: proxy };
}

let HTMLDialogElementShimInstalled = false;
function installDialogShim(doc) {
  HTMLDialogElementShimInstalled = true;
  const proto = Object.getPrototypeOf(doc.createElement('dialog'));
  if (!proto.showModal) {
    proto.showModal = function showModal() {
      this.open = true;
      this.setAttribute('open', '');
      this.classList?.add?.('block');
      if (!this.parentNode) doc.body.appendChild(this);
    };
    proto.close = function close(returnValue) {
      if (returnValue !== undefined) this.returnValue = returnValue;
      this.open = false;
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  }
}

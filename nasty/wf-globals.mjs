/**
 * Live ESM bindings for Webfoundry "globals" (state, post, d, …).
 * Node ESM does not resolve bare names from globalThis; importers get live
 * bindings from this module instead. window.X = … is bridged via defineGlobal.
 */

export let anime;
export let arrayify;
export let d;
export let post;
export let rawctrls;
export let renderComponent;
export let renderTemplate;
export let selectFile;
export let showModal;
export let state;
export let tap;
export let triggerRouterError;
export let wfeval;
export let document;
export let window;
export let localStorage;
export let sessionStorage;
export let location;
export let history;
export let fetch;
export let navigator;
export let rootPrefix;
/** Exported bundle (product) name; native only — undefined on the web. */
export let bundleName;

/** DOM constructors used as bare globals (Dominant `instanceof Node`, etc.). */
export let Node;
export let Element;
export let HTMLElement;
export let Text;
export let Comment;
export let Document;
export let Attr;
export let MutationObserver;
export let ResizeObserver;

/** Browser window APIs used as bare globals in WF (Node ESM has no Window scope). */
export let addEventListener;
export let removeEventListener;
export let dispatchEvent;
export let requestAnimationFrame;
export let cancelAnimationFrame;
export let scrollTo;
/** Present so injected imports succeed; throws Not implemented. */
export let alert;

/** Data-like globals set via window.X = … */
export const WF_DATA_GLOBAL_NAMES = [
  'anime',
  'arrayify',
  'd',
  'post',
  'rawctrls',
  'renderComponent',
  'renderTemplate',
  'selectFile',
  'showModal',
  'state',
  'tap',
  'triggerRouterError',
  'wfeval',
  'document',
  'window',
  'localStorage',
  'sessionStorage',
  'location',
  'history',
  'fetch',
  'navigator',
  'rootPrefix',
  'bundleName',
  'Node',
  'Element',
  'HTMLElement',
  'Text',
  'Comment',
  'Document',
  'Attr',
  'MutationObserver',
  'ResizeObserver',
];

/** Methods forwarded from the Nasty Window (and alert no-op). */
export const WF_WINDOW_METHOD_NAMES = [
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'scrollTo',
  'alert',
];

export const WF_GLOBAL_NAMES = [...WF_DATA_GLOBAL_NAMES, ...WF_WINDOW_METHOD_NAMES];

const setters = {
  anime: (v) => { anime = v; },
  arrayify: (v) => { arrayify = v; },
  d: (v) => { d = v; },
  post: (v) => { post = v; },
  rawctrls: (v) => { rawctrls = v; },
  renderComponent: (v) => { renderComponent = v; },
  renderTemplate: (v) => { renderTemplate = v; },
  selectFile: (v) => { selectFile = v; },
  showModal: (v) => { showModal = v; },
  state: (v) => { state = v; },
  tap: (v) => { tap = v; },
  triggerRouterError: (v) => { triggerRouterError = v; },
  wfeval: (v) => { wfeval = v; },
  document: (v) => { document = v; },
  window: (v) => { window = v; },
  localStorage: (v) => { localStorage = v; },
  sessionStorage: (v) => { sessionStorage = v; },
  location: (v) => { location = v; },
  history: (v) => { history = v; },
  fetch: (v) => { fetch = v; },
  navigator: (v) => { navigator = v; },
  rootPrefix: (v) => { rootPrefix = v; },
  bundleName: (v) => { bundleName = v; },
  Node: (v) => { Node = v; },
  Element: (v) => { Element = v; },
  HTMLElement: (v) => { HTMLElement = v; },
  Text: (v) => { Text = v; },
  Comment: (v) => { Comment = v; },
  Document: (v) => { Document = v; },
  Attr: (v) => { Attr = v; },
  MutationObserver: (v) => { MutationObserver = v; },
  ResizeObserver: (v) => { ResizeObserver = v; },
  addEventListener: (v) => { addEventListener = v; },
  removeEventListener: (v) => { removeEventListener = v; },
  dispatchEvent: (v) => { dispatchEvent = v; },
  requestAnimationFrame: (v) => { requestAnimationFrame = v; },
  cancelAnimationFrame: (v) => { cancelAnimationFrame = v; },
  scrollTo: (v) => { scrollTo = v; },
  alert: (v) => { alert = v; },
};

const getters = {
  anime: () => anime,
  arrayify: () => arrayify,
  d: () => d,
  post: () => post,
  rawctrls: () => rawctrls,
  renderComponent: () => renderComponent,
  renderTemplate: () => renderTemplate,
  selectFile: () => selectFile,
  showModal: () => showModal,
  state: () => state,
  tap: () => tap,
  triggerRouterError: () => triggerRouterError,
  wfeval: () => wfeval,
  document: () => document,
  window: () => window,
  localStorage: () => localStorage,
  sessionStorage: () => sessionStorage,
  location: () => location,
  history: () => history,
  fetch: () => fetch,
  navigator: () => navigator,
  rootPrefix: () => rootPrefix,
  bundleName: () => bundleName,
  Node: () => Node,
  Element: () => Element,
  HTMLElement: () => HTMLElement,
  Text: () => Text,
  Comment: () => Comment,
  Document: () => Document,
  Attr: () => Attr,
  MutationObserver: () => MutationObserver,
  ResizeObserver: () => ResizeObserver,
  addEventListener: () => addEventListener,
  removeEventListener: () => removeEventListener,
  dispatchEvent: () => dispatchEvent,
  requestAnimationFrame: () => requestAnimationFrame,
  cancelAnimationFrame: () => cancelAnimationFrame,
  scrollTo: () => scrollTo,
  alert: () => alert,
};

/** Reassign a live export and mirror onto globalThis when possible. */
export function defineGlobal(name, value) {
  const set = setters[name];
  if (!set) {
    try {
      globalThis[name] = value;
    } catch {
      /* ignore */
    }
    return;
  }
  set(value);
  if (name !== 'window' && name !== 'document') {
    try {
      globalThis[name] = value;
    } catch {
      /* ignore */
    }
  }
}

export function readGlobal(name) {
  const get = getters[name];
  return get ? get() : globalThis[name];
}

/**
 * Wrap the Nasty Window so `window.state = …` updates live ESM bindings
 * (same authoring model as the browser). Also bind bare addEventListener etc.
 */
export function installWindowGlobalsProxy(win) {
  const dataNames = new Set(WF_DATA_GLOBAL_NAMES);
  const proxy = new Proxy(win, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && dataNames.has(prop) && prop !== 'window') {
        return readGlobal(prop);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, prop, value, receiver) {
      if (typeof prop === 'string' && dataNames.has(prop) && prop !== 'window') {
        defineGlobal(prop, value);
        return true;
      }
      return Reflect.set(target, prop, value, receiver);
    },
    has(target, prop) {
      if (typeof prop === 'string' && dataNames.has(prop)) return true;
      return Reflect.has(target, prop);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === 'string' && dataNames.has(prop) && prop !== 'window') {
        return { configurable: true, enumerable: true, writable: true, value: readGlobal(prop) };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });

  defineGlobal('window', proxy);

  // Bare window methods → underlying Nasty Window (not the proxy, avoid recursion).
  defineGlobal('addEventListener', (...args) => win.addEventListener(...args));
  defineGlobal('removeEventListener', (...args) => win.removeEventListener(...args));
  defineGlobal('dispatchEvent', (...args) => win.dispatchEvent(...args));
  defineGlobal('requestAnimationFrame', (...args) => win.requestAnimationFrame(...args));
  defineGlobal('cancelAnimationFrame', (...args) => win.cancelAnimationFrame(...args));
  defineGlobal('scrollTo', () => {});
  defineGlobal('alert', () => {
    throw new Error('Not implemented');
  });

  try {
    Object.defineProperty(globalThis, 'window', {
      value: proxy,
      configurable: true,
      writable: true,
      enumerable: false,
    });
  } catch {
    globalThis.window = proxy;
  }
  return proxy;
}

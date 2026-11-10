import BiMap from './bimap.js';
import Boo from 'https://esm.run/@camilaprav/boo@1.0.6';
import d from './dominant.js';
import htmlsnap from 'https://esm.run/@camilaprav/htmlsnap@0.0.16';
import morphdom from 'https://esm.run/morphdom';

// Injected by the Firefox extension into another site (Decoration projects): no page globals,
// and traffic goes through the extension instead of parent.postMessage.
let decoratingFor = document.documentElement.getAttribute('data-wf-decorating');
let decorating = decoratingFor != null;
let state = { map: new BiMap(), cursors: {}, overlays: {} };
if (!decorating) window.state = state;
// htmlsnap needs randomUUID, which plain-HTTP sites don't have.
if (decorating && !crypto.randomUUID) {
  crypto.randomUUID = () => '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
}
let wforigin = decorating ? decoratingFor : new URL(location.href).searchParams.get('isolate') || location.origin;
if (/^(\w+\.)?(webfoundry.app|webfoundry\d+\.netlify\.app|localhost)$/.test(wforigin)) throw new Error(`Bad isolation origin`);
let post = decorating
  ? data => window.postMessage({ wfDecorate: 'up', json: JSON.stringify(data) }, location.origin)
  : data => parent.postMessage({ path: null, ...data, path: location.pathname.slice(1).split('/').slice(3).join('/') }, wforigin);
if (decorating) {
  // Bridge deliveries re-enter as ordinary messages from Webfoundry, so every listener below applies.
  addEventListener('message', ev => {
    if (ev.source !== window || ev.data?.wfDecorate !== 'down') return;
    dispatchEvent(new MessageEvent('message', { data: JSON.parse(ev.data.json), origin: wforigin }));
  });
}
let components = {};

// Platform variants. Each is a condition on the element itself (`&:is(html[…] *)`)
// so they stack (lin:mobile:hidden). :is() keeps specificity: OS > desktop|mobile > native > bare.
let PLATFORM_VARIANTS_CSS = [
  '@custom-variant native (&:is(html:where([wf-native-preview]) *));',
  '@custom-variant desktop (&:is(html[wf-desktop-preview] *));',
  '@custom-variant mobile (&:is(html[wf-mobile-preview] *));',
  '@custom-variant win (&:is(html[wf-win-preview] *));',
  '@custom-variant lin (&:is(html[wf-lin-preview] *));',
  '@custom-variant mac (&:is(html[wf-mac-preview] *));',
  '@custom-variant android (&:is(html[wf-android-preview] *));',
  '',
].join('\n');
let PLATFORM_OSES = ['win', 'lin', 'mac', 'android'];

/** Ensure Tailwind sees the platform variants even if the project's head.js is stale. */
function ensurePlatformVariantStyles() {
  let style = document.querySelector('style.wf-platform-variants');
  if (style?.textContent === PLATFORM_VARIANTS_CSS) return;
  if (!style) {
    style = document.createElement('style');
    style.type = 'text/tailwindcss';
    style.className = 'wf-platform-variants';
    document.head.append(style);
  }
  style.textContent = PLATFORM_VARIANTS_CSS;
}

/**
 * Gate platform variants via html preview attributes. `mode` is the form factor
 * (off | desktop | mobile); `os` is web | win | lin | mac | android. Any form factor
 * turns on native:; an OS adds its own attribute. Parent posts (isolate is cross-origin).
 */
function applyPlatformPreview(mode, os = 'web') {
  ensurePlatformVariantStyles();
  let root = document.documentElement;
  for (let x of ['desktop', 'mobile', 'native', ...PLATFORM_OSES]) root.removeAttribute(`wf-${x}-preview`);
  if (mode === 'off') return;
  root.setAttribute('wf-native-preview', '');
  root.setAttribute(`wf-${mode}-preview`, '');
  if (PLATFORM_OSES.includes(os)) root.setAttribute(`wf-${os}-preview`, '');
}

// Legacy values: true (old native preview) and win/lin/mac (OS-as-mode) imply desktop.
function normalizePlatformPreview(value) {
  if (value === 'desktop' || value === 'mobile') return value;
  if (value === true || value === 'true' || value === 'nux' || PLATFORM_OSES.includes(value)) return 'desktop';
  return 'off';
}

function normalizePlatformOs(value, legacyMode) {
  if (value === 'nux' || legacyMode === 'nux') return 'lin'; // Linux was `nux`
  if (PLATFORM_OSES.includes(value)) return value;
  if (PLATFORM_OSES.includes(legacyMode)) return legacyMode;
  return 'web';
}

// Like el.scrollIntoView(), but only scrolls containers inside this document (ending at this
// frame's own viewport). scrollIntoView() also scrolls every ancestor window, which yanks the
// editor and any page embedding it (e.g. the landing page demo).
function scrollWithinFrame(el, { block = 'nearest', inline = 'nearest' } = {}) {
  let root = document.scrollingElement || document.documentElement;
  let canScroll = (x, axis) => {
    let cs = getComputedStyle(x);
    let overflow = axis === 'y' ? cs.overflowY : cs.overflowX;
    return /^(auto|scroll|overlay)$/.test(overflow) && (axis === 'y' ? x.scrollHeight > x.clientHeight : x.scrollWidth > x.clientWidth);
  };
  // body's overflow propagates to the viewport unless <html> sets its own, so it only scrolls itself in that case.
  let bodyIsOwnScroller = getComputedStyle(document.documentElement).overflow !== 'visible';
  let scrollers = [];
  for (let x = el.parentElement; x && x !== root; x = x.parentElement) {
    if (x === document.body && !bodyIsOwnScroller) continue;
    if (canScroll(x, 'y') || canScroll(x, 'x')) scrollers.push(x);
  }
  scrollers.push(root);
  let delta = (start, end, viewStart, viewEnd, mode) => {
    if (mode === 'center') return (start + end) / 2 - (viewStart + viewEnd) / 2;
    if (start >= viewStart && end <= viewEnd) return 0;
    if (start < viewStart || end - start > viewEnd - viewStart) return start - viewStart;
    return end - viewEnd;
  };
  for (let sc of scrollers) {
    let r = el.getBoundingClientRect();
    let view;
    if (sc === root) view = { top: 0, left: 0, bottom: innerHeight, right: innerWidth };
    else {
      let b = sc.getBoundingClientRect();
      let top = b.top + sc.clientTop, left = b.left + sc.clientLeft;
      view = { top, left, bottom: top + sc.clientHeight, right: left + sc.clientWidth };
    }
    sc.scrollTop += delta(r.top, r.bottom, view.top, view.bottom, block);
    sc.scrollLeft += delta(r.left, r.right, view.left, view.right, inline);
  }
}

addEventListener('message', async ev => {
  let { type, ...rest } = ev.data;
  if (type !== 'state' || ev.origin !== wforigin) return;
  let uid = state.collab?.uid;
  let changed = k => rest.cursors?.[k]?.length && JSON.stringify(state.cursors[k]) !== JSON.stringify(rest.cursors[k]);
  // Follow our own selection; while we have none, follow whichever agent just changed its selection.
  let follow = uid && (JSON.stringify(state.cursors[uid]) !== JSON.stringify(rest.cursors?.[uid]) ? uid
    : !rest.cursors?.[uid]?.length && Object.keys(rest.cursors || {}).filter(k => /(^|\/)agent:/.test(k) && changed(k)).at(-1));
  if (follow) {
    let scroll = () => {
      let first = state.map.get(rest.cursors[follow]?.at?.(-1));
      let rect = first?.getBoundingClientRect?.();
      let visible = rect && rect.top >= 20 && rect.bottom <= innerHeight - 20;
      !visible && first && scrollWithinFrame(first, { block: rect.height <= innerHeight ? 'center' : 'nearest', inline: rect.width <= innerWidth ? 'center' : 'nearest' });
    };
    uid === 'master' ? scroll() : setTimeout(scroll, 500);
  }
  if ('platformPreview' in rest) applyPlatformPreview(normalizePlatformPreview(rest.platformPreview), normalizePlatformOs(rest.platformOs, rest.platformPreview));
  else if ('nativePreview' in rest) applyPlatformPreview(rest.nativePreview ? 'desktop' : 'off');
  Object.assign(state, rest);
  d.update();
});
addEventListener('message', async ev => {
  if (ev.data.type !== 'platformPreview' || ev.origin !== wforigin) return;
  applyPlatformPreview(normalizePlatformPreview(ev.data.mode), normalizePlatformOs(ev.data.os, ev.data.mode));
});
addEventListener('message', async ev => {
  if (ev.data.type !== 'nativePreview' || ev.origin !== wforigin) return;
  applyPlatformPreview(ev.data.enabled ? 'desktop' : 'off');
});
addEventListener('message', async ev => {
  if (ev.data.type !== 'update' || ev.origin !== wforigin) return;
  let doc = new DOMParser().parseFromString(ev.data.html, 'text/html')
  morphdom(document.head, doc.head);
  morphdom(document.body.firstElementChild, doc.body.firstElementChild);
});
addEventListener('message', async ev => {
  if (ev.data.type !== 'eval' || ev.origin !== wforigin) return;
  try {
    let AsyncFunction = (async () => {}).constructor;
    let fn = new AsyncFunction('state', 'args', ev.data.fn);
    post({ type: 'eval:res', rpcid: ev.data.rpcid, result: await fn(state, ev.data.args) });
  } catch (err) {
    console.error(err);
    post({ type: 'eval:res', rpcid: ev.data.rpcid, error: err.toString() });
  }
});
addEventListener('message', async ev => {
  if (ev.data.type !== 'templates' || ev.origin !== wforigin) return;
  components = {};
  for (let x of Object.values(ev.data.templates)) {
    let doc = new DOMParser().parseFromString(x, 'text/html');
    for (let y of doc.querySelectorAll('[id]')) {
      if (y.parentElement.closest('[id]')) continue;
      components[y.id] = y;
    }
  }
  expandComponents();
});
function expandComponents() {
  for (let x of document.querySelectorAll('[wf-component]')) {
    let k = x.getAttribute('wf-component');
    let c = components[k]?.cloneNode?.(true);
    if (!c) continue;
    c.setAttribute('wf-component', k);
    x.getAttribute('wf-props') && c.setAttribute('wf-props', x.getAttribute('wf-props'));
    if (x.outerHTML === c.outerHTML) continue;
    x.replaceWith(c);
    // FIXME: state.map.set(state.map.getKey(x), c);
  }
}
if (!decorating) {
  addEventListener('click', ev => ev.preventDefault());
  addEventListener('mousedown', async ev => {
    if (ev.button !== 0) return;
    document.activeElement.blur();
    ev.preventDefault();
    let { target } = ev;
    let croot = target.closest('[wf-component]');
    if (croot) target = croot;
    if (!ev.shiftKey) post({ type: 'action', key: 'changeSelection', cur: state.collab.uid, s: [state.map.getKey(target)] });
    else post({ type: 'action', key: 'changeSelection', cur: state.collab.uid, s: [...new Set([...state.cursors[state.collab.uid] || [], state.map.getKey(target)])] });
  });
}
addEventListener('keydown', ev => {
  if (decorating && state.decorate?.preview) return;
  post({ type: 'keydown', key: ev.key, ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey });
});
async function trackCursors() {
  requestAnimationFrame(async () => await trackCursors());
  if (!document.body) return; // document.open
  for (let k of Object.keys(state.overlays)) {
    if (state.cursors[k]) continue;
    for (let x of state.overlays[k]) x.disable();
    delete state.overlays[k];
  }
  for (let [k, ids] of Object.entries(state.cursors)) {
    let ovs = (state.overlays[k] ??= []);
    while (ids.length > ovs.length) {
      let i = ovs.length;
      let color = () => state.cursorColors?.[k] ?? '';
      // The border is a child so its fade doesn't compete with Boo's transition class on the overlay.
      let o = d.el('div', { class: 'wf-cursor hidden z-1000 pointer-events-none' }, d.el('div', {
        class: ['absolute inset-0 transition-opacity', () => color() ? 'border' : 'border border-blue-400', () => state.fadedCursors?.includes(k) ? 'opacity-0' : ''],
        style: { borderColor: color },
      }));
      ovs.push(new Boo(o, () => state.map.get(state.cursors[k][i]), { transitionClass: 'transition-[left,right,top,bottom]' }));
    }
    while (ovs.length > ids.length) ovs.pop().disable();
    for (let x of ovs) !x.ov.parentElement && document.body.append(x.ov);
  }
}
await trackCursors();
let snap = () => {
  let [snap, map] = htmlsnap(document.documentElement, { idtrack: true, map: state.map });
  state.map = map;
  let doc = new DOMParser().parseFromString(snap, 'text/html');
  doc.querySelectorAll('.wf-cursor').forEach(x => x.remove());
  // A site's scripts and styles can be huge and the editor's mirror never needs them.
  if (decorating) doc.querySelectorAll('script, style, link, noscript, template, [data-wfd-ui]').forEach(x => x.remove());
  // Runtime-only platform preview chrome — never persist into the authored page.
  doc.documentElement.removeAttribute('wf-desktop-preview');
  doc.documentElement.removeAttribute('wf-mobile-preview');
  doc.documentElement.removeAttribute('wf-native-preview');
  doc.querySelectorAll('style.wf-platform-variants, style.wf-native-variant').forEach(x => x.remove());
  for (let x of doc.querySelectorAll('[wf-component]')) {
    let props = x.getAttribute('wf-props') || '';
    if (props) props = ` wf-props="${props.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}"`;
    x.outerHTML = `<${x.tagName.toLowerCase()} data-htmlsnap="${x.getAttribute('data-htmlsnap')}" wf-component="${x.getAttribute('wf-component')}"${props}></${x.tagName.toLowerCase()}>`;
  }
  if (doc.documentElement.outerHTML === state.snap) return;
  snap = state.snap = doc.documentElement.outerHTML;
  post({ type: 'htmlsnap', snap });
};
// Real sites mutate constantly, and each snapshot serializes the whole document.
let snapTimer = null;
let scheduleSnap = decorating ? () => { snapTimer ??= setTimeout(() => { snapTimer = null; snap() }, 250) } : snap;
let mutobs = new MutationObserver(() => { expandComponents(); scheduleSnap() });
mutobs.observe(document, { attributes: true, subtree: true, childList: true, characterData: true });
if (decorating) {
  if (document.readyState === 'loading') await new Promise(resolve => addEventListener('DOMContentLoaded', resolve, { once: true }));
  let { createRuntime } = await import('./ifdecorate.js');
  state.decorate = createRuntime({ post, wforigin, morphdom, getId: el => state.map.getKey(el), moduleUrl: import.meta.url });
  // The editor resets its mirror on ready, so the first snapshot has to come after it.
  post({ type: 'ready', status: 200 });
  snap();
  state.decorate.reportUrl();
} else {
  snap();
  post({ type: 'ready', status: 200 });
}

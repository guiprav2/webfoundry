import BiMap from './bimap.js';
import Boo from 'https://cdn.jsdelivr.net/npm/@camilaprav/boo@1.0.6/+esm';
import d from './dominant.js';
import htmlsnap from 'https://cdn.jsdelivr.net/npm/@camilaprav/htmlsnap@0.0.16/+esm';
import morphdom from 'https://cdn.jsdelivr.net/npm/morphdom@2.7.8/+esm';

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
// ?isolate= names the editor trusted with eval and state, so any site framing a project origin could
// claim it. Only accept the editor this origin hangs off: same scheme, its parent domain or a sibling
// that isn't another project's frame (those labels end in a uuid; see isolationLabel in other/util.js).
if (!decorating && new URL(location.href).searchParams.get('isolate') != null && !(() => {
  let u;
  try { u = new URL(wforigin) } catch { return false }
  let root = location.host.split('.').slice(1).join('.');
  if (u.origin !== wforigin || u.protocol !== location.protocol || !root) return false;
  if (u.host === root) return true;
  return u.host.endsWith(`.${root}`) && !/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(u.hostname.split('.')[0]);
})()) throw new Error(`Bad isolation origin`);
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
// Walks every scroll container between el and the viewport, innermost first, and moves each one
// only when el isn't fully visible within it (keeping `margin` px clear): centered when el fits,
// else aligned to its start. Only axes the user can scroll move: overflow: hidden (or clip) clips
// without a scrollbar, so the page's own layout decides what shows there, not the editor.
function scrollWithinFrame(el, { margin = 20 } = {}) {
  let root = document.scrollingElement || document.documentElement;
  let scrollable = overflow => /^(auto|scroll|overlay)$/.test(overflow);
  // body's overflow propagates to the viewport unless <html> sets its own, so it only scrolls itself in that case.
  let html = getComputedStyle(document.documentElement);
  let bodyIsOwnScroller = html.overflow !== 'visible';
  let viewportStyle = bodyIsOwnScroller ? html : getComputedStyle(document.body);
  let scrollers = [];
  for (let x = el.parentElement; x && x !== root; x = x.parentElement) {
    if (x === document.body && !bodyIsOwnScroller) continue;
    let cs = getComputedStyle(x);
    let y = scrollable(cs.overflowY) && x.scrollHeight > x.clientHeight;
    let xAxis = scrollable(cs.overflowX) && x.scrollWidth > x.clientWidth;
    if (y || xAxis) scrollers.push({ sc: x, y, x: xAxis });
  }
  // The viewport scrolls unless its overflow is hidden or clipped (visible behaves as auto there).
  let viewportAxis = overflow => overflow !== 'hidden' && overflow !== 'clip';
  scrollers.push({ sc: root, y: viewportAxis(viewportStyle.overflowY), x: viewportAxis(viewportStyle.overflowX) });
  let delta = (start, end, viewStart, viewEnd) => {
    let m = Math.min(margin, Math.max(0, (viewEnd - viewStart - (end - start)) / 2));
    if (start >= viewStart + m && end <= viewEnd - m) return 0;
    if (end - start <= viewEnd - viewStart) return (start + end) / 2 - (viewStart + viewEnd) / 2;
    return start - viewStart;
  };
  for (let { sc, x, y } of scrollers) {
    let r = el.getBoundingClientRect();
    let view;
    if (sc === root) view = { top: 0, left: 0, bottom: root.clientHeight || innerHeight, right: root.clientWidth || innerWidth };
    else {
      let b = sc.getBoundingClientRect();
      let top = b.top + sc.clientTop, left = b.left + sc.clientLeft;
      view = { top, left, bottom: top + sc.clientHeight, right: left + sc.clientWidth };
    }
    let dy = delta(r.top, r.bottom, view.top, view.bottom);
    let dx = delta(r.left, r.right, view.left, view.right);
    if (dy && y) sc.scrollTop += dy;
    if (dx && x) sc.scrollLeft += dx;
  }
}

let handledFollowToken = null;
addEventListener('message', async ev => {
  let { type, ...rest } = ev.data;
  if (type !== 'state' || ev.origin !== wforigin) return;
  // The first message after a (re)load is also what sets state.collab.
  let uid = rest.collab?.uid ?? state.collab?.uid;
  let changed = k => rest.cursors?.[k]?.length && JSON.stringify(state.cursors[k]) !== JSON.stringify(rest.cursors[k]);
  // Follow our own selection; while we have none, follow whichever agent just changed its selection.
  // followCursor: the IDE just brought this page up for an agent; scroll to it once per document.
  let hint = rest.followCursor;
  let hinted = hint?.token && hint.token !== handledFollowToken && hint.cur;
  delete rest.followCursor;
  let follow = uid && (JSON.stringify(state.cursors[uid]) !== JSON.stringify(rest.cursors?.[uid]) ? uid
    : rest.followAgents && !rest.cursors?.[uid]?.length && (hinted || Object.keys(rest.cursors || {}).filter(k => /(^|\/)agent:/.test(k) && changed(k)).at(-1)));
  if (follow) {
    // A page the IDE just brought up may not be mapped or laid out yet (its iframe is still being
    // shown), and scrolling a hidden frame does nothing, so retry for a few seconds.
    let scroll = (tries = 40) => {
      let first = state.map.get(rest.cursors[follow]?.at?.(-1));
      let laidOut = first?.isConnected && innerHeight > 0 && first.getClientRects().length;
      if (!laidOut) return tries > 0 && setTimeout(() => scroll(tries - 1), 100);
      scrollWithinFrame(first);
      if (follow === hinted) handledFollowToken = hint.token;
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

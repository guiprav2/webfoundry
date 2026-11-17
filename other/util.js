import { lookup as mimeLookup } from 'https://cdn.jsdelivr.net/npm/mrmime@2.0.1/+esm';

window.tap = x => (console.log(x), x);

export let resolve = x => (typeof x === 'function' ? x() : x);

// Decoration projects (see controllers/Decoration.js) keep their hooks in this file.
export let DECORATION_FILE = 'site.decoration.json';
export let isDecorationPath = path => path === DECORATION_FILE;

// Subdomain label of a project's isolated frame origin ('name:uuid' -> 'name-uuid').
// Labels that fit DNS's 63 characters stay as they always were (their origins hold preview app data);
// longer ones get the name part truncated.
export function isolationLabel(project) {
  let clean = x => x.toLowerCase().replace(/[^a-z0-9:-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  let [name, uuid] = String(project).split(':');
  let label = clean(`${name}-${uuid}`);
  if (label.length <= 63) return label;
  uuid = clean(uuid);
  name = clean(name).slice(0, Math.max(0, 62 - uuid.length)).replace(/-+$/, '');
  return name ? `${name}-${uuid}` : uuid;
}

export function normalizeOrigin(value) {
  let text = String(value ?? '').trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  try {
    let url = new URL(text);
    return /^https?:$/.test(url.protocol) && url.hostname ? url.origin : null;
  } catch {
    return null;
  }
}

// Decoration frames hold another site, reachable only through the Firefox extension.
export function framePost(frame, msg) {
  if (frame.decoration) return window.postMessage({ wfDecorateBridge: true, type: 'down', json: JSON.stringify(msg) }, location.origin);
  if (frame.el?.contentWindow) frame.el.contentWindow.postMessage(msg, new URL(frame.el.src).origin);
}

// fn must be a block-bodied function: its source text becomes the body run inside the frame.
export let ifeval = (fn, args) => new Promise((resolve, reject) => {
  let frame = state.designer.target;
  let iforigin = new URL(frame.el.src).origin;
  let rpcid = crypto.randomUUID();
  let body = fn.toString().replace(/^async\s*/, '').replace(/^[^(]*\([^)]*\)\s*=>\s*\{?/, '').replace(/\}$/, '').trim();
  let listener = ev => {
    if (ev.origin !== iforigin || ev.data.type !== 'eval:res' || ev.data.rpcid !== rpcid) return;
    removeEventListener('message', listener);
    if (ev.data.error) reject(new Error(ev.data.error));
    else resolve(ev.data.result);
  };
  addEventListener('message', listener);
  framePost(frame, { type: 'eval', fn: body, rpcid, args });
});

export function arrayify(x, opt = null) {
  if (Array.isArray(x)) return x;
  if (x === undefined || (opt === 'nonull' && x === null)) return [];
  return [x];
}

export function debounce(func, delay) {
  let timeoutId;
  let pending = [];
  let lastArgs;
  let lastThis;
  return function (...args) {
    clearTimeout(timeoutId);
    lastArgs = args;
    lastThis = this;
    if (func.constructor.name === 'AsyncFunction') {
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
        timeoutId = setTimeout(() => {
          let waiters = pending;
          pending = [];
          func.apply(lastThis, lastArgs)
            .then(result => waiters.forEach(p => p.resolve(result)))
            .catch(err => waiters.forEach(p => p.reject(err)));
        }, delay);
      });
    } else {
      timeoutId = setTimeout(() => func.apply(lastThis, lastArgs), delay);
    }
  };
}

// Webfoundry's own analytics tag lives in the site's root index.html, which doubles as the
// project template. It must never reach a user's project, preview or export.
export function stripClarity(html) {
  return String(html).replace(/[ \t]*<script\b[^>]*>(?:(?!<\/script>)[\s\S])*<\/script>[ \t]*\n?/gi, x => x.includes('clarity.ms') ? '' : x);
}

export function esc(str) { return str == null ? '' : String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;') }

export let joinPath = window.joinPath = (path, name) => [...(path?.split?.('/') || []), name].filter(Boolean).join('/');

export async function selectFile(accept) {
  let { promise: p, resolve: res } = Promise.withResolvers();
  let input = d.el('input', { type: 'file', /*accept,*/ class: 'hidden' });
  input.addEventListener('change', ev => res(input.files[0]));
  document.body.append(input);
  input.click();
  input.remove();
  return p;
}

export function isMedia(path) {
  let type = mimeLookup(path);
  return type?.startsWith?.('image/') || type?.startsWith?.('video/') || type?.startsWith?.('audio/');
};

window.isMedia = isMedia;
window.mimeLookup = mimeLookup;

class LoadingManager {
  ops = {};

  busy(k) {
    let { ops } = this;
    if (k) return ops[k]?.length || 0;
    return Object.values(ops).flat().length;
  }

  async run(k, fn, multi = false) {
    let { ops } = this;
    ops[k] ??= [];
    if (!multi && ops[k].length)
      throw new Error(`Operation already running: "${k}"`);
    ops[k].push(fn);
    d.update();
    let result;
    try {
      result = await fn();
    } finally {
      ops[k].splice(ops[k].indexOf(fn), 1);
      if (!ops[k].length) delete ops[k];
      d.update();
    }
    return result;
  }
}

export let loadman = window.loadman = new LoadingManager();

import { lookup as mimeLookup } from 'https://esm.sh/mrmime';

window.tap = x => (console.log(x), x);

export let resolve = x => (typeof x === 'function' ? x() : x);

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

// Page-targeted editing of frames other than the one on screen ("shadow editors").
//
// Actions find their frame through state.designer.target, which is the visible frame unless a
// withFrame() scope is running. A scope spans awaits, so it can't overlap anything else that
// runs actions: scopes run one at a time, wait for in-flight userAction()s, and hold back new
// ones until they finish. Every entry point that runs actions outside a scope uses userAction().

import { joinPath } from './util.js';

let BUSY_TIMEOUT = 5000;
let LOAD_TIMEOUT = 35000;

let scopes = null; // Tail of the scope queue; null when no scope is queued or running.
let inflight = 0;

let sleep = ms => new Promise(pres => setTimeout(pres, ms));

let findFrame = path => state.designer.list.find(x => x.path === path);

// Starts fn synchronously when no scope is active, so callers can still preventDefault().
export function userAction(fn) {
  if (scopes) return scopes.then(() => userAction(fn));
  return (async () => {
    ++inflight;
    try { return await fn() }
    finally { --inflight }
  })();
}

export function withFrame(frame, fn) {
  let run = (scopes || Promise.resolve()).then(async () => {
    let deadline = Date.now() + BUSY_TIMEOUT;
    while (inflight) {
      if (Date.now() > deadline) throw new Error(`Editor busy with another action (is a dialog open?). Retry shortly.`);
      await sleep(25);
    }
    if (!state.designer.list.includes(frame)) throw new Error(`Editor closed: ${frame.path}`);
    state.designer.scoped = frame;
    try { return await fn() }
    finally { state.designer.scoped = null }
  });
  let settled = run.catch(() => {}).then(() => { if (scopes === settled) scopes = null });
  scopes = settled;
  return run;
}

function pageExists(path) {
  return (state.files.list || []).some(x => Array.isArray(x) && !x[2] && joinPath(x[1] || '', x[0]) === path);
}

// Finds the page's frame, loading it hidden if needed, and waits until it can take edits.
export async function ensureFrame(path) {
  if (!state.projects.current) throw new Error(`Project not open`);
  if (!path.endsWith('.html')) throw new Error(`Not an HTML page: ${path}`);
  if (!findFrame(path)) {
    if (!pageExists(path)) throw new Error(`Page not found: ${path}`);
    await post('designer.select', path, { shadow: true });
  }
  let deadline = Date.now() + LOAD_TIMEOUT;
  while (true) {
    let frame = findFrame(path);
    if (!frame) throw new Error(`Page failed to load: ${path}`);
    if (frame.ready) return frame;
    if (Date.now() > deadline) throw new Error(`Timed out loading page: ${path}`);
    await sleep(25);
  }
}

// Runs fn with state.designer.target set to the page's frame, loading it first if needed.
// Frames stay open afterwards: removing one from state.designer.list makes wf-map re-insert
// every iframe, which reloads them all and invalidates their htmlsnap IDs.
export async function withPage(path, fn) {
  return await withFrame(await ensureFrame(path), fn);
}

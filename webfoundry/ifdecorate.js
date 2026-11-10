// Decoration runtime. Loaded by ifdesigner.js when it was injected into another site by the
// Firefox extension. It resolves hooks against the live page and applies what they carry:
// extra Tailwind classes, and Webfoundry-owned elements around or over the hooked element.

export let OWNED = 'data-wf-owned';
export let HOOK = 'data-wfd-hook';
export let GHOST = 'data-wfd-ghost';
export let UI = 'data-wfd-ui';

let VOID_TAGS = new Set(['AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT', 'LINK', 'META', 'SOURCE', 'TRACK', 'WBR']);
let NOT_OURS = `[${OWNED}],[${GHOST}],[${UI}],.wf-cursor`;

let normalize = s => (s || '').replace(/\s+/g, ' ').trim();
let ownText = el => normalize([...el.childNodes].filter(x => x.nodeType === 3).map(x => x.nodeValue).join(' '));

function accessibleName(el) {
  let labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    let text = normalize(labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' '));
    if (text) return text;
  }
  return normalize(el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder') || el.textContent);
}

function textOf(el, source) {
  if (source === 'own') return ownText(el);
  if (source === 'label') return accessibleName(el);
  return normalize(el.textContent);
}

function textTest({ value, mode = 'contains', source = 'full', ignoreCase = true }) {
  if (mode === 'regex') {
    let re = new RegExp(value, ignoreCase ? 'i' : '');
    return el => re.test(textOf(el, source));
  }
  let fold = s => (ignoreCase ? s.toLowerCase() : s);
  let wanted = fold(normalize(value));
  if (mode === 'exact') return el => fold(textOf(el, source)) === wanted;
  return el => fold(textOf(el, source)).includes(wanted);
}

function attrTest({ name, value = null, mode = 'exact' }) {
  return el => {
    let actual = el.getAttribute(name);
    if (actual == null) return false;
    if (mode === 'present') return true;
    return mode === 'contains' ? actual.includes(value ?? '') : actual === value;
  };
}

function hasMatchingAncestor(el, within, root) {
  let test = within.text?.value ? textTest(within.text) : () => true;
  for (let x = el.parentElement; x && x !== root; x = x.parentElement) {
    if ((!within.css || x.matches(within.css)) && test(x)) return true;
  }
  return false;
}

// Every element the target describes under root, in document order. Inside a parent hook,
// root is one element that parent matched. Throws on an invalid selector or regex.
export function resolveTarget(target, root = document) {
  let useText = !!target.text?.value;
  let scope = root === document ? document.body : root;
  let found = target.css ? [...root.querySelectorAll(target.css)] : [...scope.querySelectorAll('*')];
  found = found.filter(x => scope.contains(x) && !x.closest(NOT_OURS));
  for (let attr of target.attrs || []) found = found.filter(attrTest(attr));
  if (useText) found = found.filter(textTest(target.text));
  if (target.within?.css || target.within?.text?.value) found = found.filter(x => hasMatchingAncestor(x, target.within, root));
  // "full" text also matches every ancestor of the real target; keep the innermost.
  if (useText && (target.text.source ?? 'full') === 'full') {
    let set = new Set(found);
    found = found.filter(x => ![...x.querySelectorAll('*')].some(y => set.has(y)));
  }
  return found;
}

// Applies the single/nth/all policy. An ambiguous single hook applies nowhere: guessing
// would silently decorate the wrong element.
export function selectMatches(target, found) {
  if (target.nth != null && target.nth !== '') {
    let hit = found[Number(target.nth)];
    return { matches: hit ? [hit] : [], status: hit ? 'ok' : 'unmatched' };
  }
  if (!found.length) return { matches: [], status: 'unmatched' };
  if (target.multiple || found.length === 1) return { matches: found, status: 'ok' };
  return { matches: [], status: 'ambiguous' };
}

export function pageMatches(pages, pathname) {
  if (!pages || pages.mode === 'site') return true;
  if (pages.mode === 'path') return pathname === pages.value;
  let re = pages.value.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${re}$`).test(pathname);
}

// Generated class names (CSS modules, styled-components, etc.) change on every site deploy.
let isStableToken = x => x.length <= 40 && !/\d{3}|[0-9a-f]{6,}/i.test(x) && !/^(css|sc|jsx|svelte|ng|_)[-_]?/.test(x) && !/__[a-z0-9]{4,}$/i.test(x) && !/[:[\]/]/.test(x);
let cssEsc = x => CSS.escape(x);

function structuralPath(el, root = document) {
  let parts = [];
  let scoped = root !== document;
  for (let x = el; x && x !== (scoped ? root : document.documentElement); x = x.parentElement) {
    // Inside a repeated parent, an id would only ever match one of its instances.
    if (!scoped && x.id && isStableToken(x.id)) { parts.unshift(`#${cssEsc(x.id)}`); break }
    let tag = x.tagName.toLowerCase();
    let same = x.parentElement ? [...x.parentElement.children].filter(y => y.tagName === x.tagName && !y.closest(NOT_OURS)) : [x];
    parts.unshift(same.length > 1 && x !== document.body ? `${tag}:nth-of-type(${[...x.parentElement.children].filter(y => y.tagName === x.tagName).indexOf(x) + 1})` : tag);
  }
  if (scoped) parts.unshift(':scope');
  return parts.join(' > ');
}

let camel = s => s.trim().replace(/[^\p{L}\p{N}]+(.)?/gu, (_, c) => (c || '').toUpperCase()).replace(/^[^\p{L}_$]+/u, '');

let STABLE_ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'name', 'aria-label', 'role', 'itemprop'];

export function createRuntime({ post, wforigin, morphdom, getId, moduleUrl }) {
  let hooks = [];
  let preview = false;
  let statuses = {};
  let lastStatusJson = '';
  let data = {};
  let lastDataJson = '';
  // hookId -> Map<element, { added: Set<class>, inserts: Map<insertId, record> }>
  let applied = new Map();
  let ghostUid = 0;
  let highlights = [];
  let highlightRaf = 0;

  let originalClasses = el => {
    let added = new Set();
    for (let hook of applied.values()) for (let c of hook.get(el)?.added || []) added.add(c);
    return [...el.classList].filter(x => !added.has(x));
  };

  function serialize(node) {
    let clone = node.cloneNode(true);
    for (let x of [clone, ...clone.querySelectorAll('*')]) { x.removeAttribute(OWNED); x.removeAttribute('data-htmlsnap') }
    return clone.outerHTML;
  }

  function build(insert, key) {
    let tpl = document.createElement('template');
    tpl.innerHTML = insert.html;
    let node = tpl.content.firstElementChild || document.createElement('div');
    node.setAttribute(OWNED, key);
    return node;
  }

  function place(el, node, position) {
    if (position === 'before') el.parentNode.insertBefore(node, el);
    else if (position === 'after') el.after(node);
    else if (position === 'firstChild') el.prepend(node);
    else el.append(node);
  }

  let isPlaced = (el, node, position) => (position === 'before' || position === 'after' ? node.parentNode === el.parentNode : node.parentNode === el);

  let canPlace = (el, position) => {
    if (position === 'firstChild' || position === 'lastChild') return !VOID_TAGS.has(el.tagName);
    return el !== document.body && el !== document.documentElement;
  };

  // Ghost: the original keeps its layout box but is invisible; the replacement is anchored
  // over it. The original sets the replacement's width, and the replacement can only ever
  // grow the original's height, so sizing can't feed back into itself.
  function saveStyle(el, prop) {
    return [prop, el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)];
  }
  function restoreStyle(el, [prop, value, priority]) {
    if (value) el.style.setProperty(prop, value, priority);
    else el.style.removeProperty(prop);
  }

  function measureGhost(ghost) {
    ghost.raf = 0;
    let { el, shell, node, saved } = ghost;
    if (!el.isConnected || !node.isConnected) return;
    restoreStyle(el, saved.minHeight);
    let natural = el.getBoundingClientRect().height;
    shell.style.setProperty('--wfd-natural-h', `${natural}px`);
    let content = node.getBoundingClientRect().height;
    if (content <= natural + 0.5) return;
    let cs = getComputedStyle(el);
    let extras = cs.boxSizing === 'border-box' ? 0 : ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((sum, k) => sum + parseFloat(cs[k]), 0);
    el.style.setProperty('min-height', `${content - extras}px`, 'important');
  }

  function mountGhost(el, node, key) {
    let name = `--wfd-ghost-${++ghostUid}`;
    let saved = { visibility: saveStyle(el, 'visibility'), anchorName: saveStyle(el, 'anchor-name'), minHeight: saveStyle(el, 'min-height') };
    let existingAnchor = getComputedStyle(el).anchorName;
    el.style.setProperty('visibility', 'hidden', 'important');
    el.style.setProperty('anchor-name', existingAnchor && existingAnchor !== 'none' ? `${existingAnchor}, ${name}` : name, 'important');

    let shell = document.createElement('div');
    shell.setAttribute(GHOST, key);
    shell.style.cssText = [
      'position: absolute !important',
      `position-anchor: ${name}`,
      'position-visibility: always',
      'top: anchor(top)',
      'left: anchor(left)',
      'width: anchor-size(width)',
      'min-height: var(--wfd-natural-h, anchor-size(height))',
      'margin: 0',
      'box-sizing: border-box',
      'display: flex',
      'flex-direction: column',
    ].join('; ');
    shell.append(node);
    el.after(shell);

    let ghost = { el, shell, node, saved, raf: 0 };
    ghost.observer = new ResizeObserver(() => { ghost.raf ||= requestAnimationFrame(() => measureGhost(ghost)) });
    ghost.observer.observe(node);
    ghost.observer.observe(el);
    return ghost;
  }

  function unmountGhost(ghost) {
    ghost.observer.disconnect();
    cancelAnimationFrame(ghost.raf);
    ghost.shell.remove();
    for (let saved of Object.values(ghost.saved)) restoreStyle(ghost.el, saved);
  }

  function unmount(record) {
    if (record.ghost) unmountGhost(record.ghost);
    else record.node.remove();
  }

  function mount(hook, el, insert) {
    if (!canPlace(el, insert.position)) return null;
    let key = `${hook.id}/${insert.id}`;
    let node = build(insert, key);
    let record = { node, position: insert.position, source: insert.html, serial: serialize(node), hookId: hook.id, insertId: insert.id };
    if (insert.position === 'ghost') record.ghost = mountGhost(el, node, key);
    else place(el, node, insert.position);
    return record;
  }

  function syncInserts(hook, el, rec) {
    let wanted = new Set(hook.inserts.map(x => x.id));
    for (let [id, record] of rec.inserts) {
      if (!wanted.has(id)) { unmount(record); rec.inserts.delete(id) }
    }
    for (let insert of hook.inserts) {
      let record = rec.inserts.get(insert.id);
      if (record && !record.node.isConnected) {
        unmount(record);
        rec.inserts.delete(insert.id);
        record = null;
      }
      if (!record) {
        record = mount(hook, el, insert);
        if (record) rec.inserts.set(insert.id, record);
        continue;
      }
      if (insert.position !== 'ghost' && !isPlaced(el, record.node, insert.position)) place(el, record.node, insert.position);
      if (insert.html !== record.source && insert.html !== record.serial) {
        morphdom(record.node, build(insert, `${hook.id}/${insert.id}`));
        record.serial = serialize(record.node);
      }
      record.source = insert.html;
    }
  }

  function setHookAttr(el, hookId, on) {
    let ids = new Set((el.getAttribute(HOOK) || '').split(' ').filter(Boolean));
    if (on) ids.add(hookId); else ids.delete(hookId);
    let value = [...ids].join(' ');
    if (!value) el.removeAttribute(HOOK);
    else if (el.getAttribute(HOOK) !== value) el.setAttribute(HOOK, value);
  }

  function applyHook(hook, el, rec) {
    setHookAttr(el, hook.id, true);
    let want = new Set(hook.classes);
    for (let c of rec.added) {
      if (!want.has(c)) { el.classList.remove(c); rec.added.delete(c) }
    }
    for (let c of want) {
      if (!el.classList.contains(c)) { el.classList.add(c); rec.added.add(c) }
    }
    syncInserts(hook, el, rec);
  }

  function teardown(hookId, el, rec) {
    for (let c of rec.added) el.classList.remove(c);
    for (let record of rec.inserts.values()) unmount(record);
    setHookAttr(el, hookId, false);
  }

  // Each parent match is its own scope: one child target applies once per parent match.
  function matchWithin(target, roots) {
    let matches = [];
    let ambiguous = false;
    for (let root of roots) {
      let result = selectMatches(target, resolveTarget(target, root));
      matches.push(...result.matches);
      ambiguous ||= result.status === 'ambiguous';
    }
    return { matches, status: matches.length ? 'ok' : ambiguous ? 'ambiguous' : 'unmatched' };
  }

  function resolveHook(hook, byId, memo) {
    if (memo.has(hook.id)) return memo.get(hook.id);
    memo.set(hook.id, { matches: [], status: 'error' }); // A parent cycle resolves to nothing.
    let result = { matches: [], status: 'off-page' };
    try {
      if (hook.parent) {
        let parent = byId.get(hook.parent);
        let roots = parent ? resolveHook(parent, byId, memo).matches : [];
        result = roots.length ? matchWithin(hook.target, roots) : { matches: [], status: 'unmatched' };
      } else if (pageMatches(hook.pages, location.pathname)) {
        result = matchWithin(hook.target, [document]);
      }
    } catch (err) {
      result = { matches: [], status: 'error' };
    }
    memo.set(hook.id, result);
    return result;
  }

  let MAX_VALUE_LENGTH = 2000;
  function valueOf(el) {
    if (el.tagName === 'IMG') return el.currentSrc || el.src;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return el.value;
    return normalize(el.textContent).slice(0, MAX_VALUE_LENGTH);
  }

  // Hooks sharing an ID in the same scope, and hooks that match all their repeats, are arrays.
  function buildData(memo) {
    let childrenOf = new Map();
    for (let hook of hooks) {
      let parent = hook.parent ?? null;
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent).push(hook);
    }
    let walk = (group, within) => {
      let out = {};
      let keys = [...new Set(group.map(x => x.key))];
      for (let key of keys) {
        let same = group.filter(x => x.key === key);
        let found = same.flatMap(hook => (memo.get(hook.id)?.matches || []).filter(el => !within || within.contains(el)).map(el => ({ el, hook })));
        found.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
        let values = found.map(({ el, hook }) => (childrenOf.has(hook.id) ? walk(childrenOf.get(hook.id), el) : valueOf(el)));
        out[key] = same.length > 1 || same.some(x => x.target.multiple) ? values : values[0] ?? null;
      }
      return out;
    };
    return walk(childrenOf.get(null) || [], null);
  }

  function evaluate() {
    let liveIds = new Set(hooks.map(x => x.id));
    for (let [hookId, elements] of applied) {
      if (liveIds.has(hookId)) continue;
      for (let [el, rec] of elements) teardown(hookId, el, rec);
      applied.delete(hookId);
    }
    let byId = new Map(hooks.map(x => [x.id, x]));
    let memo = new Map();
    for (let hook of hooks) resolveHook(hook, byId, memo);
    let next = {};
    for (let hook of hooks) {
      let { matches, status } = memo.get(hook.id);
      let elements = applied.get(hook.id);
      if (!elements) applied.set(hook.id, elements = new Map());
      let matched = new Set(matches);
      for (let [el, rec] of elements) {
        if (matched.has(el) && el.isConnected) continue;
        teardown(hook.id, el, rec);
        elements.delete(el);
      }
      for (let el of matches) {
        let rec = elements.get(el);
        if (!rec) elements.set(el, rec = { added: new Set(), inserts: new Map() });
        applyHook(hook, el, rec);
      }
      next[hook.id] = { status, count: matches.length };
    }
    statuses = next;
    let json = JSON.stringify(statuses);
    if (json !== lastStatusJson) { lastStatusJson = json; post({ type: 'decorate:status', statuses }) }
    data = buildData(memo);
    let dataJson = JSON.stringify(data);
    if (dataJson !== lastDataJson) { lastDataJson = dataJson; post({ type: 'decorate:data', data }) }
  }

  let evalTimer = null;
  let scheduleEvaluate = () => { evalTimer ??= setTimeout(() => { evalTimer = null; evaluate() }, 50) };

  // Edits made inside owned elements (by the regular designer actions) flow back to the project.
  let dirtyOwned = new Set();
  let ownedTimer = null;
  function flushOwned() {
    ownedTimer = null;
    let nodes = [...dirtyOwned];
    dirtyOwned.clear();
    for (let elements of applied.values()) for (let rec of elements.values()) for (let record of rec.inserts.values()) {
      if (!nodes.includes(record.node) || !record.node.isConnected) continue;
      let html = serialize(record.node);
      if (html === record.serial) continue;
      record.serial = html;
      post({ type: 'decorate:owned', hookId: record.hookId, insertId: record.insertId, html });
    }
  }

  let observer = new MutationObserver(records => {
    for (let record of records) {
      let target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      let owned = target?.closest?.(`[${OWNED}]`);
      if (owned) dirtyOwned.add(owned);
    }
    if (dirtyOwned.size) ownedTimer ??= setTimeout(flushOwned, 150);
    scheduleEvaluate();
  });

  // Client-side navigation changes the URL without a page load.
  let lastHref = location.href;
  let reportUrl = () => post({ type: 'decorate:url', url: location.href });
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    reportUrl();
    scheduleEvaluate();
  }, 250);

  // Tailwind only ever sees classes Webfoundry owns: a site's own "hidden" or "p-4" must
  // not generate utilities. The output is scoped for the same reason, and because hooks
  // apply with !important, a site using the same class name would otherwise be overridden.
  let SCOPE = `[${OWNED}],[${OWNED}] *,[${HOOK}],[${HOOK}] > *,[${GHOST}],.wf-cursor`;
  let VARS_SCOPE = `[${OWNED}],[${HOOK}],.wf-cursor`;

  function ensureFont(cls) {
    let name = cls.match(/gfont-\[(.+?)\]$/)?.[1];
    if (!name || document.getElementById(`wfd-gfont-${name}`)) return;
    let family = name.replace(/_/g, ' ');
    let link = document.createElement('link');
    link.id = `wfd-gfont-${name}`;
    link.rel = 'stylesheet';
    link.setAttribute(UI, '');
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@100;200;300;400;500;600;700;800;900&display=swap`;
    let style = document.createElement('style');
    style.setAttribute(UI, '');
    style.textContent = `.${CSS.escape(cls)} { font-family: "${family}" !important }`;
    document.head.append(link, style);
  }

  function candidates() {
    let out = new Set();
    for (let hook of hooks) for (let c of hook.classes) out.add(c);
    for (let el of document.querySelectorAll(`[${OWNED}], [${OWNED}] [class], .wf-cursor`)) for (let c of el.classList) out.add(c);
    for (let c of out) if (c.includes('gfont-[')) ensureFont(c);
    return out;
  }

  function scopeCss(css) {
    let sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    let walk = rules => {
      for (let rule of rules) {
        if (rule instanceof CSSStyleRule) {
          let selector = rule.selectorText;
          if (/^\s*:(root|host)\b/.test(selector)) rule.selectorText = `:where(${VARS_SCOPE})`;
          else if (selector.includes('.') && !selector.includes('::')) rule.selectorText = `:where(${SCOPE}):is(${selector})`;
        } else if (rule.cssRules) {
          walk(rule.cssRules);
        }
      }
    };
    walk(sheet.cssRules);
    return [...sheet.cssRules].map(x => x.cssText).join('\n');
  }

  function startTailwind() {
    window.wfTailwindCandidates = candidates;
    window.wfTailwindTransform = scopeCss;
    let entry = document.createElement('style');
    entry.type = 'text/tailwindcss';
    entry.setAttribute(UI, '');
    // No preflight: it would reset the site. "important" because utilities live in a
    // @layer, and any unlayered rule of the site's would otherwise beat them.
    entry.textContent = '@layer theme, utilities;\n@import "tailwindcss/theme.css" layer(theme);\n@import "tailwindcss/utilities.css" layer(utilities) important;\n';
    document.head.append(entry);
    let script = document.createElement('script');
    script.src = new URL('./tailplay4.dafuq.js', moduleUrl).href;
    script.setAttribute(UI, '');
    document.head.append(script);
    let style = document.createElement('style');
    style.setAttribute(UI, '');
    style.textContent = `html[data-wfd-preview] .wf-cursor { display: none !important }`;
    document.head.append(style);
  }

  // Editing mode: the page can't react to the mouse, so clicking selects instead of navigating.
  let selectableTarget = ev => {
    let target = ev.composedPath().find(x => x.nodeType === 1 && getId(x) != null) || ev.target;
    if (target.hasAttribute?.(GHOST)) target = target.firstElementChild || target;
    return target;
  };

  for (let type of ['click', 'dblclick', 'auxclick', 'mouseup', 'submit']) {
    addEventListener(type, ev => {
      if (preview) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }, true);
  }
  // Hidden from the site, but not canceled: that would suppress the mousedown selecting relies on.
  for (let type of ['pointerdown', 'pointerup']) {
    addEventListener(type, ev => { if (!preview) ev.stopImmediatePropagation() }, true);
  }
  addEventListener('mousedown', ev => {
    if (preview) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    if (ev.button !== 0) return;
    document.activeElement?.blur?.();
    post({ type: 'decorate:pick', id: getId(selectableTarget(ev)), shift: ev.shiftKey });
  }, true);

  function drawHighlights() {
    highlightRaf = highlights.length ? requestAnimationFrame(drawHighlights) : 0;
    for (let { el, box } of highlights) {
      let r = el.getBoundingClientRect();
      Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    }
  }

  function clearHighlight() {
    for (let { box } of highlights) box.remove();
    highlights = [];
  }

  function highlight(elements) {
    clearHighlight();
    for (let el of elements.slice(0, 200)) {
      let box = document.createElement('div');
      box.setAttribute(UI, '');
      box.style.cssText = 'position: fixed; z-index: 2147483646; pointer-events: none; outline: 2px solid #22c55e; background: #22c55e22';
      document.body.append(box);
      highlights.push({ el, box });
    }
    if (highlights.length && !highlightRaf) drawHighlights();
  }

  let signature = x => [x.tagName, ...originalClasses(x).filter(isStableToken).sort()].join('.');
  let childShape = x => [...x.children].map(c => c.tagName).join();
  let nameSelector = x => `${x.tagName.toLowerCase()}${originalClasses(x).filter(isStableToken).slice(0, 2).map(c => `.${cssEsc(c)}`).join('')}`;
  let positionSelector = x => {
    let same = [...x.parentElement.children].filter(y => y.tagName === x.tagName);
    return same.length > 1 ? `${x.tagName.toLowerCase()}:nth-of-type(${same.indexOf(x) + 1})` : x.tagName.toLowerCase();
  };

  // Bare tags only count as repeats when their contents are shaped alike, or every <div>
  // beside another <div> would look like a list.
  function isRepeated(x) {
    let sig = signature(x);
    let bare = !sig.includes('.');
    return [...x.parentElement.children].filter(y => !y.closest(NOT_OURS) && signature(y) === sig && (!bare || childShape(y) === childShape(x))).length > 1;
  }

  // Finds the nearest level at or above el that repeats, and a selector for el in every repeat.
  function detectRepeat(el, root) {
    let top = root === document ? document.body : root;
    let below = '';
    for (let x = el; x && x !== top; x = x.parentElement) {
      if (isRepeated(x)) {
        let css = `${structuralPath(x.parentElement, root)} > ${nameSelector(x)}${below}`;
        try {
          let count = resolveTarget({ css }, root);
          if (count.length > 1 && count.includes(el)) return { css, count: count.length };
        } catch {}
      }
      below = ` > ${positionSelector(x)}${below}`;
    }
    return null;
  }

  let enclosingHooks = el => {
    let out = [];
    for (let x = el.parentElement; x; x = x.parentElement) {
      for (let id of (x.getAttribute(HOOK) || '').split(' ').filter(Boolean)) out.push({ id, el: x });
    }
    return out;
  };

  let parentRoot = (parentId, el) => enclosingHooks(el).find(x => x.id === parentId)?.el ?? null;

  function suggestKey(el, text) {
    let cls = originalClasses(el).find(isStableToken);
    let source = text && text.length <= 24 ? text : cls || el.tagName.toLowerCase();
    return camel(source) || el.tagName.toLowerCase();
  }

  // Everything the hook dialog needs to offer targeting choices for one element.
  // parentId: undefined picks the nearest enclosing hook, null targets the whole page.
  function describe(el, parentId) {
    let tag = el.tagName.toLowerCase();
    let parents = enclosingHooks(el);
    parentId = parentId === undefined ? parents[0]?.id ?? null : parentId;
    let root = (parentId && parentRoot(parentId, el)) || document;
    let count = css => { try { return resolveTarget({ css }, root).length } catch { return 0 } };
    let candidatesCss = [];
    let add = css => { if (css && !candidatesCss.some(x => x.css === css)) candidatesCss.push({ css, count: count(css) }) };
    if (root === document && el.id && isStableToken(el.id)) add(`#${cssEsc(el.id)}`);
    for (let name of STABLE_ATTRS) {
      let value = el.getAttribute(name);
      if (value) add(`${tag}[${name}="${value.replace(/["\\]/g, '\\$&')}"]`);
    }
    let classes = originalClasses(el);
    let stable = classes.filter(isStableToken).slice(0, 2);
    if (stable.length) add(`${tag}${stable.map(x => `.${cssEsc(x)}`).join('')}`);
    add(structuralPath(el, root));
    let repeat = detectRepeat(el, root);
    if (repeat) add(repeat.css);
    add(tag);

    let own = ownText(el);
    let text = own.length >= 2 && own.length <= 80 ? own : '';
    // Inside a parent, one target serves every parent match, so it can't lean on this match's
    // own ids, attribute values or text.
    let unique = candidatesCss.find(x => x.count === 1 && !x.css.includes(' > ') && /[#[]/.test(x.css) === (root === document));
    let single = { css: unique?.css ?? structuralPath(el, root), attrs: [], within: {}, multiple: false, nth: null };
    let target = { ...single };
    if (!unique) {
      let byText = { css: tag, text: { value: text, mode: 'exact', source: 'own', ignoreCase: true } };
      if (repeat) Object.assign(target, { css: repeat.css, multiple: true });
      else if (root === document && text && resolveTarget(byText, root).length === 1) Object.assign(target, byText);
    }

    let ancestors = [];
    for (let x = el.parentElement; x && x !== (root === document ? document.documentElement : root) && ancestors.length < 6; x = x.parentElement) {
      let stableCls = originalClasses(x).filter(isStableToken)[0];
      let css = x.id && isStableToken(x.id) ? `#${cssEsc(x.id)}` : `${x.tagName.toLowerCase()}${stableCls ? `.${cssEsc(stableCls)}` : ''}`;
      if (!ancestors.some(y => y.css === css)) ancestors.push({ css });
    }

    return {
      tag,
      classes,
      attrs: [...el.attributes].filter(x => !/^(class|style|data-htmlsnap|data-wf)/.test(x.name)).slice(0, 12).map(x => ({ name: x.name, value: x.value.slice(0, 200) })),
      ownText: own.slice(0, 200),
      fullText: normalize(el.textContent).slice(0, 200),
      label: accessibleName(el).slice(0, 200),
      key: suggestKey(el, text),
      cssCandidates: candidatesCss,
      ancestors,
      target,
      single,
      repeat,
      parentId,
      parents: [...new Set(parents.map(x => x.id))],
      canHaveChildren: !VOID_TAGS.has(el.tagName),
      canHaveSiblings: el !== document.body && el !== document.documentElement,
      path: location.pathname,
    };
  }

  function test(target, selected, parentId) {
    let roots = parentId ? [...(applied.get(parentId)?.keys() || [])] : [document];
    let found = [];
    let matches = [];
    let ambiguous = false;
    let index = -1;
    try {
      for (let root of roots) {
        let inRoot = resolveTarget(target, root);
        let result = selectMatches(target, inRoot);
        found.push(...inRoot);
        matches.push(...result.matches);
        ambiguous ||= result.status === 'ambiguous';
        if (index < 0) index = inRoot.indexOf(selected);
      }
    } catch (err) {
      clearHighlight();
      return { error: String(err.message || err), count: 0 };
    }
    highlight(matches.length ? matches : found);
    return { status: matches.length ? 'ok' : ambiguous ? 'ambiguous' : 'unmatched', total: found.length, count: matches.length, includesSelected: matches.includes(selected), index };
  }

  addEventListener('message', ev => {
    if (ev.origin !== wforigin || ev.data?.type !== 'decorate:config') return;
    if (ev.data.hooks) hooks = ev.data.hooks;
    if ('preview' in ev.data) {
      preview = !!ev.data.preview;
      document.documentElement.toggleAttribute('data-wfd-preview', preview);
      clearHighlight();
    }
    evaluate();
  });

  startTailwind();
  observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'id', 'href', 'src', 'role', 'name', 'aria-label', 'title', 'alt', 'placeholder', 'value'], characterData: true });

  return {
    get preview() { return preview },
    reportUrl,
    describe,
    test,
    clearHighlight,
    firstOwned: key => document.querySelector(`[${OWNED}="${key}"]`),
    firstMatch: hookId => [...(applied.get(hookId)?.keys() || [])][0] || null,
    statuses: () => statuses,
    data: () => data,
  };
}

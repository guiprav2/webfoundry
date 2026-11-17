// Checks that project HTML files keep the shape Webfoundry expects, now that agents and people
// also edit them outside the IDE. Used by reflect, in the IDE and from `wf reflect`, so it parses
// without a DOM. The rules follow other/templates.js (what `wf create-file` scaffolds):
// - pages/ and components/: <head> holds only meta, title and the runtime loader scripts, and
//   nothing sits outside <head> and <body>.
// - pages/: <body> is the full-height flex column that starts hidden, and its only element is the
//   root div, which doesn't pin itself to the viewport height.

let VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
let RAW = new Set(['script', 'style', 'textarea', 'title']);
let BODY_CLASSES = ['flex', 'flex-col', '[&>div:first-child]:flex-1'];
let LOADER_SRC = /(^|\/)webfoundry\/(ifdesigner|head)\.js$/;
let ROOT_HEIGHT = /^(min-h|h)-(screen|dvh|svh|lvh|\[100[dsl]?vh\])$/;

let decode = s => s.replace(/&(amp|lt|gt|quot|#39|apos);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" })[e]);

function parseAttrs(raw) {
  let attrs = {};
  for (let m of raw.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    attrs[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

// A small tree builder for well-formed (saved by Webfoundry or written by hand) HTML.
function parse(html) {
  let doc = { name: '#document', children: [] };
  let stack = [doc];
  let errors = [];
  let re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>/gi;
  let at = 0;
  let text = s => s && stack.at(-1).children.push({ name: '#text', text: s });
  for (let m; (m = re.exec(html));) {
    text(html.slice(at, m.index));
    at = re.lastIndex;
    let [all, close, open, attrs, selfClosing] = m;
    if (all.startsWith('<!')) continue;
    if (close) {
      let name = close.toLowerCase();
      let i = stack.findLastIndex(x => x.name === name);
      if (i < 1) { errors.push(`Stray closing tag </${name}>`); continue }
      if (i !== stack.length - 1) errors.push(`<${stack.at(-1).name}> isn't closed before </${name}>`);
      stack.length = i;
      continue;
    }
    let el = { name: open.toLowerCase(), attrs: parseAttrs(attrs), children: [] };
    stack.at(-1).children.push(el);
    if (RAW.has(el.name)) {
      let end = html.toLowerCase().indexOf(`</${el.name}`, at);
      if (end < 0) { errors.push(`<${el.name}> is never closed`); break }
      el.text = html.slice(at, end);
      re.lastIndex = at = html.indexOf('>', end) + 1;
      continue;
    }
    if (!VOID.has(el.name) && !selfClosing) stack.push(el);
  }
  text(html.slice(at));
  for (let el of stack.slice(1)) errors.push(`<${el.name}> is never closed`);
  return { doc, errors };
}

let elements = node => node.children.filter(x => x.name !== '#text');
let strayText = node => node.children.some(x => x.name === '#text' && x.text.trim());

function checkHead(head, problems) {
  for (let el of elements(head)) {
    if (el.name === 'meta' || el.name === 'title') continue;
    if (el.name === 'script' && (LOADER_SRC.test(el.attrs.src || '') || (!el.attrs.src && /\brootPrefix\b/.test(el.text || '')))) continue;
    let detail = el.attrs.src || el.attrs.href || el.attrs.class || '';
    problems.push(`Extraneous <${el.name}${detail ? ` ${detail}` : ''}> in <head>: it may only hold meta, title and the Webfoundry runtime scripts`);
  }
}

function checkBody(body, problems) {
  let classes = (body.attrs.class || '').split(/\s+/);
  let missing = BODY_CLASSES.filter(x => !classes.includes(x));
  if (missing.length) problems.push(`<body> is missing the classes ${missing.join(' ')} (it's the page's full-height flex column)`);
  if (!/display\s*:\s*none/.test(body.attrs.style || '')) problems.push(`<body> should keep style="display: none"; the runtime reveals it once styles are ready`);
  let kids = elements(body);
  let roots = kids.filter(x => x.name === 'div');
  if (!roots.length) problems.push(`<body> has no root div; all page content goes inside one div right under <body>`);
  for (let el of kids.filter(x => x !== roots[0])) problems.push(`Extraneous <${el.name}> in <body>, outside the root div`);
  if (strayText(body)) problems.push(`Text in <body> outside the root div`);
  let root = roots[0];
  let pinned = (root?.attrs.class || '').split(/\s+/).filter(x => ROOT_HEIGHT.test(x));
  if (pinned.length) problems.push(`The root div sets ${pinned.join(' ')}; it already fills the viewport, and a fixed height stops sticky headers from sticking`);
}

/** Problems with a project file's structure (empty when fine). Only pages/ and components/ HTML is checked. */
export function checkWebfoundryFile(path, html) {
  if (!/^(pages|components)\/.+\.html$/.test(path)) return [];
  let { doc, errors } = parse(html);
  let problems = [...errors];
  let tops = elements(doc);
  let htmlEl = tops.find(x => x.name === 'html');
  for (let el of tops.filter(x => x !== htmlEl)) problems.push(`Extraneous <${el.name}> outside <html>`);
  if (strayText(doc)) problems.push(`Text outside <html>`);
  if (!htmlEl) return [...problems, `Missing <html>`];
  let head = elements(htmlEl).find(x => x.name === 'head');
  let body = elements(htmlEl).find(x => x.name === 'body');
  for (let el of elements(htmlEl).filter(x => x !== head && x !== body)) problems.push(`Extraneous <${el.name}> in <html>, outside <head> and <body>`);
  if (strayText(htmlEl)) problems.push(`Text in <html>, outside <head> and <body>`);
  if (!head) problems.push(`Missing <head>`);
  else checkHead(head, problems);
  if (!body) problems.push(`Missing <body>`);
  else if (path.startsWith('pages/')) checkBody(body, problems);
  return problems;
}

// Static src/poster values and inline-style url(...) in a page are relative to the page's own
// directory (../media/x.png from pages/, ../../media/x.png from pages/blog/), so moving a page to
// another folder must rebase them. wf-src values are project-root paths and need no change.

let dirOf = path => path.split('/').slice(0, -1).join('/');

// Joins a page-relative URL path onto a directory; null when it climbs out of the project.
function resolve(dir, rel) {
  let parts = dir ? dir.split('/') : [];
  for (let seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

function relative(fromDir, target) {
  let from = fromDir ? fromDir.split('/') : [];
  let to = target.split('/');
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  return '../'.repeat(from.length - i) + to.slice(i).join('/');
}

let isRebasable = url => !!url && !/^([a-z][a-z\d+.-]*:|\/|#|\{\{)/i.test(url.trim()) && !url.includes('{{');

// mapTarget remaps targets that moved along with the page (folder moves).
export function rebasePageUrls(html, oldPath, newPath, mapTarget = x => x) {
  let oldDir = dirOf(oldPath), newDir = dirOf(newPath);
  if (oldDir === newDir) return html;
  let rebase = url => {
    if (!isRebasable(url)) return url;
    let [, path, rest] = url.match(/^([^?#]*)(.*)$/s);
    let target = path && resolve(oldDir, path);
    if (target == null || target === '') return url;
    let next = relative(newDir, mapTarget(target)) + rest;
    return path.endsWith('/') && !next.endsWith('/') ? next + '/' : next;
  };
  // Preceded by whitespace, so wf-src and data-src are left alone.
  html = html.replace(/(\s(?:src|poster)\s*=\s*)(["'])(.*?)\2/gis, (m, pre, q, v) => pre + q + rebase(v) + q);
  html = html.replace(/(\sstyle\s*=\s*)(["'])(.*?)\2/gis, (m, pre, q, v) =>
    pre + q + v.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (u, uq, uv) => `url(${uq}${rebase(uv)}${uq})`) + q);
  return html;
}

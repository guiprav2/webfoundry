// `wf reflect`: what the IDE's files.reflect does, from the files on disk, for when HTML was
// edited outside Webfoundry. Writes webfoundry/templates.json (every .html file's source) and
// webfoundry/scripts.json (every .js path), over the same files the IDE lists (the project
// .gitignore, node_modules, .git and swap files are left out), and reports pages and components
// that lost Webfoundry's structure.
import fs from 'fs';
import path from 'path';
import { buildGitignoreMatcher } from './companion/gitignore.js';
import { checkWebfoundryFile } from './page-check.js';

function listFiles(root) {
  let ignored = buildGitignoreMatcher(root);
  let out = [];
  let walk = dir => {
    for (let entry of fs.readdirSync(dir, { withFileTypes: true })) {
      let abs = path.join(dir, entry.name);
      if (ignored(abs)) continue;
      let stat = entry.isSymbolicLink() ? fs.statSync(abs, { throwIfNoEntry: false }) : entry;
      if (stat?.isDirectory()) walk(abs);
      else if (stat?.isFile()) out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

export function reflectProject(root) {
  let files = listFiles(root);
  let templates = {};
  for (let x of files.filter(x => x.endsWith('.html'))) templates[x] = fs.readFileSync(path.join(root, x), 'utf8');
  let scripts = files.filter(x => x.endsWith('.js'));
  fs.mkdirSync(path.join(root, 'webfoundry'), { recursive: true });
  fs.writeFileSync(path.join(root, 'webfoundry/templates.json'), JSON.stringify(templates));
  fs.writeFileSync(path.join(root, 'webfoundry/scripts.json'), JSON.stringify(scripts));
  let problems = Object.fromEntries(Object.entries(templates).map(([p, html]) => [p, checkWebfoundryFile(p, html)]).filter(x => x[1].length));
  return { success: true, templates: Object.keys(templates).length, scripts: scripts.length, problems };
}

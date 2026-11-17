#!/usr/bin/env node
// Builds demos/<name>.zip from the landing's demo repos, so landing visits load them from this site
// instead of cloning through the public CORS proxy. Rerun after pushing changes to a demo repo.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let outDir = path.join(root, 'demos');
let demos = {
  counter: 'https://github.com/guiprav2/counter.git',
  todomvc: 'https://github.com/guiprav2/todomvc.git',
  webfoundry: 'https://github.com/guiprav2/webfoundry.git',
};
// Keep the self demo from nesting the other archives once demos/ is committed.
let exclude = { webfoundry: ['demos'] };
// Demo repos carry whatever runtime they were last saved with; ship this build's instead, like
// projects.create does for new projects (source in this repo -> path in the demo).
let runtime = [
  'index.html', 'webfoundry/app.js', 'webfoundry/bimap.js', 'webfoundry/ifdesigner.js', 'webfoundry/head.js',
  'webfoundry/dominant.js', 'webfoundry/tailplay4.dafuq.js', 'webfoundry/adwaita.tw.css', 'webfoundry/material.tw.css',
  'webfoundry/fluent.tw.css', 'webfoundry/adwaita-icons.css', ['webfoundry/wf.config.js', 'wf.config.js'],
].map(x => (Array.isArray(x) ? x : [x, x]));

let only = process.argv.slice(2);
let tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-demos-'));
fs.mkdirSync(outDir, { recursive: true });
try {
  for (let [name, url] of Object.entries(demos)) {
    if (only.length && !only.includes(name)) continue;
    let dir = path.join(tmp, name);
    execFileSync('git', ['clone', '--quiet', '--depth', '1', '--branch', 'master', url, dir], { stdio: 'inherit' });
    let rev = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD']).toString().trim();
    for (let [src, dest] of runtime) {
      // The self demo's index.html is the site shell itself; the others only get files they already have.
      if (name !== 'webfoundry' && !fs.existsSync(path.join(dir, dest))) continue;
      fs.mkdirSync(path.dirname(path.join(dir, dest)), { recursive: true });
      fs.copyFileSync(path.join(root, src), path.join(dir, dest));
    }
    // git archive only packs committed files.
    execFileSync('git', ['-C', dir, '-c', 'user.name=build-demos', '-c', 'user.email=build-demos@localhost', 'commit', '--quiet', '--allow-empty', '-am', 'Current Webfoundry runtime']);
    let out = path.join(outDir, `${name}.zip`);
    execFileSync('git', ['-C', dir, 'archive', '--format=zip', '-o', out, 'HEAD', '--', '.', ...(exclude[name] || []).map(x => `:(exclude)${x}`)]);
    console.log(`${name}: ${url}@${rev} -> ${path.relative(root, out)} (${fs.statSync(out).size} bytes)`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

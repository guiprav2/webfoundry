#!/usr/bin/env node
import chokidar from 'chokidar';
import dotenv from 'dotenv';
import fs, { promises as fsp } from 'fs';
import getpass from './getpass.js';
import os from 'os';
import path from 'path';
import pidtree from 'pidtree';
import pty from 'node-pty';
import readline from 'readline';
import server from './server.js';
import { execFile } from 'child_process';
import { glob } from 'glob';
import { mkdirp } from 'mkdirp';
import { promisify } from 'util';
import { rimraf } from 'rimraf';
import { minimatch } from 'minimatch';

let execFileAsync = promisify(execFile);
let configDir = `${process.env.HOME}/.webfoundry`;
mkdirp.sync(configDir);
let configFile = `${configDir}/config.env`;
let ocl = console.log;
console.log = () => null;
fs.existsSync(configFile) && dotenv.config({ path: configFile });
console.log = ocl;
if (!process.env.WF_CLIENT_KEY) {
  console.log(`Since this app offers a shell via WebSocket, it's important to authenticate before allowing access.`);
  console.log(`You can find your Webfoundry client key in the settings menu of the app.`);
  let key = await getpass('Enter a secret Webfoundry client key used for authentication: ');
  if (!key) { console.log('WF_CLIENT_KEY cannot be empty. Exiting.'); process.exit(1) }
  fs.appendFileSync(configFile, `WF_CLIENT_KEY=${key}\n`);
  process.env.WF_CLIENT_KEY = key;
  console.log(`WF_CLIENT_KEY saved to ${configFile}.`);
}

let workspace = process.cwd();
if (!fs.existsSync(`${workspace}/.webfoundry`)) {
  console.log(`No .webfoundry file found in: ${workspace}`);
  await new Promise(pres => {
    let rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Would you like to initialize a Webfoundry workspace here? (y/N): ', answer => {
      rl.close();
      let yes = answer.trim().toLowerCase();
      if (yes !== 'y' && yes !== 'yes') process.exit(0);
      fs.writeFileSync(`${workspace}/.webfoundry`, '');
      pres();
    });
  });
}

let s = server(process.env.WF_CLIENT_KEY);
s.events.on('connected', () => console.log('Client connected (handshake OK).'));
s.events.on('disconnected', () => console.log('Client disconnected.'));

let lastOps = new Map();
function markFileOp(ws, relPath) {
  if (!ws) return;
  let map = lastOps.get(ws) ?? new Map();
  map.set(relPath, Date.now());
  lastOps.set(ws, map);
}
setInterval(() => {
  let now = Date.now();
  for (let [ws, paths] of lastOps) {
    for (let [p, t] of paths) {
      if (now - t > 500) paths.delete(p);
    }
    if (paths.size === 0) lastOps.delete(ws);
  }
}, 1000);

// List files under a path, filtering by .gitignore and defaults
// Note: build matcher per request root so the caller's .gitignore is honored.
s.rpc('files:list', async ({ path: listRoot }) => {
  // Only honor the .gitignore at the listing root; use it to prune traversal
  let ignoreGlobs = buildGlobIgnoresFromGitignore(listRoot);
  let files = await glob(`${listRoot}/**/*`, { nodir: true, dot: true, ignore: ignoreGlobs });
  // Final guard for negations and edge cases using listRoot's .gitignore only
  let localIsIgnored = buildGitignoreMatcher(listRoot);
  return files.filter(p => !localIsIgnored(p));
});

s.rpc('files:stat', async ({ path }) => {
  try { return await fsp.stat(path) }
  catch (err) { if (err.code === 'ENOENT') return null; throw err }
});

s.rpc('files:load', async ({ path }) => {
  try { return (await fsp.readFile(path)).toString('base64') }
  catch (err) { if (err.code === 'ENOENT') return null; throw err }
});

s.rpc('files:save', async ({ ws, path, data }) => {
  await mkdirp(path.split('/').slice(0, -1).join('/'));
  await fsp.writeFile(path, Buffer.from(data, 'base64'));
  markFileOp(ws, path);
});

s.rpc('files:mv', async ({ path, newPath }) => await fsp.rename(path, newPath));
s.rpc('files:rm', async ({ ws, path }) => { await rimraf(path); markFileOp(ws, path) });
// Build an ignore matcher from .gitignore (root only) plus default ignores
function buildGitignoreMatcher(root) {
  let gitignorePath = path.join(root, '.gitignore');
  let rules = [];
  try {
    if (fs.existsSync(gitignorePath)) {
      let raw = fs.readFileSync(gitignorePath, 'utf8');
      for (let line of raw.split(/\r?\n/)) {
        if (!line) continue;
        // Handle comments and trim whitespace (basic handling)
        if (line.startsWith('#')) continue;
        // Preserve leading '!' for negation before trimming
        let negate = line.startsWith('!');
        let pattern = negate ? line.slice(1) : line;
        pattern = pattern.trim();
        if (!pattern) continue;
        // Normalize: drop leading './'
        if (pattern.startsWith('./')) pattern = pattern.slice(2);
        let anchored = pattern.startsWith('/');
        if (anchored) pattern = pattern.slice(1);
        let dirOnly = pattern.endsWith('/');
        if (dirOnly) pattern = pattern.slice(0, -1);
        // Expand to globs relative to root; unanchored patterns match at any depth
        let base = anchored ? pattern : `**/${pattern}`;
        let globs = [];
        if (dirOnly) {
          // Ignore the directory entry itself and everything under it
          globs.push(base);
          globs.push(`${base}/**`);
        } else {
          // Match both files and directories with this name/pattern
          globs.push(base);
          globs.push(`${base}/**`);
        }
        for (let g of globs) rules.push({ g, negate });
      }
    }
  } catch (err) {
    console.error('Failed to parse .gitignore:', err);
  }
  // Default ignores: node_modules, .git, and swap files
  function defaultIgnored(p) {
    return /(^|\/)node_modules(\/|$)/.test(p) || /(^|\/)\.git(\/|$)/.test(p) || /\.swp$/.test(p);
  }
  return function isIgnored(absPath) {
    // Compute posix-style relative path
    let rel = absPath.startsWith(root + path.sep) ? absPath.slice(root.length + 1) : absPath;
    let relPosix = rel.split(path.sep).join('/');
    // Apply .gitignore rules in order; last match wins
    let ignored = false;
    for (let { g, negate } of rules) {
      if (minimatch(relPosix, g, { dot: true })) ignored = !negate;
    }
    return ignored || defaultIgnored(relPosix);
  }
}

// Build absolute ignore globs for `glob({ ignore })` from a single directory's .gitignore
// Notes:
// - Negated patterns cannot be represented here; they are handled by the final filter.
// - For directory patterns (trailing '/') and simple names (no glob meta), add both the
//   directory itself and all descendants to enable traversal pruning.
function buildGlobIgnoresFromGitignore(root) {
  let globs = [];
  let gi = path.join(root, '.gitignore');
  let rootPosix = root.split(path.sep).join('/');
  // Always skip VCS metadata under the listing root
  globs.push(`${rootPosix}/.git/**`);
  globs.push(`${rootPosix}/**/.git/**`);
  function stripInlineComment(s) {
    let out = '';
    let esc = false;
    for (let ch of s) {
      if (ch === '#' && !esc) break;
      if (ch === '\\' && !esc) { esc = true; continue }
      if (esc) { out += ch; esc = false; continue }
      out += ch;
    }
    if (esc) out += '\\';
    return out;
  }
  try {
    if (!fs.existsSync(gi)) return globs;
    let raw = fs.readFileSync(gi, 'utf8');
    for (let rawLine of raw.split(/\r?\n/)) {
      let line = rawLine;
      if (!line) continue;
      if (/^\s*#/.test(line)) continue;
      line = stripInlineComment(line).trim();
      if (!line) continue;
      let negate = line.startsWith('!');
      if (negate) continue; // only used in final filter
      let pattern = negate ? line.slice(1) : line;
      if (pattern.startsWith('./')) pattern = pattern.slice(2);
      let anchored = pattern.startsWith('/');
      if (anchored) pattern = pattern.slice(1);
      let dirOnly = pattern.endsWith('/');
      if (dirOnly) pattern = pattern.slice(0, -1);
      let hasMeta = /[\*\?\[\]\{\}]/.test(pattern);
      let treatAsDir = dirOnly || !hasMeta;
      // Build absolute base
      let base = anchored ? `${rootPosix}/${pattern}` : `${rootPosix}/**/${pattern}`;
      // Ignore the base pattern itself (files and directories with this name/pattern)
      globs.push(base);
      // If treated as dir, also ignore everything underneath for pruning
      if (treatAsDir) globs.push(`${base}/**`);
    }
  } catch (err) {
    console.error('Failed to build glob ignores:', err);
  }
  return globs;
}

let isIgnored = buildGitignoreMatcher(workspace);
let watcher = chokidar.watch(workspace, {
  ignoreInitial: true,
  ignored: p => /(^|[\\/])node_modules([\\/]|$)/.test(p) || isIgnored(p)
});
['add', 'change', 'unlink'].forEach(event => {
  watcher.on(event, path => {
    // Extra guard: never broadcast events for ignored paths
    try { if (isIgnored(path)) return } catch {}
    let relPath = path.slice(workspace.length + 1);
    let type = `files:${event === 'unlink' ? 'rm' : event}`;
    let now = Date.now();
    let exclude = new Set();
    for (let [ws, paths] of lastOps) if (now - (paths.get(path) ?? 0) < 500) exclude.add(ws);
    s.broadcast({ type, path: relPath }, exclude);
  });
});

let terminals = {};
s.rpc('shell:spawn', async ({ ws, shell, subdir, cols, rows }) => {
  shell ??= 'bash';
  let cwd = workspace;
  subdir && (cwd += `/${subdir}`);
  await mkdirp(cwd);
  let session = crypto.randomUUID();
  let term = pty.spawn(shell, [], { name: 'xterm-color', cols, rows, cwd, env: { WF_SESSION: session, ...process.env } });
  term.session = session;
  term.ws = ws;
  terminals[session] = term;
  term.on('data', data => ws.send(JSON.stringify({ type: 'shell', subtype: 'stream', pipe: 'stdout', session, payload: Buffer.from(data).toString('base64') })));
  let lastLabel;
  term.monint = setInterval(async () => {
    try {
      let pids = await pidtree(term.pid);
      pids.push(term.pid);
      let { stdout } = await execFileAsync('ps', ['-o', 'pid=,comm=', '-p', pids.join(',')]);
      let lines = stdout.trim().split('\n').filter(Boolean);
      let procs = lines.map(line => {
        let [pidStr, ...cmdParts] = line.trim().split(/\s+/);
        return { pid: Number(pidStr), command: cmdParts.join(' ') };
      })
      let names = procs.map(p => p.command);
      let process = names.at(-1);
      let lastPid = procs.at(-1)?.pid;
      let cwd = null;
      try { cwd = await fsp.readlink(`/proc/${lastPid}/cwd`) } catch {}
      let label = 'system';
      if (cwd) {
        if (cwd === workspace) label = 'workspace';
        else if (cwd.startsWith(workspace + '/')) {
          let rel = cwd.slice(workspace.length + 1);
          label = rel.split('/')[0] || 'workspace';
        }
      }
      label += ` (${process})`
      if (lastLabel === label) return
      lastLabel = label;
      ws.send(JSON.stringify({ type: 'shell', subtype: 'label', session, label }))
    } catch (err) {
      if (err.code === 'ESRCH' || err.code === 'ENOENT') return
      console.error('process monitor error:', err)
    }
  }, 500)
  term.on('exit', () => {
    clearInterval(term.monint);
    delete terminals[session];
    ws.send(JSON.stringify({ type: 'shell:close', session }));
  });
  return session;
});

s.rpc('shell:resize', ({ session, cols, rows }) => {
  let term = terminals[session];
  if (!term) throw new Error(`Unknown terminal session: ${session}`);
  term.resize(cols, rows);
});

s.rpc('shell:kill', ({ session }) => {
  let term = terminals[session];
  if (!term) throw new Error(`Unknown terminal session: ${session}`);
  clearInterval(term.monint);
  term.kill();
});

s.events.on('message:shell', ({ session, payload }) => {
  let term = terminals[session];
  if (!term) throw new Error(`Unknown terminal session: ${session}`);
  term.write(Buffer.from(payload, 'base64').toString('utf-8'));
});

console.log('Webfoundry Companion listening on ws://localhost:8845/');
console.log(`Current workspace: ${workspace}`);

// The project-root .gitignore as a path predicate. Shared by the Companion's files:list (which
// decides what the IDE sees) and wf reflect, so both agree on a project's files.
import fs from 'fs';
import path from 'path';
import { minimatch } from 'minimatch';

export function buildGitignoreMatcher(root) {
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

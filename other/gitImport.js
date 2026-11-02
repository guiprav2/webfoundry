import git from 'https://esm.run/isomorphic-git';
import gitHttp from 'https://unpkg.com/isomorphic-git@beta/http/web/index.js';

export let gitCorsProxy = 'https://cors.isomorphic-git.org';

export async function loadGitBranchInfo(repoUrl) {
  let trimmed = (repoUrl || '').trim();
  if (!trimmed) throw new Error('Repository URL required.');
  try {
    new URL(trimmed);
  } catch (err) {
    throw new Error('Enter a valid repository URL.');
  }
  let refs = [];
  let info = null;
  try {
    info = await git.getRemoteInfo({ http: gitHttp, url: trimmed, corsProxy: gitCorsProxy });
    refs = normalizeGitRefs(info?.refs);
  } catch (err) {
    try {
      refs = await git.listServerRefs({ http: gitHttp, url: trimmed, corsProxy: gitCorsProxy });
    } catch (err2) {
      throw new Error(err?.message || 'Unable to read repository.');
    }
  }
  let { branches, defaultBranch } = parseGitBranches(refs, info);
  if (!branches.length) throw new Error('No Git branches found.');
  return { branches, defaultBranch };
}

export function deriveProjectNameFromUrl(repoUrl) {
  if (!repoUrl) return '';
  try {
    let remote = new URL(repoUrl);
    let parts = remote.pathname.split('/').filter(Boolean);
    if (!parts.length) return '';
    let last = parts[parts.length - 1] || '';
    return decodeURIComponent(last.replace(/\.git$/, ''));
  } catch (err) {
    return '';
  }
}

function normalizeGitRefs(refs) {
  if (!refs) return [];
  if (Array.isArray(refs)) return refs;
  let entries = [];
  let walk = (node, parts = []) => {
    if (node == null) return;
    if (typeof node === 'string') {
      if (!parts.length) return;
      let ref = parts.join('/');
      if (!ref.startsWith('refs/')) ref = `refs/${ref}`;
      entries.push({ ref, oid: node });
      return;
    }
    if (typeof node === 'object' && !Array.isArray(node)) {
      if (typeof node.oid === 'string' && parts.length) {
        let ref = parts.join('/');
        if (!ref.startsWith('refs/')) ref = `refs/${ref}`;
        let entry = { ref, oid: node.oid };
        if (node.target) entry.target = node.target;
        entries.push(entry);
        return;
      }
      for (let [key, value] of Object.entries(node)) walk(value, [...parts, key]);
    }
  };
  walk(refs, []);
  return entries;
}

function parseGitBranches(refs, info) {
  refs = refs || [];
  let branches = refs
    .map(x => x?.ref || x)
    .filter(x => typeof x === 'string' && x.startsWith('refs/heads/'))
    .map(trimGitBranch);
  branches = Array.from(new Set(branches.filter(Boolean))).sort((a, b) => a.localeCompare(b));
  let defaultBranch = trimGitBranch(info?.defaultBranch) || trimGitBranch(info?.HEAD?.ref) || trimGitBranch(info?.HEAD?.target);
  if (!defaultBranch) {
    let head = refs.find(x => (x?.ref || x) === 'HEAD');
    defaultBranch = trimGitBranch(head?.target || head?.symref);
  }
  if (!defaultBranch) {
    if (branches.includes('main')) defaultBranch = 'main';
    else if (branches.includes('master')) defaultBranch = 'master';
  }
  return { branches, defaultBranch };
}

function trimGitBranch(ref) {
  if (!ref || typeof ref !== 'string') return null;
  return ref.replace(/^refs\/heads\//, '');
}

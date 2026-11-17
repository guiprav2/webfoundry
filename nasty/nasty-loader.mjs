/**
 * Combined ESM loader for Nasty-hosted Webfoundry apps:
 * - resolves `wf-nasty:globals` to wf-globals.mjs
 * - fetches/caches https: imports (esm.run)
 * - injects `import { state, post, … } from 'wf-nasty:globals'` into app modules
 *   so bare globals work under Node ESM
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const GLOBALS_URL = pathToFileURL(join(here, 'wf-globals.mjs')).href;

const WF_GLOBAL_NAMES = [
  'anime',
  'arrayify',
  'd',
  'post',
  'rawctrls',
  'renderComponent',
  'renderTemplate',
  'selectFile',
  'showModal',
  'state',
  'tap',
  'triggerRouterError',
  'wfeval',
  'document',
  'window',
  'localStorage',
  'sessionStorage',
  'location',
  'history',
  'fetch',
  'navigator',
  'rootPrefix',
  'bundleName',
  'Node',
  'Element',
  'HTMLElement',
  'Text',
  'Comment',
  'Document',
  'Attr',
  'MutationObserver',
  'ResizeObserver',
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'scrollTo',
  'alert',
];

const SKIP_FILES = new Set([
  'main.js',
  'shim.js',
  'nasty-loader.mjs',
  'https-loader.mjs',
  'wf-globals.mjs',
  'export-native.js',
  'tar.js',
  'overlay-boot.mjs',
  'overlay.mjs',
  'overlay.js',
  'test-tar.mjs',
]);

const cacheDir = join(
  process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
  'nasty-wf-https',
);

function cachePath(url) {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 24);
  return join(cacheDir, `${hash}.js`);
}

function appRoot() {
  return process.env.NASTY_WF_APP_ROOT || '';
}

function underAppRoot(filePath) {
  const root = appRoot();
  if (!root) return false;
  const resolved = filePath.endsWith(sep) ? filePath : filePath;
  return resolved === root || resolved.startsWith(root.endsWith(sep) ? root : root + sep);
}

function shouldInject(url) {
  if (!url.startsWith('file:')) return false;
  if (url === GLOBALS_URL) return false;
  let filePath;
  try {
    filePath = fileURLToPath(url);
  } catch {
    return false;
  }
  if (!underAppRoot(filePath)) return false;
  const base = filePath.split(sep).pop();
  if (SKIP_FILES.has(base)) return false;
  if (!/\.(js|mjs)$/.test(base)) return false;
  // Do not rewrite the Nasty runtime package if it ever appears under the app tree.
  if (filePath.includes(`${sep}node_modules${sep}nasty${sep}`)) return false;
  return true;
}

function isLocallyBound(source, name) {
  const patterns = [
    new RegExp(`\\bimport\\s+${name}\\s+from\\b`),
    new RegExp(`\\bimport\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\b`),
    new RegExp(`\\bimport\\s+${name}\\s*,`),
    new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`),
    new RegExp(`\\bfunction\\s+${name}\\b`),
    new RegExp(`\\bclass\\s+${name}\\b`),
  ];
  return patterns.some((re) => re.test(source));
}

function injectGlobalsImport(source) {
  if (
    source.includes("from 'wf-nasty:globals'") ||
    source.includes('from "wf-nasty:globals"')
  ) {
    return source;
  }
  const names = WF_GLOBAL_NAMES.filter((n) => !isLocallyBound(source, n));
  if (!names.length) return source;
  return `import { ${names.join(', ')} } from 'wf-nasty:globals';\n` + source;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'wf-nasty:globals') {
    return { shortCircuit: true, url: GLOBALS_URL };
  }
  if (specifier.startsWith('https://') || specifier.startsWith('http://')) {
    return { shortCircuit: true, url: specifier };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('https://') || url.startsWith('http://')) {
    mkdirSync(cacheDir, { recursive: true });
    const file = cachePath(url);
    if (!existsSync(file)) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTPS import failed ${res.status}: ${url}`);
      writeFileSync(file, await res.text());
    }
    return {
      shortCircuit: true,
      format: 'module',
      source: readFileSync(file, 'utf8'),
    };
  }

  if (shouldInject(url)) {
    const filePath = fileURLToPath(url);
    const source = injectGlobalsImport(readFileSync(filePath, 'utf8'));
    return {
      shortCircuit: true,
      format: 'module',
      source,
    };
  }

  return nextLoad(url, context);
}

/**
 * Node ESM loader: resolve https:/http: imports (esm.run CDN deps used by WF app.js).
 * Registered from main.js via module.register before importing webfoundry/app.js.
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const cacheDir = join(
  process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
  'nasty-wf-https',
);

function cachePath(url) {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 24);
  return join(cacheDir, `${hash}.js`);
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('https://') || specifier.startsWith('http://')) {
    return { shortCircuit: true, url: specifier };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith('https://') && !url.startsWith('http://')) {
    return nextLoad(url, context);
  }
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

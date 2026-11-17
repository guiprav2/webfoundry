/**
 * Browser-side: build Nasty native bundles for the current project
 * (linux-x64 AppImage overlay, android-arm64 APK inject + debug resign).
 */
import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3.10.2/+esm';
import { ApkSigner, SigningKey } from 'https://cdn.jsdelivr.net/npm/apk_sign_ts@1.0.1/browser/+esm';
import rfiles from '../repos/rfiles.js';
import { appendOverlay, createTarGz } from './tar.js';
import { fetchGoogleFontFaces, fontFileStem, gfontTokenToFamily, scanGfontNames } from './gfonts.js';

// Generic Nasty runtimes (no app), hosted on the Nasty site with CORS headers (its _headers file).
let NASTY_RUNTIME_BASE = 'https://nasty-engine.netlify.app/runtime/';
let LINUX_BUNDLE_URL = `${NASTY_RUNTIME_BASE}nasty-runtime-x86_64.AppImage`;
let ANDROID_BUNDLE_URL = `${NASTY_RUNTIME_BASE}nasty-runtime-arm64.apk`;
const SIGNING_KEY_URL = new URL('./signing/key.pem', import.meta.url).href;
const SIGNING_CERT_URL = new URL('./signing/cert.pem', import.meta.url).href;

function clampDim(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(200, Math.min(10000, Math.round(n)));
}

/** Sanitize to Nasty Window appId: /^[A-Za-z0-9][A-Za-z0-9._-]*$/ */
function sanitizeAppId(name) {
  let id = String(name || 'app').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!id) id = 'webfoundry-app';
  if (!/^[A-Za-z0-9]/.test(id)) id = `wf-${id}`;
  return id.slice(0, 64);
}

const RESIZABLE_MODES = new Set(['both', 'horizontal', 'vertical', 'none']);
const ORIENTATIONS = new Set(['auto', 'portrait', 'landscape']);

function normalizeClassNames(value) {
  return String(value ?? '')
    .trim()
    .split(/[\t\n\f\r ]+/)
    .filter(Boolean)
    .join(' ');
}

function normalizeResizable(value) {
  let mode = String(value ?? 'both').trim().toLowerCase();
  return RESIZABLE_MODES.has(mode) ? mode : 'both';
}

function normalizeOrientation(value) {
  let mode = String(value ?? 'auto').trim().toLowerCase();
  return ORIENTATIONS.has(mode) ? mode : 'auto';
}

/**
 * Collect project + adapter files for a native overlay (shared by linux/android).
 * @returns {Promise<Record<string, Uint8Array>>}
 */
async function buildOverlayFiles(project, opts = {}) {
  const projectName = (opts.name || project.split(':')[0] || 'app').replace(/[^\w.-]+/g, '-');
  opts.onProgress?.({ phase: 'files' });

  const files = {};
  for (const path of await rfiles.list(project)) {
    if (/(^\.git\/|(^|\/)node_modules\/)/.test(path)) continue;
    if (path.startsWith('nasty/signing/')) continue;
    const blob = await rfiles.load(project, path);
    if (!blob) continue;
    files[path] = new Uint8Array(await blob.arrayBuffer());
  }
  // Snapshot before adapter/runtime files join, so the font scan sees only project sources.
  let projectFiles = { ...files };

  for (const name of [
    'main.js',
    'shim.js',
    'wf-globals.mjs',
    'nasty-loader.mjs',
    'https-loader.mjs',
  ]) {
    const res = await fetch(new URL(`./${name}`, import.meta.url));
    if (!res.ok) throw new Error(`Missing adapter file nasty/${name} (${res.status})`);
    files[name] = new Uint8Array(await res.arrayBuffer());
  }

  for (const name of ['app.js', 'dominant.js']) {
    const res = await fetch(new URL(`../webfoundry/${name}`, import.meta.url));
    if (!res.ok) throw new Error(`Missing webfoundry/${name} (${res.status})`);
    files[`webfoundry/${name}`] = new Uint8Array(await res.arrayBuffer());
  }

  files['.nasty-entry'] = new TextEncoder().encode('main.js\n');
  if (!files['package.json']) {
    files['package.json'] = new TextEncoder().encode(
      `${JSON.stringify({ name: projectName, private: true, type: 'module' }, null, 2)}\n`,
    );
  }

  // Optional branding: project icons/, else IDE favicon.ico as icons/icon.png bytes.
  await ensureOverlayIcons(project, files);

  // Vendor Google Fonts the project's own pages/components/controllers reference
  // (gfont-[Font_Name], theme classes) so first launch works offline.
  opts.onProgress?.({ phase: 'fonts' });
  await ensureOverlayGfonts(files, projectFiles);

  const windowConfig = {
    width: clampDim(opts.width, 1280),
    height: clampDim(opts.height, 800),
    startMaximized: !!opts.startMaximized,
    rememberDimensions: opts.rememberDimensions !== false,
    borderless: !!opts.borderless,
    dragAnywhere: !!opts.dragAnywhere,
    resizable: normalizeResizable(opts.resizable),
    orientation: normalizeOrientation(opts.orientation),
    documentClassNames: normalizeClassNames(opts.documentClassNames),
    // Theme: adwaita | kendo | beer (forced), system (host OS), none (web look).
    theme: ['adwaita', 'kendo', 'beer', 'system'].includes(opts.theme) ? opts.theme : 'none',
    // File name of the exported bundle (window.bundleName fallback when the host
    // doesn't report it, e.g. Android; Linux reads the running AppImage's name).
    bundleFileName: typeof opts.bundleFileName === 'string' ? opts.bundleFileName : undefined,
    appId: sanitizeAppId(projectName),
    title: projectName,
  };
  files['nasty-window.json'] = new TextEncoder().encode(`${JSON.stringify(windowConfig, null, 2)}\n`);
  return files;
}

// Fonts a theme's classes need at runtime, vendored like gfont-[…] so first launch
// neither waits on nor depends on downloads. Beer (and-*) draws every icon with
// Material Symbols ligatures (~1 MB per weight; only regular is used) and sets
// text in Inter, the first family of its --font stack. Suffixes follow
// fetchGoogleFontFaces file names ('' = 400, _500, _bold = 700).
const THEME_FONTS = [
  { classRe: /(?:^|[\s"'`:])and-[a-z]/, family: 'Material Symbols Outlined', suffixes: [''] },
  { classRe: /(?:^|[\s"'`:])and-[a-z]/, family: 'Inter', suffixes: ['', '_500', '_bold'] },
];

// Files whose text counts as font usage: the project's own markup, scripts and
// styles. Skipped: webfoundry/ (runtime: *.tw.css define every and-* class,
// head.js/app.js mention gfont-[…], and templates.json only mirrors the project's
// .html files, which are scanned directly), docs such as AGENTS.md, and binaries.
function isFontUsageSource(path) {
  if (path.startsWith('webfoundry/') || path === 'wf.config.js') return false;
  return /\.(html?|[cm]?js|jsx|tsx?|css|json|svg)$/i.test(path);
}

async function ensureOverlayGfonts(files, sources = files) {
  const names = new Set();
  const themeFonts = new Map();
  const decoder = new TextDecoder();
  for (const [path, bytes] of Object.entries(sources)) {
    if (!isFontUsageSource(path)) continue;
    try {
      const text = decoder.decode(bytes);
      for (const name of scanGfontNames(text)) names.add(name);
      for (const font of THEME_FONTS) if (font.classRe.test(text)) themeFonts.set(font.family, font.suffixes);
    } catch {
      // Non-text bytes — skip.
    }
  }
  const hasFamily = family => {
    const stem = fontFileStem(family);
    return Object.keys(files).some(path => {
      if (!path.startsWith('fonts/')) return false;
      const base = path.slice('fonts/'.length).toLowerCase().replace(/\.[^.]+$/, '');
      return base === stem || base.startsWith(`${stem}_`) || base.startsWith(`${stem}-`);
    });
  };
  for (const token of names) {
    const family = gfontTokenToFamily(token);
    if (!family || hasFamily(family)) continue;
    themeFonts.delete(family);
    try {
      const faces = await fetchGoogleFontFaces(family);
      for (const face of faces) files[`fonts/${face.fileName}`] = face.data;
    } catch (error) {
      console.warn(`Webfoundry native export: skip gfont-[${token}]:`, error?.message || error);
    }
  }
  for (const [family, suffixes] of themeFonts) {
    if (hasFamily(family)) continue;
    const stem = fontFileStem(family);
    try {
      const faces = await fetchGoogleFontFaces(family);
      for (const face of faces) {
        const base = face.fileName.toLowerCase().replace(/\.[^.]+$/, '');
        if (suffixes.some(suffix => base === `${stem}${suffix}`)) files[`fonts/${face.fileName}`] = face.data;
      }
    } catch (error) {
      console.warn(`Webfoundry native export: skip theme font ${family}:`, error?.message || error);
    }
  }
}

async function ensureOverlayIcons(project, files) {
  const hasIcon = Object.keys(files).some(p => p === 'icons/icon.png' || p === 'icons/icon-256.png');
  if (hasIcon) return;
  for (const candidate of ['icons/icon.png', 'favicon.ico', '../favicon.ico']) {
    // project favicon
    if (candidate === '../favicon.ico') continue;
    if (files[candidate]) {
      if (candidate !== 'icons/icon.png') files['icons/icon.png'] = files[candidate];
      return;
    }
  }
  if (files['favicon.ico']) {
    files['icons/icon.png'] = files['favicon.ico'];
    return;
  }
  try {
    const res = await fetch(new URL('../favicon.ico', import.meta.url));
    if (res.ok) {
      files['icons/icon.png'] = new Uint8Array(await res.arrayBuffer());
    }
  } catch {
    // optional
  }
}

/**
 * Read a runtime bundle response, reporting { phase: 'download', loaded, total }.
 * total is null when unknown (no Content-Length, or it's the compressed size).
 */
async function readBundle(res, onProgress) {
  if (!onProgress || !res.body) return res.blob();
  let total = res.headers.get('Content-Encoding') ? null : Number(res.headers.get('Content-Length')) || null;
  let reader = res.body.getReader();
  let chunks = [];
  let loaded = 0;
  onProgress({ phase: 'download', loaded, total });
  while (true) {
    let { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress({ phase: 'download', loaded, total: total && Math.max(total, loaded) });
  }
  return new Blob(chunks);
}

/**
 * @param {string} project
 * @param {object} [opts] window options, plus optional onProgress({ phase, loaded?, total?, percent? })
 *   with phases files, fonts, compress, download, build.
 * @returns {Promise<Blob>}
 */
export async function exportLinuxAppImage(project, opts = {}) {
  const files = await buildOverlayFiles(project, { bundleFileName: `${opts.name || 'app'}-x86_64.AppImage`, ...opts });
  opts.onProgress?.({ phase: 'compress' });
  const tarGz = await createTarGz(files);
  const runtimeRes = await fetch(LINUX_BUNDLE_URL);
  if (!runtimeRes.ok) {
    throw new Error(
      `Failed to download linux-x64 runtime bundle (${runtimeRes.status}). Expected ${LINUX_BUNDLE_URL}`,
    );
  }
  const runtimeBlob = await readBundle(runtimeRes, opts.onProgress);
  opts.onProgress?.({ phase: 'build' });
  return appendOverlay(runtimeBlob, tarGz);
}

/**
 * Inject project overlay into the hosted android-arm64 runtime APK and resign
 * with the shipped debug key (sideload / adb install; not Play Store).
 * @param {string} project
 * @param {object} [opts] window options, plus optional onProgress({ phase, loaded?, total?, percent? })
 *   with phases files, fonts, download, build, pack (percent), sign.
 * @returns {Promise<Blob>}
 */
export async function exportAndroidApk(project, opts = {}) {
  const files = await buildOverlayFiles(project, { bundleFileName: `${opts.name || 'app'}.apk`, ...opts });
  const runtimeRes = await fetch(ANDROID_BUNDLE_URL);
  if (!runtimeRes.ok) {
    throw new Error(
      `Failed to download android-arm64 runtime bundle (${runtimeRes.status}). Expected ${ANDROID_BUNDLE_URL}`,
    );
  }
  const runtimeBuf = new Uint8Array(await (await readBundle(runtimeRes, opts.onProgress)).arrayBuffer());
  opts.onProgress?.({ phase: 'build' });
  const zip = await JSZip.loadAsync(runtimeBuf);

  // Drop previous project files under assets/nasty/, keep runtime fonts + node_modules/nasty.
  const keepPrefix = [
    'assets/nasty/fonts/',
    'assets/nasty/node_modules/nasty/',
  ];
  for (const path of Object.keys(zip.files)) {
    if (!path.startsWith('assets/nasty/')) continue;
    if (path === 'assets/nasty/' || path === 'assets/nasty') continue;
    if (keepPrefix.some(p => path === p || path.startsWith(p))) continue;
    zip.remove(path);
  }

  for (const [rel, bytes] of Object.entries(files)) {
    zip.file(`assets/nasty/${rel}`, bytes);
  }
  zip.file('assets/nasty/entry', 'main.js\n');

  // Regenerate files.list from remaining assets/nasty entries.
  const listed = Object.keys(zip.files)
    .filter(p => p.startsWith('assets/nasty/') && !zip.files[p].dir)
    .map(p => p.slice('assets/nasty/'.length))
    .filter(p => p && p !== 'files.list' && !p.split('/').some(seg => seg.startsWith('.')))
    .sort();
  zip.file('assets/nasty/files.list', `${listed.join('\n')}\n`);

  // Strip old signatures so resign can attach a new block.
  for (const path of Object.keys(zip.files)) {
    if (!path.startsWith('META-INF/')) continue;
    if (/\.(SF|RSA|DSA|EC)$/i.test(path) || /MANIFEST\.MF$/i.test(path)) {
      zip.remove(path);
    }
  }

  let onPack = opts.onProgress && (meta => opts.onProgress({ phase: 'pack', percent: meta.percent }));
  const unsigned = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }, onPack);
  opts.onProgress?.({ phase: 'sign' });
  // opts.signingKey { keyPem, certPem } (e.g. from apk-signing-key.js) replaces the shared debug key.
  const [keyPem, certPem] = opts.signingKey ? [opts.signingKey.keyPem, opts.signingKey.certPem] : await Promise.all([
    fetch(SIGNING_KEY_URL).then(r => {
      if (!r.ok) throw new Error(`Missing nasty/signing/key.pem (${r.status})`);
      return r.text();
    }),
    fetch(SIGNING_CERT_URL).then(r => {
      if (!r.ok) throw new Error(`Missing nasty/signing/cert.pem (${r.status})`);
      return r.text();
    }),
  ]);
  let signedApk;
  try {
    signedApk = await signApkInWorker(unsigned, keyPem, certPem);
  } catch (err) {
    if (!err?.workerUnavailable) throw err;
    console.warn('Webfoundry native export: signing on the main thread:', err.message);
    let signer = new ApkSigner({ signingKey: SigningKey.fromPEM(keyPem, certPem) });
    signedApk = (await signer.sign(unsigned)).signedApk;
  }
  return new Blob([signedApk], { type: 'application/vnd.android.package-archive' });
}

// Rejects with err.workerUnavailable when the worker can't start, so the caller can sign inline.
function signApkInWorker(apk, keyPem, certPem) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./sign-apk-worker.js', import.meta.url), { type: 'module' });
    } catch (err) {
      return reject(Object.assign(new Error(err?.message || String(err)), { workerUnavailable: true }));
    }
    worker.onmessage = ({ data }) => {
      worker.terminate();
      if (data.error) reject(new Error(data.error));
      else resolve(data.signedApk);
    };
    worker.onerror = ev => {
      ev.preventDefault?.();
      worker.terminate();
      reject(Object.assign(new Error(ev.message || 'APK signing worker failed to load'), { workerUnavailable: true }));
    };
    // Not transferred: the inline fallback may still need the bytes.
    worker.postMessage({ apk, keyPem, certPem });
  });
}

export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.className = 'hidden';
  a.download = filename;
  a.href = URL.createObjectURL(blob);
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

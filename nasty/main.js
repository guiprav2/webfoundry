/**
 * Nasty entry for a Webfoundry project export.
 * Boots webfoundry/app.js inside a native Window/Document.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as nasty from 'nasty';
import { Document, Window, DOMParser } from 'nasty';
import { defineGlobal } from './wf-globals.mjs';
import { installShims } from './shim.js';

const appRoot = dirname(fileURLToPath(import.meta.url));
process.env.NASTY_WF_APP_ROOT = appRoot;
// Android packs fonts at <payload>/fonts while nasty lives under node_modules/nasty,
// so font-registry's ../fonts relative path misses. Point lookups at the payload fonts.
process.env.NASTY_FONT_DIR ??= join(appRoot, 'fonts');

// HTTPS CDN imports + bare WF globals (state/post/…) via live ESM bindings.
register(pathToFileURL(join(appRoot, 'nasty-loader.mjs')).href);

if (typeof globalThis.DOMParser !== 'function') {
  globalThis.DOMParser = DOMParser;
}

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function clampDim(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(200, Math.min(10000, Math.round(n)));
}

const baked = loadJson(join(appRoot, 'nasty-window.json')) || {};

// Export theme: a forced theme activates its platform's OS variant whatever the
// host is (Adwaita → lin:adw-*, Kendo UI → win:win-*, Beer → android:and-*);
// system leaves Nasty's auto-detected OS; none renders like the web preview
// (native:/desktop:/mobile: only). Older bundles baked a systemTheme boolean.
// Namespace import so runtimes without setTailwindOsKind still boot.
const THEME_OS = { adwaita: 'lin', kendo: 'win', beer: 'android' };
const theme = typeof baked.theme === 'string' ? baked.theme : baked.systemTheme === true ? 'system' : 'none';
if (THEME_OS[theme]) nasty.setTailwindOsKind?.(THEME_OS[theme]);
else if (theme !== 'system') nasty.setTailwindOsKind?.(null);
const appId = typeof baked.appId === 'string' && baked.appId
  ? baked.appId
  : (process.env.NASTY_WF_APP_ID || 'webfoundry-app');
const title = typeof baked.title === 'string' && baked.title
  ? baked.title
  : (process.env.NASTY_WF_TITLE || 'Webfoundry App');
const remember = baked.rememberDimensions !== false;
const RESIZABLE_MODES = new Set(['both', 'horizontal', 'vertical', 'none']);
function normalizeResizable(value) {
  const mode = String(value ?? 'both').trim().toLowerCase();
  return RESIZABLE_MODES.has(mode) ? mode : 'both';
}

const ORIENTATIONS = new Set(['auto', 'portrait', 'landscape']);
function normalizeOrientation(value) {
  const mode = String(value ?? 'auto').trim().toLowerCase();
  return ORIENTATIONS.has(mode) ? mode : 'auto';
}

const defaults = {
  width: clampDim(baked.width, 1280),
  height: clampDim(baked.height, 800),
  maximized: !!baked.startMaximized,
  borderless: !!baked.borderless,
  dragAnywhere: !!baked.dragAnywhere,
  resizable: normalizeResizable(baked.resizable),
  orientation: normalizeOrientation(baked.orientation),
};

// Remembered geometry lives on the end-user machine under $HOME/.<appId>/window.json.
const userDataPath = join(homedir(), `.${appId}`);
let width = defaults.width;
let height = defaults.height;
let maximized = defaults.maximized;
let lastNormal = { width, height };

if (remember) {
  const saved = loadJson(join(userDataPath, 'window.json'));
  if (saved) {
    width = clampDim(saved.width, width);
    height = clampDim(saved.height, height);
    if (typeof saved.maximized === 'boolean') maximized = saved.maximized;
    lastNormal = { width, height };
  }
}

const win = new Window({
  appId,
  title,
  width,
  height,
  maximized,
  maximizable: true,
  resizable: defaults.resizable,
  borderless: defaults.borderless,
  dragAnywhere: defaults.dragAnywhere,
  orientation: defaults.orientation,
});
const doc = new Document();
win.document = doc;

installShims({ appRoot, win, doc });
// Bare `bundleName` / `window.bundleName`: the bundle's file name (undefined on the web).
// Linux: the running AppImage as the user named it ($APPIMAGE is set by the AppImage
// runtime); elsewhere the file name baked at export (e.g. counter.apk).
const bundleName = process.env.APPIMAGE ? basename(process.env.APPIMAGE)
  : typeof baked.bundleFileName === 'string' && baked.bundleFileName ? baked.bundleFileName
    : title;
defineGlobal('bundleName', bundleName);

let saveGeometryTimer = null;

function saveWindowGeometry() {
  if (!remember || !win.userDataPath) return;
  try {
    mkdirSync(win.userDataPath, { recursive: true });
    const size = win.size();
    const isMax = !!win.maximized;
    if (!isMax && size?.width > 0 && size?.height > 0) {
      lastNormal = { width: Math.round(size.width), height: Math.round(size.height) };
    }
    writeFileSync(
      join(win.userDataPath, 'window.json'),
      `${JSON.stringify({
        width: lastNormal.width,
        height: lastNormal.height,
        maximized: isMax,
      }, null, 2)}\n`,
    );
  } catch (err) {
    console.warn('Failed to save window geometry:', err?.message || err);
  }
}

/** Debounce resize-driven writes; flush immediately on maximize/close. */
function scheduleSaveWindowGeometry() {
  if (!remember) return;
  if (saveGeometryTimer) clearTimeout(saveGeometryTimer);
  saveGeometryTimer = setTimeout(() => {
    saveGeometryTimer = null;
    saveWindowGeometry();
  }, 200);
}

function flushSaveWindowGeometry() {
  if (saveGeometryTimer) {
    clearTimeout(saveGeometryTimer);
    saveGeometryTimer = null;
  }
  saveWindowGeometry();
}

// Seed d before app.js loads controllers that import { d } from wf-nasty:globals.
const dominant = (await import(pathToFileURL(join(appRoot, 'webfoundry/dominant.js')).href)).default;
defineGlobal('d', dominant);
globalThis.d = dominant;

const appMod = await import(pathToFileURL(join(appRoot, 'webfoundry/app.js')).href);
// Match Webfoundry page bodies: first child fills the column (Tailwind
// [&>div:first-child]:flex-1 is resolved onto that child by Nasty).
const baseBodyClass = 'flex flex-col [&>div:first-child]:flex-1 h-full bg-white text-black';
const extraBodyClass = typeof baked.documentClassNames === 'string'
  ? baked.documentClassNames.trim().split(/[\t\n\f\r ]+/).filter(Boolean).join(' ')
  : '';
doc.body.className = extraBodyClass ? `${baseBodyClass} ${extraBodyClass}` : baseBodyClass;
doc.body.appendChild(dominant.el(appMod.default));

// Nasty polls the native event queue itself, routes pointer/wheel/key events to
// the document, and re-dispatches every event on the window. Do NOT call
// win.drainEvents() here: whatever this loop drained never reached the DOM, so
// clicks and scrolling were randomly lost. Listen on the window instead.
let closing = false;
win.addEventListener('close', () => {
  if (closing) return;
  closing = true;
  flushSaveWindowGeometry();
  if (!win.closed) win.close();
  doc.close?.();
});
// Track live size in memory; debounce disk writes to 200ms after resize ticks.
win.addEventListener('resize', () => {
  if (!win.maximized) {
    const size = win.size();
    if (size?.width > 0 && size?.height > 0) {
      lastNormal = { width: Math.round(size.width), height: Math.round(size.height) };
    }
  }
  scheduleSaveWindowGeometry();
});
win.addEventListener('maximize', () => flushSaveWindowGeometry());

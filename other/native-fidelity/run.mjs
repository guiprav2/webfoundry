#!/usr/bin/env node
// Native fidelity harness: renders each fixture page in headless Chrome (Webfoundry
// runtime, platform preview attributes) and in Nasty (the prebuilt linux-x64 runtime
// under Xvfb), then diffs the screenshots and writes report.json + report.html.
//
//   node other/native-fidelity/run.mjs [--out DIR] [--only name,…] [--tolerance 32] [--max-mismatch 0.02]
//     [--width 800] [--height 600] [--timeout 90000] [--playwright path/to/playwright-core/index.mjs]
//     [--chrome /usr/bin/google-chrome] [--skip-nasty] [--skip-browser] [--xvfb]
//     [--appimage path/to/nasty-runtime-x86_64.AppImage]  (default: Nasty's runtime cache)
//
// Nasty windows open on the normal desktop, as Nasty's own AGENTS.md requires (virtual X
// runs have slowed or crashed the machine); --xvfb opts into xvfb-run for CI.
// Needs network (CDN imports, Tailwind runtime, Google Fonts), Chrome and
// playwright-core. The runtime AppImage is extracted once into <out>/runtime; the
// bundle itself is never modified.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { captureController, fixtures, pageHtml } from './fixtures.mjs';
import { fetchGoogleFontFaces, fontFileStem, gfontTokenToFamily, scanGfontNames } from '../../nasty/gfonts.js';

let repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let args = parseArgs(process.argv.slice(2));
let out = resolve(args.out || join(tmpdir(), 'wf-native-fidelity'));
let width = Number(args.width || 800);
let height = Number(args.height || 600);
let timeoutMs = Number(args.timeout || 90000);
let tolerance = Number(args.tolerance ?? 32);
let maxMismatch = Number(args['max-mismatch'] ?? 0.02);
let only = args.only ? new Set(String(args.only).split(',')) : null;
let selected = fixtures.filter(f => !only || only.has(f.name));
let children = new Set();

process.on('exit', () => { for (let child of children) killTree(child); });
for (let sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

mkdirSync(join(out, 'shots'), { recursive: true });
let results = selected.map(f => ({ name: f.name, description: f.description, theme: f.theme, browserAttrs: f.browserAttrs }));

if (!args['skip-nasty']) {
  let runtime = ensureRuntime();
  for (let [i, fixture] of selected.entries()) results[i].nasty = await runNasty(runtime, fixture);
}
let pw = await loadPlaywright();
let browser = await pw.chromium.launch({ executablePath: args.chrome || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
try {
  if (!args['skip-browser']) {
    for (let [i, fixture] of selected.entries()) results[i].browser = await runBrowser(browser, fixture);
  }
  for (let r of results) r.diff = await compare(browser, r);
} finally {
  await browser.close();
}

let report = { generatedAt: new Date().toISOString(), width, height, tolerance, maxMismatch, results };
writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(out, 'report.html'), reportHtml(report));
for (let r of results) {
  let d = r.diff;
  let verdict = d?.mismatch == null ? 'n/a' : d.pass ? 'PASS' : 'FAIL';
  console.log(`${verdict.padEnd(4)} ${r.name.padEnd(20)} mismatch=${d?.mismatch == null ? '-' : (d.mismatch * 100).toFixed(2) + '%'} nasty=${r.nasty?.ok ? r.nasty.ms + 'ms' : r.nasty?.error || 'skipped'} browser=${r.browser?.ok ? r.browser.ms + 'ms' : r.browser?.error || 'skipped'}`);
}
console.log(`Report: ${join(out, 'report.html')}`);
process.exit(results.every(r => r.diff?.pass) ? 0 : 1);

function parseArgs(argv) {
  let res = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    let key = argv[i].slice(2);
    res[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return res;
}

async function loadPlaywright() {
  let candidates = [args.playwright, process.env.PLAYWRIGHT_CORE, 'playwright-core'].filter(Boolean);
  for (let c of candidates) {
    try { return await import(c.startsWith('/') ? pathToFileURL(c).href : c); } catch {}
  }
  throw new Error('playwright-core not found: pass --playwright /path/to/playwright-core/index.mjs or set PLAYWRIGHT_CORE');
}

function killTree(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
}

// Extract the AppImage once (keyed by its size and mtime) so each run reuses it.
function ensureRuntime() {
  let bundle = args.appimage || join(homedir(), 'prog/nasty-tools/appimage/nasty-runtime-x86_64.AppImage');
  let st = statSync(bundle);
  let dir = join(out, 'runtime');
  let key = `${st.size}-${st.mtimeMs}`;
  let marker = join(dir, '.key');
  if (!existsSync(marker) || readFileSync(marker, 'utf8') !== key) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    let t0 = Date.now();
    let r = spawnSync(bundle, ['--appimage-extract'], { cwd: dir, stdio: 'ignore', timeout: 180000 });
    if (r.status !== 0) throw new Error(`AppImage extraction failed (${r.status ?? r.signal})`);
    writeFileSync(marker, key);
    console.log(`Extracted Nasty runtime in ${Date.now() - t0}ms`);
  }
  return join(dir, 'squashfs-root');
}

function projectFiles(fixture) {
  let html = pageHtml(fixture);
  return {
    'pages/index.html': html,
    'controllers/Fidelity.js': captureController,
    'webfoundry/templates.json': JSON.stringify({ 'pages/index.html': html }),
    'webfoundry/scripts.json': JSON.stringify(['controllers/Fidelity.js']),
    'wf.uiconfig.json': JSON.stringify({ tailwind: true, nerdfonts: false, betterscroll: false }),
  };
}

// Theme fonts the export vendors for and-* (see THEME_FONTS in nasty/export-native.js),
// plus any gfont-[…] tokens; cached under <out>/fonts.
async function vendorFonts(fixture, appDir) {
  let text = pageHtml(fixture);
  let families = [...scanGfontNames(text)].map(gfontTokenToFamily);
  let themed = /(?:^|[\s"'`:])and-[a-z]/.test(text);
  if (themed) families.push('Material Symbols Outlined', 'Inter');
  for (let family of families) {
    let stem = fontFileStem(family);
    let cache = join(out, 'fonts', stem);
    if (!existsSync(join(cache, '.ready'))) {
      mkdirSync(cache, { recursive: true });
      for (let face of await fetchGoogleFontFaces(family)) writeFileSync(join(cache, face.fileName), face.data);
      writeFileSync(join(cache, '.ready'), '');
    }
    mkdirSync(join(appDir, 'fonts'), { recursive: true });
    for (let name of spawnSync('ls', [cache], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)) {
      copyFileSync(join(cache, name), join(appDir, 'fonts', name));
    }
  }
}

// Same overlay layout as buildOverlayFiles(): adapter files at the root, the runtime's
// app.js/dominant.js under webfoundry/, project files, nasty-window.json.
async function buildApp(runtime, fixture) {
  let appDir = join(out, 'apps', fixture.name);
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(join(appDir, 'webfoundry'), { recursive: true });
  for (let name of ['main.js', 'shim.js', 'wf-globals.mjs', 'nasty-loader.mjs', 'https-loader.mjs']) {
    copyFileSync(join(repo, 'nasty', name), join(appDir, name));
  }
  for (let name of ['app.js', 'dominant.js']) copyFileSync(join(repo, 'webfoundry', name), join(appDir, 'webfoundry', name));
  for (let [path, text] of Object.entries(projectFiles(fixture))) {
    mkdirSync(dirname(join(appDir, path)), { recursive: true });
    writeFileSync(join(appDir, path), text);
  }
  writeFileSync(join(appDir, '.nasty-entry'), 'main.js\n');
  writeFileSync(join(appDir, 'package.json'), `${JSON.stringify({ name: `nf-${fixture.name}`, private: true, type: 'module' }, null, 2)}\n`);
  writeFileSync(join(appDir, 'nasty-window.json'), `${JSON.stringify({
    width, height, startMaximized: false, rememberDimensions: false, borderless: false, dragAnywhere: false,
    resizable: 'none', orientation: 'auto', documentClassNames: '', theme: fixture.theme,
    appId: `nf-${fixture.name}`, title: `nf-${fixture.name}`,
  }, null, 2)}\n`);
  await vendorFonts(fixture, appDir);
  return appDir;
}

// Runs the app through the runtime's own boot script (overlay-boot.mjs), which
// uses <share>/app when there's no overlay: point that at the fixture's app dir.
async function runNasty(runtime, fixture) {
  let appDir = await buildApp(runtime, fixture);
  let share = join(runtime, 'usr/share/nasty');
  rmSync(join(share, 'app'), { recursive: true, force: true });
  symlinkSync(appDir, join(share, 'app'));
  let png = join(out, 'shots', `${fixture.name}.nasty.png`);
  rmSync(png, { force: true });
  let log = [];
  let t0 = Date.now();
  let cmd = args.xvfb ? ['xvfb-run', ['-a', '-s', `-screen 0 ${width + 200}x${height + 200}x24`, join(runtime, 'AppRun')]] : [join(runtime, 'AppRun'), []];
  let child = spawn(...cmd, {
    detached: true,
    env: {
      ...process.env,
      NF_CAPTURE: png,
      NF_SETTLE_MS: String(args.settle || 2000),
      HOME: join(out, 'home'),
      XDG_CACHE_HOME: join(out, 'home/.cache'),
      ...(args.xvfb ? { WAYLAND_DISPLAY: '' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.stdout.on('data', b => log.push(String(b)));
  child.stderr.on('data', b => log.push(String(b)));
  let timedOut = false;
  let timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
  let code = await new Promise(res => child.on('exit', (c, s) => res(c ?? s)));
  clearTimeout(timer);
  killTree(child);
  children.delete(child);
  let ms = Date.now() - t0;
  let logText = log.join('');
  writeFileSync(join(out, 'shots', `${fixture.name}.nasty.log`), logText);
  if (existsSync(png)) return { ok: true, ms, png: `shots/${fixture.name}.nasty.png`, exit: code };
  return { ok: false, ms, exit: code, error: timedOut ? `timed out after ${timeoutMs}ms` : `no capture (exit ${code})`, log: logText.slice(-2000) };
}

// Serves a project made of the repo runtime (webfoundry/*, root index.html) and the
// fixture's files straight from memory, like `npx serve -s` would.
async function runBrowser(browser, fixture) {
  let files = projectFiles(fixture);
  let ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  let errors = [];
  try {
    await ctx.addInitScript(attrs => {
      localStorage.setItem('webfoundry:dev', '1');
      // Init scripts can run before <html> exists.
      let apply = () => { for (let a of attrs) document.documentElement.setAttribute(a, ''); };
      if (document.documentElement) return apply();
      let mo = new MutationObserver(() => document.documentElement && (mo.disconnect(), apply()));
      mo.observe(document, { childList: true });
    }, fixture.browserAttrs);
    await ctx.route('http://fixture.test/**', async route => {
      let path = decodeURIComponent(new URL(route.request().url()).pathname.slice(1));
      let type = path.endsWith('.js') || path.endsWith('.mjs') ? 'text/javascript' : path.endsWith('.json') ? 'application/json' : path.endsWith('.css') ? 'text/css' : 'text/html';
      if (files[path] != null) return route.fulfill({ status: 200, contentType: type, body: files[path] });
      let disk = path === 'wf.config.js' ? join(repo, 'webfoundry/wf.config.js') : path.startsWith('webfoundry/') ? join(repo, path) : null;
      if (disk && existsSync(disk)) return route.fulfill({ status: 200, contentType: type, body: readFileSync(disk) });
      if (!path || path.endsWith('.html')) return route.fulfill({ status: 200, contentType: 'text/html', body: readFileSync(join(repo, 'index.html')) });
      return route.fulfill({ status: 404, body: '' });
    });
    let page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    let t0 = Date.now();
    await page.goto('http://fixture.test/', { timeout: timeoutMs });
    await page.waitForFunction(() => document.querySelector('[wf-onattach], body > div > *'), null, { timeout: timeoutMs });
    await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {});
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(Number(args.settle || 2000));
    let png = join(out, 'shots', `${fixture.name}.browser.png`);
    await page.screenshot({ path: png });
    // Which preview attributes and Webfoundry style blocks were live, to tell a harness
    // problem (variants never applied) from a rendering difference.
    let env = await page.evaluate(() => ({
      htmlAttrs: [...document.documentElement.attributes].map(a => a.name),
      styles: [...document.querySelectorAll('style[class^="wf-"]')].map(s => s.className),
    }));
    return { ok: true, ms: Date.now() - t0, png: `shots/${fixture.name}.browser.png`, errors, env };
  } catch (err) {
    return { ok: false, error: err.message.split('\n')[0], errors };
  } finally {
    await ctx.close();
  }
}

// Pixel diff in a blank page: a pixel mismatches when any channel differs by more
// than `tolerance`; mismatches show red over a faded copy of the browser shot.
async function compare(browser, r) {
  if (!r.nasty?.ok || !r.browser?.ok) return { pass: false, mismatch: null, note: 'missing screenshot' };
  let page = await browser.newPage();
  try {
    let a = `data:image/png;base64,${readFileSync(join(out, r.browser.png)).toString('base64')}`;
    let b = `data:image/png;base64,${readFileSync(join(out, r.nasty.png)).toString('base64')}`;
    let res = await page.evaluate(async ({ a, b, tolerance }) => {
      let load = src => new Promise((ok, fail) => { let i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src; });
      let [ia, ib] = await Promise.all([load(a), load(b)]);
      let w = Math.max(ia.width, ib.width);
      let h = Math.max(ia.height, ib.height);
      let pixels = img => {
        let c = new OffscreenCanvas(w, h);
        let g = c.getContext('2d');
        g.fillStyle = '#fff';
        g.fillRect(0, 0, w, h);
        g.drawImage(img, 0, 0);
        return g.getImageData(0, 0, w, h).data;
      };
      let pa = pixels(ia);
      let pb = pixels(ib);
      let out = new ImageData(w, h);
      let bad = 0;
      for (let i = 0; i < pa.length; i += 4) {
        let delta = Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2]));
        if (delta > tolerance) {
          bad++;
          out.data.set([255, 0, 0, 255], i);
        } else {
          let grey = 255 - (255 - (pa[i] + pa[i + 1] + pa[i + 2]) / 3) * 0.25;
          out.data.set([grey, grey, grey, 255], i);
        }
      }
      let c = new OffscreenCanvas(w, h);
      c.getContext('2d').putImageData(out, 0, 0);
      let blob = await c.convertToBlob({ type: 'image/png' });
      let bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { mismatch: bad / (w * h), browserSize: [ia.width, ia.height], nastySize: [ib.width, ib.height], diff: btoa(bin) };
    }, { a, b, tolerance });
    let diffPath = `shots/${r.name}.diff.png`;
    writeFileSync(join(out, diffPath), Buffer.from(res.diff, 'base64'));
    let sameSize = res.browserSize.join('x') === res.nastySize.join('x');
    return { pass: sameSize && res.mismatch <= maxMismatch, mismatch: res.mismatch, browserSize: res.browserSize, nastySize: res.nastySize, png: diffPath };
  } finally {
    await page.close();
  }
}

function reportHtml(report) {
  let esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let img = (src, label) => src ? `<figure><figcaption>${label}</figcaption><img src="${esc(src)}"></figure>` : `<figure><figcaption>${label}</figcaption><div class="missing">missing</div></figure>`;
  let rows = report.results.map(r => {
    let d = r.diff || {};
    let verdict = d.mismatch == null ? 'n/a' : d.pass ? 'pass' : 'fail';
    return `<section class="${verdict}">
  <h2>${esc(r.name)} <span>${verdict.toUpperCase()}${d.mismatch == null ? '' : ` · ${(d.mismatch * 100).toFixed(2)}% mismatched`}</span></h2>
  <p>${esc(r.description)} Theme: ${esc(r.theme)}; browser attrs: ${esc(r.browserAttrs.join(' ') || 'none')}.</p>
  <p>Browser: ${esc(r.browser?.ok ? `${r.browser.ms} ms${r.browser.errors?.length ? `, errors: ${r.browser.errors.join('; ')}` : ''}` : r.browser?.error || 'skipped')} ·
     Nasty: ${esc(r.nasty?.ok ? `${r.nasty.ms} ms` : r.nasty?.error || 'skipped')}${d.browserSize ? ` · sizes ${d.browserSize.join('x')} vs ${d.nastySize.join('x')}` : ''}</p>
  ${r.nasty?.log ? `<pre>${esc(r.nasty.log)}</pre>` : ''}
  <div class="row">${img(r.browser?.png, 'Browser')}${img(r.nasty?.png, 'Nasty')}${img(d.png, 'Diff')}</div>
</section>`;
  }).join('\n');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Native fidelity</title>
<style>
body { font: 14px system-ui, sans-serif; margin: 16px; background: #fafafa; color: #222; }
section { border-left: 4px solid #999; padding: 4px 12px; margin: 16px 0; background: #fff; }
section.pass { border-color: #2a2; } section.fail { border-color: #d22; }
h2 span { font-weight: normal; font-size: 14px; color: #666; }
.row { display: flex; gap: 8px; flex-wrap: wrap; } figure { margin: 0; flex: 1 1 260px; }
img { max-width: 100%; border: 1px solid #ddd; } .missing { padding: 40px; background: #eee; text-align: center; }
pre { max-height: 200px; overflow: auto; background: #f3f3f3; padding: 8px; font-size: 12px; }
</style></head><body>
<h1>Native fidelity</h1>
<p>${esc(report.generatedAt)} · ${report.width}x${report.height} · channel tolerance ${report.tolerance} · pass at ≤ ${(report.maxMismatch * 100).toFixed(1)}% mismatched pixels</p>
${rows}
</body></html>
`;
}

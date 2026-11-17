# Webfoundry ↔ Nasty native bundles

Export a Webfoundry project as a self-contained **native bundle**:

- **linux-x64**: AppImage with a project tar.gz overlay (`NASTYOV1` trailer).
- **android-arm64**: debug-signed APK via JSZip inject into a hosted runtime APK + resign.

## Layout

| Path | Role |
|------|------|
| `signing/key.pem` / `cert.pem` | Shipped debug signing material for browser APK resign (sideload only). |
| `main.js` | Native entry: Window + Document, shims, boots `webfoundry/app.js`. |
| `shim.js` | Browser shims + window proxy into live WF globals. |
| `wf-globals.mjs` | Live ESM exports for bare `state` / `post` / `d` / … |
| `nasty-loader.mjs` | Injects WF globals imports; caches `https://` imports. |
| `export-native.js` | Browser export for linux overlay and android inject/resign. |
| `tar.js` | ustar + gzip + trailer helpers. |

## Editor UI

**Export native app** → choose **Linux x64** or **Android arm64**.

- Linux: default width/height, maximized / remember / borderless / drag anywhere / resizable.
- Android: **orientation** (`auto` | `portrait` | `landscape`); desktop window chrome options are hidden.
- Loading copy: **Exporting native app**.
- Optional project `icons/` branding; otherwise Webfoundry `favicon.ico`.

Choices land in `state.settings.popt.nativeExport` (`wf.uiconfig.json`) and bake into `nasty-window.json`.

## Runtime bundles

Exports download the generic runtimes (no app inside) from the Nasty site, which sends CORS headers for them (`_headers` in the site's project):

- `https://nasty-engine.netlify.app/runtime/nasty-runtime-x86_64.AppImage`: Linux runtime.
- `https://nasty-engine.netlify.app/runtime/nasty-runtime-arm64.apk`: Android runtime (fonts + `node_modules/nasty` + stub entry).

They aren't in this repo. To refresh them, rebuild in Nasty, then redeploy the Nasty site, whose `runtime/` folder hardlinks Nasty's runtime cache:

```sh
# Linux
cd /path/to/app && node /path/to/nasty/node/bin/nasty-bundle.js --rebuild-runtime --skip-native-build
# Android (rebuilds the hostable runtime APK as part of --rebuild-runtime)
cd /path/to/app && node /path/to/nasty/node/bin/nasty-bundle.js \
  --target android-arm64 --rebuild-runtime --skip-native-build

# A rebuild writes new files, which breaks hardlinks, so relink before deploying.
cd /path/to/wf-workspace/nasty
ln -f ~/prog/nasty-tools/appimage/nasty-runtime-x86_64.AppImage runtime/
ln -f ~/prog/nasty-tools/android/nasty-runtime-arm64.apk runtime/
netlify deploy --prod --dir . --site nasty-engine
```

`other/native-fidelity/run.mjs` and `test-tar.mjs` read the Linux runtime from Nasty's cache (`~/prog/nasty-tools/appimage/`) unless given another path.

## Formats

- Linux: `[runtime AppImage][app.tar.gz][u64le length][NASTYOV1]`
- Android: ZIP/APK with `assets/nasty/{entry,files.list,fonts/,node_modules/nasty/,…}`; export strips `META-INF` signatures and resigns with the shipped debug key (v2/v3). Debug APKs are for sideload; re-sign with a release keystore for store builds.

win-x64 remains coming soon.

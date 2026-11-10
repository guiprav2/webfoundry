# Webfoundry Decorate

Firefox extension behind Webfoundry's Decoration projects. It lets the editor load another
site in its iframe and talk to it. Requires Firefox 147 or later (CSS anchor positioning).

## Install for development

1. Open `about:debugging`, then **This Firefox**.
2. Click **Load Temporary Add-on** and choose `manifest.json` from this folder.

## What it does

* `editor-bridge.js` runs on Webfoundry pages and relays to `background.js`.
* `background.js` keeps a per-tab session. When a registered editor loads a registered origin
  as its direct child iframe, it removes that response's `X-Frame-Options` and CSP, and adds the
  headers a cross-origin-isolated editor needs. Nothing changes for ordinary browsing.
* `frame-bridge.js` runs on every page load in that iframe, injects `webfoundry/ifdesigner.js` and the
  modules it needs (fetched by `background.js`, loaded as `blob:` modules), and relays messages to and from the editor.

All editor/page traffic goes through the extension. The page is another site, so the editor only
honors a short list of message types from it (see `fromFrame` in `controllers/Decoration.js`).

## Known limits

* Firefox partitions cookies by top-level site, and `SameSite=Lax/Strict` cookies aren't sent to a
  cross-site iframe, so you usually see a site logged out inside the editor.
* A `<meta http-equiv="Content-Security-Policy">` tag can still block injection; only the header is removed.
* Hooks are applied in the editor only. Nothing yet applies a finished decoration during normal browsing.

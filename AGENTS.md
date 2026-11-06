# Webfoundry Agents Guide (`AGENTS.md`)

This guide explains how **projects inside Webfoundry** are structured and how to use its features.

---

## 📌 General Guidelines

* MOST IMPORTANT (DO NOT IGNORE): Never edit `.html` files with text-based tools (echo with redirect, python with read/write commands, apply\_patch, etc.) Always use `wf select-file`, `wf read-html`, `wf change-selection`, and the other DOM manipulation commands documented below to modify markup safely.
* `wf read-html` only works when the last `wf select-file` command was an HTML file. Make sure to `wf select-file` before calling `wf read-html`.
* No need for `wf select-file` before manipulating non-HTML files
* Webfoundry projects are all UTF-8, so ignore ASCII-only instructions.
* Suggestions for requests on a mostly empty project (no HTML or JS files): Begin by calling `wf create-file` to scaffold pages/index.html and/or controllers/App.js.
* In Webfoundry, a div right under body is the page root, not body itself. Make sure all page content is wrapped inside that root div.
* Always start with HTML first, JavaScript second; back-and-forth until everything is in-place. Don't start JavaScript editing until there's an HTML page to drive from it.
* Always use `let`, never `const`.
* Ignore webfoundry/{scripts,templates}.json, they're fully managed by Webfoundry.
* Never put long JavaScript or script tags in HTML, always put them in a controller and call using wf-onattach or other event handler attributes.
* Event handlers must be JavaScript expressions, never statements (if needed use an IIFE).
* When calling post('ctrl.action') inside an event handler such as wf-onclick, wf-oninput, etc: Don't use await, those handlers are not async functions.
* wf-value already wires two-way binding—never add wf-oninput, wf-onchange, or wf-onkeydown on that same element for setting the binding. If you need to react to Enter, wf-onkeydown is OK.
* `_1` is a special variable only available in wf-onattach and wf-ondetach. Other event handlers only have `event`. And bindings have no special variables besides globals and wf-map scoped variables.
* When special editing DOM/HTML tools are available, prefer surgical changes like a visual editor user would do instead of selecting the root and changing its entire HTML: Select the inner elements that need replacement and either change their HTMLs one by one or delete them altogether. Change selections and create divs in just the right places before using change HTML on them. When simple class adding/removal/replacement are needed, prefer specialized tools for that instead of change HTML, especially for preparing wrappers for inner content (e.g. setting `flex justify-center items-center` on a container).
* Event handler attributes are always e.g. wf-onclick="post('ctrl.action')". Not wf-on-click="...", not data-onclick="...", not even native onclick="...".
* wf-\* attributes only apply where their native equivalents apply. E.g. wf-value is only valid for \<input>, \<textarea>, etc.
* Before working on how a page looks with `native:` / `desktop:` / `mobile:` / OS (`win:` / `lin:` / `mac:` / `android:`) utilities on Nasty, always `wf set-platform-preview desktop` or `wf set-platform-preview mobile` as appropriate (either mode also activates `native:`), plus `wf set-platform-os <os>` for OS-specific looks. Afterward, leave platform preview on or `wf set-platform-preview off` based on context (see Styling → platform variants).
* Put native-bundle branding under project `icons/` (`icon.png`, `icon-256.png`, optional `icons/android/…`). Do not invent other branding folder names.

---

## 📂 Project Structure

```
project/
 ├─ controllers/   # Controller classes (state + actions)
 ├─ pages/         # HTML files (edited in Webfoundry’s visual editor or directly)
 ├─ media/         # Project media (optional, add subdirs if desired)
 ├─ icons/         # Optional native-bundle branding (icon.png, icon-256.png, android/…)
 └─ AGENTS.md      # This file
```

* **controllers/**: one class per file, default export.
* **pages/**: HTML entrypoints, can contain bindings (`wf-if`, `wf-map`, `wf-on*`, `{{...}}`).
* **images/**: assets referenced from pages or controllers.
* **icons/**: optional launcher / desktop branding for native export (`icon.png`, `icon-256.png`, `icon.ico` later, `android/` mipmaps). If missing, export falls back to Webfoundry `favicon.ico`.

---

## 🧩 Controllers

Example:

```js
// controllers/App.js
export default class App {
  state = { input: '', items: [], warn: false };

  actions = {
    addItem: () => {
      this.state.items.push({ name: 'foo', value: 42 });
    },
  };
}
```

* **State**: global, e.g. `state.app.input`.
* **Actions**: call via `post('app.addItem')`.
* **Direct state mutation** is allowed, but use actions if side effects are desirable.

---

## 🖇 Bindings & Directives

Webfoundry templates support **declarative bindings**:

### Mustache Text

```html
<span>Hello {{state.app.input}}</span>
```

### Property bindings

```html
<input wf-src="state.app.src">
<input wf-alt="state.app.alt">
<input wf-value="state.app.input">
<input wf-checked="state.app.checked">
<input wf-disabled="state.app.disabled">
```

### Conditional Rendering (`wf-if`)

```html
<div wf-if="state.app.warn">Warning!</div>
```

### List Rendering (`wf-map`)

```html
<div wf-map="x of state.app.items">{{x.name}}: {{x.value}}</div>
```

### Event Handlers (`wf-on*`)

```html
<button wf-onclick="post('app.addItem')">Add</button>
```

* Any DOM event can be bound by replacing `*` with the event name (`wf-oninput`, `wf-onchange`, etc.).
* The attribute value is a JS expression executed when the event fires.

### Special Lifecycle Events

```html
<div wf-onattach="console.log('attached', _1)" wf-ondetach="console.log('detached', _1)"></div>
```

* `wf-onattach`: runs when element is attached to DOM, \_1 is the element.
* `wf-ondetach`: runs when element is removed from DOM, \_1 is the element.
* Use for initialization/cleanup logic.

---

## 🔄 Lifecycle & Rendering

* Pages under `pages/` are loaded and routed automatically by Webfoundry’s App class.
* HTML gets compiled into reactive DOM; state changes trigger updates.
* Agents should not re-render manually; mutate state or call actions instead.

---

## 🌍 Scope & Expressions

* Bindings and directives can access any controller state: `state.<controller>.<field>`.
* `wf-map` introduces loop variables usable in mustache bindings.
* `post()` should only be used in event handlers, not in reactive bindings.

---

## 🎨 Styling

* Tailwind utility classes are always available.
* Google Fonts can be injected via `gfont-[Font_Name]` classes.
* Use `wf-class` for dynamic class binding.

### `native:` / `desktop:` / `mobile:` Tailwind variants

Webfoundry registers composable Tailwind v4 variants named `native:`, `desktop:`, and `mobile:`. Prefix any utility with them (and compose with other variants as usual), for example `native:rounded-2xl`, `desktop:text-pink-500`, `mobile:lg:opacity-50`.

Use **`native:`** for styles shared by all Nasty hosts. Use **`desktop:`** / **`mobile:`** only for host-specific overrides so you do not duplicate common native styles.

OS variants **`win:`** (Windows), **`lin:`** (Linux), **`mac:`** (macOS), and **`android:`** narrow a style to one OS, e.g. `lin:adw-header-bar`, `android:rounded-none`. The OS is independent of the form factor, so stack them for combinations: `lin:mobile:hidden` (Linux phone), `lin:desktop:flex` (Linux desktop). Android is `android:`, never `lin:`.

**Precedence (same CSS property):** `win:` / `lin:` / `mac:` / `android:` (active OS) beats `desktop:` or `mobile:` (active host), which beats `native:`, which beats bare utilities. Stacked variants (`lin:mobile:…`) beat single ones.

**When they apply**

* **Browser / IDE preview (default):** all three inert. The page looks like a normal web app.
* **Browser with Desktop Preview on:** `native:` and `desktop:` apply; `mobile:` does not.
* **Browser with Mobile Preview on:** `native:` and `mobile:` apply; `desktop:` does not.
* **Browser with an OS selected (Windows / Linux / Android):** `native:`, the selected Desktop or Mobile mode, and that OS's variant apply.
* **Exported Nasty / native bundle:** `native:` is always on. `desktop:` is on for desktop hosts; `mobile:` is on for Android. `win:` / `lin:` / `mac:` / `android:` follow the OS.

Do not rewrite class lists for preview. Authored markup keeps the tokens; the host decides whether they take effect.

**Platform Preview buttons (IDE)**

* A platform radiogroup of icons (**Web**, **Windows**, **Linux**, **Android**) followed by the **Desktop Preview** and **Mobile Preview** toggles.
* Placement: designer chrome, immediately to the left of the refresh control on the page toolbar (same cluster as refresh / clone / delete).
* Visibility: the controls appear when the open page’s DOM mirror has at least one class token containing `native:`, `desktop:`, `mobile:`, `win:`, `lin:`, `mac:`, or `android:`.
* Behavior: two global IDE preferences. `platformOs` (`web` | `win` | `lin` | `mac` | `android`, the radiogroup) and `platformPreview` (`off` | `desktop` | `mobile`, the toggles). Web is the plain browser: selecting it turns Desktop/Mobile off. Selecting an OS turns on Desktop (Mobile for Android) if neither is on; turning Desktop/Mobile off returns to Web. Desktop/Mobile with Web selected is the generic native preview (no OS). Active modes set `wf-native-preview`, `wf-desktop-preview` or `wf-mobile-preview`, and `wf-<os>-preview` on the live preview iframe’s `<html>`. Attributes are runtime-only and are not saved into project HTML.

**CLI (agents)**

* `wf is-platform-preview` — prints `off`, `desktop`, or `mobile`.
* `wf set-platform-preview off|desktop|mobile` — set the form factor (same preference as the Desktop/Mobile toggles).
* `wf is-platform-os` — prints `web`, `win`, `lin`, `mac`, or `android`.
* `wf set-platform-os web|win|lin|mac|android` — set the OS (same preference as the platform radiogroup).

**Agent workflow for platform looks**

* Before editing or verifying native / Nasty styling, turn a platform preview on: `wf set-platform-preview desktop` (shared `native:` + desktop overrides) or `wf set-platform-preview mobile` (shared `native:` + mobile overrides). Check first with `wf is-platform-preview` if useful.
* After that work, leave the matching preview on when the user is still reviewing it, or `wf set-platform-preview off` when returning to ordinary web layout work. Prefer restoring the prior mode when you flipped it only for a short pass.

Example:

```html
<div class="rounded-none native:rounded-2xl text-white native:text-neutral-100 desktop:text-pink-500 mobile:text-sky-400">
  …
</div>
```

On the web with platform preview off, you get square corners and white text. With Desktop Preview on (or in a desktop Nasty export), corners round and text is pink. With Mobile Preview on (or on Android), corners round and text is sky.

### Adwaita `adw-*` classes

Webfoundry ships the GNOME Adwaita styles from adwaita-web as `adw-*` utility classes (every upstream class is `adw-` prefixed: `adw-button`, `adw-card`, `adw-suggested-action`, `adw-title-1`, `adw-boxed-list`, …). They are Tailwind utilities, so any variant composes: `md:adw-card`, `mobile:adw-button`, `lin:adw-headerbar`, `hover:adw-dimmed`.

* Combine component classes with their modifiers exactly like upstream: `<button class="adw-button adw-suggested-action">`, `<button class="adw-button adw-flat adw-circular">`. Child rules (e.g. `.adw-icon` inside `.adw-button`) follow from the markup.
* Platform-scoped: prefix only the component classes (`lin:adw-button adw-suggested-action`). Modifier/marker classes (`adw-suggested-action`, `adw-flat`, `adw-circular`, `adw-pill`, `adw-header-bar-title`, …) have no styles of their own and only act where the component class is active, so leave them unprefixed.
* Page base: `adw-page` (upstream `body` rule: font, spacing), `adw-background` (window background and text color); element styles as `adw-h1`…`adw-h6`, `adw-p`, `adw-a`, `adw-hr`, `adw-all` (the `*` reset).
* Themes: add `adw-theme-dark` to `<html>` (on Nasty: to `<body>`) for the dark theme; accents via `adw-accent-blue|teal|green|yellow|orange|red|pink|purple|slate` on `<html>` (web only).
* Symbolic icons: `adw-icon-<name>-symbolic` (e.g. `adw-icon-go-next-symbolic`), drawn with `background-color: currentColor` through a mask; size them with the element (e.g. `size-4 inline-block`). Web only.
* Nasty supports the subset Nasty can express: base styles, `hover:`/`active:`, class/attribute/structural modifiers, descendant/child rules, `max-md`, and dark. Focus rings, `:not()`, pseudo-elements, masks/icons, accents and vendor properties are web-only.

### Material `and-*` classes (Android)

Webfoundry also ships Material Design 3 (from Beer CSS) as `and-*` utilities. Beer styles elements, so every element becomes a class: `and-button`, `and-header`, `and-h1`…`and-h6`, `and-body` (page base: surface background, on-surface text, Material font), plus helpers such as `and-border` (outlined), `and-secondary-container` (tonal), `and-primary-text`, `and-surface`, `and-large`/`and-small`/`and-extra` (sizes), `and-circle`, `and-round`. Dark theme: `and-dark` on `<body>`.

* Scope to Android with `android:` (combine with `mobile:` / `desktop:` as needed): `<button class="android:and-button android:and-border">`.
* Material modifiers usually have styles of their own, so prefix them too (`android:and-border`, `android:and-large`). A platform-prefixed modifier still counts for compound rules (`and-button` + `and-border`) when its variant is active. This works for `adw-*` markers as well (`lin:adw-flat`).

### Native export

* Settings → **Export native app** builds a native bundle for the open project.
* Targets: **linux-x64** and **android-arm64** (win-x64 later). Android is always listed; export fails clearly if the runtime APK is missing.
* Linux: AppImage with project overlay. Android: debug-signed APK (sideload / `adb install`); re-sign with a release keystore for store builds; Play often wants AAB later.
* Optional project `icons/` for branding; otherwise Webfoundry `favicon.ico` is used.
* **Theme** pills (one at a time, click again to clear), per target: **Use Adwaita** (`lin:adw-*`), **Use Kendo UI** (`win:win-*`), **Use Beer** (`android:and-*`) force that platform's variant on any build — e.g. Kendo UI on a Linux build; **Use system theme** follows the device OS; none renders like the web preview (`native:` / `desktop:` / `mobile:` only).
* Android dialog shows **orientation** (`auto` | `portrait` | `landscape`) and hides desktop window chrome options.

### Native apps only: `window` and bare globals

These bindings exist **only in exported Nasty / native bundles**. They are not available in the ordinary browser IDE preview. Node ESM has no browser `window` scope; the native adapter injects live imports so the same unqualified names work as in the browser (`state`, `post`, `document`, `window`, …). Prefer bare names; `window.X = …` also updates those live bindings.

**Always injected (shim / WF):** `window`, `document`, `state`, `post`, `d`, `rawctrls`, `showModal`, `selectFile`, `renderComponent`, `renderTemplate`, `wfeval`, `arrayify`, `tap`, `anime`, `triggerRouterError`, `localStorage`, `sessionStorage`, `location`, `history`, `fetch`, `navigator`, `rootPrefix`, `bundleName` (the bundle's file name, e.g. `counter-x86_64.AppImage` or `counter.apk`; also `window.bundleName`; undefined on the web, so test with `typeof bundleName === 'undefined'`), `Node`, `Element`, `HTMLElement`, `Text`, `Comment`, `Document`, `Attr`, `MutationObserver`, `ResizeObserver`, and bare `addEventListener` / `removeEventListener` / `dispatchEvent` / `requestAnimationFrame` / `cancelAnimationFrame` (forwarded to the host window). Bare `scrollTo` is a no-op; bare `alert` throws `Not implemented`.

The host `window` also exposes non-standard Nasty APIs; see **Native apps using Nasty** below.

---

## 📱 Native apps using Nasty

Exported native bundles run on Nasty, not a browser. `window` is a Nasty `Window`: it supports the usual DOM-facing members and adds the non-standard APIs below. **None of these exist in the browser IDE preview.** Guard any use with a feature check (e.g. `'userDataPath' in window`, `typeof window.captureFrame === 'function'`) so pages still work on the web.

Initial values come from the project's Native export settings (baked into `nasty-window.json`). Changing them at runtime from a controller is fine.

### Window chrome and geometry

| API | Type | Notes |
|-----|------|-------|
| `window.title` | `string` (get/set) | Host window title. Prefer `<title>` / `document.title` once the page is attached. |
| `window.width` / `window.height` | `number` or `'Npx'` / `'N%'` (get/set) | Requested size. Numbers are px; `%` is relative to the display. Non-negative only. |
| `window.size()` | `() => { width, height }` | Actual current window size in px (differs from `width`/`height` after user resizes or maximizes). |
| `window.devicePixelRatio()` | `() => number` | **A method, not a property** (unlike the web). Device px per CSS px. |
| `window.resizable` | `'both' \| 'horizontal' \| 'vertical' \| 'none'` (get/set) | Which axes the user may resize. |
| `window.orientation` | `'auto' \| 'portrait' \| 'landscape'` (get/set) | Android screen orientation lock. Not the deprecated web `window.orientation` number. |
| `window.borderless` | `boolean` (get/set) | Removes OS decorations (title bar, frame). Pair with `dragAnywhere` or your own drag area. |
| `window.dragAnywhere` | `boolean \| string` (get/set) | `true`: pressing on any non-interactive spot drags the window. A key name (e.g. `'Alt'`): drag only while holding it. Elements with click listeners, scrollable areas, `contenteditable`, interactive ARIA roles, and fullscreen content never start a drag. |
| `window.maximizable` | `boolean` (get/set) | Enables double-click-to-maximize on drag areas. Defaults to `false`; throws if the body's `max-width`/`max-height` would forbid maximizing. |
| `window.maximized` | `boolean` (get/set) | Read or toggle maximized state. |
| `window.vsync` | `boolean` (get/set) | Present in sync with the display refresh (default `true`). |
| `window.closed` | `boolean` (get) | `true` once the window is closed. |
| `window.close()` | `() => void` | Closes the window and ends the app. |

### App data paths

| API | Type | Notes |
|-----|------|-------|
| `window.appId` | `string \| null` | The app's id. |
| `window.userDataPath` | `string \| null` | Absolute app data directory (`$HOME/.<appId>` by default). Persist app files here with Node `fs`. Nasty itself stores remembered window geometry in `window.json` there. |
| `window.cachePath` | `string \| null` | Absolute cache directory (`<userDataPath>/cache`). Nasty caches downloaded Google Fonts under `fonts/`. |

`localStorage` / `sessionStorage` are in-memory shims in native apps and do not survive restarts; write files under `userDataPath` for real persistence.

### File pickers

Both follow the web File System Access API shape and **reject with an `AbortError` `DOMException` on cancel**.

* `await window.showOpenFilePicker({ multiple?, types?, excludeAcceptAllOption?, startIn?, id? })` → array of `FileSystemFileHandle`. `handle.getFile()` returns a standard `File`.
* `await window.showDirectoryPicker({ mode?, startIn?, id? })` → `FileSystemDirectoryHandle`. Its file-access methods are **not implemented**; use `handle.path` with Node `fs` (or a watcher such as chokidar) instead.
* Nasty extension: every handle has **`handle.path`**, the absolute filesystem path. `startIn` accepts a handle or a path string; `id` remembers the last folder per id.
* `queryPermission()` / `requestPermission()` always resolve `'granted'`.

### Audio output

* `window.audioOutputs` → `[{ id, name, description, isDefault, sampleRate, … }]` (refreshed at most once per second).
* `window.audioOutput` (get/set) → current output device `id`; set to an `id` from `audioOutputs`, or `null` for the system default. Throws `RangeError` for an unknown id. Playing `<video>` audio moves to the new device.

### Frame capture

* `await window.captureFrame(path?, { element?, rect? })` captures the next presented frame. With a `path`, writes a PNG there; with `null`, copies the image to the system clipboard. `element` limits it to that element's on-screen box; `rect` (`{ x, y, width, height }` in CSS px) to any region.
* `await window.copyFrame({ element?, rect? })` is shorthand for `captureFrame(null, …)`.
* Both reject with `AbortError` if the window closes first.

### Animations

* `window.registerKeyframes(name, [{ offset, class }, …])` registers keyframes for Tailwind `animate-[name_duration_…]` classes, with each frame given as Tailwind classes. Register before creating elements that use `name`.

### Window events

`window.addEventListener` receives host events besides the usual DOM ones:

* `close`: the window is closing (user or `close()`). Flush state to disk here.
* `resize`: the window size changed; read `window.size()`.
* `maximize`: maximized state changed; read `window.maximized`.

### Do not call

* `window.drainEvents()`: Nasty already polls and routes native events; draining them yourself loses clicks and scrolling.
* Frame presentation APIs (`present`, `presentDocument`, `presentWithImages`, `presentOrdered`, `presentTransformed`): Nasty presents the attached document itself.
* `window.document = …`: the Webfoundry boot attaches the page document; build UI with standard DOM + Tailwind / `native:` / `desktop:` / `mobile:` classes.

---

## ⚡ Cross-Controller Usage

* It is valid to reference any controller’s state or call any action from anywhere.
* Example:

  ```html
  <div wf-if="state.user.loggedIn">Welcome {{state.user.name}}</div>
  <button wf-onclick="post('settings.toggleTheme')">Switch Theme</button>
  ```

---

## 💾 Persistence

* State is **not persisted automatically**.
* Persistence must be implemented explicitly in controllers or imported modules.

---

## 🧭 Best Practices

* **Mutate state directly** when only UI updates are needed.
* **Use actions** when updates have side effects or should be explicit.
* Avoid manual DOM manipulation; rely on bindings/directives.
* Do not perform cleanups/optimizations unless explicitly required.

---

## 🛠️ wf CLI Reference

Codex CLI exposes a `wf` command that talks to the local Companion server. Commands fall into three groups; follow the noted syntax exactly.

### Structure & Scaffolding

* `wf create-file <relative/path>` – scaffold new files via Webfoundry templates (single positional path only).
* `wf read-html` – print the current page snapshot (includes `data-htmlsnap` IDs); **no arguments allowed**.
* `wf change-selection <id ...>` – select elements by data-htmlsnap ID (IDs only); use `wf toggle-selection` to restore the previous selection.
* `wf copy-selected` – copy the current selection.
* `wf paste-first-child|paste-last-child|paste-next-sibling|paste-prev-sibling [--count 1]` – paste relative to the selection.
* `wf create-first-child|create-last-child|create-next-sibling|create-prev-sibling [--tag div | --html 'markup'] [--count 1]` – insert new nodes (use the --html option for non-layout nodes to speed things up)
* `wf wrap [--tag div]` / `wf unwrap` / `wf delete-selected` – restructure or clear nodes.
* `wf change-html|change-inner-html --html '<markup>'` – replace outer/inner markup of the selection.

### Styling & Attributes

* `wf change-element-tag --tag span`
* `wf change-element-id --id hero_title`
* `wf add-css-classes class...`
* `wf remove-css-classes class...`
* `wf replace-css-classes --old old --classes "new"`
* `wf replace-text "New copy"`
* `wf set-placeholder "Placeholder text"`
* `wf set-href https://example.com`
* `wf set-src path/to/logo.svg [--expr state.app.logo]`
* `wf set-input-value value --expr state.form.name`
* `wf set-form-method --method post`
* `wf toggle-hidden`
* `wf is-platform-preview` – print `off` / `desktop` / `mobile` for IDE platform preview
* `wf set-platform-preview off|desktop|mobile` – set platform preview form factor (enable before working on `native:` / `desktop:` / `mobile:` looks; either on-mode also activates `native:`; restore or leave on based on context afterward)
* `wf is-platform-os` / `wf set-platform-os web|win|lin|mac|android` – read/set the previewed OS for `win:` / `lin:` / `mac:` / `android:` looks
* `wf is-page-preview` – print the open page's mode: `preview` (the page runs live, as users see it) or `edit` (visual editor)
* `wf set-page-preview preview|edit|toggle` – switch the open page between preview and edit modes (same as the editor's Preview button)

### Logic & Events

* `wf set-if-expr "state.app.ready"`
* `wf set-map-expr "item of state.app.items"`
* `wf set-disabled "!form.valid"`
* `wf set-event-handlers click=post('app.save')`
* `wf add-event-handlers click=post('app.save')`
* `wf rm-event-handlers click change`

All `wf` commands accept `--cur` to target a different designer cursor (defaults to `master`).

### Usage Notes & Validation Rules

* Run `wf` commands from inside the Webfoundry project root (the folder that contains `wf.config.js`).
* `wf create-file` requires exactly one positional path; all other arguments must be explicit flags.
* `wf read-html` takes **no arguments**. If it fails, ensure a page is open via `selectFile`.
* `wf change-selection` accepts only data-htmlsnap IDs—do **not** supply file paths or flags such as `--file`.
* DOM operations (create, paste, wrap, attribute changes, etc.) operate on the currently selected elements. Open a page with `selectFile` and immediately `wf change-selection` the root or target node before editing.
* Event handler commands expect `event=expression` pairs (e.g. `wf add-event-handlers click=post('app.handleClick')`).
* When a command reports missing IDs, refresh your snapshot with `wf read-html` before retrying.
* Page preview is distinct from platform preview: page preview runs the page live (bindings, controllers, event handlers), while platform preview only changes which `native:` / `desktop:` / `mobile:` utilities apply. Use `wf set-page-preview preview` to check runtime behavior, then `wf set-page-preview edit` to go back to the visual editor; restore whichever mode the user had when you're done. Switching modes reloads the page, so `data-htmlsnap` IDs change: run `wf read-html` again before selecting elements.
* Chain multiple `wf` commands using && when the commands are closely related, speeding things up and making changes look more atomic.
* *NEVER* use text-based HTML edits (`echo` with redirect, `python` read/writes, `apply_patch`, etc.); always rely on the `wf` subcommands.

---

## 📌 Quick Reference

* **Access state**: `state.<controller>.<field>`
* **Call action**: `post('<controller>.<action>', ...args)`
* **Text binding**: `{{expr}}`
* **Two-way binding**: `<input wf-value="...">`
* **Conditionals**: `wf-if="expr"`
* **Lists**: `wf-map="x of expr"`
* **Events**: `wf-on<event>="expr"`
* **Lifecycle hooks**: `wf-onattach`, `wf-ondetach`
* **Pages**: live in `pages/`, must include `<script type="module" src="../webfoundry/head.js"></script>` in `<head>`

---

## Sprites and transparent PNGs

A sprite, a prop, or a UI frame that sits on top of another picture is a cutout. The source picture is the figure or the ornament on one flat backdrop color: no floor, no cast shadow, no furniture, no extra background. A chair painted into the sprite cannot sit in the room. Poses of one character share a baseline. The plate or the room is a separate image and stays opaque. The subject may contain green. That green is not the backdrop.

Put that source file in the project, then call `remove_background`. `input` is the source path. `output` must end in `.png`. `color` is the exact backdrop color as `#rrggbb`, read off the backdrop, not off the costume. The tool removes pixels by distance to that color and feathers the edge. A lime shirt stays when the backdrop is a different green. It writes a transparent PNG.

Use `remove_background` only when the background is a flat key color that should disappear. Leave plates, photos, and pictures whose background is part of the art alone.

In page HTML, an image `src` is `../images/...`. Mounting the page strips one leading `../` from `src` and from every CSS `url(...)`, including `background-image` and `border-image-source`. This is the same one prefix, once:

```html
style="border-image-source: url('../images/ui/dialog-frame.png')"
```

`run_js` runs in the open page iframe. The visual editor has to be open or it throws. `args` is a map of parameter names to values, and `body` is the function body. `run_js({ args: { x: 1, y: 2 }, body: 'return x + y' })` is `await new AsyncFunction('x', 'y', 'return x + y')(1, 2)`. Return the value you want back. `document` is the page.

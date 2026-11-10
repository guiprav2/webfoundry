# Webfoundry Agents Guide (`AGENTS.md`)

This guide explains how **projects inside Webfoundry** are structured and how to use its features.

---

## 📌 General Guidelines

* MOST IMPORTANT (DO NOT IGNORE): Never edit `.html` files with text-based tools (echo with redirect, python with read/write commands, apply\_patch, etc.) Always use `wf read-html` and the other DOM manipulation commands documented below to modify markup safely.
* Don't run `wf select-file` before reading or editing HTML: it switches the page the user is looking at and can disrupt their work. Pass `--page pages/x.html` to `wf read-html` and the edit commands instead. Only use `wf select-file` to bring the user's attention to something, or when explicitly asked to.
* No need for `wf select-file` before manipulating non-HTML files
* This file documents everything you need. `webfoundry/*.js` in a project is the generated runtime, so don't read it to learn how things work. To list the theme classes that exist, `grep '@utility adw-' webfoundry/adwaita.tw.css` (likewise `and-` in `material.tw.css`, `win-` in `fluent.tw.css`).
* To test behavior, see **Testing a page** under the wf CLI Reference.
* Webfoundry projects are all UTF-8, so ignore ASCII-only instructions.
* Suggestions for requests on a mostly empty project (no HTML or JS files): Begin by calling `wf create-file` to scaffold pages/index.html and/or controllers/App.js.
* In Webfoundry, a div right under body is the page root, not body itself. Make sure all page content is wrapped inside that root div.
* Always start with HTML first, JavaScript second; back-and-forth until everything is in-place. Don't start JavaScript editing until there's an HTML page to drive from it.
* Always use `let`, never `const`.
* Ignore webfoundry/{scripts,templates}.json, they're fully managed by Webfoundry.
* Never put long JavaScript or script tags in HTML, always put them in a controller and call using wf-onattach or other event handler attributes.
* Event handlers must be JavaScript expressions, never statements (if needed use an IIFE).
* When calling post('ctrl.action') inside an event handler such as wf-onclick, wf-oninput, etc: `await` is allowed (wf-on\*, wf-onattach and wf-ondetach run as async functions) but only needed when sequencing work. Reactive bindings (`{{...}}`, wf-if, wf-map, wf-value, …) are synchronous, so never use `await` there.
* wf-value already wires two-way binding—never add wf-oninput, wf-onchange, or wf-onkeydown on that same element for setting the binding. If you need to react to Enter, wf-onkeydown is OK.
* `_1` is a special variable only available in wf-onattach and wf-ondetach. Other event handlers only have `event`, which is the global `window.event`, so read it before the first `await`. And bindings have no special variables besides globals and wf-map scoped variables.
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
 ├─ components/    # Reusable components (see Components below)
 ├─ pages/         # HTML files (edited in Webfoundry’s visual editor or directly)
 ├─ media/         # Project media (add subdirs if desired)
 ├─ icons/         # Optional native-bundle branding (icon.png, icon-256.png, android/…)
 ├─ webfoundry/    # Runtime, managed by Webfoundry; don't edit
 ├─ wf.config.js   # Marks the project root for the wf CLI; don't edit
 ├─ wf.uiconfig.json # Page options: tailwind, nerdfonts, betterscroll (booleans)
 └─ AGENTS.md      # This file
```

* **controllers/**: one class per file, default export.
* **pages/**: HTML entrypoints, can contain bindings (`wf-if`, `wf-map`, `wf-on*`, `{{...}}`). HTML files can't be created in the project root.
* **media/**: assets referenced from pages or controllers. The media gallery lists only this directory.
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
* **Direct state mutation** is allowed, but it doesn't re-render by itself (see Rendering below). Prefer actions, and use `post()` even for one-liners in handlers: `wf-onclick="state.app.n++"` updates the state and leaves the page stale until something else renders.
* **Naming**: the key is the camelCased file name, so `controllers/TodoList.js` is `state.todoList` and `post('todoList.add')`.
* **Instances**: each controller is instantiated once at startup. There's no automatic init hook; run setup from `wf-onattach` on the page root, e.g. `wf-onattach="post('app.init')"`.
* **Rendering**: `post()` re-renders before the action, right after it returns or reaches its first `await`, and again when it finishes. To show progress in the middle of a long async action, or after mutating state outside `post()` (timers, sockets, direct mutation in a handler), call `d.update()`.
* `post()` returns a promise for the action's result and rejects with `Unknown controller: x` or `Unknown controller action: x.y` on bad names.

---

## 🖇 Bindings & Directives

Webfoundry templates support **declarative bindings**:

### Mustache Text

```html
<span>Hello {{state.app.input}}</span>
```

* Escape literal braces as `\{{...}}`.
* `{{markdown: expr}}` renders the Markdown string as a `div.prose`.
* A `<textarea>` whose only content is `{{expr}}` is two-way bound, like `wf-value`.

### Property bindings

```html
<input wf-src="state.app.src">
<input wf-alt="state.app.alt">
<input wf-value="state.app.input">
<input wf-checked="state.app.checked">
<input wf-disabled="state.app.disabled">
<input wf-placeholder="state.app.hint">
<a wf-href="state.app.url">Link</a>
<div wf-innerhtml="state.app.html"></div>
```

* `wf-value` and `wf-checked` write back with `expr = newValue`, so their expression must be assignable.

### Dynamic Classes (`wf-class`)

```html
<div class="bg-gray-200" wf-class="{{state.app.on ? 'text-white' : ''}} {{replaces bg-gray-200: state.app.on && 'bg-blue-500'}}"></div>
```

* Each expression must be wrapped in `{{...}}` and returns class names.
* `{{replaces cls: expr}}` also removes one static class, `cls`, from the element.

### Conditional Rendering (`wf-if`)

```html
<div wf-if="state.app.warn">Warning!</div>
```

### List Rendering (`wf-map`)

```html
<div wf-map="x of state.app.items">{{x.name}}: {{x.value}}</div>
```

* The syntax is exactly `name of expr`, with one variable. There's no index variable.
* `wf-if` and `wf-map` can't share an element (it throws). Nest them instead.
* At runtime, `wf-if` and `wf-map` elements and the page root lose the `hidden` attribute and the `hidden` / `invisible` classes, so those are safe for decluttering the visual editor. `id` is removed from `wf-map` items.

### Components

* Put the markup in any `components/*.html` file, as an element with `id="Name"`. Optionally add `components/Name.js` with a default-exported class that takes `props`.
* Use it with `<div wf-component="Name" wf-props='{"title":"Hi"}'></div>`. `wf-props` is JSON.
* Inside the component's markup, `this` is the class instance, e.g. `{{this.props.title}}`.
* `await showModal('Name', props)` opens a component in a `<dialog>` and resolves to `[dialog.returnValue, ...dialog.returnDetail]`. Navigating to another page removes open dialogs.

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
* HTML gets compiled into reactive DOM; `post()` and two-way bindings trigger updates (see Controllers → Rendering).
* Don't re-render by hand beyond `d.update()`; mutate state or call actions instead.
* Routing: `/` is `pages/index.html` and `/foo/bar.html` is `pages/foo/bar.html`. Unknown paths render `pages/404.html`, if present. `triggerRouterError(code)` renders `pages/<code>.html`.
* Links: relative `<a href>` values navigate without a reload, relative to the current page's directory, so write `about.html`, not `../pages/about.html`. `#id` scrolls to that element. Hrefs with a scheme (`https:`, `mailto:`) and `download` links keep native behavior. Programmatic navigation is `history.pushState(null, '', url)`. Pass parameters in the query string (`wf-href="'details.html?id=' + t.id"`) and read them with `new URLSearchParams(location.search)`, usually from the `wf-onattach` of the destination page's root.
* The page root (the `div` right under `body`) already fills the viewport: `body` is a full-height flex column and the root is its `flex-1` child. Don't add `min-h-screen` or `h-screen` to the root; it pins the root to one viewport, and a `sticky` header inside it stops sticking after that.
* The page `<title>` comes from each page's `<head>`. `wf` can't select `<head>` elements even though `wf read-html` shows IDs for them, so set titles with `wf set-page-title "About"` (a blank page title uses the project title, set with `wf set-project-title`). Pages created by `wf create-file` start with `<body style="display: none">`, which the runtime reveals once styles are ready; keep it, along with the generated `<head>` scripts.

---

## 🌍 Scope & Expressions

* Bindings and directives can access any controller state: `state.<controller>.<field>`.
* `wf-map` introduces loop variables usable in mustache bindings, other bindings and event handlers inside it, e.g. `wf-onclick="post('tasks.remove', t.id)"`.
* `post()` should only be used in event handlers, not in reactive bindings.

---

## 🎨 Styling

* Tailwind utility classes are always available.
* Google Fonts can be injected via `gfont-[Font_Name]` classes.
* Use `wf-class` for dynamic class binding.
* `dark:` follows the OS setting (`prefers-color-scheme`) only. For an in-app dark mode toggle, put a `dark` class on `<html>` from a controller and style with `in-[.dark]:bg-stone-950` and the like, which also reaches dialogs.
* With `nerdfonts` on in `wf.uiconfig.json` (the default), Nerd Font icons are available as `<i class="nf nf-fa-check"></i>`.

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

### Fluent `win-*` classes (Windows)

Webfoundry also ships Windows Fluent 2 (from the Kendo UI Fluent theme) as `win-*` utilities, e.g. `win:win-button`. Scope them with `win:`.

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

* **Mutate state directly** when only UI updates are needed, followed by `d.update()` if it isn't inside an action.
* **Use actions** when updates have side effects or should be explicit.
* Avoid manual DOM manipulation; rely on bindings/directives.
* Do not perform cleanups/optimizations unless explicitly required.

---

## 🛠️ wf CLI Reference

The `wf` command talks to the local Companion server, which forwards to the Webfoundry tab that has the project open. Commands fall into three groups; follow the noted syntax exactly. `wf help` lists them.

### Structure & Scaffolding

* `wf select-file <relative/path>` – switch the IDE to a file, moving the user's view. Only for bringing the user's attention to something, or when explicitly asked to; read and edit with `--page` otherwise.
* `wf create-file <relative/path>` – scaffold new files via Webfoundry templates (single positional path only). `.html` gets the page skeleton and `controllers/*.js` a controller class; anything else starts empty. The active page doesn't change: read and edit the new page with `--page`, or pass `--select` to also open it (same rule as `wf select-file`). If the file exists, the IDE asks the user whether to overwrite, so check first.
* `wf read-html --page pages/x.html` – print a page's snapshot (includes `data-htmlsnap` IDs). Without `--page`, it reads the page open in the IDE.
* `wf change-selection <id ...>` – select elements by data-htmlsnap ID (IDs only); use `wf toggle-selection` to restore the previous selection.
* `wf copy-selected` – copy the current selection.
* `wf paste-first-child|paste-last-child|paste-next-sibling|paste-prev-sibling --target <ids> [--count 1]` – paste relative to the target.
* `wf create-first-child|create-last-child|create-next-sibling|create-prev-sibling --target <ids> [--tag div | --html 'markup'] [--count 1]` – insert new nodes (use the --html option for non-layout nodes to speed things up)
* `wf wrap [--tag div]` / `wf unwrap` / `wf delete-selected` – restructure or clear nodes.
* `wf change-html|change-inner-html --target <ids> --html '<markup>'` – replace outer/inner markup of the target.

### Styling & Attributes

* `wf change-element-tag --tag span`
* `wf change-element-id --id hero_title`
* `wf add-css-classes class...`
* `wf remove-css-classes class...`
* `wf replace-css-classes --old "old classes" --new "new classes"` (for a regex: `--old 'wfregexp:/^bg-/'`)
* `wf replace-text "New copy"`
* `wf set-placeholder "Placeholder text"`
* `wf set-href https://example.com`
* `wf set-src path/to/logo.svg [--expr state.app.logo]` – a static audio or video path also changes the element's tag to match.
* `wf set-input-value value --expr state.form.name` – `<input>` elements only; bind a `<textarea>` with `wf change-html`.
* `wf change-form-method --method post`
* `wf toggle-hidden`
* `wf is-platform-preview` – print `off` / `desktop` / `mobile` for IDE platform preview
* `wf set-platform-preview off|desktop|mobile` – set platform preview form factor (enable before working on `native:` / `desktop:` / `mobile:` looks; either on-mode also activates `native:`; restore or leave on based on context afterward)
* `wf is-platform-os` / `wf set-platform-os web|win|lin|mac|android` – read/set the previewed OS for `win:` / `lin:` / `mac:` / `android:` looks
* `wf is-page-preview` – print the open page's mode: `preview` (the page runs live, as users see it) or `edit` (visual editor)
* `wf set-page-preview preview|edit|toggle` – switch the open page between preview and edit modes (same as the editor's Preview button)
* `wf get-project-title` / `wf set-project-title "My App"` – read/set the project title (same as Project Title in Settings; stored in `index.html`)
* `wf get-page-title [--page pages/x.html]` / `wf set-page-title "About" [--page pages/x.html]` – read/set a page's title (same as Page Title in Settings). `""` clears it, and the page then uses the project title. Not available in preview mode. Setting titles isn't available to collab peers.

### Logic & Events

* `wf set-if-expr "state.app.ready"`
* `wf set-map-expr "item of state.app.items"`
* `wf set-disabled "!form.valid"`
* `wf set-event-handlers "click=post('app.save')"` – replaces all handlers on the selection.
* `wf add-event-handlers "click=post('app.save')"` – adds or overwrites only the named events.
* `wf rm-event-handlers click change`

Use bare event names (`click`, not `onclick`). Quote the pairs, because parentheses are shell syntax.

### Instances, Projects & Cursors

* `wf instances` – list connected Webfoundry instances: id, `local` or `collab`, open project, origin.
* `wf projects` – list the projects visible on each instance, with their storage (`cfs` is on disk, `local` is browser storage) and which one is open.
* `wf open-project <name>` / `wf create-project <name>` – open or create a project. Work on it from its folder under the workspace.
* `wf open [--url <url>]` – open a new Webfoundry instance in the default browser and print its id.
* `wf list-editors` – list open visual editors: path, flags (`active`, `shadow`, `loading`, `preview`), cursors.

These flags work on any subcommand:

* `--page <path>` – run an HTML read/edit command on that page without switching to it. The page loads in the background if needed, and needs no `wf select-file`. Selections and undo are per page, and `data-htmlsnap` IDs are only valid for the page they came from. Pass the same `--page` on every command in a sequence.
* `--target <ids>` – **required on every HTML edit command** (create, paste, wrap, unwrap, delete, tag, ID, text, attribute, class, expression, and event handler commands). Comma-separated `data-htmlsnap` IDs from `wf read-html`. The IDs also become your cursor's selection. `wf copy-selected` accepts it too.
* `--cur <id>` – which designer cursor to use. The default is `WF_CURSOR`, else one derived from the agent's session id, else `master`. Each agent has its own cursor, in its own color, so `--cur master` is how you act on what the user has selected. An agent's cursor fades out after 5 seconds without a command that uses it, and is removed after 1 minute, which drops its selection.
* `--instance <id>` (or `WF_INSTANCE`) – the instance to talk to; a unique prefix of its id is enough.
* `--project <name>` – the project to act on instead of the one containing the working directory. It only picks among instances that already have that project open.

Each command reaches exactly one instance. With several matches it fails with `More than one Webfoundry instance matches` and lists them; pick one with `--instance`. Subagents usually share their parent's session id and so its cursor: give each subagent its own `WF_CURSOR` when several edit at once. `--page` isn't available from collab peers yet.

Flag aliases: `--ids` (change-selection), `--classes` (add/remove-css-classes), `--text` (replace-text), `--url` (set-href), `--expr` (expression commands), `--handler` (repeatable, set/add-event-handlers), `--event` (repeatable, rm-event-handlers). Add `-v` after the subcommand for a full stack trace on failure.

### Testing a page

`wf set-page-preview preview` runs the page live in the IDE, but `wf` can't click or type in it. To test interactions, serve the project folder as static files with every unknown path falling back to `/index.html` (that's what `_redirects` declares; e.g. `npx serve -s .`) and drive it with a headless browser such as Playwright. Pages render from `webfoundry/templates.json`, which the IDE regenerates a moment after an edit, so wait a second or two after your last `wf` command. There's no IDE-side console access from `wf`.

### Usage Notes & Validation Rules

* Run `wf` commands from inside the Webfoundry project root (the folder that contains `wf.config.js`).
* `wf create-file` requires exactly one positional path; all other arguments must be explicit flags (`--select` is the only one it takes).
* `wf read-html` takes only global flags such as `--page`. If it fails with `Designer closed`, pass `--page`.
* `wf change-selection` accepts only data-htmlsnap IDs—do **not** supply file paths or flags such as `--file`.
* HTML edit commands (create, paste, wrap, attribute changes, etc.) act on the elements named by `--target`, even if you changed the selection beforehand. Get IDs from `wf read-html --page pages/x.html`, then run e.g. `wf add-css-classes --page pages/x.html --target <id> --classes flex`.
* `wf change-inner-html` needs exactly one target element. Commands limited to one element type (`set-input-value`, `set-placeholder`, `change-form-method`) silently do nothing on other elements, so check the result with `wf read-html`.
* A flag's value can't begin with `--`; it would be read as another flag.
* Event handler commands expect `event=expression` pairs (e.g. `wf add-event-handlers "click=post('app.handleClick')"`).
* When a command reports missing IDs, refresh your snapshot with `wf read-html` before retrying. IDs don't survive `wf select-file`, `wf change-html`, `wf change-inner-html` (for anything inside the replaced markup) or a preview switch.
* Page preview is distinct from platform preview: page preview runs the page live (bindings, controllers, event handlers), while platform preview only changes which `native:` / `desktop:` / `mobile:` utilities apply. Use `wf set-page-preview preview` to check runtime behavior, then `wf set-page-preview edit` to go back to the visual editor; restore whichever mode the user had when you're done. Switching modes reloads the page, so `data-htmlsnap` IDs change: run `wf read-html` again before selecting elements.
* Chain multiple `wf` commands using && when the commands are closely related, speeding things up and making changes look more atomic.
* The project is identified by the name of the folder containing `wf.config.js`, which must match the project open in the IDE.
* Environment: `WF_ENDPOINT` overrides the Companion URL (default `ws://localhost:8845`). `WF_CLIENT_KEY` overrides the key from `~/.webfoundry/config.env`.
* `wf set-platform-preview off` also returns the previewed OS to `web`.
* Common errors:
  * `wf.config.js not found`: run from inside the project.
  * `WF_CLIENT_KEY not found`: start the Companion once, or set the variable.
  * `Connection timed out.`: the Companion isn't reachable.
  * `Webfoundry project not connected: <name>`: open that project in the IDE with Companion enabled.
  * `Timed out waiting for Webfoundry response`: the IDE took over 10s, often because a dialog is waiting for the user. `wf set-src` and `wf set-input-value` open one when given neither a value nor `--expr`.
  * `Designer closed`: pass `--page pages/x.html`.
  * `This command requires --target`: pass the element IDs from `wf read-html`.
  * `No elements selected.`: pass `--target` (only `wf copy-selected` and `wf toggle-selection` can still hit this).
  * `Can't edit in preview mode.`: run `wf set-page-preview edit`.
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
* **Pages**: live in `pages/`; create them with `wf create-file` so `<head>` has the runtime scripts (`../webfoundry/ifdesigner.js`, `../webfoundry/head.js`)

---

## Sprites and transparent PNGs

`remove_background` and `run_js` below are tools of Webfoundry's built-in agent panel. External CLI agents don't have them.

A sprite, a prop, or a UI frame that sits on top of another picture is a cutout. The source picture is the figure or the ornament on one flat backdrop color: no floor, no cast shadow, no furniture, no extra background. A chair painted into the sprite cannot sit in the room. Poses of one character share a baseline. The plate or the room is a separate image and stays opaque. The subject may contain green. That green is not the backdrop.

Put that source file in the project, then call `remove_background`. `input` is the source path. `output` must end in `.png`. `color` is the exact backdrop color as `#rrggbb`, read off the backdrop, not off the costume. The tool removes pixels by distance to that color and feathers the edge. A lime shirt stays when the backdrop is a different green. It writes a transparent PNG.

Use `remove_background` only when the background is a flat key color that should disappear. Leave plates, photos, and pictures whose background is part of the art alone.

In page HTML, an image `src` is `../media/...`. Mounting the page strips one leading `../` from `src` and from every CSS `url(...)` in inline `style` attributes, including `background-image` and `border-image-source`. This is the same one prefix, once:

```html
style="border-image-source: url('../media/ui/dialog-frame.png')"
```

`run_js` runs in the open page iframe. The visual editor has to be open or it throws, and it times out after 20 seconds. `args` is a map of parameter names to values, and `body` is the function body. `run_js({ args: { x: 1, y: 2 }, body: 'return x + y' })` is `await new AsyncFunction('x', 'y', 'return x + y')(1, 2)`. Return the value you want back. `document` is the page.

---

## 🪝 Decoration projects

A Decoration project has no pages. `site.decoration.json` stores the site's origin and its hooks, and selecting that file opens the site in the designer. Creating one is hidden in the UI for now. Requires the Firefox extension in `other/firefox-decorate/`.

* The site's DOM belongs to the site. A selected element can't be changed until a hook targets it, and hooking a parent does not unlock its children.
* Each hook has an ID and can be scoped inside a parent hook, in which case its target is resolved once per parent match.
* Repeated elements are detected when the hook is created, so one hook covers every repeat.
* The hooks form a state object (`state.decoration.data`). A hook with child hooks is an object of its children; any other hook is its element's text (`src` for images, `value` for inputs). A hook matching all its repeats, or sharing its ID with another hook in the same parent, is an array.
* On a hooked element, only added Tailwind classes are editable (`wf add-css-classes` / `wf remove-css-classes`). Its original classes are read-only, and other edits are refused.
* Insert elements through a hooked element with the usual `wf create-*` and `wf paste-*` commands. Ghost is in the Create toolbar menu.
* Inserted elements belong to the project and accept the usual `wf` commands, except ones that would change the site's DOM around the inserted root.
* Inserted elements are plain HTML: `wf-*` bindings and controllers don't run in them.
* Ghost hides the hooked element (`visibility: hidden !important`) and anchors the replacement over it. The element's width drives the replacement, and a taller replacement pushes the page down.
* `wf set-page-preview preview` lets the site respond to clicks, which is how you navigate it; `edit` returns to selecting. Each page load gets new `data-htmlsnap` IDs, so run `wf read-html` again after navigating.

---

## 🧰 Editing this repository's own HTML

This section applies only when working on the Webfoundry repository itself. To change a repo `.html` file, open a new Webfoundry instance and edit through `wf`, never with text tools and never through the user's open tab.

1. Back up the page, `webfoundry/scripts.json` and `webfoundry/templates.json`, and save `git status --short`.
2. Open a new instance with `xdg-open http://localhost:8846/editor.html` or `xdg-open https://www.webfoundry.app/editor.html`. Run `wf instances` before and after to find the new instance's ID.
3. From the repo root, run `wf open-project webfoundry --instance <id>`, then `wf select-file pages/x.html --instance <id>`, and repeat `wf read-html --instance <id>` until the snapshot is there. Edit with the DOM commands and `--target`, using your own `--cur` and the same `--instance`.
4. Wait a few seconds for the save, then diff the page against the backup. Only the intended markup should differ; otherwise restore the backup. Opening the project rewrites `webfoundry/scripts.json`, so restore it and `templates.json` from the backup. Pages are served from `templates.json`, so a new edit shows in the running app only after Webfoundry next regenerates it.

---

## 🐞 Issue tracking (`other/issues.js`)

This section applies only when working on the Webfoundry repository itself. If `other/issues.js` doesn't exist, ignore it.

Issues are front-matter + Markdown files at `issues/<id>.md` in the repository root, wherever the tool is run from. Front-matter fields are `id`, `brief`, `state`, `tags`, and `created`. States are `todo` (the initial state), `wip`, `done`, and `wont-do`.

```sh
other/issues.js add <id> "<brief description>" --bare [--tag <tag>]...
other/issues.js mark <id> <todo|wip|done|wont-do>
other/issues.js comment <id> --author "<name>" --brief "<comment>"
other/issues.js read <id>
other/issues.js list
other/issues.js rm <id>
other/issues.js edit <id>
```

* Agents have no interactive `$EDITOR`, so always pass `--bare` to `add` and `--brief` to `comment`, and don't use `edit`. Without them, the command launches `$EDITOR`, or fails if it isn't set.
* To add a longer description after `add --bare`, edit `issues/<id>.md` directly and leave the front-matter intact.
* IDs may contain letters, digits, `_`, `.`, and `-`, and can't start with `.` or `-`.
* `--author` is mandatory on `comment`. Use your own name, not the user's.
* Always pass the state to `mark`: when omitted, it resets the issue to `todo`.
* `list` prints one `state | id | brief` line per open issue. Open means `todo` or `wip`, so `done` and `wont-do` issues are not listed.
* Every command except `list` prints the resulting issue file to stdout. `rm` prints it one last time, then deletes it.
* `rm` is irrevocable, so only use it when the user asks for it. To close an issue, prefer `mark <id> done` or `mark <id> wont-do`.

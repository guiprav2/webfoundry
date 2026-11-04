# Webfoundry Agents Guide (`AGENTS.md`)

This guide explains how **projects inside Webfoundry** are structured and how to use its features.

---

## 📌 General Guidelines

* MOST IMPORTANT (DO NOT IGNORE): Never edit `.html` files with text-based tools (echo with redirect, python with read/write commands, apply\_patch, etc.) Always use `wf select-file`, `wf read-html`, `wf change-selection`, and the other DOM manipulation commands documented below to modify markup safely.
* `wf read-html` only works when the last `wf select-file` command was an HTML file. Make sure to `wf select-file` before calling `wf read-html`.
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
* Before working on how a page looks with `native:` / `desktop:` / `mobile:` utilities on Nasty, always `wf set-platform-preview desktop` or `wf set-platform-preview mobile` as appropriate (either mode also activates `native:`). Afterward, leave platform preview on or `wf set-platform-preview off` based on context (see Styling → platform variants).
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

**Precedence (same CSS property):** `desktop:` or `mobile:` (active host) beats `native:`, which beats bare utilities.

**When they apply**

* **Browser / IDE preview (default):** all three inert. The page looks like a normal web app.
* **Browser with Desktop Preview on:** `native:` and `desktop:` apply; `mobile:` does not.
* **Browser with Mobile Preview on:** `native:` and `mobile:` apply; `desktop:` does not.
* **Exported Nasty / native bundle:** `native:` is always on. `desktop:` is on for desktop hosts; `mobile:` is on for Android.

Do not rewrite class lists for preview. Authored markup keeps the tokens; the host decides whether they take effect.

**Platform Preview buttons (IDE)**

* Labels: **Desktop Preview** and **Mobile Preview**.
* Placement: designer chrome, immediately to the left of the refresh control on the page toolbar (same cluster as refresh / clone / delete).
* Visibility: the buttons appear when the open page’s DOM mirror has at least one class token containing `native:`, `desktop:`, or `mobile:`.
* Behavior: toggles a global IDE preference (`platformPreview`: `off` | `desktop` | `mobile`). Active mode sets `wf-desktop-preview` or `wf-mobile-preview` on the live preview iframe’s `<html>` (mutually exclusive) and always sets `wf-native-preview` with either mode so `native:` utilities apply too. Attributes are runtime-only and are not saved into project HTML.

**CLI (agents)**

* `wf is-platform-preview` — prints `off`, `desktop`, or `mobile`.
* `wf set-platform-preview off|desktop|mobile` — set platform preview (same preference as the toolbar buttons).

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

### Native export

* Settings → **Export native app** builds a native bundle for the open project.
* Targets: **linux-x64** and **android-arm64** (win-x64 later). Android is always listed; export fails clearly if the runtime APK is missing.
* Linux: AppImage with project overlay. Android: debug-signed APK (sideload / `adb install`); re-sign with a release keystore for store builds; Play often wants AAB later.
* Optional project `icons/` for branding; otherwise Webfoundry `favicon.ico` is used.
* Android dialog shows **orientation** (`auto` | `portrait` | `landscape`) and hides desktop window chrome options.

### Native apps only: `window` and bare globals

These bindings exist **only in exported Nasty / native bundles**. They are not available in the ordinary browser IDE preview. Node ESM has no browser `window` scope; the native adapter injects live imports so the same unqualified names work as in the browser (`state`, `post`, `document`, `window`, …). Prefer bare names; `window.X = …` also updates those live bindings.

**Always injected (shim / WF):** `window`, `document`, `state`, `post`, `d`, `rawctrls`, `showModal`, `selectFile`, `renderComponent`, `renderTemplate`, `wfeval`, `arrayify`, `tap`, `anime`, `triggerRouterError`, `localStorage`, `sessionStorage`, `location`, `history`, `fetch`, `navigator`, `rootPrefix`, `Node`, `Element`, `HTMLElement`, `Text`, `Comment`, `Document`, `Attr`, `MutationObserver`, `ResizeObserver`, and bare `addEventListener` / `removeEventListener` / `dispatchEvent` / `requestAnimationFrame` / `cancelAnimationFrame` (forwarded to the host window). Bare `scrollTo` is a no-op; bare `alert` throws `Not implemented`.

**Host `window` (Nasty Window) — non-web extras apps may use:**

* Geometry / chrome: `title`, `width`, `height`, `resizable`, `orientation`, `borderless`, `dragAnywhere`, `maximizable`, `maximized`, `vsync`, `closed`, `close()`
* Paths: `appId`, `userDataPath`, `cachePath`
* Pickers: `showDirectoryPicker(options?)`, `showOpenFilePicker(options?)`
* Audio: `audioOutputs`, `audioOutput`
* Timing / events: `requestAnimationFrame`, `cancelAnimationFrame`, `addEventListener`, `removeEventListener`, `dispatchEvent`, `drainEvents()`
* DOM attachment: `document` (get/set), `navigator`, `Image`
* Optional capture helpers: `captureFrame`, `copyFrame`

Do **not** call frame presentation APIs (`present`, `presentDocument`, `presentWithImages`, `presentOrdered`, `presentTransformed`); Nasty presents attached documents itself. Build UI with standard DOM + Tailwind / `native:` / `desktop:` / `mobile:` classes.

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
* `wf set-platform-preview off|desktop|mobile` – set platform preview (enable before working on `native:` / `desktop:` / `mobile:` looks; either on-mode also activates `native:`; restore or leave on based on context afterward)

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

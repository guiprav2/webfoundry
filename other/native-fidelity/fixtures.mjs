// Fixture pages for the native fidelity harness, kept as strings so the harness
// can write them into its scratch projects (repo .html files are only edited via wf).
// Each fixture: root markup (the page root div), the Nasty export theme, and the
// <html> attributes that make the browser preview apply the same platform variants.
// The root's wf-onattach runs the capture hook (a no-op in the browser).

let capture = `wf-onattach="post('fidelity.capture')"`;

export let fixtures = [
  {
    name: 'plain-tailwind',
    description: 'Plain Tailwind layout: header, grid of cards, buttons, borders, shadows, text sizes.',
    theme: 'none',
    browserAttrs: [],
    root: `<div class="flex flex-col bg-slate-50 text-slate-900" ${capture}>
  <header class="flex items-center justify-between bg-slate-800 px-6 py-4 text-white">
    <span class="text-xl font-bold">Fidelity</span>
    <nav class="flex gap-4 text-sm"><span>Home</span><span>Docs</span><span class="rounded bg-white/20 px-2">Pro</span></nav>
  </header>
  <main class="grid grid-cols-3 gap-4 p-6">
    <div class="rounded-xl border border-slate-200 bg-white p-4 shadow">
      <h2 class="mb-2 text-lg font-semibold">Cards</h2>
      <p class="text-sm text-slate-600">Rounded corners, borders and a shadow.</p>
    </div>
    <div class="rounded-xl bg-indigo-600 p-4 text-white">
      <h2 class="mb-2 text-lg font-semibold">Solid</h2>
      <p class="text-sm opacity-80">White text on indigo.</p>
    </div>
    <div class="flex flex-col items-start gap-2 rounded-xl border-2 border-dashed border-emerald-400 p-4">
      <button class="rounded-md bg-emerald-500 px-3 py-1 text-white">Primary</button>
      <button class="rounded-md border border-slate-300 px-3 py-1">Secondary</button>
    </div>
    <div class="col-span-2 flex items-center gap-3 rounded-lg bg-amber-100 p-4">
      <div class="size-10 rounded-full bg-amber-400"></div>
      <div class="flex-1"><div class="font-medium">Flex row</div><div class="text-xs text-slate-500">Avatar + text</div></div>
      <span class="rounded-full bg-amber-500 px-2 py-0.5 text-xs text-white">Badge</span>
    </div>
    <div class="flex items-center justify-center rounded-lg bg-gradient-to-br from-pink-400 to-violet-500 p-4 text-white">Gradient</div>
  </main>
</div>`,
  },
  {
    name: 'adwaita-lin',
    description: 'Adwaita (lin:adw-*) controls, Nasty forced to the Adwaita theme; browser with Linux desktop preview.',
    theme: 'adwaita',
    browserAttrs: ['wf-native-preview', 'wf-desktop-preview', 'wf-lin-preview'],
    root: `<div class="flex flex-col gap-4 p-6 lin:adw-background" ${capture}>
  <h1 class="lin:adw-title-1">Adwaita</h1>
  <div class="flex gap-2">
    <button class="lin:adw-button">Default</button>
    <button class="lin:adw-button adw-suggested-action">Suggested</button>
    <button class="lin:adw-button adw-destructive-action">Destructive</button>
    <button class="lin:adw-button adw-flat">Flat</button>
    <button class="lin:adw-button adw-pill">Pill</button>
  </div>
  <div class="lin:adw-card p-4">
    <div class="lin:adw-heading">Card heading</div>
    <div class="lin:adw-dimmed">Dimmed body text inside an adw-card.</div>
  </div>
  <div class="lin:adw-list-box">
    <div class="lin:adw-row p-3">First row</div>
    <div class="lin:adw-row p-3">Second row</div>
  </div>
</div>`,
  },
  {
    name: 'material-android',
    description: 'Material (android:and-*) controls, Nasty forced to the Beer theme; browser with Android preview.',
    theme: 'beer',
    browserAttrs: ['wf-native-preview', 'wf-mobile-preview', 'wf-android-preview'],
    root: `<div class="flex flex-col gap-4 p-6 android:and-body" ${capture}>
  <h3 class="android:and-h3">Material</h3>
  <div class="flex flex-wrap gap-2">
    <button class="android:and-button">Filled</button>
    <button class="android:and-button android:and-border">Outlined</button>
    <button class="android:and-button android:and-secondary-container">Tonal</button>
    <button class="android:and-button android:and-circle"><i class="android:and-i">add</i></button>
  </div>
  <article class="android:and-article">
    <h5 class="android:and-h5">Card</h5>
    <p>Body text in an and-article.</p>
  </article>
  <span class="android:and-chip">Chip</span>
</div>`,
  },
  {
    name: 'platform-variants',
    description: 'native:/desktop:/mobile: variants; browser with Desktop Preview, Nasty with no forced theme (Linux desktop host).',
    theme: 'none',
    browserAttrs: ['wf-native-preview', 'wf-desktop-preview'],
    root: `<div class="flex flex-col gap-4 p-6" ${capture}>
  <div class="rounded-none bg-slate-300 p-4 native:rounded-2xl native:bg-emerald-300">native: rounded + emerald</div>
  <div class="bg-white p-4 text-black desktop:bg-pink-500 desktop:text-white mobile:bg-sky-400">desktop: pink, mobile: sky</div>
  <div class="hidden p-4 desktop:block desktop:bg-amber-300">desktop-only block</div>
  <div class="block bg-red-500 p-4 text-white native:hidden">web-only block (should be hidden)</div>
  <div class="flex gap-2">
    <span class="rounded bg-slate-200 px-2 native:bg-violet-300">a</span>
    <span class="rounded bg-slate-200 px-2 desktop:bg-violet-500 desktop:text-white">b</span>
  </div>
</div>`,
  },
];

// Capture hook controller, shared by both sides: on Nasty it waits for the page
// to settle, writes the next frame to $NF_CAPTURE and closes the window.
export let captureController = `export default class Fidelity {
  state = { captured: false };

  actions = {
    capture: async () => {
      if (typeof window.captureFrame !== 'function') return;
      let env = globalThis.process?.env || {};
      if (!env.NF_CAPTURE) return;
      await new Promise(res => setTimeout(res, Number(env.NF_SETTLE_MS || 2000)));
      await window.captureFrame(env.NF_CAPTURE);
      this.state.captured = true;
      window.close();
    },
  };
}
`;

export function pageHtml(fixture) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${fixture.name}</title>
</head>
<body>
${fixture.root}
</body>
</html>
`;
}

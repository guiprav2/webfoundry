(async () => {
  {
    let script = document.createElement('script');
    script.className = 'wf-gfont-script';
    script.textContent = `
(function () {
  let re = /^gfont-\\[.+?\\]$/;
  let ensure = names => {
    let uniq = [...new Set(names.filter(Boolean))];
    for (let x of uniq) {
      let id = 'gfont-[' + x + ']';
      if (document.getElementById(id)) continue;
      // <link> is more reliable than @import inside a dynamic <style>,
      // especially when preview mounts the page after head.js has booted.
      let link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      link.href =
        'https://fonts.googleapis.com/css2?family=' +
        encodeURIComponent(x.replace(/_/g, ' ')).replace(/%20/g, '+') +
        ':ital,wght@0,100;0,200;0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,100;1,200;1,300;1,400;1,500;1,600;1,700;1,800;1,900&display=swap';
      document.head.append(link);
      let style = document.createElement('style');
      style.id = id + '-rule';
      style.textContent =
        '.gfont-\\\\[' + x + '\\\\] { font-family: "' + x.replace(/_/g, ' ') + '" }';
      document.head.append(style);
    }
  };
  let collectFromEl = el => {
    if (!el || el.nodeType !== 1 || !el.classList) return [];
    return [...el.classList].filter(c => re.test(c)).map(c => c.slice('gfont-['.length, -1));
  };
  let scanTree = root => {
    if (!root || root.nodeType !== 1) {
      root = document.documentElement;
    }
    if (!root) return;
    let names = collectFromEl(root);
    for (let y of root.querySelectorAll('*')) names.push(...collectFromEl(y));
    ensure(names);
  };
  let observer = new MutationObserver(muts => {
    let gfonts = [];
    for (let mut of muts) {
      if (mut.type === 'childList') {
        for (let x of mut.addedNodes) {
          if (x.nodeType !== 1) continue;
          gfonts.push(...collectFromEl(x));
          for (let y of x.querySelectorAll('*')) gfonts.push(...collectFromEl(y));
        }
      } else if (mut.type === 'attributes') {
        gfonts.push(...collectFromEl(mut.target));
      }
    }
    ensure(gfonts);
  });
  observer.observe(document.documentElement || document, {
    attributes: true,
    childList: true,
    subtree: true,
    attributeFilter: ['class'],
  });
  // Preview compiles/inserts pages asynchronously after this script runs.
  // Keep scanning for a while so late mounts still pick up gfont-* classes.
  scanTree(document.documentElement);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scanTree(document.documentElement));
  }
  let polls = 0;
  let poll = setInterval(() => {
    scanTree(document.documentElement);
    polls++;
    if (polls >= 40) clearInterval(poll); // ~10s at 250ms
  }, 250);
})();
`;
    document.head.append(script);
  }
  let cfg = (await import('../wf.config.js')).default;
  let promises = [];
  let prefix = location.pathname.startsWith('/files/') ? '../' : '';
  if (cfg.nerdfonts) {
    let link = document.createElement('link');
    link.className = 'wf-nf-link';
    link.rel = 'stylesheet';
    link.href = 'https://www.nerdfonts.com/assets/css/webfont.css';
    let plink = Promise.withResolvers();
    link.onload = () => plink.resolve('nf');
    link.onerror = err => plink.reject(err);
    promises.push(plink.promise);
    document.head.append(link);
  }
  if (cfg.tailwind) {
    // native:* utilities apply only when html carries wf-native-preview
    // (IDE Native Preview toggle, or any host that sets the attribute).
    // On Nasty the JS resolver treats native: as always-on instead.
    let nativeVariant = document.createElement('style');
    nativeVariant.type = 'text/tailwindcss';
    nativeVariant.className = 'wf-native-variant';
    nativeVariant.textContent = '@custom-variant native (&:is(html:where([wf-native-preview]) *));\n';
    document.head.append(nativeVariant);

    // desktop:/mobile: and the OS variants win:/lin:/mac:/android: follow the same
    // html preview attributes (IDE Platform Preview); Nasty resolves them natively.
    // Each is a condition on the element itself so variants stack (lin:mobile:…).
    if (!document.querySelector('style.wf-platform-variants')) {
      let platformVariants = document.createElement('style');
      platformVariants.type = 'text/tailwindcss';
      platformVariants.className = 'wf-platform-variants';
      platformVariants.textContent = [
        '@custom-variant native (&:is(html:where([wf-native-preview]) *));',
        '@custom-variant desktop (&:is(html[wf-desktop-preview] *));',
        '@custom-variant mobile (&:is(html[wf-mobile-preview] *));',
        '@custom-variant win (&:is(html[wf-win-preview] *));',
        '@custom-variant lin (&:is(html[wf-lin-preview] *));',
        '@custom-variant mac (&:is(html[wf-mac-preview] *));',
        '@custom-variant android (&:is(html[wf-android-preview] *));',
        '',
      ].join('\n');
      document.head.append(platformVariants);
    }

    // Theme utilities as Tailwind @utility blocks, so every variant composes:
    // adw-* (GNOME Adwaita, from adwaita-web), and-* (Android Material Design 3, from
    // Beer CSS) and win-* (Windows Fluent 2, from the Kendo UI Fluent theme) — e.g.
    // lin:adw-button, android:mobile:and-button, win:win-button.
    // Each theme is large, so it loads only once the page uses its prefix
    // (checked now and on DOM changes, like the icon CSS below).
    let themes = { adw: 'adwaita', and: 'material', win: 'fluent' };
    // Append each theme once, with its content: Tailwind recompiles every
    // text/tailwindcss style whenever one changes, so no empty placeholder first.
    let themeLoads = (window.wfThemeLoads ??= new Map());
    let loadTheme = key => {
      let name = themes[key];
      if (!name || themeLoads.has(name) || document.querySelector(`style.wf-${name}`)) return themeLoads.get(name);
      let load = (async () => {
        try {
          let res = await fetch(`${prefix}webfoundry/${name}.tw.css`);
          if (!res.ok || document.querySelector(`style.wf-${name}`)) return;
          let style = document.createElement('style');
          style.type = 'text/tailwindcss';
          style.className = `wf-${name}`;
          style.textContent = await res.text();
          document.head.append(style);
        } catch (err) {
          console.warn(`${name} utilities unavailable:`, err);
        }
      })();
      themeLoads.set(name, load);
      return load;
    };
    let themeRe = /(?:^|[\s:])(adw|and|win)-[\w-]/g;
    let scanThemes = el => {
      let found = new Set();
      let visit = node => {
        if (node.nodeType !== 1) return;
        for (let m of String(node.className?.baseVal ?? node.className ?? '').matchAll(themeRe)) found.add(m[1]);
      };
      visit(el);
      for (let x of el.querySelectorAll?.('[class]') ?? []) visit(x);
      return found;
    };
    let initial = scanThemes(document.documentElement);
    await Promise.all([...initial].map(loadTheme));
    if (initial.size < Object.keys(themes).length) {
      let themeObserver = new MutationObserver(muts => {
        for (let mut of muts) {
          let nodes = mut.type === 'attributes' ? [mut.target] : [...mut.addedNodes];
          for (let node of nodes) for (let key of scanThemes(node)) loadTheme(key);
        }
        if (Object.values(themes).every(name => themeLoads.has(name))) themeObserver.disconnect();
      });
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
    }

    // Symbolic icons (adw-icon-*) are plain CSS with inlined SVGs; only load
    // them once a page actually uses one.
    let iconRe = /(?:^|\s)(?:[\w-]+:)*adw-icon-[\w-]+/;
    let iconObserver;
    let loadIcons = () => {
      if (document.querySelector('link.wf-adwaita-icons')) return;
      iconObserver?.disconnect();
      let link = document.createElement('link');
      link.className = 'wf-adwaita-icons';
      link.rel = 'stylesheet';
      link.href = `${prefix}webfoundry/adwaita-icons.css`;
      document.head.append(link);
    };
    let usesIcons = el => iconRe.test(el.className?.baseVal ?? el.className ?? '') || !!el.querySelector?.('[class*="adw-icon-"]');
    if (usesIcons(document.documentElement)) loadIcons();
    else {
      iconObserver = new MutationObserver(muts => {
        for (let mut of muts) {
          let nodes = mut.type === 'attributes' ? [mut.target] : [...mut.addedNodes].filter(x => x.nodeType === 1);
          if (nodes.some(usesIcons)) return loadIcons();
        }
      });
      iconObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
    }

    let script = document.createElement('script');
    script.className = 'wf-tw-script';
    script.src = `${prefix}webfoundry/tailplay4.dafuq.js`;
    let pscript = Promise.withResolvers();
    script.onload = () => pscript.resolve('tw');
    script.onerror = err => pscript.reject(err);
    document.head.append(script);
    promises.push(pscript.promise);
  }
  if (cfg.betterscroll) {
    let style = document.createElement('style');
    style.className = 'wf-betterscroll-style';
    style.textContent = `::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
::-webkit-scrollbar-track {
  background: transparent;
  box-shadow: inset 0 0 4px rgba(0, 0, 0, 0.05);
  border-radius: 4px;
}
::-webkit-scrollbar-thumb {
  background-color: grey;
  border-radius: 4px;
  border: 2px solid transparent;
  background-clip: content-box;
}
::-webkit-scrollbar-thumb:hover {
  background-color: #b0b0b0;
}
::-webkit-scrollbar-thumb:horizontal {
  background-clip: padding-box;
}
::-webkit-scrollbar-thumb:vertical {
  background-clip: padding-box;
}
`;
    document.head.append(style);
  }
  {
    let preflight = document.createElement('style');
    preflight.className = 'wf-preflight';
    preflight.textContent = `[hidden] { display: none !important } dialog { margin: auto } :empty { min-height: 1rem }`;
    let ppreflight = Promise.withResolvers();
    preflight.onload = () => ppreflight.resolve('preflight');
    preflight.onerror = err => ppreflight.reject(err);
    promises.push(ppreflight.promise);
    document.head.append(preflight);
  }
  await Promise.all(promises);
  let div = document.createElement('div'); document.body.append(div); div.remove();
  document.body.style.display = '';
})();

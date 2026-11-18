import prettier from '../other/prettier.js';
import rfiles from '../repos/rfiles.js';
import rprojects from '../repos/rprojects.js';
import { getOpenAIKey, promptForOpenAIKey } from '../other/openai.js';
import { getXAIKey, promptForXAIKey } from '../other/xai.js';

export default class Settings {
  state = { hasOpenAIKey: false, hasXAIKey: false };

  actions = {
    init: async () => {
      let { bus } = state.event;
      this.state.hasOpenAIKey = !!getOpenAIKey();
      bus.on('settings:openaiKey:changed', ({ hasKey }) => {
        this.state.hasOpenAIKey = hasKey;
        d.update();
      });
      this.state.hasXAIKey = !!getXAIKey();
      bus.on('settings:xaiKey:changed', ({ hasKey }) => {
        this.state.hasXAIKey = hasKey;
        d.update();
      });
      this.state.opt = JSON.parse(localStorage.getItem('webfoundry:config') || 'null');
      if (!this.state.opt) {
        this.state.opt = {
          brand: true,
          toolbar: true,
          companion: false,
          companionKey: `wf-${crypto.randomUUID()}`,
          isolate: true,
        };
        await post('settings.save');
      }
      // Keep the service worker's copy of the hardened-isolation flag in sync (it can't read localStorage).
      await post('settings.syncCoi');
      document.body.classList.add('bg-cover', 'bg-center');
      if (this.state.opt.wallpaper) document.body.style.backgroundImage = `url("${state.settings.opt.wallpaper}")`;
      if (state.collab.uid !== 'master') return;
      bus.on('projects:select:ready', async () => {
        let project = state.projects.current;
        if (!project) { this.state.popt = {}; return }
        this.state.popt = await rprojects.config(project);
        this.state.popt.storage = localStorage.getItem(`webfoundry:projects:storage:${project.split(':')[1]}`);
        await post('settings.fetchProjectTitle');
      });
      ['add', 'change'].forEach(x => bus.on(`files:${x}`, async ({ path }) => {
        let parts = path.split('/');
        if (state.projects.current?.split?.(':')?.[0] !== parts[0] || parts.slice(1).join('/') !== 'index.html') return;
        await post('settings.fetchProjectTitle');
      }));
      ['save', 'rm'].forEach(x => bus.on(`files:${x}`, async ({ event, path }) => {
        let project = state.projects.current;
        let name = project.split(':')[0];
        if (path !== `${name}/wf.uiconfig.json`) return;
        bus.emit('settings:projects:reload:start', { project });
        this.state.popt = await rprojects.config(project);
        this.state.popt.storage = localStorage.getItem(`webfoundry:projects:storage:${project.split(':')[1]}`);
        d.update();
        bus.emit('settings:projects:reload:ready', { project, opt: this.state.popt });
      }));
      ['push', 'pull'].forEach(x => bus.on(`broadcast:files:${x}`, async ({ project }) => {
        if (state.projects.current !== project) return;
        bus.emit('settings:projects:reload:start', { project });
        this.state.popt = await rprojects.config(project);
        this.state.popt.storage = localStorage.getItem(`webfoundry:projects:storage:${project.split(':')[1]}`);
        d.update();
        bus.emit('settings:projects:reload:ready', { project, opt: this.state.popt });
      }));
    },

    setOpenAIKey: async () => {
      await promptForOpenAIKey();
    },

    setXAIKey: async () => {
      await promptForXAIKey();
    },

    fetchProjectTitle: async () => {
      let blob = await rfiles.load(state.projects.current, 'index.html');
      if (!blob) return; // Decoration projects have no index.html.
      let index = new DOMParser().parseFromString(await blob.text(), 'text/html');
      this.state.projectTitle = index.head?.querySelector?.('title')?.textContent;
    },

    projectTitleChanged: async () => {
      let project = state.projects.current;
      let blob = await rfiles.load(project, 'index.html');
      if (!blob) return;
      let index = new DOMParser().parseFromString(await blob.text(), 'text/html');
      if (!index.head) index.documentElement.insertAdjacentHTML('afterbegin', '<head></head>');
      if (!index.head.querySelector('title')) index.head.insertAdjacentHTML('beforeend', '<title></title>');
      index.head.querySelector('title').textContent = this.state.projectTitle;
      await rfiles.save(project, 'index.html', new Blob([await prettier(`<!doctype html>${index.documentElement.outerHTML}`, { parser: 'html' })], { type: 'text/html' }));
    },

    save: () => localStorage.setItem('webfoundry:config', JSON.stringify(this.state.opt)),

    /** Tell the service worker whether to send COOP/COEP (resolves once it has stored the flag). */
    syncCoi: async () => {
      let sw = navigator.serviceWorker?.controller;
      if (!sw) return;
      await new Promise(resolve => {
        let channel = new MessageChannel();
        let done = setTimeout(resolve, 2000);
        channel.port1.onmessage = () => {
          clearTimeout(done);
          resolve();
        };
        sw.postMessage({ type: 'webfoundry-coi', on: !!this.state.opt.coi }, [channel.port2]);
      });
    },

    /**
     * Hardened isolation: COOP same-origin + COEP credentialless on every page,
     * making the editor and previews cross-origin isolated (SharedArrayBuffer,
     * Atomics.wait). Applied by the service worker, so it takes a reload.
     */
    toggleCoi: async () => {
      let on = !this.state.opt.coi;
      let message = on
        ? 'Webfoundry will reload with cross-origin isolation on. Images, media and embeds from sites that do not allow it may stop loading, and cross-site popups (e.g. sign-in windows) lose their link to this tab. Other Webfoundry tabs switch on their next reload.'
        : 'Webfoundry will reload without cross-origin isolation. Pages that rely on SharedArrayBuffer or Atomics.wait will stop working.';
      let [btn] = await showModal('ConfirmationDialog', { title: on ? 'Turn on hardened isolation?' : 'Turn off hardened isolation?', message });
      if (btn !== 'yes') return;
      this.state.opt.coi = on;
      await post('settings.save');
      await post('settings.syncCoi');
      location.reload();
    },

    option: async (k, v, force) => {
      v ??= !this.state.opt[k];
      let { bus } = state.event;
      if (!force) {
        let prevented = false;
        await bus.emitAsync('settings:global:option:start', { k, v, preventDefault: () => prevented = true });
        if (prevented) return bus.emit('settings:global:option:abort', { k, v });
      }
      this.state.opt[k] = v;
      await post('settings.save');
      if (k === 'wallpaper') document.body.style.backgroundImage = v ? `url("${v}")` : '';
      bus.emit('settings:global:option:ready', { k, v });
    },

    projectOption: async (k, v, force) => {
      v ??= !this.state.popt[k];
      let project = state.projects.current;
      let { bus } = state.event;
      if (!force) {
        let prevented = false;
        await bus.emitAsync('settings:projects:option:start', { k, v, preventDefault: () => prevented = true });
        if (prevented) return bus.emit('settings:projects:option:abort', { k, v });
      }
      this.state.popt[k] = v;
      if (k === 'storage') localStorage.setItem(`webfoundry:projects:storage:${project.split(':')[1]}`, v);
      else await rprojects.config(project, { ...this.state.popt, storage: undefined });
      bus.emit('settings:projects:option:ready', { k, v });
    },
  };
};

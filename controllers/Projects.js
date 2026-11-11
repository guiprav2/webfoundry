import rfiles from '../repos/rfiles.js';
import rprojects from '../repos/rprojects.js';
import { defaultHtml } from '../other/templates.js';
import { DECORATION_FILE, esc, stripClarity } from '../other/util.js';

export default class Projects {
  state = { list: [] };

  actions = {
    init: async () => {
      let { bus } = state.event;
      bus.on('projects:create:ready', async ({ project }) => {
        await post('projects.load');
        await post('projects.select', project);
      });
      bus.on('projects:mv:ready', async ({ project, newName }) => {
        await post('projects.load');
        await post('projects.select', `${newName}:${project.split(':')[1]}`);
      });
      bus.on('projects:rm:ready', async ({ project }) => {
        if (this.state.current === project) await post('projects.select', null);
        await post('app.selectPanel', 'projects');
        await post('projects.load');
      });
      bus.on('settings:global:option:ready', async ({ k, v }) => {
        if (k !== 'companion' || v) return;
        if (rprojects.storage(state.projects.current) === 'cfs') await post('projects.select', null);
      });
      await post('projects.load');
    },

    load: async () => {
      let { bus } = state.event;
      bus.emit('projects:load:start');
      this.state.list = rprojects.list();
      bus.emit('projects:load:ready');
    },

    create: async (name, opt = {}) => {
      let { bus } = state.event;
      bus.emit('projects:create:start');
      bus.emit('projects:create:prompt');
      if (name) {
        if (state.projects.list.find(x => x.split(':')[0] === name)) throw new Error(`Project already exists: ${name}`);
      } else {
        while (true) {
          let [btn, val] = await showModal('CreateProjectDialog');
          if (btn !== 'ok') return bus.emit('projects:create:cancel');
          name = val.name;
          if (val.origin) opt.decoration = { origin: val.origin };
          break;
        }
      }
      let project = await loadman.run('projects.create', async () => {
        bus.emit('projects:create:confirmed', { name });
        let project = rprojects.create(name);
        let uuid = project.split(':')[1];
        opt.nerdfonts ??= true;
        opt.tailwind ??= true;
        opt.betterscroll ??= true;
        state.projects.list.push(project); // needed by rprojects.config
        await rprojects.config(project, opt);
        // Decoration projects have no pages of their own: just the hooks and shared media.
        if (opt.decoration) {
          let { origin } = opt.decoration;
          let model = { version: 1, origin, startPath: '/', hooks: [] };
          await rfiles.save(project, DECORATION_FILE, new Blob([`${JSON.stringify(model, null, 2)}\n`], { type: 'application/json' }));
          await rfiles.save(project, 'media/.keep', new Blob([''], { type: 'text/plain' }));
          await rfiles.save(project, 'AGENTS.md', new Blob([await (await fetch('AGENTS.md')).text()], { type: 'text/markdown' }));
          await rfiles.save(project, 'wf.config.js', new Blob([await (await fetch('webfoundry/wf.config.js')).text()], { type: 'text/javascript' }));
          bus.emit('projects:create:ready', { project });
          return project;
        }
        await Promise.all(['controllers', 'components', 'media', 'pages'].map(async x => await rfiles.save(project, `${x}/.keep`, new Blob([''], { type: 'text/plain' }))));
        await Promise.all([
          'AGENTS.md',
          'index.html',
          'webfoundry/_redirects',
          'webfoundry/wf.config.js',
          'webfoundry/app.js',
          'webfoundry/bimap.js',
          'webfoundry/ifdesigner.js',
          'webfoundry/head.js',
          'webfoundry/dominant.js',
          'webfoundry/tailplay4.dafuq.js',
          'webfoundry/adwaita.tw.css',
          'webfoundry/material.tw.css',
          'webfoundry/fluent.tw.css',
          'webfoundry/adwaita-icons.css',
        ].map(async x => {
          let text = await (await fetch(x)).text();
          if (x === 'index.html') text = stripClarity(text).replace('<title>Webfoundry</title>', `<title>${esc(name)}</title>`);
          let target = x;
          if (target.endsWith('/wf.config.js')) target = 'wf.config.js';
          if (target.endsWith('/_redirects')) target = '_redirects';
          await rfiles.save(project, target, new Blob([text], { type: mimeLookup(x) }));
        }));
        await rfiles.save(project, 'pages/index.html', new Blob([defaultHtml()], { type: 'text/html' }));
        bus.emit('projects:create:ready', { project });
        return project;
      });
      return project;
    },

    mv: async (project, newName) => {
      let { bus } = state.event;
      let [name, uuid] = project.split(':');
      bus.emit('projects:mv:start', { project });
      bus.emit('projects:mv:prompt', { project });
      if (newName) {
        if (state.projects.list.find(x => x.split(':')[0] === newName)) throw new Error(`Project already exists: ${newName}`);
      } else {
        while (true) {
          let [btn, val] = await showModal('PromptDialog', { title: 'Rename project', placeholder: 'Project name', initialValue: newName || name, allowEmpty: false, short: true });
          if (btn !== 'ok') return bus.emit('projects:mv:cancel');
          newName = val;
          if (state.projects.list.find(x => x.split(':')[0] === val)) { await showModal('InfoDialog', { title: `Project already exists.` }); continue }
          break;
        }
      }
      await loadman.run('projects.mv', async () => {
        bus.emit('projects:mv:confirmed', { project, newName });
        await rprojects.mv(project, newName);
        bus.emit('projects:mv:ready', { project, newName });
      });
    },

    rm: async project => {
      let { bus } = state.event;
      bus.emit('projects:rm:start', { project });
      bus.emit('projects:rm:confirm', { project });
      let [btn] = await showModal('ConfirmationDialog', { title: 'Delete project?' });
      if (btn !== 'yes') { bus.emit('projects:rm:cancel', { project }); return { success: true, note: `Denied by user; acknowledge non-deletion` } }
      await loadman.run('projects.rm', async () => {
        bus.emit('projects:rm:confirmed', { project });
        await rprojects.rm(project);
        bus.emit('projects:rm:ready', { project });
      });
    },

    select: project => {
      let { bus } = state.event;
      bus.emit('projects:select:start', { project });
      if (project && this.state.list.indexOf(project) === -1) {
        bus.emit('projects:select:error', { project, error: new Error(`Project not found: ${project}`) });
        return { success: false, reason: `Project not found` };
      }
      this.state.current = project;
      bus.emit('projects:select:ready', { project });
    },
  };
};

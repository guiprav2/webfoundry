import * as pako from 'https://cdn.jsdelivr.net/npm/pako@3.0.3/+esm';
import LightningFS from 'https://cdn.jsdelivr.net/npm/@isomorphic-git/lightning-fs@4.10.5/+esm';
import git from 'https://cdn.jsdelivr.net/npm/isomorphic-git@1.44.12/+esm';
import gitHttp from 'https://unpkg.com/isomorphic-git@1.0.0-beta.36/http/web/index.js';
import prettier from '../other/prettier.js';
import rfiles from '../repos/rfiles.js';
import { rebasePageUrls } from '../other/page-move.js';
import { checkWebfoundryFile } from '../other/page-check.js';
import rprojects from '../repos/rprojects.js';
import structuredFiles from '../other/structuredFiles.js';
import { DECORATION_FILE, debounce, isDecorationPath, isolationLabel, joinPath, loadman, stripClarity } from '../other/util.js';
import { defaultCtrl, defaultHtml } from '../other/templates.js';
import { lookup as mimeLookup } from 'https://cdn.jsdelivr.net/npm/mrmime@2.0.1/+esm';
import { deriveProjectNameFromUrl, gitCorsProxy } from '../other/gitImport.js';
import { downloadBlob, exportAndroidApk, exportLinuxAppImage } from '../nasty/export-native.js';

// Runtime files projects created before adw-* support may lack (served from the IDE instead).
let ADWAITA_RUNTIME_FILES = ['webfoundry/adwaita.tw.css', 'webfoundry/adwaita-icons.css', 'webfoundry/material.tw.css', 'webfoundry/fluent.tw.css'];

let loadChain = Promise.resolve();

export default class Files {
  state = {
    list: [],
    expandedPaths: new Set(),
    gitImportQueryHandled: false,
    autoSelectOnLoad: null,
    importing: 0,

    expanded: path => {
      if (!path) return true;
      let paths = [];
      let currentPath = '';
      for (let part of path.split('/').slice(0, -1)) { currentPath += `${part}/`; paths.push(currentPath) }
      return paths.every(x => this.state.expandedPaths.has(x));
    },

    protected: path => ['components', 'controllers', 'media', 'pages'].includes(path),
  };

  actions = {
    init: async () => {
      let { bus } = state.event;
      let respond = async ({ project, path }, callback) => {
        try {
          path = decodeURIComponent(path);
          if (!project?.includes?.(':')) return callback({ type: 'fetch:res', project, path, status: 400, error: 'Bad project' });
          let adwaitaRuntime = ADWAITA_RUNTIME_FILES.includes(path);
          let data;
          try {
            data = state.collab.uid === 'master'
              ? await rfiles.load(project, path)
              : await ungzblob(unb64(await post('collab.rpc', 'fetch', { project, path })), mimeLookup(path));
          } catch (err) {
            if (!adwaitaRuntime) throw err;
          }
          // Projects created before adw-* support lack these runtime files; serve the IDE's copies.
          // ... and the designer bridge has to match this IDE, while project copies never update.
          if ((!data && adwaitaRuntime) || path === 'webfoundry/ifdesigner.js') {
            let res = await fetch(path);
            if (res.ok) data = await res.blob();
          }
          if (!data) return callback({ type: 'fetch:res', project, path, status: 404, error: 'Not found' });
          // Webfoundry's analytics tag, in projects created before clarity-in-user-projects: never run it in previews.
          if (path === 'index.html') data = new Blob([stripClarity(await data.text())], { type: 'text/html' });
          callback({ type: 'fetch:res', project, path, status: 200, data });
        } catch (err) {
          console.error(err);
          callback({ type: 'fetch:res', project, path, status: 500, error: err.message });
        }
      };

      navigator.serviceWorker.addEventListener('message', async event => {
        let { type, project, path } = event.data || {};
        if (type !== 'fetch' || window.wfThisProject === project) return;
        let port = event.ports?.[0];
        if (!port) return;
        await respond({ project, path }, payload => port.postMessage(payload));
      });

      window.addEventListener('message', async ev => {
        let { rpcid, type, project, path, contents } = ev.data || {};
        if (location.origin !== ev.origin) {
          let url = new URL(ev.origin);
          let parts = url.hostname.split('.');
          let domain = parts.slice(1).join('.');
          let project = parts[0];
          if (!/^webfoundry.app|webfoundry\d+\.netlify\.app|localhost$/.test(domain)) return;
          if (!state.projects.current || isolationLabel(state.projects.current) !== project) return; // FIXME: Also check path.
        }
        if (type === 'fetch') {
          if (!ev.source || typeof ev.source.postMessage !== 'function') return;
          await respond({ project, path }, payload => ev.source.postMessage(payload, ev.origin));
        }
        if (type === 'write') {
          if (!path.startsWith('data/')) return await ev.source.postMessage({ rpcid, type: 'write:res', success: false, error: `Cannot write outside data/` });
          await rfiles.save(project, path, unb64(contents, mimeLookup(path)));
          await post('files.load');
          await ev.source.postMessage({ rpcid, type: 'write:res', success: true }, ev.origin);
        }
      });
      if (state.collab.uid !== 'master') return;
      bus.on('projects:select:ready', async ({ project }) => await loadman.run('files.projectSelect', async () => {
        this.state.list = [];
        this.state.expandedPaths = new Set(['pages/']);
        this.state.current = null;
        // During Git imports, auto-select is deferred until the import finishes (see runGitImportFlow).
        this.state.autoSelectOnLoad = project && !this.state.importing ? 'pages/index.html' : null;
        d.update();
        if (project) {
          await post('files.load');
          if (!state.app.panel || state.app.panel === 'projects') await post('app.selectPanel', 'files');
        }
      }));
      bus.on('files:load:ready', async () => {
        let target = this.state.autoSelectOnLoad;
        this.state.autoSelectOnLoad = null;
        if (!target || this.state.current) return;
        if (this.state.list.some(x => joinPath(x[1], x[0]) === DECORATION_FILE)) target = DECORATION_FILE;
        let hasTarget = this.state.list.some(x => joinPath(x[1], x[0]) === target);
        if (!hasTarget) return;
        await post('files.select', target);
      });
      bus.on('files:select:ready', ({ path }) => {
        if (!path || path.endsWith('/')) return;
        let parts = path.split('/').slice(0, -1);
        let partial = '';
        for (let i = 0; i < parts.length; i++) {
          partial += `${parts[i]}/`;
          this.state.expandedPaths.add(partial);
        }
      });
      bus.on('files:create:ready', async ({ path, select = true }) => {
        await post('files.load');
        if (select) await post('files.select', path);
      });
      bus.on('files:mv:ready', async ({ path, newPath }) => {
        let { current } = this.state;
        await post('files.load');
        if (current === path || (path.endsWith('/') && current?.startsWith?.(path))) {
          if (!path.endsWith('/')) await post('files.select', newPath);
          else await post('files.select', current.replace(new RegExp(`^${path}`), newPath));
        }
      });
      bus.on('files:rm:ready', async () => await post('files.load'));
      for (let x of ['add', 'change', 'rm']) {
        bus.on(`broadcast:files:${x}`, ({ event, path }) => {
          let name = path.split('/')[0];
          let storage = rprojects.storage(state.projects.list.find(x => x.startsWith(`${name}:`)));
          if (storage !== 'local') return;
          bus.emit(event.split(':').slice(1).join(':'), { path });
        });
        bus.on(`companion:files:${x}`, ({ type, path }) => {
          let name = path.split('/')[0];
          let project = state.projects.list.find(x => x.startsWith(`${name}:`));
          if (!project) return;
          let storage = rprojects.storage(project);
          if (storage !== 'cfs') return;
          bus.emit(type, { path });
        });
        bus.on(`files:${x}`, async ({ path }) => {
          if (!state.projects.current || !path.startsWith(`${state.projects.current.split(':')[0]}/`)) return;
          x !== 'change' && await post('files.load');
          if (!path.endsWith('.html') && !path.endsWith('.js')) return;
          (path.endsWith('.html') || x !== 'change') && await post('files.reflect');
        });
      }
      ['push', 'pull'].forEach(x => bus.on(`broadcast:files:${x}`, async () => await post('files.load')));
      bus.on('settings:projects:option:start', async ({ k, v, preventDefault }) => {
        if (k !== 'storage') return;
        preventDefault();
        let project = state.projects.current;
        // Turning Companion FS off (v === 'local') moves files into browser storage, then deletes the folder on disk (rfiles.push).
        let message = v === 'local'
          ? `This will remove the project directory (${project.split(':')[0]}/) from your local file system. Its files will be moved into browser storage.`
          : null;
        let [btn] = await showModal('ConfirmationDialog', { title: 'Are you sure?', message });
        if (btn !== 'yes') return;
        await post(v === 'local' ? 'files.push' : 'files.pull');
      });
    },

    load: debounce(async () => await (loadChain = loadChain.catch(() => {}).then(() => loadman.run('files.load', async () => {
      let project = state.projects.current;
      let { bus } = state.event;
      bus.emit('files:load:start');
      let list = (await rfiles.list(project)).filter(x => !/(\..*\.sw.$|^index.html$|^wf.uiconfig.json$|^webfoundry\/)/.test(x));
      if (state.projects.current !== project) return bus.emit('files:load:abort');
      if (!list.includes(this.state.current)) await post('files.select', null);
      this.state.list = structuredFiles(list);
      bus.emit('files:load:ready');
    }))), 500),

    select: async path => {
      if (state.collab.uid !== 'master') return await post('collab.open', path);
      let project = state.projects.current;
      let { bus } = state.event;
      bus.emit('files:select:start');
      let check = path?.endsWith?.('/') ? path.slice(0, -1) : path;
      if (check && !state.files.list.find(x => joinPath(x[1], x[0]) === check)) throw new Error(`Path does not exist: ${path}`);
      if (path?.endsWith?.('/')) {
        if (this.state.expandedPaths.has(path)) this.state.expandedPaths.delete(path);
        else this.state.expandedPaths.add(path);
      } else {
        this.state.current = path;
      }
      d.updateSync();
      bus.emit('files:select:ready', { project, path });
      if (path?.endsWith?.('.html') || isDecorationPath(path)) await new Promise((pres, prej) => {
        if (state.designer.list.find(x => x.path === path && x.ready)) { return pres() }
        state.event.bus.on('designer:select:ready', () => pres());
        state.event.bus.on('designer:select:error', () => prej());
      });
    },

    // select: open the new file afterwards. Defaults on for the IDE, off for background (agent) creates.
    create: async (path, name, type = 'file', { background = false, select = !background } = {}) => {
      let project = state.projects.current;
      let { bus } = state.event;
      bus.emit('files:create:start');
      let ai = !!name;
      if (!name) {
        let btn;
        [btn, type, name] = await showModal('CreateFileDialog');
        if (btn !== 'ok') return bus.emit('files:create:abort', { project, path });
        if (type === 'file' && !name.includes('.') && (path === 'pages' || path?.startsWith?.('pages/'))) {
          let [choice] = await showModal('FileExtensionWarningDialog');
          if (!choice) return bus.emit('files:create:abort', { project, path });
          if (choice === 'html') name += '.html';
        }
      }
      let fullpath = path ? joinPath(path, name) : name;
      if (await rfiles.load(project, fullpath)) {
        if (background) return { success: false, reason: `File already exists` };
        let [btn2] = await showModal('ConfirmationDialog', { title: 'File exists. Overwrite?' });
        if (btn2 !== 'yes') { bus.emit('files:create:abort', { project, path, name }); return { success: false, reason: `File already exists` } }
      }
      if (type === 'file') {
        if (name.endsWith('.html') && !fullpath.includes('/')) {
          bus.emit('files:create:abort', { project, path, name });
          !ai && await showModal('InfoDialog', { title: `HTML files are not allowed in the root directory.` });
          return { success: false, reason: `HTML files are not allowed in the root directory` };
        }
        let defaultContent = '';
        if (fullpath.startsWith('controllers/') && fullpath.endsWith('.js')) defaultContent = defaultCtrl(fullpath);
        if (fullpath.endsWith('.html')) defaultContent = defaultHtml({ title: name });
        let iext = name.lastIndexOf('.');
        let parser = iext < 0 ? '' : name.slice(iext + 1);
        defaultContent = await prettier(defaultContent, { parser });
        let blob = new Blob([defaultContent], { type: mimeLookup(fullpath) });
        return await loadman.run('files.create', async () => {
          await rfiles.save(project, fullpath, blob);
          bus.emit('files:create:ready', { project, path: fullpath, select });
          // Peers have no files:create:ready listener (the host owns the tree), so open it here.
          if (select && state.collab.uid !== 'master') await post('collab.open', fullpath);
          return { success: true, note: select ? `File created and selected (opened)` : `File created` };
        });
      } else {
        return await loadman.run('files.create', async () => {
          await rfiles.save(project, `${fullpath}/.keep`, new Blob([''], { type: 'text/plain' }));
          bus.emit('files:create:ready', { project, path: `${fullpath}/.keep` });
          return { success: true, note: `Directory created and selected (opened)` };
        });
      }
    },

    dragstart: (ev, path) => { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', path) },
    dragover: (ev, path) => { ev.preventDefault(); ev.stopPropagation(); ev.dataTransfer.dropEffect = 'move'; this.state.dropTarget = path === '/' ? path : path.slice(0, path.lastIndexOf('/')) },

    drop: async (ev, dest) => {
      let project = state.projects.current;
      ev.preventDefault();
      ev.stopPropagation();
      this.state.dropTarget = null;
      d.update();
      let path = ev.dataTransfer.getData('text/plain');
      let tail = path.split('/').at(path.endsWith('/') ? -2 : -1) + (path.endsWith('/') ? '/' : '');
      let newPath = dest === '/' ? tail : dest.slice(0, dest.lastIndexOf('/') + 1) + tail;
      if (newPath.startsWith(path)) return;
      await rfiles.mv(project, path, newPath);
      await rebaseMovedPages(project, path, newPath, path.endsWith('/'));
      state.event.bus.emit('files:mv:ready', { project, path, newPath });
    },

    dragend: () => { this.state.dropTarget = null },

    mv: async (path, newPath) => {
      let project = state.projects.current;
      let { bus } = state.event;
      bus.emit('files:mv:start');
      let isDir = path.endsWith('/');
      let newName;
      if (!newPath) {
        let btn;
        [btn, newName] = await showModal('RenameFileDialog', { initialValue: path.split('/').at(isDir ? -2 : -1) });
        if (btn !== 'ok') return bus.emit('files:mv:abort', { project, path });
      }
      // FIXME: Confirm overwrites.
      newPath ??= [...path.split('/').slice(0, isDir ? -2 : -1), newName].join('/') + (isDir ? '/' : '');
      return await loadman.run('files.mv', async () => {
        await rfiles.mv(project, path, newPath);
        await rebaseMovedPages(project, path, newPath, isDir);
        bus.emit('files:mv:ready', { project, path, newPath });
        return { success: true, note: `File moved and selected (opened)` };
      });
    },

    rm: async path => {
      let project = state.projects.current;
      let { bus } = state.event;
      bus.emit('files:rm:start');
      let [btn] = await showModal('ConfirmationDialog', { title: 'Delete this file or folder?' });
      if (btn !== 'yes') { bus.emit('files:rm:abort', { project, path }); return { success: true, note: `Remove denied by user; acknowledge non-removal` } }
      await loadman.run('files.rm', async () => {
        await rfiles.rm(project, path);
        bus.emit('files:rm:ready', { project, path });
      });
    },

    reflect: debounce(async () => {
      if (state.collab.uid !== 'master') return; // The host owns the project's files.
      let { bus } = state.event;
      let project = state.projects.current;
      bus.emit('files:reflect:start', { project });
      // Sorted, so this and `wf reflect` (other/reflect.js) write the same JSON for the same files.
      let files = (await rfiles.list(project)).sort();
      let templates = {};
      for (let x of files.filter(x => x.endsWith('.html'))) templates[x] = await (await rfiles.load(project, x)).text();
      await rfiles.save(project, 'webfoundry/templates.json', new Blob([JSON.stringify(templates)], { type: 'application/json' }));
      let scripts = files.filter(x => x.endsWith('.js'));
      await rfiles.save(project, 'webfoundry/scripts.json', new Blob([JSON.stringify(scripts)], { type: 'application/json' }));
      // Pages are also edited outside the IDE now; flag ones that lost Webfoundry's structure.
      let problems = Object.fromEntries(Object.entries(templates).map(([path, html]) => [path, checkWebfoundryFile(path, html)]).filter(x => x[1].length));
      this.state.pageProblems = problems;
      for (let [path, list] of Object.entries(problems)) console.warn(`${path} isn't a well-formed Webfoundry file:\n- ${list.join('\n- ')}`);
      bus.emit('files:reflect:ready', { project, templates, scripts, problems });
    }, 200),

    push: async () => await loadman.run('files.push', async () => {
      let { bus } = state.event;
      let project = state.projects.current;
      bus.emit('files:push:start');
      await rfiles.push(project);
      await post('settings.projectOption', 'storage', 'local', true);
      await post('broadcast.publish', 'files:push', { project });
      bus.emit('files:push:ready');
    }),

    pull: async () => await loadman.run('files.pull', async () => {
      let { bus } = state.event;
      let project = state.projects.current;
      bus.emit('files:pull:start');
      if (!await rfiles.pull(project)) return bus.emit('files:pull:abort', { project });
      await post('settings.projectOption', 'storage', 'cfs', true);
      await post('broadcast.publish', 'files:pull', { project });
      bus.emit('files:pull:ready');
    }),

    deploy: async () => {
      let project = state.projects.current;
      let key = localStorage.getItem('webfoundry:netlifyApiKey');
      if (!key) {
        let [btn, x] = await showModal('NetlifyApiKeyDialog', { key });
        if (btn !== 'ok') return;
        key = x;
        localStorage.setItem('webfoundry:netlifyApiKey', key);
        if (!key) return;
      }
      let siteId = localStorage.getItem(`webfoundry:netlifySiteId:${project}`);
      let deployMode = localStorage.getItem('webfoundry:netlifyDeployMode') || 'production';
      let btn, type, x, selectedMode;
      while (true) {
        [btn, type, x, selectedMode] = await showModal('NetlifyDeployDialog', { key, id: siteId, mode: deployMode });
        if (selectedMode) deployMode = selectedMode;
        if (btn === 'key') {
          // Assign the outer `key` (no shadowing), so the deploy uses the new key.
          let [keyBtn, newKey] = await showModal('NetlifyApiKeyDialog', { key });
          if (keyBtn !== 'ok') continue;
          key = newKey;
          localStorage.setItem('webfoundry:netlifyApiKey', key);
          if (!key) return;
          continue;
        }
        if (btn !== 'ok') return;
        break;
      }
      deployMode = deployMode || 'production';
      showModal('LoadingDialog', { msg: 'Compressing files...' });
      let blob = await rfiles.exportZip(project);
      document.querySelector('dialog')?.remove?.();
      if (type === 'new') {
        try { siteId = (await netlifyCreateSite(key, x)).id }
        catch (err) { await showModal('NetlifyPostDeployDialog', { success: false, error: err.message }); return }
      } else if (type === 'existing') {
        siteId = x;
      }
      localStorage.setItem(`webfoundry:netlifySiteId:${project}`, siteId);
      localStorage.setItem('webfoundry:netlifyDeployMode', deployMode);
      showModal('LoadingDialog', { msg: 'Deploying to Netlify...' });
      try {
        let deploy = await netlifyUpload({ key, siteId, blob, mode: deployMode });
        document.querySelector('dialog')?.remove?.();
        let pagePath = this.state.current?.startsWith?.('pages/') ? this.state.current.slice('pages/'.length) : '';
        if (pagePath.endsWith('/index.html')) pagePath = pagePath.slice(0, -'/index.html'.length);
        if (pagePath === 'index.html') pagePath = '';
        let formatUrl = base => {
          if (!base) return null;
          let url = base.endsWith('/') ? base.slice(0, -1) : base;
          if (!pagePath) return url;
          let encodedPath = pagePath.split('/').map(part => encodeURIComponent(part)).join('/');
          return `${url}/${encodedPath}`;
        };
        let productionUrl = deployMode === 'production' ? formatUrl(deploy.ssl_url || deploy.url) : null;
        let previewUrl = deployMode === 'preview' ? formatUrl(deploy.review_url || deploy.deploy_ssl_url || deploy.deploy_url || deploy.ssl_url || deploy.url) : null;
        let [btn] = await showModal('NetlifyPostDeployDialog', { success: true, productionUrl, previewUrl, mode: deployMode });
        if (btn === 'preview' && previewUrl) open(previewUrl, `${siteId}:preview`);
        if (btn === 'visit' && productionUrl) open(productionUrl, siteId);
      } catch (err) {
        console.error(err);
        document.querySelector('dialog')?.remove?.();
        await showModal('NetlifyPostDeployDialog', { success: false, error: err.message });
      }
    },

    // wf deploy: no dialogs. site / newSite pick or create the site; otherwise the project's linked one.
    deployHeadless: async ({ site, newSite, preview = false } = {}) => {
      let project = state.projects.current;
      let key = localStorage.getItem('webfoundry:netlifyApiKey');
      if (!key) return { success: false, error: `No Netlify API key in this browser. Ask the user to deploy once from the editor's Deploy button, which stores the key.` };
      let mode = preview ? 'preview' : 'production';
      return await loadman.run('files.deploy', async () => {
        try {
          let siteId = localStorage.getItem(`webfoundry:netlifySiteId:${project}`);
          let created = false;
          if (newSite) { siteId = (await netlifyCreateSite(key, newSite)).id; created = true }
          else if (site) siteId = (await netlifyFindSite(key, site)).id;
          if (!siteId) return { success: false, error: `This project isn't linked to a Netlify site yet. Pass --new <name> to create one or --site <name-or-id> to use an existing one.` };
          let blob = await rfiles.exportZip(project);
          let deploy = await netlifyUpload({ key, siteId, blob, mode });
          localStorage.setItem(`webfoundry:netlifySiteId:${project}`, siteId);
          let url = mode === 'production'
            ? deploy.ssl_url || deploy.url
            : deploy.deploy_ssl_url || deploy.deploy_url || deploy.review_url;
          return { success: true, mode, created, siteId, siteName: deploy.name, deployId: deploy.id, url };
        } catch (err) {
          return { success: false, error: err.message };
        }
      });
    },

    // wf deploy-info: whether a key is stored and which site the project deploys to.
    deployInfo: async () => {
      let project = state.projects.current;
      let key = localStorage.getItem('webfoundry:netlifyApiKey');
      let siteId = localStorage.getItem(`webfoundry:netlifySiteId:${project}`);
      let info = { success: true, keySet: !!key, siteId: siteId || null };
      if (!key || !siteId) return info;
      try {
        let site = await netlifyFindSite(key, siteId);
        Object.assign(info, { siteName: site.name, url: site.ssl_url || site.url, publishedDeployId: site.published_deploy?.id || null, publishedAt: site.published_deploy?.published_at || null });
      } catch (err) {
        info.error = err.message;
      }
      return info;
    },

    importZip: async () => {
      let project = state.projects.current;
      let input = d.html`<input class="hidden" type="file" accept=".zip">`;
      input.onchange = async () => {
        let [file] = input.files;
        if (!file) return;
        showModal('LoadingDialog', { msg: 'Importing ZIP...' });
        await rfiles.importZip(project, file);
        await post('files.injectBuiltins');
        await post('files.reflect');
        await post('files.load');
        document.querySelector('dialog')?.remove?.();
      }
      document.body.append(input);
      input.click();
      input.remove();
    },

    importGit: async () => {
      let project = state.projects.current;
      if (!project) return;
      let detail = await promptGitImportDialog({
        title: 'Import HTTPS Git repository',
        requireName: false,
      });
      if (!detail) return;
      let repoUrl = detail.url?.trim();
      let branch = detail.branch?.trim();
      if (!repoUrl || !branch) return;
      try {
        await runGitImportFlow(project, repoUrl, branch);
      } catch (err) {
        console.error(err);
        await showModal('InfoDialog', { title: `Git import failed: ${err.message}` });
      }
    },

    handleGitImportQuery: async () => {
      if (state.collab.uid !== 'master') return;
      if (this.state.gitImportQueryHandled) return;
      // zip= takes a same-origin archive (the landing demos, see other/build-demos.js); git= clones through the CORS proxy.
      let zipQuery = consumeGitImportParam('zip');
      let query = zipQuery || consumeGitImportParam();
      if (!query) return;
      this.state.gitImportQueryHandled = true;
      let { repoUrl: presetUrl, projectName: presetName } = parseGitImportParam(query);
      let derivedName = presetName?.trim() || (zipQuery ? deriveProjectNameFromZipUrl : deriveProjectNameFromUrl)(presetUrl) || '';
      if (state.app.demo && derivedName) {
        let existing = state.projects.list.find(x => x.startsWith(`${derivedName}:`));
        if (existing) {
          await post('projects.select', existing);
          return;
        }
      }
      let repoUrl = presetUrl;
      let branch = 'master';
      if (!repoUrl) return;
      let baseName = derivedName || 'imported-project';
      let projectName = baseName;
      for (let n = 2; state.projects.list.some(x => x.split(':')[0] === projectName); n++) projectName = `${baseName}-${n}`;
      let project;
      this.state.importing++;
      try {
        try {
          project = await post('projects.create', projectName);
        } catch (err) {
          console.error(err);
          await showModal('InfoDialog', { title: `Failed to create project: ${err.message}` });
          return;
        }
        if (!project) project = state.projects.list.find(x => x.startsWith(`${projectName}:`));
        try {
          if (zipQuery) await runZipImportFlow(project, repoUrl);
          else await runGitImportFlow(project, repoUrl, branch);
        } catch (err) {
          console.error(err);
          await showModal('InfoDialog', { title: `${zipQuery ? 'ZIP' : 'Git'} import failed: ${err.message}` });
        }
      } finally {
        this.state.importing--;
      }
    },

    exportZip: async () => {
      let project = state.projects.current;
      showModal('LoadingDialog', { msg: 'Exporting ZIP...' });
      let blob = await rfiles.exportZip(project);
      document.querySelector('dialog')?.remove?.();
      let a = d.html`<a class="hidden" ${{ download: `${project.split(':')[0]}.zip`, href: URL.createObjectURL(blob) }}>`;
      document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
    },

    exportNative: async () => {
      let project = state.projects.current;
      if (!project) return;
      let btn, options;
      try {
        [btn, options] = await showModal('NativeExportDialog');
      } catch (err) {
        console.error(err);
        await showModal('InfoDialog', { title: `Native export dialog failed: ${err.message}` });
        return;
      }
      if (btn !== 'ok' || !options) return;
      // Older dialogs returned a bare target string; accept either shape.
      let target = typeof options === 'string' ? options : options.target;
      let windowOpts = typeof options === 'string' ? {} : options;
      if (target !== 'linux-x64' && target !== 'android-arm64') {
        await showModal('InfoDialog', { title: `Target ${target} is not available yet.` });
        return;
      }
      let name = project.split(':')[0];
      // Components get a copy of props, so pass msg as a binding to update it live.
      let loading = { msg: 'Exporting native app...' };
      showModal('LoadingDialog', { msg: d.binding({ get: () => loading.msg }) });
      let progress = {};
      let phaseStart = Date.now();
      let render = () => {
        let msg = nativeExportProgressMsg(target, progress);
        // Steps without their own progress (e.g. font downloads) show elapsed time instead.
        let secs = Math.floor((Date.now() - phaseStart) / 1000);
        if (secs >= 3 && progress.phase !== 'download' && progress.phase !== 'pack') msg += ` (${secs}s)`;
        if (msg === loading.msg) return;
        loading.msg = msg;
        d.update();
      };
      let onProgress = p => {
        if (p.phase !== progress.phase) phaseStart = Date.now();
        progress = p;
        render();
      };
      let ticker = setInterval(render, 1000);
      try {
        let blob;
        let filename;
        if (target === 'android-arm64') {
          blob = await exportAndroidApk(project, {
            name,
            onProgress,
            orientation: windowOpts.orientation,
            documentClassNames: windowOpts.documentClassNames,
            theme: windowOpts.theme ?? (windowOpts.systemTheme ? 'system' : 'none'),
          });
          filename = `${name}.apk`;
        } else {
          blob = await exportLinuxAppImage(project, {
            name,
            onProgress,
            width: windowOpts.width,
            height: windowOpts.height,
            startMaximized: windowOpts.startMaximized,
            rememberDimensions: windowOpts.rememberDimensions,
            borderless: windowOpts.borderless,
            dragAnywhere: windowOpts.dragAnywhere,
            resizable: windowOpts.resizable,
            documentClassNames: windowOpts.documentClassNames,
            theme: windowOpts.theme ?? (windowOpts.systemTheme ? 'system' : 'none'),
          });
          filename = `${name}-x86_64.AppImage`;
        }
        clearInterval(ticker);
        document.querySelector('dialog')?.remove?.();
        downloadBlob(blob, filename);
      } catch (err) {
        console.error(err);
        clearInterval(ticker);
        document.querySelector('dialog')?.remove?.();
        await showModal('InfoDialog', { title: `Native export failed: ${err.message}` });
      }
    },
  };
};

function nativeExportProgressMsg(target, { phase, loaded, total, percent }) {
  let mb = n => (n / 1048576).toFixed(0);
  let runtime = target === 'android-arm64' ? 'Android' : 'Linux';
  switch (phase) {
    case 'files': return 'Collecting project files...';
    case 'fonts': return 'Bundling fonts...';
    case 'compress': return 'Compressing project...';
    case 'download':
      if (!total) return `Downloading ${runtime} runtime... ${mb(loaded)} MB`;
      return `Downloading ${runtime} runtime... ${Math.floor((loaded / total) * 100)}% (${mb(loaded)} / ${mb(total)} MB)`;
    case 'build': return target === 'android-arm64' ? 'Adding project to APK...' : 'Building AppImage...';
    case 'pack': return `Compressing APK... ${Math.floor(percent ?? 0)}%`;
    case 'sign': return 'Signing APK...';
    default: return 'Exporting native app...';
  }
}

// Moving pages across folders shifts what their relative static srcs point at (see other/page-move.js).
async function rebaseMovedPages(project, path, newPath, isDir) {
  let moves = isDir
    ? (await rfiles.list(project)).filter(x => x.startsWith(newPath)).map(x => [path + x.slice(newPath.length), x])
    : [[path, newPath]];
  // A folder move takes the files it holds along, so references into it follow too.
  let mapTarget = isDir ? t => (t.startsWith(path) ? newPath + t.slice(path.length) : t) : undefined;
  for (let [from, to] of moves) {
    if (!to.endsWith('.html') || !from.startsWith('pages/') || !to.startsWith('pages/')) continue;
    let blob = await rfiles.load(project, to);
    if (!blob) continue;
    let html = await blob.text();
    let next = rebasePageUrls(html, from, to, mapTarget);
    if (next !== html) await rfiles.save(project, to, new Blob([next], { type: 'text/html' }));
  }
}

async function promptGitImportDialog(props = {}) {
  let [btn, detail] = await showModal('GitImportDialog', props);
  if (btn !== 'ok') return null;
  return detail || null;
}

async function importGitRepository(project, url, branch) {
  let dir = `/wf-git-import-${Date.now()}`;
  let fs = new LightningFS(`wf-git-import-${Math.random().toString(16).slice(2)}`, { wipe: true });
  let pfs = fs.promises;
  try {
    await pfs.mkdir(dir);
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }
  await git.clone({
    fs,
    http: gitHttp,
    dir,
    url,
    ref: branch,
    singleBranch: true,
    depth: 1,
    corsProxy: gitCorsProxy,
  });
  await persistGitFiles(project, pfs, dir, '');
  await rfiles.importGit(project, await collectGitEntries(pfs, `${dir}/.git`, '.git'));
}

async function collectGitEntries(pfs, fullPath, relativePath, entries = []) {
  let stat = await pfs.stat(fullPath);
  if (stat?.type === 'dir') {
    entries.push({ path: relativePath, dir: true });
    for (let x of await pfs.readdir(fullPath)) await collectGitEntries(pfs, `${fullPath}/${x}`, `${relativePath}/${x}`, entries);
  } else if (stat?.type === 'file') {
    entries.push({ path: relativePath, blob: new Blob([await pfs.readFile(fullPath)]) });
  }
  return entries;
}

async function persistGitFiles(project, pfs, currentDir, prefix) {
  let entries = await pfs.readdir(currentDir);
  for (let entry of entries) {
    if (entry === '.git') continue;
    let fullPath = currentDir === '/' ? `/${entry}` : `${currentDir}/${entry}`;
    let relativePath = prefix ? `${prefix}/${entry}` : entry;
    let stat = await pfs.stat(fullPath);
    if (stat?.type === 'file') {
      let data = await pfs.readFile(fullPath);
      // Repos made with older Webfoundry versions (the landing demos among them) carry its analytics tag.
      if (relativePath === 'index.html') data = stripClarity(new TextDecoder().decode(data));
      let blob = new Blob([data], { type: mimeLookup(relativePath) || 'application/octet-stream' });
      await rfiles.save(project, relativePath, blob);
    } else if (stat?.type === 'dir') {
      await persistGitFiles(project, pfs, fullPath, relativePath);
    }
  }
}

async function runGitImportFlow(project, repoUrl, branch) {
  await runImportFlow(project, `Importing ${branch}...`, () => importGitRepository(project, repoUrl, branch));
}

// No .git for these: the archives are snapshots, and the project can still be pushed to a new repo later.
async function runZipImportFlow(project, zipUrl) {
  await runImportFlow(project, 'Importing project...', async () => {
    let url = new URL(zipUrl, location.href);
    if (url.origin !== location.origin) throw new Error('Only archives from this site can be imported by URL.');
    let res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
    await rfiles.importZip(project, await res.blob());
    // Same analytics-tag cleanup git imports get in persistGitFiles.
    let index = await rfiles.load(project, 'index.html');
    if (index) await rfiles.save(project, 'index.html', new Blob([stripClarity(await index.text())], { type: 'text/html' }));
  });
}

async function runImportFlow(project, msg, importFn) {
  showModal('LoadingDialog', { msg });
  state.files.importing++;
  try {
    await importFn();
    if (state.projects.current === project) {
      // Close whatever was open (it may be stale now), then open pages/index.html once the refreshed list is in.
      await post('files.select', null);
      await post('designer.reset');
      state.files.autoSelectOnLoad = 'pages/index.html';
    }
    await post('files.reflect');
    await post('files.load');
  } finally {
    state.files.importing--;
    document.querySelector('dialog')?.remove?.();
  }
}

function deriveProjectNameFromZipUrl(zipUrl) {
  try {
    let last = new URL(zipUrl, location.href).pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(last.replace(/\.zip$/i, ''));
  } catch (err) {
    return '';
  }
}

function consumeGitImportParam(key = 'git') {
  try {
    let current = new URL(location.href);
    let value = current.searchParams.get(key);
    if (value == null) return null;
    current.searchParams.delete(key);
    history.replaceState(null, '', `${current.pathname}${current.search}${current.hash}`);
    return value;
  } catch (err) {
    console.error('Failed to parse gitimport param', err);
    return null;
  }
}

function parseGitImportParam(value) {
  let raw = value?.trim() || '';
  if (!raw) return { repoUrl: '', projectName: '' };
  if (raw.includes('::')) {
    let [maybeName, ...rest] = raw.split('::');
    let repo = rest.join('::').trim();
    return { repoUrl: repo || '', projectName: maybeName?.trim() || '' };
  }
  return { repoUrl: raw, projectName: '' };
}

async function ungzblob(blob, type) {
  if (blob == null) return null;
  return new Blob([pako.ungzip(new Uint8Array(await blob.arrayBuffer()))], { type });
}

function unb64(base64, type = '') {
  if (base64 == null) return null;
  let chars = atob(base64);
  let nums = new Array(chars.length);
  for (let i = 0; i < chars.length; i++) nums[i] = chars.charCodeAt(i);
  return new Blob([new Uint8Array(nums)], { type });
}

// Netlify deploys, shared by the Deploy dialog and the wf deploy command. The API key never
// leaves this browser: agents reach these through the IDE, which reads it from localStorage.
let NETLIFY_API = 'https://api.netlify.com/api/v1';

async function netlifyCreateSite(key, name) {
  let res = await fetch(`${NETLIFY_API}/sites`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.errors?.subdomain?.join?.(', ') || '' } catch {}
    throw new Error(`Couldn't create Netlify site "${name}" (${res.status}${detail ? `: ${detail}` : ''})`);
  }
  return await res.json();
}

// Accepts a site ID, a site name (foo) or its domain (foo.netlify.app, or a custom domain).
async function netlifyFindSite(key, site) {
  let headers = { Authorization: `Bearer ${key}` };
  let tries = [site];
  if (!site.includes('.') && !/^[0-9a-f-]{36}$/.test(site)) tries.push(`${site}.netlify.app`);
  for (let x of tries) {
    let res = await fetch(`${NETLIFY_API}/sites/${encodeURIComponent(x)}`, { headers });
    if (res.ok) return await res.json();
    if (res.status === 401) throw new Error('The stored Netlify API key was rejected.');
  }
  throw new Error(`Netlify site not found: ${site}`);
}

// Uploads a project ZIP and waits until Netlify reports the deploy ready (mode: production | preview).
async function netlifyUpload({ key, siteId, blob, mode = 'production', timeout = 300000 }) {
  let headers = { Authorization: `Bearer ${key}` };
  let uploadStart = Date.now();
  let deployId = null;
  let expectedContext = mode === 'preview' ? 'deploy-preview' : 'production';
  try {
    let url = `${NETLIFY_API}/sites/${siteId}/deploys${mode === 'preview' ? '?draft=true' : ''}`;
    let res = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/zip' }, body: blob });
    if (!res.ok) throw Object.assign(new Error(`Netlify deploy upload failed (${res.status})`), { upload: true });
    try {
      let payload = await res.json();
      deployId = payload?.id || payload?.deploy_id || null;
      if (payload?.context) expectedContext = payload.context;
    } catch {} // Unreadable response: find the deploy by listing below.
  } catch (err) {
    if (err.upload) throw err;
    // A network/CORS failure reading the response can still mean the upload went through.
    if (!err.message.includes('CORS')) console.error(err);
  }
  let recentEnough = createdAt => {
    let created = new Date(createdAt).getTime();
    return !createdAt || Number.isNaN(created) || created + 60000 >= uploadStart;
  };
  let matchesContext = deploy => {
    if (deploy.context) return deploy.context === expectedContext;
    return expectedContext === 'deploy-preview' ? deploy.published === false : deploy.published !== false;
  };
  let start = Date.now();
  while (Date.now() - start < timeout) {
    let deploy = null;
    if (deployId) {
      let res = await fetch(`${NETLIFY_API}/sites/${siteId}/deploys/${deployId}`, { headers }).catch(() => null);
      if (res?.ok) deploy = await res.json();
    } else {
      let res = await fetch(`${NETLIFY_API}/sites/${siteId}/deploys?per_page=10`, { headers }).catch(() => null);
      if (res?.ok) {
        let deploys = (await res.json()).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        deploy = deploys.find(x => matchesContext(x) && recentEnough(x.created_at)) || null;
      }
    }
    if (deploy?.state === 'error') throw Object.assign(new Error(deploy.error_message || 'Deploy failed'), { deploy });
    if (deploy?.state === 'ready') return deploy;
    await new Promise(pres => setTimeout(pres, 3000));
  }
  throw new Error('Deploy status check timed out');
}

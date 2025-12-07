import * as pako from 'https://esm.sh/pako';
import LightningFS from 'https://esm.sh/@isomorphic-git/lightning-fs';
import git from 'https://esm.sh/isomorphic-git';
import gitHttp from 'https://unpkg.com/isomorphic-git@beta/http/web/index.js';
import prettier from '../other/prettier.js';
import rfiles from '../repos/rfiles.js';
import rprojects from '../repos/rprojects.js';
import structuredFiles from '../other/structuredFiles.js';
import { debounce, joinPath, loadman } from '../other/util.js';
import { defaultCtrl, defaultHtml } from '../other/templates.js';
import { lookup as mimeLookup } from 'https://esm.sh/mrmime';
import { deriveProjectNameFromUrl, gitCorsProxy } from '../other/gitImport.js';

export default class Files {
  state = {
    list: [],
    expandedPaths: new Set(),
    gitImportQueryHandled: false,
    autoSelectOnLoad: null,

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
          let data = state.collab.uid === 'master'
            ? await rfiles.load(project, path)
            : await ungzblob(unb64(await post('collab.rpc', 'fetch', { project, path })), mimeLookup(path));
          if (!data) return callback({ type: 'fetch:res', project, path, status: 404, error: 'Not found' });
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
        let { type, project, path } = ev.data || {};
        if (type !== 'fetch') return;
        if (location.origin !== ev.origin) {
          let url = new URL(ev.origin);
          let parts = url.hostname.split('.');
          let domain = parts.slice(1).join('.');
          let project = parts[0];
          if (!/^webfoundry.app|webfoundry\d+\.netlify\.app|localhost$/.test(domain)) return;
          if (state.projects.current?.replaceAll?.(':', '-') !== project) return; // FIXME: Also check path.
        }
        if (!ev.source || typeof ev.source.postMessage !== 'function') return;
        await respond({ project, path }, payload => ev.source.postMessage(payload, ev.origin));
      });
      if (state.collab.uid !== 'master') return;
      bus.on('projects:select:ready', async ({ project }) => await loadman.run('files.projectSelect', async () => {
        this.state.list = [];
        this.state.expandedPaths = new Set(['pages/']);
        this.state.current = null;
        this.state.autoSelectOnLoad = project ? 'pages/index.html' : null;
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
      bus.on('files:create:ready', async ({ path }) => {
        await post('files.load');
        await post('files.select', path);
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
        bus.on(`companion:files:${x}`, ({ event, path }) => {
          let name = path.split('/')[0];
          let project = state.projects.list.find(x => x.startsWith(`${name}:`));
          if (!project) return;
          let storage = rprojects.storage(project);
          if (storage !== 'cfs') return;
          bus.emit(event.split(':').slice(1).join(':'), { path });
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
        let [btn] = await showModal('ConfirmationDialog', { title: 'Ya sure?' });
        if (btn !== 'yes') return;
        await post(v === 'local' ? 'files.push' : 'files.pull');
      });
    },

    load: debounce(async () => await loadman.run('files.load', async () => {
      let project = state.projects.current;
      let { bus } = state.event;
      bus.emit('files:load:start');
      let list = (await rfiles.list(project)).filter(x => !/(\..*\.sw.$|^index.html$|^wf.uiconfig.json$|^webfoundry\/)/.test(x));
      if (state.projects.current !== project) return bus.emit('files:load:abort');
      if (!list.includes(this.state.current)) await post('files.select', null);
      this.state.list = structuredFiles(list);
      bus.emit('files:load:ready');
    }), 500),

    select: async path => {
      if (state.collab.uid !== 'master') return;
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
      if (path?.endsWith?.('.html')) await new Promise((pres, prej) => {
        console.log(1);
        if (state.designer.list.find(x => x.path === path && x.ready)) { console.log(1.5); return pres() }
        state.event.bus.on('designer:select:ready', () => (console.log(2), pres()));
        state.event.bus.on('designer:select:error', () => (console.log(3), prej()));
      });
    },

    create: async (path, name, type = 'file') => {
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
          bus.emit('files:create:ready', { project, path: fullpath });
          return { success: true, note: `File created and selected (opened)` };
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
      await rfiles.mv(state.projects.current, path, newPath);
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
      let { bus } = state.event;
      let project = state.projects.current;
      bus.emit('files:reflect:start', { project });
      let files = await rfiles.list(project);
      let templates = {};
      for (let x of files.filter(x => x.endsWith('.html'))) templates[x] = await (await rfiles.load(project, x)).text();
      await rfiles.save(project, 'webfoundry/templates.json', new Blob([JSON.stringify(templates)], { type: 'application/json' }));
      let scripts = files.filter(x => x.endsWith('.js'));
      await rfiles.save(project, 'webfoundry/scripts.json', new Blob([JSON.stringify(scripts)], { type: 'application/json' }));
      bus.emit('files:reflect:ready', { project, templates, scripts });
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
      await rfiles.pull(project);
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
          let key = localStorage.getItem('webfoundry:netlifyApiKey');
          let [btn, x] = await showModal('NetlifyApiKeyDialog', { key });
          if (btn !== 'ok') continue;
          key = x;
          localStorage.setItem('webfoundry:netlifyApiKey', key);
          if (!key) return;
          continue;
        }
        if (btn !== 'ok') return;
        break;
      }
      deployMode = deployMode || 'production';
      showModal('LoadingDialog', { msg: 'Compressing files...' });
      const blob = await rfiles.exportZip(project);
      document.querySelector('dialog')?.remove?.();
      const headers = { Authorization: `Bearer ${key}` };
      if (type === 'new') {
        const res = await fetch('https://api.netlify.com/api/v1/sites', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: x }),
        });
        if (!res.ok) {
          await showModal('NetlifyPostDeployDialog', { success: false });
          return;
        }
        const json = await res.json();
        siteId = json.id;
      } else if (type === 'existing') {
        siteId = x;
      }
      localStorage.setItem(`webfoundry:netlifySiteId:${project}`, siteId);
      localStorage.setItem('webfoundry:netlifyDeployMode', deployMode);
      const uploadStart = Date.now();
      let uploadDeployId = null;
      let expectedContext = deployMode === 'preview' ? 'deploy-preview' : 'production';
      showModal('LoadingDialog', { msg: 'Deploying to Netlify...' });
      let uploadFailed = false;
      try {
        let uploadUrl = `https://api.netlify.com/api/v1/sites/${siteId}/deploys`;
        if (deployMode === 'preview') uploadUrl += '?draft=true';
        const res = await fetch(uploadUrl, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/zip' },
          body: blob,
        });
        if (!res.ok) {
          uploadFailed = true;
          throw new Error(`Netlify deploy upload failed (${res.status})`);
        }
        try {
          let payload = await res.json();
          uploadDeployId = payload?.id || payload?.deploy_id || uploadDeployId;
          if (payload?.context) expectedContext = payload.context;
        } catch (_) {
          /* ignore parse failures; we'll fall back to listing */
        }
      } catch (err) {
        if (!err.message.includes('CORS')) console.error(err);
        if (uploadFailed) {
          document.querySelector('dialog')?.remove?.();
          await showModal('NetlifyPostDeployDialog', { success: false, error: err.message });
          return;
        }
      }
      const recentEnough = createdAt => {
        if (!createdAt) return true;
        let created = new Date(createdAt).getTime();
        if (Number.isNaN(created)) return true;
        return created + 180000 >= uploadStart;
      };
      const matchesContext = deploy => {
        if (!deploy) return false;
        if (!expectedContext) return true;
        if (deploy.context) return deploy.context === expectedContext;
        if (expectedContext === 'deploy-preview') return deploy.published === false;
        if (expectedContext === 'production') return deploy.published !== false;
        return true;
      };
      const checkDeployStatus = async (timeout = 300000, interval = 3000) => {
        const start = Date.now();
        let warnedDetailFetch = false;
        while (Date.now() - start < timeout) {
          let deploy = null;
          if (uploadDeployId) {
            try {
              const detailRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/deploys/${uploadDeployId}`, { headers });
              if (detailRes.ok) deploy = await detailRes.json();
              if (deploy && deploy.context) expectedContext = deploy.context;
            } catch (err) {
              if (!warnedDetailFetch) console.warn('Failed to load Netlify deploy detail:', err);
              warnedDetailFetch = true;
            }
          }
          if (!deploy) {
            const res = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/deploys?per_page=10`, { headers });
            if (res.ok) {
              let deploys = await res.json();
              deploys.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
              deploy = deploys.find(item => matchesContext(item) && recentEnough(item?.created_at));
            }
          }
          if (deploy && !uploadDeployId && deploy.created_at) {
            let createdTime = new Date(deploy.created_at).getTime();
            if (!Number.isNaN(createdTime) && createdTime + 60000 < uploadStart) deploy = null;
          }
          if (deploy) {
            if (deploy.state === 'error') {
              let message = deploy.error_message || deploy.error_message_body || 'Deploy failed';
              let err = new Error(message);
              err.deploy = deploy;
              throw err;
            }
            if (deploy.state === 'ready') return deploy;
          }
          await new Promise(resolve => setTimeout(resolve, interval));
        }
        throw new Error('Deploy status check timed out');
      };
      try {
        let deploy = await checkDeployStatus();
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
      let query = consumeGitImportParam();
      if (!query) return;
      this.state.gitImportQueryHandled = true;
      let { repoUrl: presetUrl, projectName: presetName } = parseGitImportParam(query);
      let derivedName = presetName?.trim() || deriveProjectNameFromUrl(presetUrl) || '';
      if (state.app.demo && derivedName) {
        let existing = state.projects.list.find(x => x.startsWith(`${derivedName}:`));
        if (existing) {
          await post('projects.select', existing);
          return;
        }
      }
      let initialName = derivedName || 'imported-project';
      while (true) {
        let repoUrl = query;
        let branch = 'master';
        let projectName = initialName;
        if (!repoUrl || !branch || !projectName) {
          dialogProps = {
            ...dialogProps,
            initialUrl: repoUrl || '',
            initialBranch: branch || '',
            initialName: projectName || dialogProps.initialName,
            nameError: '',
          };
          continue;
        }
        if (state.projects.list.find(x => x.split(':')[0] === projectName)) {
          dialogProps = {
            ...dialogProps,
            initialUrl: repoUrl,
            initialBranch: branch,
            initialName: projectName,
            nameError: 'Project with this name already exists. Choose another name.',
          };
          continue;
        }
        let project;
        try {
          project = await post('projects.create', projectName);
        } catch (err) {
          console.error(err);
          await showModal('InfoDialog', { title: `Failed to create project: ${err.message}` });
          return;
        }
        if (!project) project = state.projects.list.find(x => x.startsWith(`${projectName}:`));
        try {
          await runGitImportFlow(project, repoUrl, branch);
        } catch (err) {
          console.error(err);
          await showModal('InfoDialog', { title: `Git import failed: ${err.message}` });
        }
        return;
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
  };
};

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
      let blob = new Blob([data], { type: mimeLookup(relativePath) || 'application/octet-stream' });
      await rfiles.save(project, relativePath, blob);
    } else if (stat?.type === 'dir') {
      await persistGitFiles(project, pfs, fullPath, relativePath);
    }
  }
}

async function runGitImportFlow(project, repoUrl, branch) {
  showModal('LoadingDialog', { msg: `Importing ${branch}...` });
  try {
    await importGitRepository(project, repoUrl, branch);
    //await post('files.injectBuiltins');
    //await post('files.reflect');
    //await post('files.load');
    document.querySelector('dialog')?.remove?.();
  } catch (err) {
    document.querySelector('dialog')?.remove?.();
    throw err;
  }
}

function consumeGitImportParam() {
  try {
    let current = new URL(location.href);
    let value = current.searchParams.get('git');
    current.searchParams.delete('git');
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

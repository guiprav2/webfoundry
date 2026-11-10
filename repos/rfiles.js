import JSZip from 'https://esm.run/jszip';
import lf from 'https://esm.run/localforage';
import rprojects from './rprojects.js';
import { lookup as mimeLookup } from 'https://esm.run/mrmime';

class FilesRepository {
  async list(project) {
    if (state.collab.uid !== 'master') return await post('collab.peerFile', 'list', project);
    let [name, uuid] = project.split(':');
    let storage = rprojects.storage(project);
    let list;
    switch (storage) {
      case 'local': {
        let ks = await lf.keys();
        let prefix = `webfoundry:projects:files:${uuid}:`;
        list = ks.filter(x => x.startsWith(prefix)).map(x => x.slice(prefix.length));
        break;
      }
      case 'cfs': list = (await post('companion.rpc', 'files:list', { path: name })).map(x => x.slice(name.length + 1)); break;
      default: throw new Error(`Unknown project storage: ${storage}`);
    }
    return list;
  }

  async save(project, path, blob) {
    if (state.collab.uid !== 'master') return await post('collab.peerFile', 'save', project, path, blob);
    let [name, uuid] = project.split(':');
    let storage = rprojects.storage(project);
    switch (storage) {
      case 'local': {
        let k = `webfoundry:projects:files:${uuid}:${path}`;
        let exists = await lf.getItem(k);
        await lf.setItem(k, blob);
        await post('broadcast.publish', `files:${exists ? 'change' : 'add'}`, { project, path: `${name}/${path}` });
        break;
      }
      case 'cfs': return await post('companion.rpc', 'files:save', { path: `${name}/${path}`, data: await b64(blob) });
      default: throw new Error(`Unknown project storage: ${storage}`);
    }
  }

  async load(project, path) {
    if (state.collab.uid !== 'master') return await post('collab.peerFile', 'load', project, path);
    let [name, uuid] = project.split(':');
    let storage = rprojects.storage(project);
    switch (storage) {
      case 'local': return await lf.getItem(`webfoundry:projects:files:${uuid}:${path}`);
      case 'cfs': return unb64(await post('companion.rpc', 'files:load', { path: `${name}/${path}` }), mimeLookup(path));
      default: throw new Error(`Unknown project storage: ${storage}`);
    }
  }

  async mv(project, path, newPath) {
    if (state.collab.uid !== 'master') return await post('collab.peerFile', 'mv', project, path, newPath);
    let [name, uuid] = project.split(':');
    let storage = rprojects.storage(project);
    switch (storage) {
      case 'local': {
        if (!path.endsWith('/')) {
          let blob = await lf.getItem(`webfoundry:projects:files:${uuid}:${path}`);
          await lf.setItem(`webfoundry:projects:files:${uuid}:${newPath}`, blob);
          await lf.removeItem(`webfoundry:projects:files:${uuid}:${path}`);
          await post('broadcast.publish', 'files:rm', { project, path: `${name}/${path}` });
          await post('broadcast.publish', 'files:add', { project, path: `${name}/${newPath}` });
        } else {
          for (let x of (await lf.keys()).filter(x => x.startsWith(`webfoundry:projects:files:${uuid}:${path}`))) {
            let y = x.replace(new RegExp(`^webfoundry:projects:files:${uuid}:${path}`), `webfoundry:projects:files:${uuid}:${newPath}`);
            let blob = await lf.getItem(x);
            await lf.setItem(y, blob);
            await lf.removeItem(x);
            await post('broadcast.publish', 'files:rm', { project, path: `${name}/${path}` });
            await post('broadcast.publish', 'files:add', { project, path: `${name}/${newPath}` });
          }
        }
        break;
      }
      case 'cfs': return await post('companion.rpc', 'files:mv', { path: `${name}/${path}`, newPath: `${name}/${newPath}` });
      default: throw new Error(`Unknown project storage: ${storage}`);
    }
  }

  async rm(project, path) {
    if (state.collab.uid !== 'master') return await post('collab.peerFile', 'rm', project, path);
    let [name, uuid] = project.split(':');
    let storage = rprojects.storage(project);
    switch (storage) {
      case 'local': {
        if (!path.endsWith('/')) lf.removeItem(`webfoundry:projects:files:${uuid}:${path}`);
        else for (let x of (await lf.keys()).filter(x => x.startsWith(`webfoundry:projects:files:${uuid}:${path}`))) await lf.removeItem(x);
        await post('broadcast.publish', 'files:rm', { project, path: `${name}/${path}` });
        break;
      }
      case 'cfs': return await post('companion.rpc', 'files:rm', { path: `${name}/${path}` });
      default: throw new Error(`Unknown project storage: ${storage}`);
    }
  }

  async importZip(project, blob) {
    let zip = await JSZip.loadAsync(blob);
    for (let [path, entry] of Object.entries(zip.files)) {
      if (path.endsWith('/')) continue;
      let fileBlob = await entry.async('blob');
      await this.save(project, path, new Blob([await fileBlob.arrayBuffer()], { type: mimeLookup(path) || 'application/octet-stream', }));
    }
  }

  async exportZip(project, extraFiles = {}) {
    let zip = new JSZip();
    for (let path of await this.list(project)) {
      if (/(^\.git\/|(^|\/)node_modules\/)/.test(path)) continue;
      zip.file(path, await this.load(project, path));
    }
    for (let [k, v] of Object.entries(extraFiles)) zip.file(k, v);
    return await zip.generateAsync({ type: 'blob' });
  }

  async push(project) {
    let [name, uuid] = project.split(':');
    for (let x of (await post('companion.rpc', 'files:list', { path: name })).map(x => x.slice(name.length + 1))) {
      await lf.setItem(`webfoundry:projects:files:${uuid}:${x}`, unb64(await post('companion.rpc', 'files:load', { path: `${name}/${x}` }), mimeLookup(x)));
      await post('broadcast.publish', 'files:add', { path: `${name}/${x}` });
    }
    await this.rmGit(project);
    let entries = (await post('companion.rpc', 'files:gitEntries', { path: name })).map(x => ({ ...x, path: x.path.slice(name.length + 1) }));
    for (let x of entries) {
      if (x.dir) continue;
      let blob = unb64(await post('companion.rpc', 'files:load', { path: `${name}/${x.path}` }));
      if (blob) await lf.setItem(`webfoundry:projects:git:${uuid}:${x.path}`, blob);
    }
    await lf.setItem(`webfoundry:projects:gitmeta:${uuid}`, entries);
    await post('companion.rpc', 'files:rm', { path: `${name}/` });
    return true;
  }

  // Repository data lives outside the files namespace so list() consumers (file tree, LLM tools, collab, zip export) never see it.
  async rmGit(project) {
    let uuid = project.split(':')[1];
    let prefix = `webfoundry:projects:git:${uuid}:`;
    for (let k of (await lf.keys()).filter(x => x.startsWith(prefix))) await lf.removeItem(k);
    await lf.removeItem(`webfoundry:projects:gitmeta:${uuid}`);
  }

  async pullGit(project) {
    let [name, uuid] = project.split(':');
    let entries = await lf.getItem(`webfoundry:projects:gitmeta:${uuid}`) || [];
    for (let x of entries.filter(x => x.dir)) await post('companion.rpc', 'files:mkdir', { path: `${name}/${x.path}` });
    for (let x of entries) {
      if (x.dir) continue;
      let blob = await lf.getItem(`webfoundry:projects:git:${uuid}:${x.path}`);
      if (blob) await this.writeGitFile(`${name}/${x.path}`, blob, x.mode);
    }
    await this.rmGit(project);
  }

  // Chunked because packs can exceed the WebSocket payload limit.
  async writeGitFile(path, blob, mode) {
    let chunkSize = 32 * 1024 * 1024;
    for (let i = 0; i === 0 || i < blob.size; i += chunkSize) {
      let last = i + chunkSize >= blob.size;
      await post('companion.rpc', 'files:save', { path, data: await b64(blob.slice(i, i + chunkSize)) ?? '', replace: i === 0, append: i > 0, mode: last ? mode : undefined });
    }
  }

  // Stores a .git obtained outside the file system (git import). entries: [{ path: '.git/...', dir: true } | { path, blob }].
  // Returns false without touching anything if the project already has a repository.
  async importGit(project, entries) {
    let [name, uuid] = project.split(':');
    let storage = rprojects.storage(project);
    switch (storage) {
      case 'local': {
        if ((await lf.getItem(`webfoundry:projects:gitmeta:${uuid}`))?.length) return false;
        for (let x of entries) if (x.blob) await lf.setItem(`webfoundry:projects:git:${uuid}:${x.path}`, x.blob);
        await lf.setItem(`webfoundry:projects:gitmeta:${uuid}`, entries.map(({ blob, ...x }) => x));
        return true;
      }
      case 'cfs': {
        if (await post('companion.rpc', 'files:stat', { path: `${name}/.git` })) return false;
        for (let x of entries.filter(x => x.dir)) await post('companion.rpc', 'files:mkdir', { path: `${name}/${x.path}` });
        for (let x of entries) if (x.blob) await this.writeGitFile(`${name}/${x.path}`, x.blob);
        return true;
      }
      default: throw new Error(`Unknown project storage: ${storage}`);
    }
  }

  async pull(project) {
    let [name, uuid] = project.split(':');
    if (await post('companion.rpc', 'files:stat', { path: `${name}/` })) {
      let [btn] = await showModal('ConfirmationDialog', { title: `${name}/ exists in workspace. Merge and overwrite?` });
      if (btn !== 'yes') return false;
    }
    let ks = await lf.keys();
    let prefix = `webfoundry:projects:files:${uuid}:`;
    let fks = ks.filter(x => x.startsWith(prefix)).map(x => x.slice(prefix.length));
    for (let x of fks) await post('companion.rpc', 'files:save', { path: `${name}/${x}`, data: await b64(await lf.getItem(`webfoundry:projects:files:${uuid}:${x}`)) });
    await this.pullGit(project);
    for (let x of fks) {
      await lf.removeItem(`webfoundry:projects:files:${uuid}:${x}`);
      await post('broadcast.publish', 'files:rm', { path: `${name}/${x}` });
    }
    return true;
  }
}

function b64(blob) {
  return new Promise((resolve, reject) => {
    let reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function unb64(base64, type = '') {
  if (base64 == null) return null;
  let chars = atob(base64);
  let nums = new Uint8Array(chars.length);
  for (let i = 0; i < chars.length; i++) nums[i] = chars.charCodeAt(i);
  return new Blob([nums], { type });
}

export default new FilesRepository();

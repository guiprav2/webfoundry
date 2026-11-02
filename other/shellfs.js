import rfiles from '../repos/rfiles.js';
import { debounce } from './util.js';

let reloadSidebar = debounce(() => {
  post('files.load');
}, 200);

export function projectFs() {
  function project() {
    let current = state.projects.current;
    if (!current) throw new Error('No project is open');
    return current;
  }
  return {
    async list() {
      return await rfiles.list(project());
    },
    async read(path) {
      let blob = await rfiles.load(project(), path);
      if (!blob) return null;
      return await blob.text();
    },
    async write(path, text) {
      await rfiles.save(project(), path, new Blob([text], { type: 'text/plain' }));
      reloadSidebar();
    },
    async remove(path) {
      await rfiles.rm(project(), path);
      reloadSidebar();
    },
    async move(path, newPath) {
      await rfiles.mv(project(), path, newPath);
      reloadSidebar();
    },
  };
}

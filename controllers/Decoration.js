import rfiles from '../repos/rfiles.js';
import { DECORATION_FILE, ifeval, framePost } from '../other/util.js';

let uid = prefix => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
let keyFromName = name => String(name ?? '').trim().replace(/[^\p{L}\p{N}]+(.)?/gu, (_, c) => (c || '').toUpperCase()).replace(/^[^\p{L}_$]+/u, '') || 'hook';
let splitClasses = cls => (Array.isArray(cls) ? cls.join(' ') : String(cls ?? '')).split(/\s+/).filter(Boolean);

export default class Decoration {
  state = {
    model: null,
    statuses: {},
    data: {},
    url: '',
    urlInput: '',
    extensionVersion: null,

    get frame() {
      let frame = state.designer.current;
      return frame?.decoration ? frame : null;
    },

    get selection() {
      let frame = this.frame;
      return (frame?.cursors?.[state.collab.uid] || []).map(id => {
        let el = frame.map.get(id);
        if (!el) return null;
        let owned = el.closest('[data-wf-owned]');
        let hooks = (el.getAttribute('data-wfd-hook') || '').split(' ').map(x => this.model?.hooks.find(y => y.id === x)).filter(Boolean);
        let added = [...new Set(hooks.flatMap(x => x.classes))];
        return {
          el,
          tag: el.tagName.toLowerCase(),
          kind: owned ? 'owned' : hooks.length ? 'hooked' : 'site',
          hook: hooks[0] ?? null,
          isOwnedRoot: owned === el,
          added,
          original: [...el.classList].filter(x => !added.includes(x)),
        };
      }).filter(Boolean);
    },

    get selected() {
      let { selection } = this;
      return selection.length === 1 ? selection[0] : null;
    },

    readOnlyClass(cls) {
      return this.selection.some(x => x.kind === 'site' || (x.kind === 'hooked' && !x.added.includes(cls)));
    },

    get canAddClass() {
      let { selection } = this;
      return !this.frame || (selection.length > 0 && selection.every(x => x.kind !== 'site'));
    },

    // Whether a toolbar action is invalid for the current selection. Always false outside decoration projects.
    blocked(key) {
      if (!this.frame) return false;
      return !actions[key] || actions[key].disabled?.({ cur: state.collab.uid })?.some(Boolean) === true;
    },
  };

  rpcs = new Map();

  send = (msg, frame = this.state.frame) => frame && framePost(frame, msg);

  pushConfig = (frame = this.state.frame) => this.send({ type: 'decorate:config', hooks: this.state.model.hooks, preview: !!frame?.preview }, frame);

  // One write at a time, and always the latest model.
  persist = () => {
    let project = state.projects.current;
    let text = `${JSON.stringify(this.state.model, null, 2)}\n`;
    if (text === this.lastText) return;
    this.lastText = text;
    this.saveChain = (this.saveChain || Promise.resolve())
      .then(() => rfiles.save(project, DECORATION_FILE, new Blob([text], { type: 'application/json' })))
      .catch(err => console.error('Decoration save failed:', err));
  };

  commit = () => {
    this.persist();
    this.pushConfig();
    d.update();
  };

  hook = id => this.state.model.hooks.find(x => x.id === id);

  // Runs a hook-model change as one undoable step. mutate(apply) does (apply=true) or undoes it.
  change = async (cur, mutate) => {
    await post('designer.pushHistory', cur, async apply => {
      mutate(apply);
      this.commit();
    });
  };

  selectedHooks = cur => {
    let frame = this.state.frame;
    let ids = (frame?.cursors?.[cur] || []).map(id => frame.map.get(id)?.getAttribute('data-wfd-hook')?.split(' ')[0]);
    return [...new Set(ids.filter(Boolean))].map(this.hook).filter(Boolean);
  };

  actions = {
    init: () => {
      addEventListener('message', async ev => {
        if (ev.source !== window || ev.origin !== location.origin || !ev.data?.wfDecorateBridge) return;
        let { type, rpcid, json } = ev.data;
        if (type === 'registered') return this.rpcs.get(rpcid)?.(ev.data);
        if (type !== 'up') return;
        let frame = this.state.frame || state.designer.list.find(x => x.decoration);
        if (frame) await this.actions.fromFrame(frame, JSON.parse(json));
      });
      state.event.bus.on('files:change', async ({ path }) => {
        let project = state.projects.current;
        if (!project || path !== `${project.split(':')[0]}/${DECORATION_FILE}` || !this.state.model) return;
        let text = await (await rfiles.load(project, DECORATION_FILE)).text();
        if (text === this.lastText) return;
        this.lastText = text;
        this.state.model = JSON.parse(text);
        this.pushConfig();
        d.update();
      });
    },

    // Asks the extension to allow this origin in this tab. False if it isn't installed.
    register: async origin => {
      let rpcid = crypto.randomUUID();
      let res = await new Promise(resolve => {
        let timer = setTimeout(() => resolve(null), 1500);
        this.rpcs.set(rpcid, data => { clearTimeout(timer); resolve(data) });
        window.postMessage({ wfDecorateBridge: true, type: 'register', rpcid, origin }, location.origin);
      });
      this.rpcs.delete(rpcid);
      this.state.extensionVersion = res?.ok ? res.version : null;
      return !!res?.ok;
    },

    // Prepares a decoration frame. Returns its descriptor, or null if the site can't be opened.
    open: async () => {
      let project = state.projects.current;
      let blob = await rfiles.load(project, DECORATION_FILE);
      let text = await blob.text();
      let model = JSON.parse(text);
      if (!await this.actions.register(model.origin)) {
        await showModal('InfoDialog', { title: 'Webfoundry Decorate extension required' });
        return null;
      }
      this.lastText = text;
      this.state.model = model;
      this.state.statuses = {};
      this.state.data = {};
      for (let hook of model.hooks) {
        hook.key ??= keyFromName(hook.name);
        hook.parent ??= null;
      }
      this.state.url = this.state.urlInput = model.origin + (model.startPath || '/');
      return { url: this.state.url };
    },

    // Only these frame messages are honored: the frame is another site, so its messages
    // can be forged and must never reach the general action dispatcher.
    fromFrame: async (frame, msg) => {
      switch (msg?.type) {
        case 'eval:res':
          dispatchEvent(new MessageEvent('message', { data: msg, origin: new URL(frame.el.src).origin }));
          break;
        case 'ready':
        case 'htmlsnap':
          await post('designer.frameMessage', { ...msg, path: frame.path });
          break;
        case 'keydown':
          if (!frame.preview) await post('designer.keydown', msg);
          break;
        case 'decorate:pick': {
          if (frame.preview || !msg.id) break;
          let cur = state.collab.uid;
          if (!document.hasFocus()) window.focus();
          let s = msg.shift ? [...new Set([...(frame.cursors[cur] || []), msg.id])] : [msg.id];
          await actions.changeSelection.handler({ cur, s });
          break;
        }
        case 'decorate:status':
          this.state.statuses = msg.statuses || {};
          d.update();
          break;
        case 'decorate:data':
          this.state.data = msg.data ?? {};
          d.update();
          break;
        case 'decorate:url':
          this.state.url = this.state.urlInput = String(msg.url);
          d.update();
          break;
        case 'decorate:owned': {
          let insert = this.hook(msg.hookId)?.inserts.find(x => x.id === msg.insertId);
          if (!insert || typeof msg.html !== 'string' || insert.html === msg.html) break;
          insert.html = msg.html;
          this.commit();
          break;
        }
      }
    },

    frameReady: frame => {
      // Every page load has new element ids; the next snapshot replaces the mirror.
      frame.newPage = true;
      frame.cursors = {};
      this.pushConfig(frame);
    },

    togglePreview: () => {
      let frame = this.state.frame;
      frame.preview = !frame.preview;
      this.send({ type: 'decorate:config', preview: frame.preview });
      d.update();
      return { success: true, note: frame.preview ? `Preview toggled on` : `Preview toggled off` };
    },

    navigate: async url => {
      let frame = this.state.frame;
      if (!frame) return;
      let target = new URL(url || this.state.urlInput, this.state.url).href;
      await ifeval(({ args }) => { location.href = args.target }, { target }).catch(() => {});
    },

    reload: () => ifeval(() => { location.reload() }, {}).catch(() => {}),

    // Hook dialog entry point: for the selected element, or for a hook picked from the list.
    editHook: async () => {
      let selected = this.state.selected;
      if (!selected) return;
      if (selected.kind === 'owned') return await showModal('InfoDialog', { title: `This element belongs to your project and doesn't need a hook.` });
      let frame = this.state.frame;
      let cur = state.collab.uid;
      let id = frame.cursors[cur][0];
      let existing = selected.hook;
      let describe = async parent => {
        let info = await ifeval(({ args }) => { return state.decorate.describe(state.map.get(args.id), args.parent) }, { id, parent });
        info.parents = info.parents.map(x => this.hook(x)).filter(Boolean).filter(x => x.id !== existing?.id).map(x => ({ id: x.id, key: x.key }));
        return info;
      };
      let [btn, spec] = await showModal('HookDialog', {
        info: await describe(existing ? existing.parent : undefined),
        hook: existing,
        describe,
        test: async (target, parent) => await ifeval(({ args }) => { return state.decorate.test(args.target, state.map.get(args.id), args.parent) }, { target, id, parent }).catch(err => ({ error: String(err), count: 0 })),
      });
      await ifeval(() => { state.decorate.clearHighlight() }, {}).catch(() => {});
      if (btn === 'remove') return await post('decoration.removeHook', existing.id);
      if (btn !== 'ok') return;
      if (existing) {
        let before = JSON.parse(JSON.stringify(existing));
        await this.change(cur, apply => Object.assign(existing, apply ? spec : before));
        return { success: true, hookId: existing.id };
      }
      let hook = { id: uid('hook'), classes: [], inserts: [], ...spec };
      await this.change(cur, apply => {
        let { hooks } = this.state.model;
        if (apply) hooks.push(hook);
        else hooks.splice(hooks.indexOf(hook), 1);
      });
      return { success: true, hookId: hook.id };
    },

    // Removing a parent hook removes the hooks scoped inside it.
    removeHook: async hookId => {
      if (!this.hook(hookId)) return;
      let { model } = this.state;
      let before = model.hooks;
      let doomed = new Set([hookId]);
      for (let grew = true; grew;) {
        grew = false;
        for (let x of before) if (doomed.has(x.parent) && !doomed.has(x.id)) { doomed.add(x.id); grew = true }
      }
      await this.change(state.collab.uid, apply => { model.hooks = apply ? before.filter(x => !doomed.has(x.id)) : before });
    },

    selectHook: async hookId => {
      let frame = this.state.frame;
      let id = await ifeval(({ args }) => {
        let el = state.decorate.firstMatch(args.hookId);
        return el ? state.map.getKey(el) : null;
      }, { hookId });
      if (id) await actions.changeSelection.handler({ cur: state.collab.uid, s: [id] });
      return frame;
    },

    insert: async (position, { cur = state.collab.uid, tag, html, i = 1 } = {}) => {
      let selected = this.state.selected;
      if (selected?.kind !== 'hooked') return { success: false, error: `Select a hooked element first.` };
      if (/Child$/.test(position) && selected.el.matches('area,base,br,col,embed,hr,img,input,link,meta,source,track,wbr')) return { success: false, error: `<${selected.tag}> can't have children.` };
      let { hook } = selected;
      let existingGhost = position === 'ghost' && hook.inserts.find(x => x.position === 'ghost');
      let tpl = document.createElement('template');
      tpl.innerHTML = html?.trim() ? html : `<${tag || 'div'} class="min-h-4"></${tag || 'div'}>`;
      for (let x of tpl.content.querySelectorAll('[data-wf-owned], [data-wfd-hook], [data-htmlsnap]')) ['data-wf-owned', 'data-wfd-hook', 'data-htmlsnap'].forEach(y => x.removeAttribute(y));
      let roots = Array.from({ length: i }, () => [...tpl.content.children].map(x => x.outerHTML)).flat();
      // "after" and "firstChild" each land next to the hook, which would reverse the order.
      if (position === 'after' || position === 'firstChild') roots.reverse();
      if (position === 'ghost') roots = roots.slice(0, 1);
      let inserts = existingGhost ? [existingGhost] : roots.map(x => ({ id: uid('el'), position, html: x }));
      if (!existingGhost) {
        await this.change(cur, apply => {
          if (apply) hook.inserts.push(...inserts);
          else hook.inserts = hook.inserts.filter(x => !inserts.includes(x));
        });
      }
      // The new node appears after the runtime applies the config and the mirror catches up.
      let last = position === 'after' || position === 'firstChild' ? inserts[0] : inserts.at(-1);
      let key = `${hook.id}/${last.id}`;
      for (let n = 0; n < 20; n++) {
        let id = await ifeval(({ args }) => {
          let el = state.decorate.firstOwned(args.key);
          return el ? state.map.getKey(el) : null;
        }, { key }).catch(() => null);
        if (id && this.state.frame.map.get(id)) {
          await actions.changeSelection.handler({ cur, s: [id] });
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return { success: true, hookId: hook.id, insertId: last.id };
    },

    // deleteSelected on the root of an owned element removes the insert from its hook.
    deleteSelectedInserts: async cur => {
      let frame = this.state.frame;
      let keys = (frame.cursors[cur] || []).map(id => frame.map.get(id)?.getAttribute('data-wf-owned')).filter(Boolean);
      let removed = keys.map(key => {
        let [hookId, insertId] = key.split('/');
        let hook = this.hook(hookId);
        let insert = hook?.inserts.find(x => x.id === insertId);
        return insert && { hook, insert, index: hook.inserts.indexOf(insert) };
      }).filter(Boolean);
      frame.cursors[cur] = [];
      await this.change(cur, apply => {
        for (let { hook, insert, index } of removed) {
          if (apply) hook.inserts.splice(hook.inserts.indexOf(insert), 1);
          else hook.inserts.splice(index, 0, insert);
        }
      });
      await post('designer.sync', frame);
      return { success: true };
    },

    addClasses: async (cur, cls) => {
      let hooks = this.selectedHooks(cur);
      let tokens = splitClasses(cls);
      if (tokens.some(x => x.startsWith('{{'))) return { success: false, error: `Expressions can't be added to hooked elements.` };
      let added = hooks.map(hook => [hook, tokens.filter(x => !hook.classes.includes(x))]);
      await this.change(cur, apply => {
        for (let [hook, list] of added) hook.classes = apply ? [...hook.classes, ...list] : hook.classes.filter(x => !list.includes(x));
      });
      return { success: true };
    },

    // Only ever touches classes the hook added; the site's own are read-only.
    removeClasses: async (cur, cls) => {
      let hooks = this.selectedHooks(cur);
      let tokens = splitClasses(cls);
      let prev = hooks.map(hook => [hook, hook.classes]);
      let refused = tokens.filter(x => !hooks.some(hook => hook.classes.includes(x)));
      await this.change(cur, apply => {
        for (let [hook, before] of prev) hook.classes = apply ? before.filter(x => !tokens.includes(x)) : before;
      });
      return refused.length ? { success: false, error: `Original classes are read-only: ${refused.join(' ')}` } : { success: true };
    },

    replaceClasses: async (cur, old, cls) => {
      let hooks = this.selectedHooks(cur);
      let tokens = splitClasses(cls);
      let matches = x => {
        if (old instanceof RegExp) return x.match(old);
        return splitClasses(old).includes(x);
      };
      let prev = hooks.map(hook => [hook, hook.classes]);
      await this.change(cur, apply => {
        for (let [hook, before] of prev) hook.classes = apply ? [...new Set([...before.filter(x => !matches(x)), ...tokens])] : before;
      });
      return { success: true };
    },
  };
}

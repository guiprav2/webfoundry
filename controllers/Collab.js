import * as pako from 'https://cdn.jsdelivr.net/npm/pako@3.0.3/+esm';
import RealtimeCollab from '../other/RealtimeCollab.js';
import actions from '../other/actions.js';
import diff from 'https://cdn.jsdelivr.net/npm/fast-diff@1.3.0/+esm';
import morphdom from 'https://cdn.jsdelivr.net/npm/morphdom@2.7.8/+esm';
import rfiles from '../repos/rfiles.js';
import { FitAddon } from 'https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/+esm';
import { ensureFrame, userAction, withPage } from '../other/shadowEditors.js';
import { Terminal } from 'https://cdn.jsdelivr.net/npm/xterm@5.3.0/+esm';
import { touchAgentCursor } from './Companion.js';

export default class Collab {
  state = {
    get uid() { return location.pathname !== '/collab.html' ? 'master' : this.rtc?.uid },
    ver: 0,
    rpcs: {},
    follow: true, // Peers view the host's page until they open another one.
    snaps: {}, // Peer: latest host snapshot per path, with the htmlsnap IDs commands resolve against.
    peerPages: {}, // Host: the page each peer that stopped following has open.
    sentPages: {}, // Host: what was last sent for each of those pages.
  };

  actions = {
    init: async () => {
      let { bus } = state.event;
      if (this.state.uid === 'master') {
        bus.on('projects:select:ready', async () => await post('collab.sync'));
        bus.on('files:select:ready', async () => await post('collab.sync'));
        bus.on('files:load:ready', async () => await post('collab.sync'));
        bus.on('designer:select:ready', async () => await post('collab.sync', 'full'));
        bus.on('designer:changeSelection:ready', async () => await post('collab.sync'));
        bus.on('designer:save:ready', async () => await post('collab.sync', 'delta'));
        bus.on('designer:resize:ready', async () => await post('collab.sync'));
        bus.on('designer:togglePreview:ready', async ({ preview }) => await post('collab.sync', !preview && 'full'));
        bus.on('shell:toggle:ready', () => setTimeout(async () => await post('collab.sync'), 1000));
        bus.on('shell:select:ready', async () => await post('collab.sync'));
        bus.on('shell:message:label', async () => await post('collab.sync'));
        bus.on('shell:message:stream', async ({ session, payload }) => this.state.rtc?.send?.({ type: 'shell:stream', session, payload }));
        bus.on('shell:close:ready', async () => await post('collab.sync'));
        ['settings:openaiKey:changed', 'settings:xaiKey:changed', 'settings:global:option:ready'].forEach(x => bus.on(x, async () => await post('collab.sync')));
      } else {
        let room = location.hash.slice(1);
        if (!room) { location.href = '/'; return }
        this.state.rtc = new RealtimeCollab(room);
        this.state.rtc.events.on('sync', async ev => await post('collab.apply', ev));
        this.state.rtc.events.on('page', async ev => await post('collab.applyPage', ev));
        this.state.rtc.events.on('agent:delta', async ev => await post('agent.remoteDelta', ev));
        this.state.rtc.events.on('agent:done', async ev => await post('agent.remoteDone', ev));
        this.state.rtc.events.on('agent:open', async ev => await post('collab.open', ev.path));
        this.state.rtc.events.on('rpc:response', async ev => await post('collab.rpcResponse', ev));
        this.state.rtc.events.on('presence:leave', async () => {
          await post('collab.leave');
          state.event.bus.emit('collab:presence:update', { presence: this.state.rtc.presence });
          if (!state.collab.rtc.presence.some(x => x.user === 'master')) { state.projects.current = null; state.files.list = []; this.state.sessionEnded = true; await post('agent.remoteDone', { error: 'The host left the session.' }) }
        });
        this.state.rtc.events.on('presence:update', async () => state.event.bus.emit('collab:presence:update', { presence: this.state.rtc.presence }));
        this.state.rtc.events.on('presence:join', async () => state.event.bus.emit('collab:presence:update', { presence: this.state.rtc.presence }));
        this.state.rtc.events.on('shell:stream', async ({ session, payload }) => state.shell.list.find(x => x.session === session)?.term?.write?.(simpleunb64(payload)));
        bus.on('designer:resize:ready', async () => await post('collab.resizeSync'));
      }
    },

    setup: async () => {
      let [btn, rtc] = await showModal('Collaborate');
      if (btn !== 'ok') return await rtc.teardown();
      this.state.rtc = rtc;
      rtc.events.on('presence:join', async () => { await post('collab.sync', 'full'); state.event.bus.emit('collab:presence:update', { presence: rtc.presence }) });
      rtc.events.on('presence:leave', async () => { await post('collab.leave'); state.event.bus.emit('collab:presence:update', { presence: rtc.presence }) });
      rtc.events.on('presence:update', async () => state.event.bus.emit('collab:presence:update', { presence: rtc.presence }));
      rtc.events.on('rpc:*', async ev => await post('collab.rpcInvoke', ev));
      rtc.events.on('changeSelection', async ev => await post('designer.changeSelection', ev.peer, ev.s.map(x => state.designer.current.map.get(x))));
      rtc.events.on('resize', async ev => { state.designer.frameWidth = ev.frameWidth; state.designer.frameHeight = ev.frameHeight; d.update() });
      rtc.events.on('cmd', async ev => {
        let cur = ev.cur?.startsWith?.(`${ev.peer}/`) ? ev.cur : ev.peer;
        touchAgentCursor(cur);
        let run = () => actions[ev.k].handler({ ...ev, cur });
        let page = this.state.peerPages[ev.peer];
        try { await (page ? withPage(page, run) : userAction(run)) }
        catch (err) { console.error(err) }
      });
      rtc.events.on('teardown', async () => await post('collab.leave'));
      rtc.events.on('agent:prompt', async ev => await post('agent.peerPrompt', ev));
      await post('collab.sync', 'full');
    },

    stop: () => {
      if (!this.state.rtc) return;
      this.state.rtc.teardown();
      this.state.rtc = null;
      state.event.bus.emit('collab:presence:update', { presence: [] });
    },

    rpc: async (proc, data = {}) => {
      let req = { type: null, rpcid: null, ...data, type: `rpc:${proc}`, rpcid: crypto.randomUUID() };
      this.state.rtc.send(req);
      let p = Promise.withResolvers();
      this.state.rpcs[req.rpcid] = { pres: p.resolve, prej: p.reject };
      return await p.promise;
    },

    rpcResponse: async ev => {
      if (ev.peer !== 'master') throw new Error(`RPC response spoof (not from master)`);
      if (!this.state.rpcs[ev.rpcid]) throw new Error(`Unknown RPCID: ${ev.rpcid}`);
      let rpc = this.state.rpcs[ev.rpcid];
      delete this.state.rpcs[ev.rpcid];
      if (ev.error) return rpc.prej(new Error(ev.error));
      rpc.pres(ev.data);
    },

    rpcInvoke: async ev => {
      try {
        let proc = ev.type.split(':')[1];
        let fn = this.rpcs[proc];
        if (!fn) throw new Error(`Unknown RPC: ${proc}`);
        this.state.rtc.send({ type: 'rpc:response', rpcid: ev.rpcid, data: await fn(ev) });
      } catch (err) {
        console.error(err);
        this.state.rtc.send({ type: 'rpc:response', rpcid: ev.rpcid, error: err.toString() });
      }
    },

    sync: async kind => {
      await post('designer.assignCursorColors', ['master', ...(this.state.rtc?.presence || []).map(x => x.user)]);
      let snap = state.designer.open ? state.designer.current.snap : '';
      // No session, nobody to send to: starting one (or a peer joining) sends a full sync anyway.
      if (!this.state.rtc) { this.state.lastSnap = snap; return; }
      this.state.ver++;
      let delta;
      if (kind === 'delta' && this.state.lastSnap) {
        let diffs = boundedDiff(this.state.lastSnap, snap);
        if (diffs) delta = await gzbase64(JSON.stringify(diffs));
      }
      this.state.lastSnap = snap;
      this.state.rtc?.send?.({
        type: 'sync',
        ver: this.state.ver,
        project: state.projects.current,
        files: state.files.list,
        expandedPaths: [...state.files.expandedPaths],
        current: state.files.current,
        frameWidth: state.designer.frameWidth,
        frameHeight: state.designer.frameHeight,
        followAgents: state.designer.followAgents,
        platformPreview: state.settings.opt.platformPreview,
        platformOs: state.settings.opt.platformOs,
        contents: kind === 'full' || (kind === 'delta' && !delta) ? snap : undefined,
        delta,
        cursors: state.designer.current?.cursors || {},
        cursorColors: state.designer.cursorColors,
        fadedCursors: state.designer.fadedCursors,
        agentAvailable: state.agent.available, // Only ever this boolean: API keys stay on the host.
        clipboards: state.designer.clipboards,
        shell: {
          open: state.shell.open,
          list: state.shell.list.map(x => ({
            session: x.session,
            label: x.label,
            cols: x.term.cols,
            rows: x.term.rows,
            msgbuf: kind === 'full' && x.msgbuf,
            active: state.shell.current === x.session,
          })),
        },
      });
      await post('collab.syncPages');
    },

    // Pages peers have open besides the host's current one, which the regular sync covers.
    syncPages: async () => {
      if (!this.state.rtc) return;
      for (let path of new Set(Object.values(this.state.peerPages))) {
        if (path === state.files.current) continue;
        let frame = state.designer.list.find(x => x.path === path);
        if (!frame?.snap) continue;
        let cursors = JSON.stringify([frame.cursors, state.designer.fadedCursors]);
        let sent = this.state.sentPages[path];
        if (sent?.snap === frame.snap && sent?.cursors === cursors) continue;
        this.state.sentPages[path] = { snap: frame.snap, cursors };
        this.state.rtc.send({ type: 'page', path, contents: sent?.snap !== frame.snap ? await gzbase64(JSON.stringify(frame.snap)) : undefined, cursors: frame.cursors, cursorColors: state.designer.cursorColors, fadedCursors: state.designer.fadedCursors });
      }
    },

    // Peer: file access goes through the host, which owns the project's storage.
    peerFile: async (op, project, path, arg) => {
      switch (op) {
        case 'list': return await post('collab.rpc', 'list', { project });
        case 'load':
          try { return await ungzblob(unb64(await post('collab.rpc', 'fetch', { project, path }))) }
          catch (err) { if (/Not found/.test(err.message)) return null; throw err }
        case 'save': return await post('collab.rpc', 'save', { project, path, data: await b64(await gzblob(arg)) });
        case 'rm': return await post('collab.rpc', 'rm', { project, path });
        case 'mv': return await post('collab.rpc', 'mv', { project, path, newPath: arg });
        default: throw new Error(`Unknown file operation: ${op}`);
      }
    },

    // Peer: opens any project file, independently of what the host has open.
    open: async path => {
      if (!path) return;
      let project = state.projects.current;
      if (path.endsWith('/')) {
        this.state.ownTree = true;
        if (state.files.expandedPaths.has(path)) state.files.expandedPaths.delete(path);
        else state.files.expandedPaths.add(path);
        return d.update();
      }
      let follow = path === this.state.hostCurrent;
      let page = await post('collab.rpc', 'openPage', { project, path, follow });
      this.state.follow = follow;
      state.files.current = path;
      await post('designer.select', path);
      state.event.bus.emit('files:select:ready', { project, path });
      if (page) await post('collab.applyPage', { path, contents: page.contents, cursors: page.cursors });
      d.update();
    },

    // Peer: a page frame (re)loaded, e.g. back from preview; show the host's latest edits.
    peerFrameReady: async frame => {
      let html = this.state.snaps[frame.path];
      if (!html || frame.preview || frame.decoration) return;
      frame.el?.contentWindow?.postMessage?.({ type: 'update', html }, new URL(frame.el.src).origin);
    },

    applyPage: async ev => {
      if (ev.contents) this.state.snaps[ev.path] = JSON.parse(await ungzbase64(ev.contents));
      if (ev.cursorColors) state.designer.cursorColors = ev.cursorColors;
      if (ev.fadedCursors) state.designer.fadedCursors = ev.fadedCursors;
      let frame = state.designer.current;
      if (ev.path !== state.files.current || !frame?.ready) return;
      if (ev.contents && !frame.preview) frame.el?.contentWindow?.postMessage?.({ type: 'update', html: this.state.snaps[ev.path] }, new URL(frame.el.src).origin);
      frame.cursors = ev.cursors;
      await post('designer.sync', frame);
      state.event.bus.emit('collab:apply:ready', { content: !!ev.contents });
    },

    resizeSync: async () => this.state.rtc?.send?.({ type: 'resize', frameWidth: state.designer.frameWidth, frameHeight: state.designer.frameHeight }),

    apply: async ev => {
      if (ev.ver <= this.state.ver) return;
      this.state.ver = ev.ver;
      if (ev.cursorColors) state.designer.cursorColors = ev.cursorColors;
      if (ev.fadedCursors) state.designer.fadedCursors = ev.fadedCursors;
      this.state.agentAvailable = !!ev.agentAvailable;
      state.projects.current = ev.project;
      state.files.list = ev.files;
      if (!this.state.ownTree) state.files.expandedPaths = new Set(ev.expandedPaths);
      this.state.hostCurrent = ev.current;
      if (this.state.follow && state.files.current !== ev.current) {
        state.files.current = ev.current;
        await post('designer.select', ev.current);
      }
      let onHostPage = state.files.current === ev.current;
      if (state.collab.uid !== 'master' && onHostPage) {
        state.event.bus.emit('files:select:ready', { project: ev.project, path: ev.current });
      }
      state.designer.frameWidth = ev.frameWidth;
      state.designer.frameHeight = ev.frameHeight;
      await post('designer.applyHostView', ev);
      let applyHtmlUpdate = async html => {
        this.state.snaps[ev.current] = html;
        // A peer previewing the page runs it live; it catches up when it returns to editing (peerFrameReady).
        if (onHostPage && !state.designer.current?.preview) state.designer.current?.el?.contentWindow?.postMessage?.({ type: 'update', html }, new URL(state.designer.current.el.src).origin);
      };
      if (ev.contents) {
        await applyHtmlUpdate(ev.contents);
        this.state.lastSnap = ev.contents;
      } else if (ev.delta) {
        let diffs = JSON.parse(await ungzbase64(ev.delta));
        let patched = applyFastDiff(this.state.lastSnap, diffs);
        await applyHtmlUpdate(patched);
        this.state.lastSnap = patched;
      }
      if (onHostPage && state.designer.open) {
        // FIXME
        /*
        if (JSON.stringify(ev.cursors[state.collab.uid]) !== JSON.stringify(state.designer.current.cursors[state.collab.uid]) && ev.cursors[state.collab.uid].length) {
          let first = state.designer.current.map.get(ev.cursors[state.collab.uid][0]);
          let rect = first.getBoundingClientRect();
          let visible = rect.top >= 20 && rect.bottom <= innerHeight - 20;
          !visible && first.scrollIntoView({ block: rect.height <= innerHeight ? 'center' : 'nearest', inline: rect.width <= innerWidth ? 'center' : 'nearest' });
        }
        */
        state.designer.current.cursors = ev.cursors;
        await post('designer.toggleMobileKeyboard');
      }
      state.designer.clipboards = ev.clipboards;
      if (ev.shell) {
        state.shell.open = ev.shell.open;
        while (state.shell.list.length > ev.shell.list.length) state.shell.list.pop();
        for (let [i, x] of ev.shell.list.entries()) {
          let y = state.shell.list[i];
          if (!y) state.shell.list.push(y = x);
          else { y.label = x.label; y.active = x.active }
          if (y.active) state.shell.current = y.session;
          if (y.term) continue;
          y.term = new Terminal({ cursorBlink: true, fontFamily: 'monospace', fontSize: 14, theme: { background: '#00000000', foreground: '#ffffff' } });
          y.term.resize(y.cols, y.rows);
          for (let z of y.msgbuf || []) y.term.write(simpleunb64(z));
        }
      }
      onHostPage && state.designer.open && await post('designer.sync', state.designer.current);
      state.event.bus.emit('collab:apply:ready', { content: onHostPage && !!(ev.contents || ev.delta) });
    },

    leave: async () => {
      if (this.state.uid !== 'master' && !state.collab.rtc.presence.some(x => x.user === 'master')) state.files.current = null;
      for (let k of Object.keys(this.state.peerPages)) if (!this.state.rtc?.presence?.find?.(x => x.user === k)) delete this.state.peerPages[k];
      if (this.state.uid === 'master') await post('agent.prunePeers');
      if (!state.designer.open) return;
      for (let k of Object.keys(state.designer.current.cursors)) {
        // Keys are a peer's uid, <uid>/agent:<id> for that peer's agents, or agent:<id> for the host's.
        let owner = k.split('/')[0];
        if (owner.startsWith('agent:') || owner === this.state.uid || this.state.rtc?.presence?.find?.(x => x.user === owner)) continue;
        state.designer.current.cursors[k] = []; // Emptied, not deleted: the iframe only drops overlays of keys it still sees.
      }
      await post('designer.sync', state.designer.current);
      this.state.uid === 'master' && await post('collab.sync');
    },
  };

  rpcs = {
    list: async ({ project }) => {
      if (state.projects.current !== project) throw new Error(`Wrong project: ${project}`);
      return await rfiles.list(project);
    },

    fetch: async ({ project, path }) => {
      if (state.projects.current !== project) throw new Error(`Wrong project: ${project}`);
      let blob = await rfiles.load(project, path);
      if (!blob) throw new Error(`Not found: ${path}`);
      return await b64(await gzblob(blob));
    },

    save: async ({ project, path, data }) => {
      if (state.projects.current !== project) throw new Error(`Wrong project: ${project}`);
      let blob = await ungzblob(await unb64(data));
      let isNew = !state.files.list.some(x => joinPath(x[1], x[0]) === path);
      await rfiles.save(project, path, blob);
      await post('codeEditor.externalWrite', { project, path, blob });
      if (isNew) await peerTreeChanged(path);
    },

    rm: async ({ project, path }) => {
      if (state.projects.current !== project) throw new Error(`Wrong project: ${project}`);
      await rfiles.rm(project, path);
      await peerTreeChanged(path);
    },

    mv: async ({ project, path, newPath }) => {
      if (state.projects.current !== project) throw new Error(`Wrong project: ${project}`);
      await rfiles.mv(project, path, newPath);
      await peerTreeChanged(path, newPath);
    },

    // A peer opened a file. HTML pages load as shadow editors here, so the host's own view doesn't change.
    openPage: async ({ peer, project, path, follow }) => {
      if (state.projects.current !== project) throw new Error(`Wrong project: ${project}`);
      if (follow || !path.endsWith('.html')) delete this.state.peerPages[peer];
      if (!path.endsWith('.html')) return null;
      let frame = await ensureFrame(path);
      for (let i = 0; i < 200 && !frame.snap; i++) await new Promise(pres => setTimeout(pres, 25));
      if (!follow) this.state.peerPages[peer] = path;
      return { contents: await gzbase64(JSON.stringify(frame.snap)), cursors: frame.cursors };
    },

    codeEditorState: async ({ project, path }) => {
      if (state.projects.current !== project) throw new Error(`Wrong project: ${project}`);
      return await post('codeEditor.exportState', { project, path });
    },
  };
}

// fast-diff costs roughly length x size of the change, so replacing a page root's markup could
// block the editor for minutes. Diff only what lies between the common prefix and suffix, and
// give up (null: send the full snapshot) when that middle is big.
let MAX_DIFF_MIDDLE = 8000;
function boundedDiff(a, b) {
  let max = Math.min(a.length, b.length);
  let pre = 0;
  while (pre < max && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < max - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  let midA = a.slice(pre, a.length - suf), midB = b.slice(pre, b.length - suf);
  if (midA.length + midB.length > MAX_DIFF_MIDDLE) return null;
  return [...(pre ? [[0, a.slice(0, pre)]] : []), ...diff(midA, midB), ...(suf ? [[0, a.slice(a.length - suf)]] : [])];
}

function applyFastDiff(oldText, diffs) {
  let out = '';
  for (let [op, data] of diffs) {
    if (op === 0) out += data;
    else if (op === 1) out += data;
  }
  return out;
}

async function gzbase64(str) {
  let blob = new Blob([pako.gzip(str)], { type: 'application/gzip' });
  return await b64(blob);
}

async function ungzbase64(b64str) {
  let binary = atob(b64str);
  let array = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(pako.ungzip(array));
}

async function gzblob(blob) {
  return new Blob([pako.gzip(new Uint8Array(await blob.arrayBuffer()))], { type: 'application/gzip' });
}

async function ungzblob(blob, type) {
  if (blob == null) return null;
  return new Blob([pako.ungzip(new Uint8Array(await blob.arrayBuffer()))], { type });
}

function b64(blob) {
  return new Promise((res, rej) => {
    let r = new FileReader();
    r.onloadend = () => res(r.result.split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

function unb64(base64, type = '') {
  if (base64 == null) return null;
  let chars = atob(base64);
  let nums = new Array(chars.length);
  for (let i = 0; i < chars.length; i++) nums[i] = chars.charCodeAt(i);
  return new Blob([new Uint8Array(nums)], { type });
}

let simpleunb64 = str => new TextDecoder().decode(Uint8Array.from(atob(str), c => c.charCodeAt(0)));

// Host: a peer created, moved or removed files. The host's own file actions refresh through
// bus events, but these RPCs bypass them; files:load:ready then syncs the new tree to peers.
async function peerTreeChanged(...paths) {
  await post('files.load');
  if (paths.some(x => x.endsWith('/') || /\.(html|js)$/.test(x))) await post('files.reflect');
}

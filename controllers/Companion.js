import EventEmitter from 'https://cdn.jsdelivr.net/npm/eventemitter2@6.4.9/+esm';
import rprojects from '../repos/rprojects.js';
import { userAction, withPage } from '../other/shadowEditors.js';

let AGENT_FADE_MS = 5 * 1000;
let AGENT_PRUNE_MS = 60 * 1000;
let agentSeen = new Map();
let identified = null;

export default class Companion {
  state = { pollDelay: 2000, pollTimeout: null, rpcs: {} };

  actions = {
    init: async () => {
      if (!this.state.wfListener) {
        this.state.wfListener = async ev => {
          let { id, command } = ev;
          try {
            let result = await execWfCommand(command);
            await post('companion.send', { type: 'wf:result', id, result });
          } catch (err) {
            await post('companion.send', { type: 'wf:result', id, error: err?.message || String(err) });
          }
        };
        state.event?.bus?.on?.('companion:wf:invoke', this.state.wfListener);
      }
      let reidentify = async () => {
        if (this.state.client?.status === 'connected' && identified !== currentProjectId()) await sendIdentify(this.state.client);
      };
      state.event?.bus?.on?.('projects:select:ready', reidentify);
      state.event?.bus?.on?.('collab:apply:ready', reidentify); // Collab peers follow the host's project without selecting it.
      if (state.collab.uid === 'master') setInterval(sweepAgentCursors, 1000);
      state.event.bus.on('settings:global:option:ready', async ({ k, v }) => {
        if (!k.startsWith('companion')) return;
        if (!v && this.state.client) {
          this.state.client.dispose();
          this.state.client = null;
        }
        await post('companion.poll');
      });
      await post('companion.poll');
    },

    // TODO: Replace with polling connection library
    poll: async () => {
      let next = () => {
        clearTimeout(this.state.pollTimeout);
        this.state.pollTimeout = setTimeout(() => post('companion.poll'), this.state.pollDelay);
      };
      if (!state.settings.opt.companion) return next();
      let client = createClient(state.settings.opt.companionKey);
      let ok = await new Promise(pres => {
        client.events.once('connected', () => pres(true));
        client.events.once('error', () => null); // prevent uncaught error
        setTimeout(() => pres(false), 2000);
      });
      if (!ok) { client.dispose(); return next() }
      if (this.state.client) return; // race
      this.state.client = client;
      client.events.on('message', async ev => await post('companion.message', ev));
      client.events.on('close', async () => {
        this.state.client = null;
        state.event.bus.emit('companion:disconnected');
        await post('companion.poll');
      });
      state.event.bus.emit('companion:connected');
      await sendIdentify(client);
    },

    send: data => {
      let { client } = this.state;
      if (client?.status !== 'connected') throw new Error(`Companion not connected`);
      client.send(data);
    },

    rpc: async (proc, data = {}) => {
      let req = { type: null, rpcid: null, ...data, type: `rpc:${proc}`, rpcid: crypto.randomUUID() };
      await post('companion.send', req);
      let p = Promise.withResolvers();
      this.state.rpcs[req.rpcid] = { pres: p.resolve, prej: p.reject };
      return await p.promise;
    },

    message: ev => {
      if (ev.type !== 'rpc:response') return state.event.bus.emit(`companion:${ev.type}`, ev);
      if (!this.state.rpcs[ev.rpcid]) throw new Error(`Unknown RPCID: ${ev.rpcid}`);
      let rpc = this.state.rpcs[ev.rpcid];
      delete this.state.rpcs[ev.rpcid];
      if (ev.error) return rpc.prej(new Error(ev.error));
      rpc.pres(ev.data);
    },

    copyKey: async ev => {
      await navigator.clipboard.writeText(state.settings.opt.companionKey);
      let label = ev.target.closest('button').children[1];
      label.classList.remove('hidden');
      clearTimeout(this.state.copyKeyTimeout);
      this.state.copyKeyTimeout = setTimeout(() => label.classList.add('hidden'), 2000);
    },
  };
};

function createClient(key, opt = {}) {
  opt.endpoint ??= 'ws://localhost:8845';
  opt.timeout ??= 5000;

  let ret = {
    events: new EventEmitter({ wildcard: true }),
    status: 'connecting',
  };

  let oemit = ret.events.emit;
  ret.events.emit = function (name, data) {
    try {
      return oemit.call(this, name, { event: null, ...(data || {}), event: name });
    } catch (err) {
      console.error(err);
    }
  };

  let ws = new WebSocket(opt.endpoint);
  ret.ws = ws;

  ret.send = data => ws.send(JSON.stringify(data));

  let handshakeTimeout = setTimeout(() => {
    if (ret.status !== 'connected') {
      ws.close();
      ret.events.emit('error', {
        error: new Error(`Handshake timeout after ${opt.timeout}ms`),
      });
    }
  }, opt.timeout);

  const clearHandshakeTimeout = () => {
    if (handshakeTimeout) {
      clearTimeout(handshakeTimeout);
      handshakeTimeout = null;
    }
  };

  ws.addEventListener('close', () => {
    clearHandshakeTimeout();
    ret.events.emit('close');
  });

  ws.addEventListener('message', ({ data }) => {
    try {
      data = JSON.parse(data);
    } catch {
      return ret.events.emit('error', {
        error: new Error('Received non-JSON or corrupted message'),
      });
    }

    if (data.type === 'handshake') {
      if (ret.status === 'connected') {
        return ret.events.emit('error', {
          error: new Error('Received unexpected handshake after connected'),
        });
      }

      if (data.status === 'error') {
        clearHandshakeTimeout();
        ws.close();
        return ret.events.emit('error', {
          error: new Error(`Companion handshake error: "${data.reason}"`),
        });
      }

      if (data.status === 'hello') {
        ret.status = 'handshake';
        if (data.agent !== 'webfoundry-companion') {
          clearHandshakeTimeout();
          ws.close();
          return ret.events.emit('error', {
            error: new Error(`Unexpected companion agent: "${data.agent}"`),
          });
        }
        ret.send({ type: 'handshake', key });
        return;
      }

      if (data.status === 'ok') {
        clearHandshakeTimeout();
        ret.status = 'connected';
        ws.addEventListener('error', ev => 
          ret.events.emit('error', { error: new Error(`WebSocket error`) }));
        ret.events.emit('connected');
        return;
      }
    }

    ret.events.emit('message', data);
  });

  ret.dispose = () => {
    clearHandshakeTimeout();
    ws?.close?.();
  };

  return ret;
}

let PAGE_EDIT_COMMANDS = new Set([
  'wrap', 'unwrap', 'deleteSelected', 'changeElementTag', 'addCssClasses', 'removeCssClasses', 'replaceCssClasses',
  'replaceTextContent', 'changeInputPlaceholder', 'changeLinkUrl', 'changeMediaSrc', 'setInputValue',
  'setIfExpression', 'setMapExpression', 'setDisabledExpression', 'changeElementId', 'changeHtml', 'changeInnerHtml',
  'changeFormMethod', 'createFirstChild', 'createLastChild', 'createNextSibling', 'createPrevSibling',
  'pasteFirstChild', 'pasteLastChild', 'pasteNextSibling', 'pastePrevSibling', 'toggleHidden',
  'setEventHandlers', 'addEventHandlers', 'removeEventHandlers',
]);

let PAGE_TARGETED_COMMANDS = new Set([...PAGE_EDIT_COMMANDS, 'readHtml', 'changeSelection', 'toggleSelection', 'copySelected', 'getPageTitle', 'setPageTitle']);

// Commands that change what the host sees; a collaborator's agent mustn't run them on the host.
let HOST_VIEW_COMMANDS = new Set(['listInstances', 'openProject', 'createProject', 'openInstance', 'setPagePreview', 'setPlatformPreview', 'setPlatformOs']);

// peerAgent: the command comes from an agent a collaborator is driving through this host. It works
// on that collaborator's page instead of the host's: { page(), selectFile(path), createFile(path) }.
export async function execWfCommand(command, { peerAgent } = {}) {
  if (peerAgent) {
    if (HOST_VIEW_COMMANDS.has(command?.name)) return { success: false, error: `${command.name} isn't available to a collaborator's agent.` };
    if (command?.name === 'selectFile') return await peerAgent.selectFile(command.params.path);
    if (command?.name === 'createFile') {
      let result = await peerAgent.createFile(command.params.path);
      if (!result?.success || !command.params.select) return result;
      let selected = await peerAgent.selectFile(command.params.path);
      return selected?.success === false ? selected : { ...result, selected: true };
    }
    let peerPage = peerAgent.page();
    if (peerPage && command?.params?.page == null && PAGE_TARGETED_COMMANDS.has(command?.name)) command = { ...command, params: { ...command.params, page: peerPage } };
  }
  let { page, target, ...params } = command?.params ?? {};
  if (PAGE_EDIT_COMMANDS.has(command?.name) && !target?.length) return { success: false, error: `This command requires --target <data-htmlsnap ids>. Get the ids from wf read-html.` };
  if (params.cur != null) params.cur = scopedCursor(params.cur);
  if (page != null && !PAGE_TARGETED_COMMANDS.has(command.name)) return { success: false, error: `${command.name} doesn't accept --page.` };
  if (page != null && isPeer()) return { success: false, error: `Collab peers can't target pages yet.` };
  if (target != null && params.cur == null) return { success: false, error: `${command.name} doesn't accept --target.` };
  let scoped = { ...command, params };
  let run = async () => {
    if (target != null) {
      let selected = await runSynced({ name: 'changeSelection', params: { ids: target, cur: params.cur } });
      if (!selected.success) return selected;
      if (selected.missingIds?.length) return { success: false, error: `data-htmlsnap not found: ${selected.missingIds.join(', ')}. Run wf read-html to refresh the snapshot.` };
    }
    return await runSynced(scoped);
  };
  if (page == null) return await userAction(run);
  try {
    return await withPage(page, run);
  } catch (err) {
    return { success: false, error: err?.message || String(err) };
  }
}

let isPeer = () => state.collab.uid !== 'master';

// On a collab peer, an agent's cursor lives under the peer's uid so the host can tell whose it is.
function scopedCursor(cur) {
  if (isPeer()) return cur === 'master' ? state.collab.uid : `${state.collab.uid}/${cur}`;
  touchAgentCursor(cur);
  return cur;
}

let isAgentCursor = k => /(^|\/)agent:/.test(k);

// Host only: marks an agent as active, bringing its cursor back right away if it had faded.
export function touchAgentCursor(cur) {
  if (isPeer() || !isAgentCursor(cur)) return;
  agentSeen.set(cur, Date.now());
  if (state.designer.fadedCursors.includes(cur)) sweepAgentCursors();
}

function nextEvent(name, ms, test = () => true) {
  return new Promise(pres => {
    let { bus } = state.event;
    let done = ev => { if (!test(ev)) return; clearTimeout(timer); bus.off(name, done); pres() };
    let timer = setTimeout(() => { bus.off(name, done); pres() }, ms);
    bus.on(name, done);
  });
}

// A peer's edits run on the host and come back in a sync, so wait for it before reporting
// the result. Otherwise the next wf command would find the selection it just made missing.
async function runSynced(command) {
  let edit = PAGE_EDIT_COMMANDS.has(command.name);
  if (!isPeer() || (!edit && command.name !== 'changeSelection' && command.name !== 'toggleSelection')) return await runWfCommand(command);
  let { ids, cur } = command.params;
  let applied = command.name === 'changeSelection' ? () => ids.every(x => currentSelectionIds(cur).includes(x)) : ev => !edit || ev.content;
  let synced = nextEvent('collab:apply:ready', 3000, applied); // Syncs about other changes arrive too.
  let result = await runWfCommand(command);
  if (result?.success === false) return result;
  await synced;
  let selection = currentSelectionIds(command.params.cur);
  result.selectedIds = selection;
  if ('createdIds' in result) result.createdIds = selection;
  if (command.name === 'changeSelection') result.missingIds = command.params.ids.filter(x => !selection.includes(x));
  return result;
}

// Agents don't say when they're done, so their cursors fade once they go quiet and are dropped soon after.
async function sweepAgentCursors() {
  let now = Date.now();
  let faded = new Set();
  let pruned = new Set();
  let changed = new Set();
  for (let frame of state.designer.list) {
    for (let k of Object.keys(frame.cursors)) {
      if (!isAgentCursor(k)) continue;
      if (!agentSeen.has(k)) agentSeen.set(k, now);
      let idle = now - agentSeen.get(k);
      if (idle > AGENT_PRUNE_MS) {
        delete frame.cursors[k];
        pruned.add(k);
        changed.add(frame);
      } else if (idle > AGENT_FADE_MS) {
        faded.add(k);
      }
    }
  }
  for (let k of pruned) agentSeen.delete(k);
  let list = [...faded].sort();
  let fadeChanged = JSON.stringify(list) !== JSON.stringify(state.designer.fadedCursors);
  state.designer.fadedCursors = list;
  if (!fadeChanged && !changed.size) return;
  for (let frame of fadeChanged ? state.designer.list : changed) if (frame.ready) await post('designer.sync', frame);
  await post('collab.sync');
}

async function runWfCommand(command) {
  if (!command || typeof command !== 'object') throw new Error('Invalid command payload.');
  let { name, params = {} } = command;
  if (!name) throw new Error('Command name missing.');
  let actions = window.actions;
  let cur = params.cur ?? 'master';
  // The preview iframe doesn't run the designer bridge, so edits would just hang until timeout.
  if (PAGE_EDIT_COMMANDS.has(name) && state.designer.target?.ready && state.designer.target.preview) {
    return { success: false, error: `Can't edit in preview mode. Switch back with: wf set-page-preview edit` };
  }
  switch (name) {
    case 'listInstances': {
      try {
        return { success: true, instances: await post('companion.rpc', 'wf:instances') };
      } catch (err) {
        return { success: false, error: err?.message || String(err) };
      }
    }
    case 'listProjects': {
      let open = state.projects.current;
      let projects = isPeer()
        ? (open ? [{ name: open.split(':')[0], storage: 'collab', open: true }] : [])
        : state.projects.list.map(x => ({ name: x.split(':')[0], storage: rprojects.storage(x), open: x === open }));
      return { success: true, id: instanceId(), collab: isPeer(), projects };
    }
    case 'openProject': {
      if (isPeer()) return { success: false, error: `Collab instances follow the host's project.` };
      let project = state.projects.list.find(x => x.split(':')[0] === params.name);
      if (!project) return { success: false, error: `Project not found: ${params.name}` };
      if (project !== state.projects.current) {
        let loaded = nextEvent('files:load:ready', 5000);
        await post('projects.select', project);
        await loaded;
      }
      return { success: true, project: params.name };
    }
    case 'createProject': {
      if (isPeer()) return { success: false, error: `Can't create projects on a collab instance.` };
      if (!/^[\w-][\w.-]*$/.test(params.name)) return { success: false, error: `Invalid project name: ${params.name}` };
      if (state.projects.list.some(x => x.split(':')[0] === params.name)) return { success: false, error: `Project already exists: ${params.name}` };
      let loaded = nextEvent('files:load:ready', 30000);
      await post('projects.create', params.name);
      await loaded;
      return { success: true, project: params.name };
    }
    case 'openInstance': {
      let url = params.url || `${location.origin}/editor.html`;
      window.open(url, '_blank');
      return { success: true, url, instance: null };
    }
    case 'listEditors': {
      let editors = state.designer.list.map(x => ({
        path: x.path,
        active: x.path === state.files.current,
        shadow: !!x.shadow,
        ready: !!x.ready,
        preview: !!x.preview,
        cursors: Object.keys(x.cursors).filter(k => x.cursors[k]?.length),
      }));
      return { success: true, editors };
    }
    case 'readHtml': {
      if (!state.designer.target?.ready) return { success: false, error: `Designer closed`, hint: `Use selectFile to open the desired HTML file for editing first` };
      // A peer's iframe has its own htmlsnap IDs; the host's snapshot has the ones commands resolve against.
      if (isPeer() && state.collab.snaps[state.files.current]) return { success: true, html: state.collab.snaps[state.files.current] };
      return { success: true, html: snapshotHtml() };
    }
    case 'changeSelection': {
      let ids = params.ids;
      if (!Array.isArray(ids) || !ids.length) throw new Error('ids must be a non-empty array');
      let action = actions.changeSelection;
      let payload = { cur, s: ids };
      let reasons = action.disabled?.(payload)?.filter?.(Boolean) || [];
      if (reasons.length) {
        let lines = reasons.map(x => `- ${x}`);
        if (reasons.some(x => typeof x === 'string' && x.includes('Designer closed'))) {
          lines.push('Hint: use selectFile to open the desired HTML for editing');
        }
        return { success: false, error: lines.join('\n') };
      }
      let res = await action.handler(payload);
      let selection = currentSelectionIds(cur);
      return {
        success: res?.success !== false,
        selectedIds: res?.selectedIds ?? selection,
        missingIds: res?.missingIds ?? [],
      };
    }
    case 'isPlatformPreview': {
      let action = actions.isPlatformPreview;
      let result = await action.handler(params);
      if (result !== undefined) return result;
      return { success: true, mode: state.designer.platformForm };
    }
    case 'isPlatformOs': {
      let result = await actions.isPlatformOs.handler(params);
      return result ?? { success: true, os: state.designer.platformOs };
    }
    case 'setPlatformOs': {
      let action = actions.setPlatformOs;
      let os = typeof params.os === 'string' ? params.os.trim().toLowerCase() : params.os;
      if (!['web', 'win', 'lin', 'mac', 'android'].includes(os)) {
        return { success: false, error: 'os must be web, win, lin, mac, or android' };
      }
      try {
        let result = await action.handler({ os });
        return result === undefined ? { success: true, os } : result;
      } catch (err) {
        return { success: false, error: err?.message || String(err) };
      }
    }
    case 'deploy':
    case 'deployInfo':
    case 'getProjectTitle':
    case 'setProjectTitle':
    case 'getPageTitle':
    case 'setPageTitle':
    case 'isPagePreview':
    case 'setPagePreview': {
      let action = actions[name];
      let reasons = action.disabled?.(params)?.filter?.(Boolean) || [];
      if (reasons.length) {
        let lines = reasons.map(x => `- ${x}`);
        if (reasons.some(x => typeof x === 'string' && x.includes('Designer closed'))) {
          lines.push('Hint: use selectFile to open the desired HTML first');
        }
        return { success: false, error: lines.join('\n') };
      }
      try {
        return await action.handler(params);
      } catch (err) {
        return { success: false, error: err?.message || String(err) };
      }
    }
    case 'setPlatformPreview': {
      let action = actions.setPlatformPreview;
      let mode = params.mode;
      if (typeof mode === 'string') mode = mode.trim().toLowerCase();
      if (!['off', 'desktop', 'mobile'].includes(mode)) {
        return { success: false, error: 'mode must be off, desktop, or mobile' };
      }
      let reasons = action.disabled?.({ mode })?.filter?.(Boolean) || [];
      if (reasons.length) return { success: false, error: reasons.map(x => `- ${x}`).join('\n') };
      let result = await action.handler({ mode });
      return result === undefined ? { success: true, mode } : result;
    }
    case 'selectFile': {
      let action = actions[name];
      let reasons = action.disabled?.(params)?.filter?.(Boolean) || [];
      if (reasons.length) {
        let lines = reasons.map(x => `- ${x}`);
        return { success: false, error: lines.join('\n') };
      }
      let result = await action.handler(params);
      return result === undefined ? { success: true } : result;
    }
    case 'createFile': {
      let action = actions[name];
      let reasons = action.disabled?.(params)?.filter?.(Boolean) || [];
      if (reasons.length) {
        let lines = reasons.map(x => `- ${x}`);
        if (reasons.some(x => typeof x === 'string' && x.includes('Designer closed'))) {
          lines.push('Hint: use selectFile to open the desired HTML for editing');
        }
        return { success: false, error: lines.join('\n') };
      }
      let result = await action.handler(params);
      return result === undefined ? { success: true } : result;
    }
    case 'toggleSelection':
    case 'wrap':
    case 'unwrap':
    case 'deleteSelected':
    case 'changeElementTag':
    case 'addCssClasses':
    case 'removeCssClasses':
    case 'replaceCssClasses':
    case 'replaceTextContent':
    case 'changeInputPlaceholder':
    case 'changeLinkUrl':
    case 'changeMediaSrc':
    case 'setInputValue':
    case 'setIfExpression':
    case 'setMapExpression':
    case 'setDisabledExpression':
    case 'changeElementId':
    case 'copySelected':
    case 'changeHtml':
    case 'changeInnerHtml':
    case 'changeFormMethod': {
      let action = actions[name];
      let payload = { ...params, cur };
      let reasons = action.disabled?.(payload)?.filter?.(Boolean) || [];
      if (reasons.length) {
        let lines = reasons.map(x => `- ${x}`);
        if (reasons.some(x => typeof x === 'string' && x.includes('Designer closed'))) {
          lines.push('Hint: use selectFile to open the desired HTML for editing');
        }
        return { success: false, error: lines.join('\n') };
      }
      let result = await action.handler(payload);
      return buildDesignerResponse(result, cur);
    }
    case 'createFirstChild':
    case 'createLastChild':
    case 'createNextSibling':
    case 'createPrevSibling':
    case 'pasteFirstChild':
    case 'pasteLastChild':
    case 'pasteNextSibling':
    case 'pastePrevSibling': {
      let action = actions[name];
      let payload = { ...params, cur };
      let reasons = action.disabled?.(payload)?.filter?.(Boolean) || [];
      if (reasons.length) {
        let lines = reasons.map(x => `- ${x}`);
        if (reasons.some(x => typeof x === 'string' && x.includes('Designer closed'))) {
          lines.push('Hint: use selectFile to open the desired HTML for editing');
        }
        return { success: false, error: lines.join('\n') };
      }
      let result = await action.handler(payload);
      let base = buildDesignerResponse(result, cur);
      if (!base.createdIds || !base.createdIds.length) {
        base.createdIds = inferCreatedIds(cur);
      }
      return base;
    }
    case 'toggleHidden': {
      let action = actions[name];
      {
        let payload = { ...params, cur };
        let reasons = action.disabled?.(payload)?.filter?.(Boolean) || [];
        if (reasons.length) {
          let lines = reasons.map(x => `- ${x}`);
          if (reasons.some(x => typeof x === 'string' && x.includes('Designer closed'))) {
            lines.push('Hint: use selectFile to open the desired HTML for editing');
          }
          return { success: false, error: lines.join('\n') };
        }
        await action.handler(payload);
      }
      let selection = currentSelectionIds(cur);
      let el = firstSelectedElement(cur);
      let hidden = !!el?.hasAttribute?.('hidden');
      return { success: true, selectedIds: selection, hidden };
    }
    case 'setEventHandlers':
    case 'addEventHandlers':
    case 'removeEventHandlers': {
      let action = actions[name];
      let payload = { ...params, cur };
      let reasons = action.disabled?.(payload)?.filter?.(Boolean) || [];
      if (reasons.length) {
        let lines = reasons.map(x => `- ${x}`);
        if (reasons.some(x => typeof x === 'string' && x.includes('Designer closed'))) {
          lines.push('Hint: use selectFile to open the desired HTML for editing');
        }
        return { success: false, error: lines.join('\n') };
      }
      let result = await action.handler(payload);
      let base = buildDesignerResponse(result, cur);
      base.handlers = result?.handlers ?? getEventHandlersFromSelection(cur);
      return base;
    }
    default:
      throw new Error(`Unknown wf command: ${name}`);
  }
}

async function sendIdentify(client) {
  try {
    let projectId = currentProjectId();
    await post('companion.send', { type: 'identify', kind: 'webfoundry', projectId, instanceId: instanceId(), collab: isPeer(), origin: location.origin });
    identified = projectId;
  } catch (err) {
    console.error('Failed to send identify message:', err);
  }
}

function instanceId() {
  return sessionStorage.webfoundryTabId ??= crypto.randomUUID();
}

function currentProjectId() {
  let raw = state.projects?.current;
  if (!raw) return 'default';
  let name = raw.split(':')[0];
  return name || 'default';
}

function snapshotHtml() {
  try {
    let frame = state.designer.scoped;
    if (frame) {
      let doc = new DOMParser().parseFromString('<!doctype html><head></head><body><div></div></body>', 'text/html');
      doc.head.innerHTML = frame.head.innerHTML;
      doc.body.firstElementChild.outerHTML = frame.root.outerHTML;
      return doc.documentElement.outerHTML;
    }
    return state.assistant?.doc?.documentElement?.outerHTML ?? '';
  } catch (err) {
    console.error(err);
    return '';
  }
}

function currentSelectionIds(cur = 'master') {
  let frame = state.designer.target;
  let ids = frame?.cursors?.[cur];
  return ids ? [...ids] : [];
}

function firstSelectedElement(cur = 'master') {
  let frame = state.designer.target;
  let key = frame?.cursors?.[cur]?.[0];
  return key ? frame.map.get(key) : null;
}

function getEventHandlersFromSelection(cur = 'master') {
  let el = firstSelectedElement(cur);
  if (!el) return [];
  let handlers = [];
  for (let attr of el.attributes) {
    if (attr.name.startsWith('wf-on')) handlers.push({ name: attr.name.slice(5), expr: attr.value });
  }
  return handlers;
}

function buildDesignerResponse(result, cur, extra = {}) {
  let selection = currentSelectionIds(cur);
  let response = { success: result?.success !== false, selectedIds: result?.selectedIds ?? selection, ...extra };
  if (result?.expr != null) response.expr = result.expr;
  if (result?.handlers) response.handlers = result.handlers;
  if (result?.missingIds) response.missingIds = result.missingIds;
  if (result?.createdIds) response.createdIds = result.createdIds;
  return response;
}

function inferCreatedIds(cur) {
  let frame = state.designer.target;
  if (!frame) return [];
  return frame.cursors?.[cur] ? [...frame.cursors[cur]] : [];
}

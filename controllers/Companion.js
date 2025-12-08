import EventEmitter from 'https://esm.sh/eventemitter2';

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
      state.event?.bus?.on?.('projects:select:ready', async () => {
        if (this.state.client?.status === 'connected') {
          await sendIdentify(this.state.client);
        }
      });
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

async function execWfCommand(command) {
  if (!command || typeof command !== 'object') throw new Error('Invalid command payload.');
  let { name, params = {} } = command;
  if (!name) throw new Error('Command name missing.');
  let actions = window.actions;
  let cur = params.cur ?? 'master';
  switch (name) {
    case 'readHtml': {
      if (!state.designer.current?.ready) return { success: false, error: `Designer closed`, hint: `Use selectFile to open the desired HTML file for editing first` };
      return { html: snapshotHtml() };
    }
    case 'changeSelection': {
      let ids = params.ids;
      if (!Array.isArray(ids) || !ids.length) throw new Error('ids must be a non-empty array');
      let action = actions.changeSelection;
      let reasons = action.disabled?.(payload)?.filter?.(Boolean) || [];
      if (reasons.length) {
        let lines = reasons.map(x => `- ${x}`);
        if (reasons.some(x => typeof x === 'string' && x.includes('Designer closed'))) {
          lines.push('Hint: use selectFile to open the desired HTML for editing');
        }
        return { success: false, error: lines.join('\n') };
      }
      let res = await action.handler({ cur, s: ids });
      let selection = currentSelectionIds(cur);
      return {
        success: res?.success !== false,
        selectedIds: res?.selectedIds ?? selection,
        missingIds: res?.missingIds ?? [],
      };
    }
    case 'createFile': {
      let action = actions[name];
      let reasons = action.disabled?.(payload)?.filter?.(Boolean) || [];
      if (reasons.length) {
        let lines = reasons.map(x => `- ${x}`);
        if (reasons.some(x => typeof x === 'string' && x.includes('Designer closed'))) {
          lines.push('Hint: use selectFile to open the desired HTML for editing');
        }
        return { success: false, error: lines.join('\n') };
      }
      let result = await action.handler(params || {});
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
    await post('companion.send', { type: 'identify', kind: 'webfoundry', projectId });
  } catch (err) {
    console.error('Failed to send identify message:', err);
  }
}

function currentProjectId() {
  let raw = state.projects?.current;
  if (!raw) return 'default';
  let name = raw.split(':')[0];
  return name || 'default';
}

function snapshotHtml() {
  try {
    return state.assistant?.doc?.documentElement?.outerHTML ?? '';
  } catch (err) {
    console.error(err);
    return '';
  }
}

function currentSelectionIds(cur = 'master') {
  let frame = state.designer.current;
  let ids = frame?.cursors?.[cur];
  return ids ? [...ids] : [];
}

function firstSelectedElement(cur = 'master') {
  let frame = state.designer.current;
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
  let frame = state.designer.current;
  if (!frame) return [];
  return frame.cursors?.[cur] ? [...frame.cursors[cur]] : [];
}

import * as WebSocket from 'ws';
import EventEmitter from 'eventemitter2';
import crypto from 'crypto';

export default function server(key, opt = {}) {
  if (!key) throw new Error(`Missing key`);
  opt.port ??= 8845;

  let rpc = {};

  let pendingWF = new Map();
  let socketMeta = new WeakMap();

  let ret = {
    events: new EventEmitter({ wildcard: true }),
    clients: new Set(),
    rpc: (name, fn) => rpc[name] = fn,
    broadcast: (data, exclude = new Set()) => {
      for (let ws of ret.clients) if (!exclude.has(ws)) ws.send(JSON.stringify(data));
    },
  };

  const awaitWFResult = (id, ms) => new Promise((resolve, reject) => {
    let timeout = setTimeout(() => {
      pendingWF.delete(id);
      reject(new Error('Timed out waiting for Webfoundry response'));
    }, ms);
    pendingWF.set(id, { resolve, reject, timeout });
  });

  let instanceClients = () => [...ret.clients].filter(client => socketMeta.get(client)?.kind === 'webfoundry');
  let describeInstance = client => {
    let { instanceId, projectId, collab, origin } = socketMeta.get(client);
    return { id: instanceId ?? null, project: projectId === 'default' ? null : projectId ?? null, collab: !!collab, origin: origin ?? null };
  };
  let describeInstances = clients => clients.map(describeInstance).map(x => `  ${x.id} (${x.project ?? 'no project'}${x.collab ? ', collab' : ''})`).join('\n');

  ret.rpc('wf:instances', () => instanceClients().map(describeInstance));

  // Exactly one instance runs each command: sending it to several applied the edit once per tab.
  function resolveInstance(instance, projectId) {
    let clients = instanceClients();
    if (instance) {
      let matches = clients.filter(client => socketMeta.get(client).instanceId?.startsWith(instance));
      if (!matches.length) throw new Error(`Webfoundry instance not connected: ${instance}`);
      if (matches.length > 1) throw new Error(`Instance id ${instance} is ambiguous:\n${describeInstances(matches)}`);
      let open = socketMeta.get(matches[0]).projectId;
      if (projectId && open !== projectId) throw new Error(`Instance ${instance} has ${open === 'default' ? 'no project' : `project ${open}`} open, not ${projectId}. Switch with: wf open-project ${projectId} --instance ${instance}`);
      return matches[0];
    }
    let matches = projectId ? clients.filter(client => socketMeta.get(client).projectId === projectId) : clients;
    if (!matches.length) throw new Error(projectId ? `Webfoundry project not connected: ${projectId}` : `No Webfoundry instances connected.`);
    if (matches.length > 1) throw new Error(`More than one Webfoundry instance matches. Pick one with --instance <id> or WF_INSTANCE:\n${describeInstances(matches)}`);
    return matches[0];
  }

  ret.rpc('wf:invoke', async ({ ws, command, projectId, instance }) => {
    if (!projectId && !instance && !command?.anyProject) throw new Error('projectId is required');
    if (projectId) {
      let callerMeta = socketMeta.get(ws) || {};
      if (callerMeta.projectId == null) socketMeta.set(ws, { ...callerMeta, kind: callerMeta.kind || 'cli', projectId });
      else if (callerMeta.projectId !== projectId) throw new Error(`Client not registered for project ${projectId}`);
    }
    let client = resolveInstance(instance, projectId);
    let id = crypto.randomUUID();
    client.send(JSON.stringify({ type: 'wf:invoke', id, command }));
    return await awaitWFResult(id, command?.params?.page || command?.name === 'createProject' ? 40000 : 10000); // Pages and new projects may take a while to load.
  });

  let wss = new WebSocket.WebSocketServer({ port: opt.port });
  ret.send = (ws, data) => ws.send(JSON.stringify(data)),

  wss.on('connection', (ws) => {
    ws.on('error', err => ret.events.emit('error', {
      ws,
      error: new Error(`WebSocket error: ${err.message}`),
    }));

    ws.on('close', () => {
      ret.clients.delete(ws);
      ret.events.emit('disconnected', { ws });
    });

    ret.send(ws, { type: 'handshake', status: 'hello', agent: 'webfoundry-companion' });

    ws.on('message', async msg => {
      let data;
      try {
        data = JSON.parse(msg);
      } catch {
        ret.events.emit('error', { ws, error: new Error(`Received invalid JSON`) });
        return ws.send(JSON.stringify({ type: 'error', error: 'Received invalid JSON' }));
      }
      if (data.type === 'handshake') {
        if (data.key === key) {
          ret.clients.add(ws);
          socketMeta.set(ws, { kind: 'unknown', projectId: null });
          ws.send(JSON.stringify({ type: 'handshake', status: 'ok' }));
          ret.events.emit('connected', { ws });
        } else {
          ws.send(JSON.stringify({ type: 'handshake', status: 'error', reason: 'auth_fail' }));
          ws.close(1008, `Authentication failure`);
          ret.events.emit('error', { ws, error: new Error(`Client sent bad handshake key`) });
        }
        return;
      }
      let { type } = data;
      delete data.type;
      if (type === 'identify') {
        console.log('identify:', data);
        socketMeta.set(ws, { kind: data.kind || 'unknown', projectId: data.projectId ?? null, instanceId: data.instanceId, collab: data.collab, origin: data.origin });
        return;
      }
      if (type.startsWith('rpc:')) {
        let { rpcid, ...params } = data;
        try {
          let proc = 'rpc:'.length;
          let fn = rpc[type.slice(proc)];
          if (!fn) throw new Error(`Unknown procedure: ${proc}`);
          ws.send(JSON.stringify({ type: 'rpc:response', rpcid, data: await fn({ ws: null, ...params, ws }) }));
        } catch (err) {
          console.error(err);
          ws.send(JSON.stringify({ type: 'rpc:response', rpcid, error: err.toString() }));
        }
      } else if (type === 'wf:result') {
        let { id, error, result } = data;
        let pending = pendingWF.get(id);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingWF.delete(id);
          error ? pending.reject(new Error(error)) : pending.resolve(result);
        }
      } else {
        ret.events.emit(`message:${type}`, { ws: null, ...data, ws });
      }
    });
  });

  ret.wss = wss;
  ret.dispose = () => ret.wss.close();
  return ret;
}

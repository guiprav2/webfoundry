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

  const awaitWFResult = id => new Promise((resolve, reject) => {
    let timeout = setTimeout(() => {
      pendingWF.delete(id);
      reject(new Error('Timed out waiting for Webfoundry response'));
    }, 10000);
    pendingWF.set(id, { resolve, reject, timeout });
  });

  ret.rpc('wf:invoke', async ({ ws, command, projectId }) => {
    if (!projectId) throw new Error('projectId is required');
    let callerMeta = socketMeta.get(ws) || {};
    if (callerMeta.projectId == null) socketMeta.set(ws, { ...callerMeta, kind: callerMeta.kind || 'cli', projectId });
    else if (callerMeta.projectId !== projectId) throw new Error(`Client not registered for project ${projectId}`);

    let recipients = [...ret.clients].filter(client => client !== ws).filter(client => {
      let meta = socketMeta.get(client);
      return meta?.kind === 'webfoundry' && meta.projectId === projectId;
    });
    if (!recipients.length) throw new Error(`Webfoundry project not connected: ${projectId}`);
    let id = crypto.randomUUID();
    for (let client of recipients) client.send(JSON.stringify({ type: 'wf:invoke', id, command }));
    return await awaitWFResult(id);
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
        socketMeta.set(ws, { kind: data.kind || 'unknown', projectId: data.projectId ?? null });
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

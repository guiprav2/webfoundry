import * as WebSocket from 'ws';
import EventEmitter from 'eventemitter2';
import crypto from 'crypto';

let EXTRA_ORIGINS = (process.env.WF_ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);

// Webfoundry's own origins: local dev servers, webfoundry.app and its Netlify sites. No Origin
// means a non-browser client such as the wf CLI.
export function allowedOrigin(origin) {
  if (!origin) return true;
  if (EXTRA_ORIGINS.includes(origin)) return true;
  let url;
  try { url = new URL(origin) } catch { return false }
  if (!/^https?:$/.test(url.protocol)) return false;
  let host = url.hostname;
  // Not *.localhost or other *.webfoundry.app subdomains: those serve isolated user projects.
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
    || host === 'webfoundry.app' || host === 'www.webfoundry.app'
    || /^([a-z0-9-]+--)?webfoundry\d*\.netlify\.app$/.test(host);
}

export default function server(key, opt = {}) {
  if (!key) throw new Error(`Missing key`);
  let keyBuf = Buffer.from(String(key));
  let keyMatches = given => {
    let buf = Buffer.from(String(given ?? ''));
    return buf.length === keyBuf.length && crypto.timingSafeEqual(buf, keyBuf);
  };
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
    return await awaitWFResult(id, wfCommandTimeout(command));
  });

  // Loopback only, and only browser pages from Webfoundry's own origins (the CLI sends no Origin).
  // The key is still the real gate: every message besides the handshake needs it first.
  let wss = new WebSocket.WebSocketServer({
    port: opt.port,
    host: opt.host ?? process.env.WF_COMPANION_HOST ?? '127.0.0.1',
    verifyClient: ({ origin }) => {
      if (allowedOrigin(origin)) return true;
      console.error(`Refused connection from origin ${origin}`);
      return false;
    },
  });
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
        if (keyMatches(data.key)) {
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
      if (!ret.clients.has(ws)) {
        ws.send(JSON.stringify({ type: 'error', error: 'Handshake required' }));
        return ws.close(1008, 'Handshake required');
      }
      let { type } = data;
      delete data.type;
      if (typeof type !== 'string') return ws.send(JSON.stringify({ type: 'error', error: 'Missing message type' }));
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
        // A throwing listener mustn't take the whole Companion down.
        try { ret.events.emit(`message:${type}`, { ws: null, ...data, ws }) }
        catch (err) { console.error(err); ws.send(JSON.stringify({ type: 'error', error: err.toString() })) }
      }
    });
  });

  ret.wss = wss;
  ret.dispose = () => ret.wss.close();
  return ret;
}

// How long the IDE gets to answer a wf command. Pages and new projects may take a while to load;
// a deploy zips, uploads and waits for Netlify to finish. The CLI waits 5s longer (other/wf.js).
function wfCommandTimeout(command) {
  if (command?.name === 'deploy') return 600000;
  if (command?.params?.page || command?.name === 'createProject') return 40000;
  return 10000;
}

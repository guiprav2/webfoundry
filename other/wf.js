#!/usr/bin/env node
import fs from 'fs';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import WebSocket from 'ws';
import { spawn } from 'child_process';
import { parseWfInvocation, formatWfResult } from './wf-commands.js';

let ENDPOINT = process.env.WF_ENDPOINT || 'ws://localhost:8845';
let CONFIG_PATH = path.join(os.homedir(), '.webfoundry', 'config.env');

async function main() {
  let verbose = false;
  try {
    let parsed = parseWfInvocation(process.argv.slice(2), { defaultCur: cursorFromEnv() });
    verbose = parsed.verbose;
    if (parsed.help) {
      process.stdout.write(parsed.stdout);
      process.stderr.write(parsed.stderr);
      process.exit(parsed.code);
    }
    let command = parsed.command;
    let payload = { name: command.name || parsed.subcmd, params: command.params || {} };
    if (!payload.name) throw new Error('Unable to resolve command name.');
    let key = await loadClientKey();
    let instance = parsed.route.instance ?? process.env.WF_INSTANCE ?? null;
    if (parsed.spec.anyProject) payload.anyProject = true;
    let call = (proc, params, projectId = null) => invokeCompanion(key, proc, params, projectId);
    let invoke = (target, projectId) => call('wf:invoke', { command: payload, instance: target }, projectId);
    let result;
    if (parsed.spec.openBrowser) result = await openInstance(call, parsed.command.params.url);
    else if (parsed.spec.rpc) result = { success: true, instances: await call(parsed.spec.rpc, {}) };
    else if (parsed.spec.fanOut && !instance) {
      let instances = await call('wf:instances', {});
      if (!instances.length) throw new Error('No Webfoundry instances connected.');
      result = { success: true, instances: await Promise.all(instances.map(x => invoke(x.id))) };
    } else {
      let projectId = null;
      if (!parsed.spec.anyProject) projectId = parsed.route.project ?? (instance ? await resolveProjectId().then(x => x.projectId, () => null) : (await resolveProjectId()).projectId);
      result = await invoke(instance, projectId);
    }
    let formatted = formatWfResult(parsed.spec, result, process.argv.slice(2));
    process.stdout.write(formatted.stdout);
    process.stderr.write(formatted.stderr);
    if (formatted.code) process.exit(formatted.code);
  } catch (err) {
    if ((verbose || err?.verbose) && err?.stack) console.error(err.stack);
    else console.error(err.message || err);
    process.exit(1);
  }
}

async function loadClientKey() {
  if (process.env.WF_CLIENT_KEY) return process.env.WF_CLIENT_KEY;
  try {
    let content = await fsp.readFile(CONFIG_PATH, 'utf8');
    for (let line of content.split(/\r?\n/)) {
      let [key, ...rest] = line.split('=');
      if (key === 'WF_CLIENT_KEY') {
        return rest.join('=').trim();
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  throw new Error('WF_CLIENT_KEY not found. Set the environment variable or run the Companion to generate ~/.webfoundry/config.env.');
}

// Each agent gets its own designer cursor. An agent CLI's session id is the best identity available
// without help; subagents usually share it, so they should set WF_CURSOR themselves.
function cursorFromEnv() {
  let { WF_CURSOR, WF_SESSION, CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID, CODEX_SESSION_ID } = process.env;
  if (WF_CURSOR) return WF_CURSOR;
  let session = WF_SESSION || CLAUDE_CODE_SESSION_ID || CODEX_THREAD_ID || CODEX_SESSION_ID;
  return session ? session.slice(0, 8) : 'master';
}

function launchBrowser(url) {
  let [cmd, ...args] = process.env.WF_BROWSER ? [process.env.WF_BROWSER] : process.platform === 'darwin' ? ['open'] : process.platform === 'win32' ? ['cmd', '/c', 'start', ''] : ['xdg-open'];
  spawn(cmd, [...args, url], { detached: true, stdio: 'ignore' }).on('error', err => console.error(`Couldn't open a browser: ${err.message}`)).unref();
}

async function openInstance(call, url) {
  let before = await call('wf:instances', {}).catch(() => []);
  let origin = before.find(x => !x.collab && x.origin)?.origin || 'https://webfoundry.app';
  url ||= process.env.WF_URL || `${origin}/editor.html`;
  launchBrowser(url);
  let known = new Set(before.map(x => x.id));
  for (let i = 0; i < 30; i++) {
    await new Promise(pres => setTimeout(pres, 500));
    let added = (await call('wf:instances', {}).catch(() => [])).find(x => !known.has(x.id));
    if (added) return { success: true, url, instance: added.id };
  }
  return { success: true, url, instance: null };
}

async function invokeCompanion(key, proc, params, projectId) {
  return new Promise((resolve, reject) => {
    let ws = new WebSocket(ENDPOINT);
    let rpcid = crypto.randomUUID();
    let timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('Connection timed out.'));
    }, params.command?.params?.page || params.command?.name === 'createProject' ? 45000 : 10000); // Pages and new projects may take a while to load.

    let dispose = (err) => {
      clearTimeout(timeout);
      if (err) reject(err);
      ws.close();
    };

    ws.on('error', err => dispose(err));
    ws.on('close', () => {});

    ws.on('message', msg => {
      let data;
      try {
        data = JSON.parse(msg);
      } catch {
        return dispose(new Error('Received non-JSON response from Companion.'));
      }
      if (data.type === 'handshake' && data.status === 'hello') {
        ws.send(JSON.stringify({ type: 'handshake', key }));
        return;
      }
      if (data.type === 'handshake' && data.status === 'error') {
        dispose(new Error(data.reason ? `Companion handshake failed: ${data.reason}` : 'Companion handshake failed.'));
        return;
      }
      if (data.type === 'handshake' && data.status === 'ok') {
        ws.send(JSON.stringify({ type: 'identify', kind: 'cli', projectId }));
        ws.send(JSON.stringify({ type: `rpc:${proc}`, rpcid, projectId, ...params }));
        return;
      }
      if (data.type === 'rpc:response' && data.rpcid === rpcid) {
        if (data.error) dispose(new Error(data.error));
        else {
          clearTimeout(timeout);
          ws.close();
          resolve(data.data);
        }
      }
    });
  });
}

async function resolveProjectId() {
  let dir = process.cwd();
  while (true) {
    let configPath = path.join(dir, 'wf.config.js');
    if (fs.existsSync(configPath)) {
      return { projectId: path.basename(dir), configPath };
    }
    let parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('wf.config.js not found (run wf from inside a Webfoundry project).');
}

main();

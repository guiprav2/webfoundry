#!/usr/bin/env node
import fs from 'fs';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import WebSocket from 'ws';
import { parseWfInvocation, formatWfResult } from './wf-commands.js';

let ENDPOINT = process.env.WF_ENDPOINT || 'ws://localhost:8845';
let CONFIG_PATH = path.join(os.homedir(), '.webfoundry', 'config.env');

async function main() {
  let verbose = false;
  try {
    let parsed = parseWfInvocation(process.argv.slice(2));
    verbose = parsed.verbose;
    if (parsed.help) {
      process.stdout.write(parsed.stdout);
      process.stderr.write(parsed.stderr);
      process.exit(parsed.code);
    }
    let command = parsed.command;
    let payload = { name: command.name || parsed.subcmd, params: command.params || {} };
    if (!payload.name) throw new Error('Unable to resolve command name.');
    let { projectId } = await resolveProjectId();
    let key = await loadClientKey();
    let result = await invokeCompanion(key, payload, projectId);
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

async function invokeCompanion(key, command, projectId) {
  return new Promise((resolve, reject) => {
    let ws = new WebSocket(ENDPOINT);
    let rpcid = crypto.randomUUID();
    let timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('Connection timed out.'));
    }, 10000);

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
        ws.send(JSON.stringify({ type: 'rpc:wf:invoke', rpcid, projectId, command }));
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

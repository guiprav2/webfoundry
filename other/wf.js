#!/usr/bin/env node
import fs from 'fs';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import WebSocket from 'ws';

const ENDPOINT = process.env.WF_ENDPOINT || 'ws://localhost:8845';
const CONFIG_PATH = path.join(os.homedir(), '.webfoundry', 'config.env');

const SUBCOMMANDS = {
  'read-html': {
    description: 'Print the current page HTML snapshot with data-htmlsnap attributes.',
    build: () => ({ name: 'readHtml' }),
    format: result => {
      if (!result || typeof result.html !== 'string') throw new Error('Unexpected response from readHtml');
      process.stdout.write(result.html);
    },
  },
  'change-selection': {
    description: 'Select elements by their data-htmlsnap IDs.',
    build: ({ flags, positionals }) => {
      let ids = [];
      if (flags.ids) ids.push(...splitList(flags.ids));
      if (positionals.length) ids.push(...positionals);
      if (!ids.length) throw new Error('Provide at least one id (use --ids id1,id2 or positional arguments).');
      return { name: 'changeSelection', params: { ids, cur: flags.cur || 'master' } };
    },
    format: ({ success, selectedIds }) => {
      if (success === false) throw new Error('Selection change failed.');
      console.log(`Selected: ${(selectedIds || []).join(', ')}`);
    },
  },
  'create-first-child': makeCreateCommand('createFirstChild', 'Insert new first-child elements under the current selection.'),
  'create-last-child': makeCreateCommand('createLastChild', 'Insert new last-child elements under the current selection.'),
  'create-next-sibling': makeCreateCommand('createNextSibling', 'Insert new sibling elements after the current selection.'),
  'create-prev-sibling': makeCreateCommand('createPrevSibling', 'Insert new sibling elements before the current selection.'),
  'wrap': {
    description: 'Wrap the current selection in a new element.',
    build: ({ flags }) => ({
      name: 'wrap',
      params: { tag: flags.tag || 'div', cur: flags.cur || 'master' },
    }),
    format: () => console.log('Wrapped selection.'),
  },
  'unwrap': {
    description: 'Unwrap the current selection.',
    build: ({ flags }) => ({ name: 'unwrap', params: { cur: flags.cur || 'master' } }),
    format: () => console.log('Unwrapped selection.'),
  },
  'delete-selected': {
    description: 'Delete the currently selected elements.',
    build: ({ flags }) => ({ name: 'deleteSelected', params: { cur: flags.cur || 'master' } }),
    format: () => console.log('Deleted selection.'),
  },
  'change-element-tag': {
    description: 'Change the tag of the selected elements.',
    build: ({ flags }) => {
      let tag = flags.tag;
      if (!tag) throw new Error('Specify --tag <new-tag>.');
      return { name: 'changeElementTag', params: { tag, cur: flags.cur || 'master' } };
    },
    format: () => console.log('Updated element tag.'),
  },
  'add-css-classes': {
    description: 'Add Tailwind classes to the selection.',
    build: ({ flags, positionals }) => {
      let classes = gatherClasses(flags, positionals);
      return { name: 'addCssClasses', params: { cls: classes, cur: flags.cur || 'master' } };
    },
    format: () => console.log('Added classes.'),
  },
  'remove-css-classes': {
    description: 'Remove Tailwind classes from the selection.',
    build: ({ flags, positionals }) => {
      let classes = gatherClasses(flags, positionals);
      return { name: 'removeCssClasses', params: { cls: classes, cur: flags.cur || 'master' } };
    },
    format: () => console.log('Removed classes.'),
  },
  'replace-css-classes': {
    description: 'Replace classes matching an existing value (supports /regex/).',
    build: ({ flags, positionals }) => {
      let oldVal = flags.old || positionals.shift();
      if (!oldVal) throw new Error('Specify --old <classOrRegex>.');
      let classes = gatherClasses(flags, positionals);
      return { name: 'replaceCssClasses', params: { old: oldVal, cls: classes, cur: flags.cur || 'master' } };
    },
    format: () => console.log('Replaced classes.'),
  },
  'replace-text': {
    description: 'Replace text content inside the selection.',
    build: ({ flags, positionals }) => {
      let text = flags.text ?? positionals.join(' ');
      if (text == null) throw new Error('Provide text via --text or positional argument.');
      return { name: 'replaceTextContent', params: { text, cur: flags.cur || 'master' } };
    },
    format: () => console.log('Updated text content.'),
  },
  'set-placeholder': {
    description: 'Set the placeholder attribute of selected inputs.',
    build: ({ flags, positionals }) => {
      let placeholder = flags.text ?? flags.value ?? positionals.join(' ');
      return { name: 'changeInputPlaceholder', params: { placeholder: placeholder ?? '', cur: flags.cur || 'master' } };
    },
    format: () => console.log('Updated placeholder.'),
  },
  'set-href': {
    description: 'Set the href attribute on selected anchors.',
    build: ({ flags, positionals }) => {
      let url = flags.url ?? positionals[0];
      return { name: 'changeLinkUrl', params: { url: url ?? '', cur: flags.cur || 'master' } };
    },
    format: () => console.log('Updated href.'),
  },
  'set-src': {
    description: 'Set the src attribute or wf-src binding.',
    build: ({ flags, positionals }) => {
      let src = flags.url ?? flags.src ?? positionals[0] ?? null;
      let expr = flags.expr ?? null;
      return { name: 'changeMediaSrc', params: { src, expr, cur: flags.cur || 'master' } };
    },
    format: () => console.log('Updated src binding.'),
  },
  'set-input-value': {
    description: 'Set value or wf-value binding on selected inputs.',
    build: ({ flags, positionals }) => {
      let value = flags.value ?? positionals[0] ?? null;
      let expr = flags.expr ?? null;
      return { name: 'setInputValue', params: { value, expr, cur: flags.cur || 'master' } };
    },
    format: () => console.log('Updated input value.'),
  },
  'set-disabled': {
    description: 'Set a wf-disabled expression.',
    build: ({ flags, positionals }) => {
      let expr = flags.expr ?? positionals.join(' ');
      if (!expr) throw new Error('Provide expression via --expr or positional argument.');
      return { name: 'setDisabledExpression', params: { expr, cur: flags.cur || 'master' } };
    },
    format: () => console.log('Updated disabled expression.'),
  },
};

function makeCreateCommand(action, description) {
  return {
    description,
    build: ({ flags }) => ({
      name: action,
      params: {
        tag: flags.tag || 'div',
        i: parseCount(flags.count),
        cur: flags.cur || 'master',
      },
    }),
    format: () => console.log('Created elements.'),
  };
}

function parseCount(value) {
  if (value == null) return 1;
  let n = Number(value);
  if (!Number.isFinite(n) || n < 1) throw new Error('count must be a positive integer');
  return Math.floor(n);
}

function gatherClasses(flags, positionals) {
  let classes = [];
  if (flags.classes) classes.push(...splitList(flags.classes));
  if (positionals.length) classes.push(...positionals);
  if (!classes.length) throw new Error('Provide classes via --classes "a b" or positional arguments.');
  return classes;
}

function splitList(value) {
  if (Array.isArray(value)) return value;
  return String(value)
    .split(/[,\s]+/)
    .map(x => x.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const [subcmd, ...rest] = argv;
  if (!subcmd || subcmd === 'help' || subcmd === '--help' || subcmd === '-h') {
    printHelp();
    process.exit(subcmd ? 0 : 1);
  }
  let spec = SUBCOMMANDS[subcmd];
  if (!spec) {
    console.error(`Unknown subcommand: ${subcmd}`);
    printHelp();
    process.exit(1);
  }
  let { flags, positionals } = parseFlags(rest);
  return { spec, params: spec.build({ flags, positionals }), subcmd };
}

function parseFlags(args) {
  let flags = {};
  let positionals = [];
  for (let i = 0; i < args.length; i++) {
    let arg = args[i];
    if (arg.startsWith('--')) {
      let key = arg.slice(2);
      if (!key) continue;
      let next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

function printHelp() {
  console.log('Usage: wf <subcommand> [options]\n');
  console.log('Available subcommands:');
  for (let [name, spec] of Object.entries(SUBCOMMANDS)) {
    console.log(`  ${name.padEnd(20)} ${spec.description}`);
  }
  console.log('\nExamples:');
  console.log('  wf read-html');
  console.log('  wf change-selection --ids section_1_a3 section_1_a4');
  console.log('  wf add-css-classes hero_title --classes "text-4xl font-bold"');
}

async function main() {
  try {
    let { spec, params, subcmd } = parseArgs(process.argv.slice(2));
    let command = params;
    let payload = { name: command.name || subcmd, params: command.params || {} };
    if (!payload.name) throw new Error('Unable to resolve command name.');
    let { projectId } = await resolveProjectId();
    let key = await loadClientKey();
    let result = await invokeCompanion(key, payload, projectId);
    if (spec.format) spec.format(result);
    else if (result != null) console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(err.message || err);
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

    const dispose = (err) => {
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

import { run } from '../other/kittygpt/core.js';
import { keyImageData, parseKeyColor } from '../other/keypng.js';
import { ensureOpenAIKey } from '../other/openai.js';
import { createShell, formatResult } from '../other/shell.js';
import { projectFs } from '../other/shellfs.js';
import { ensureXAIKey } from '../other/xai.js';
import rfiles from '../repos/rfiles.js';

let instructions = [
  'You are the Webfoundry agent. Reply in plain text.',
  'On the first turn in a project, find AGENTS.md and read the whole file with the shell before you edit anything. Follow it.',
  'Use the shell tool to read and change files in the open project. Paths are project-relative, and a leading / is the project root.',
  'Commands: pwd, cd, ls, cat, grep, sed, wc, mkdir, rm, mv, cp, echo, head, tail, find, touch, wf. The shell parses Bash, including pipes, && and ||, heredocs, and redirects on any part of a command. grep accepts the usual flags, including -n, -R, -I, and --include. sed -n \'10,40p\' prints a line range. Glob patterns expand.',
  'Every directory has a .keep file, including directories that already contain other files. Leave each .keep in place. Remove a directory with rm -r.',
  'Change HTML with wf. wf select-file opens the page, wf read-html prints the snapshot, and each element carries a data-htmlsnap attribute. The attribute value is the snap id.',
  'wf change-selection accepts only those snap ids, copied as bare values. Example: wf change-selection c11bf512f78e. Several ids may follow the subcommand.',
  'Writes to HTML files and to webfoundry/ are refused. cat can still read them.',
  'run_js executes inside the open page iframe. It throws when the visual editor is closed. Pass args as a map of parameter names to values and body as the function body, and return the value you want back.',
  'Sprites and UI frames that sit on another picture use a flat backdrop color. remove_background keys that exact color, so other greens in the subject stay, feathers the edge, and writes a PNG.',
].join(' ');

export default class Agent {
  state = {
    draft: '',
    busy: false,
    entries: [],
  };

  logs = [];
  shells = new Map();

  shellFor() {
    let project = state.projects.current;
    if (!project) throw new Error('No project is open');
    let shell = this.shells.get(project);
    if (!shell) {
      shell = createShell(projectFs());
      this.shells.set(project, shell);
    }
    return shell;
  }

  tools() {
    return {
      shell: {
        description: 'Run a Bash-style shell command in the open project. Pipes, heredocs, and redirects are supported. Paths are project-relative. Every directory keeps a .keep file, even when other files are present; leave those in place. Change HTML with wf. wf change-selection takes data-htmlsnap id values from wf read-html, such as c11bf512f78e.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Command to run, such as cat AGENTS.md, wf read-html, or wf change-selection <snap id>' },
          },
          required: ['command'],
        },
        handler: async ({ command }) => {
          try {
            let result = await this.shellFor().run(String(command || ''));
            return formatResult(result);
          } catch (err) {
            return (err && err.message) || String(err);
          }
        },
      },
      run_js: {
        description: 'Run JavaScript inside the current page iframe. Throws when the visual editor is not open. args is a map of parameter names to values. body is the function body. Example: args { x: 1, y: 2 } and body "return x + y" runs await new AsyncFunction("x", "y", "return x + y")(1, 2). Return a JSON-friendly value. document and the page state are the iframe globals.',
        parameters: {
          type: 'object',
          properties: {
            args: { type: 'object', description: 'Named parameters. Each key is a function parameter name.' },
            body: { type: 'string', description: 'Function body. Use return to send a value back.' },
          },
          required: ['body'],
        },
        handler: async ({ args, body }) => {
          try {
            return await runInPage(args, body);
          } catch (err) {
            return (err && err.message) || String(err);
          }
        },
      },
      remove_background: {
        description: 'Remove one exact backdrop color from an image and feather the edge, writing a transparent PNG. Use it for sprites, props, and UI frames that were painted on a flat color and must sit over another picture. Pass that color as #rrggbb. Keying is distance to that color, so a green costume stays when the backdrop is a different green. Do not use it on plates, photos, or art whose background is part of the picture. output must end in .png.',
        parameters: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'Project-relative source image path' },
            output: { type: 'string', description: 'Project-relative PNG path. Must end in .png' },
            color: { type: 'string', description: 'Exact color to remove, as #rrggbb. Sample it from the backdrop, not from the subject.' },
          },
          required: ['input', 'output', 'color'],
        },
        handler: async ({ input, output, color }) => {
          try {
            return await removeBackground(input, output, color);
          } catch (err) {
            return (err && err.message) || String(err);
          }
        },
      },
    };
  }

  actions = {
    send: async () => {
      if (this.state.busy) return;
      let text = (this.state.draft || '').trim();
      if (!text) return;
      this.state.draft = '';
      this.state.busy = true;
      this.state.entries.push({ role: 'user', text });
      let assistant = { role: 'assistant', text: '' };
      this.state.entries.push(assistant);
      d.update();
      this.stick();
      this.logs.push({ type: 'message', role: 'user', content: [text] });
      try {
        let xai = state.settings.opt?.codingAgent === 'xai';
        let key = xai ? await ensureXAIKey() : await ensureOpenAIKey();
        await run(this.logs, {
          model: xai ? 'xai:grok-4.5' : 'oai:gpt-6-luna',
          key,
          stream: true,
          instructions,
          tools: this.tools(),
          text: (kind, chunk) => {
            if (kind !== 'delta' || !chunk) return;
            assistant.text += chunk;
            d.updateSync();
            this.stick();
          },
        });
        if (!assistant.text) {
          let last = [...this.logs].reverse().find(x => x.type === 'message' && x.role === 'assistant');
          let parts = last && last.content || [];
          assistant.text = parts.filter(x => typeof x === 'string').join('');
        }
      } catch (err) {
        if (!assistant.text) assistant.text = (err && err.message) || String(err);
      } finally {
        this.state.busy = false;
        d.update();
        this.stick();
      }
    },
  };

  stick() {
    let log = document.querySelector('.AgentPanel-log');
    if (log) log.scrollTop = log.scrollHeight;
  }
}

let runJsBody = `
let AsyncFunction = (async () => {}).constructor;
let spec = args.spec || {};
let names = Object.keys(spec);
let values = names.map(name => spec[name]);
let value = await new AsyncFunction(...names, args.body)(...values);
if (value === undefined) return { t: 'undefined' };
if (value === null) return { t: 'null' };
if (typeof value === 'string') return { t: 'string', v: value };
if (typeof value === 'number' || typeof value === 'boolean') return { t: 'json', v: value };
if (typeof value === 'bigint') return { t: 'string', v: String(value) };
if (typeof Element !== 'undefined' && value instanceof Element) return { t: 'string', v: value.outerHTML };
try {
  return { t: 'json', v: JSON.parse(JSON.stringify(value)) };
} catch (err) {
  return { t: 'string', v: String(value) };
}
`;

function formatRunResult(packed) {
  if (!packed || typeof packed !== 'object') return String(packed);
  if (packed.t === 'undefined') return 'undefined';
  if (packed.t === 'null') return 'null';
  if (packed.t === 'string') return String(packed.v);
  if (packed.t === 'json') return typeof packed.v === 'string' ? packed.v : JSON.stringify(packed.v);
  return String(packed.v);
}

function runInPage(args, body) {
  if (!state.designer?.open || !state.designer.current?.el) throw new Error('Visual editor is not open');
  if (typeof body !== 'string' || !body.trim()) throw new Error('run_js requires a body');
  let spec = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  if (args != null && (typeof args !== 'object' || Array.isArray(args))) throw new Error('run_js args must be an object');
  for (let name of Object.keys(spec)) {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error(`run_js parameter is not an identifier: ${name}`);
  }
  let frame = state.designer.current;
  let iforigin = new URL(frame.el.src).origin;
  let rpcid = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      removeEventListener('message', listener);
      reject(new Error('run_js timed out'));
    }, 20000);
    let listener = ev => {
      if (ev.origin !== iforigin || ev.data?.type !== 'eval:res' || ev.data.rpcid !== rpcid) return;
      clearTimeout(timer);
      removeEventListener('message', listener);
      if (ev.data.error) reject(new Error(ev.data.error));
      else resolve(formatRunResult(ev.data.result));
    };
    addEventListener('message', listener);
    frame.el.contentWindow.postMessage({ type: 'eval', fn: runJsBody, rpcid, args: { spec, body } }, iforigin);
  });
}

async function removeBackground(input, output, color) {
  let project = state.projects.current;
  if (!project) throw new Error('No project is open');
  input = cleanPath(input);
  output = cleanPath(output);
  if (!output.endsWith('.png')) throw new Error('output must end in .png');
  let key = parseKeyColor(color);
  let blob = await rfiles.load(project, input);
  if (!blob) throw new Error(`no such file: ${input}`);
  let bitmap = await createImageBitmap(blob);
  let canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  let ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  let image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  image.data.set(keyImageData(image.data, canvas.width, canvas.height, key));
  ctx.putImageData(image, 0, 0);
  let png = await new Promise((resolve, reject) => {
    canvas.toBlob(result => result ? resolve(result) : reject(new Error('PNG encode failed')), 'image/png');
  });
  await ensureKeeps(project, output);
  await rfiles.save(project, output, png);
  post('files.load');
  let hex = [key.r, key.g, key.b].map(n => n.toString(16).padStart(2, '0')).join('');
  return `Wrote ${output} (${canvas.width}x${canvas.height}), keyed #${hex}`;
}

function cleanPath(path) {
  let text = String(path || '').trim();
  if (text.startsWith('/')) text = text.slice(1);
  if (!text || text.split('/').includes('..')) throw new Error(`bad path: ${path}`);
  return text;
}

async function ensureKeeps(project, path) {
  let parts = path.split('/');
  parts.pop();
  let acc = [];
  let existing = new Set(await rfiles.list(project));
  for (let part of parts) {
    acc.push(part);
    let keep = acc.join('/') + '/.keep';
    if (existing.has(keep)) continue;
    await rfiles.save(project, keep, new Blob([''], { type: 'text/plain' }));
    existing.add(keep);
  }
}

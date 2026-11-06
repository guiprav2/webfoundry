// Shared wf command parsing and result text. The CLI and the in-browser shell both use this.

export function parseWfInvocation(argv) {
  let verbose = false;
  let [subcmd, ...rest0] = argv;
  let rest = [...rest0];
  while (rest.length && /^--?\w+$/.test(rest[0])) {
    if (rest[0] === '-v' || rest[0] === '--verbose') { verbose = true; rest.shift(); continue; }
    break;
  }
  if (!subcmd || subcmd === 'help' || subcmd === '--help' || subcmd === '-h') {
    return { help: true, verbose, code: subcmd ? 0 : 1, stdout: helpText(), stderr: '' };
  }
  let spec = subcommands[subcmd];
  if (!spec) {
    return { help: true, verbose, code: 1, stdout: helpText(), stderr: `Unknown subcommand: ${subcmd}\n` };
  }
  try {
    let { flags, positionals } = parseFlags(rest);
    return { help: false, verbose, spec, subcmd, command: spec.build({ flags, positionals }) };
  } catch (err) {
    err.verbose = verbose;
    throw err;
  }
}

export function formatWfResult(spec, result, argv) {
  let stdout = '';
  let stderr = '';
  let code = 0;
  let io = {
    log(...args) { stdout += args.map(x => String(x)).join(' ') + '\n'; },
    error(...args) { stderr += args.map(x => String(x)).join(' ') + '\n'; },
    write(text) { stdout += text == null ? '' : String(text); },
    set code(value) { code = value; },
  };
  try {
    if (spec?.format) spec.format(result, io, argv);
    else if (result != null) io.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  } catch (err) {
    if (!err?.wfExit) throw err;
    code = err.wfExit;
  }
  return { code, stdout, stderr };
}

function helpText() {
  let lines = [
    'Usage: wf [-v] <subcommand> [options]\n',
    'Global flags:',
    '  -v, --verbose        Print full error stacktraces on failure',
    'Available subcommands:',
  ];
  for (let [name, spec] of Object.entries(subcommands)) lines.push(`  ${name.padEnd(20)} ${spec.description}`);
  lines.push('\nExamples:');
  lines.push('  wf read-html');
  lines.push('  wf change-selection --ids section_1_a3 section_1_a4');
  lines.push('  wf add-css-classes hero_title --classes "text-4xl font-bold"');
  lines.push('  wf set-platform-preview desktop');
  lines.push('  wf is-platform-preview');
  lines.push('  wf set-platform-os lin');
  lines.push('  wf set-page-preview toggle');
  lines.push('  wf is-page-preview');
  return lines.map(line => line + '\n').join('');
}

let subcommands = {
  'select-file': {
    description: 'Selects a file for editing.',
    build: ({ positionals }) => {
      let path = positionals[0].replace(/^\.\//, '');
      if (!path) throw new Error('Specify <path/file.ext> to select.');
      return { name: 'selectFile', params: { path } };
    },
    format: (result, io, argv) => {
      if (!result?.success) return die(result, io, argv);
      io.log(`Selected file: ${result?.path || 'OK'}`);
    },
  },
  'create-file': {
    description: 'Create a new project file using Webfoundry templates.',
    build: ({ positionals }) => {
      let path = positionals[0].replace(/^\.\//, '');
      if (!path) throw new Error('Specify <path/file.ext> to create.');
      return { name: 'createFile', params: { path } };
    },
    format: (result, io, argv) => {
      if (!result?.success) return die(result, io, argv);
      io.log(`Created file: ${result?.path || 'OK'}`);
    },
  },
  'read-html': {
    description: 'Print the current page HTML snapshot with data-htmlsnap attributes.',
    build: () => ({ name: 'readHtml' }),
    format: (result, io, argv) => {
      if (!result?.success) return die(result, io, argv);
      io.write(result.html);
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
    format: formatChangeSelectionResult,
  },
  'toggle-selection': {
    description: 'Toggle between the current selection and the previous one.',
    build: ({ flags }) => ({ name: 'toggleSelection', params: { cur: flags.cur || 'master' } }),
    format: formatSelectionResult,
  },
  'create-first-child': makeCreateCommand('createFirstChild', 'Insert new first-child elements under the current selection.'),
  'create-last-child': makeCreateCommand('createLastChild', 'Insert new last-child elements under the current selection.'),
  'create-next-sibling': makeCreateCommand('createNextSibling', 'Insert new sibling elements after the current selection.'),
  'create-prev-sibling': makeCreateCommand('createPrevSibling', 'Insert new sibling elements before the current selection.'),
  'paste-next-sibling': makePasteCommand('pasteNextSibling', 'Paste clipboard content after the selection.'),
  'paste-prev-sibling': makePasteCommand('pastePrevSibling', 'Paste clipboard content before the selection.'),
  'paste-first-child': makePasteCommand('pasteFirstChild', 'Paste clipboard content as the first child.'),
  'paste-last-child': makePasteCommand('pasteLastChild', 'Paste clipboard content as the last child.'),
  'wrap': {
    description: 'Wrap the current selection in a new element.',
    build: ({ flags }) => ({ name: 'wrap', params: { tag: flags.tag || 'div', cur: flags.cur || 'master' } }),
    format: formatSelectionResult,
  },
  'unwrap': {
    description: 'Unwrap the current selection.',
    build: ({ flags }) => ({ name: 'unwrap', params: { cur: flags.cur || 'master' } }),
    format: formatSelectionResult,
  },
  'delete-selected': {
    description: 'Delete the currently selected elements.',
    build: ({ flags }) => ({ name: 'deleteSelected', params: { cur: flags.cur || 'master' } }),
    format: (result, io, argv) => {
      if (!result?.success) return die(result, io, argv);
      io.log('Deleted selection.');
      formatSelectionResult(result, io, argv);
    },
  },
  'change-element-tag': {
    description: 'Change the tag of the selected elements.',
    build: ({ flags, positionals }) => {
      let tag = flags.tag ?? positionals[0];
      if (!tag) throw new Error('Specify --tag <new-tag>.');
      return { name: 'changeElementTag', params: { tag, cur: flags.cur || 'master' } };
    },
    format: formatSelectionResult,
  },
  'change-element-id': {
    description: 'Change the id attribute of the selected elements.',
    build: ({ flags, positionals }) => {
      let id = flags.id ?? positionals[0];
      if (id == null) throw new Error('Specify --id <new-id>.');
      return { name: 'changeElementId', params: { id, cur: flags.cur || 'master' } };
    },
    format: formatSelectionResult,
  },
  'add-css-classes': {
    description: 'Add Tailwind classes to the selection.',
    build: ({ flags, positionals }) => {
      let classes = gatherClasses(flags, positionals);
      return { name: 'addCssClasses', params: { cls: classes, cur: flags.cur || 'master' } };
    },
    format: formatSelectionResult,
  },
  'remove-css-classes': {
    description: 'Remove Tailwind classes from the selection.',
    build: ({ flags, positionals }) => {
      let classes = gatherClasses(flags, positionals);
      return { name: 'removeCssClasses', params: { cls: classes, cur: flags.cur || 'master' } };
    },
    format: formatSelectionResult,
  },
  'replace-css-classes': {
    description: 'Replace classes matching an existing value (supports /regex/).',
    build: ({ flags, positionals }) => {
      let oldVal = flags.old || positionals.shift();
      if (!oldVal) throw new Error('Specify --old "old class names".');
      let newVal = flags.new || positionals.shift();
      if (!newVal) throw new Error('Specify --new "new class names".');
      return { name: 'replaceCssClasses', params: { old: oldVal, cls: newVal, cur: flags.cur || 'master' } };
    },
    format: formatSelectionResult,
  },
  'replace-text': {
    description: 'Replace text content inside the selection.',
    build: ({ flags, positionals }) => {
      let text = flags.text ?? positionals.join(' ');
      if (text == null) throw new Error('Provide text via --text or positional argument.');
      return { name: 'replaceTextContent', params: { text, cur: flags.cur || 'master' } };
    },
    format: formatSelectionResult,
  },
  'set-placeholder': {
    description: 'Set the placeholder attribute of selected inputs.',
    build: ({ flags, positionals }) => {
      let placeholder = flags.text ?? flags.value ?? positionals.join(' ');
      return { name: 'changeInputPlaceholder', params: { placeholder: placeholder ?? '', cur: flags.cur || 'master' } };
    },
    format: formatSelectionResult,
  },
  'set-href': {
    description: 'Set the href attribute on selected anchors.',
    build: ({ flags, positionals }) => {
      let url = flags.url ?? positionals[0] ?? '';
      return { name: 'changeLinkUrl', params: { url, cur: flags.cur || 'master' } };
    },
    format: formatSelectionResult,
  },
  'set-src': {
    description: 'Set the src attribute or wf-src binding.',
    build: ({ flags, positionals }) => {
      let src = flags.url ?? flags.src ?? positionals[0] ?? null;
      let expr = flags.expr ?? null;
      return { name: 'changeMediaSrc', params: { src, expr, cur: flags.cur || 'master' } };
    },
    format: formatSelectionResult,
  },
  'set-input-value': {
    description: 'Set value or wf-value binding on selected inputs.',
    build: ({ flags, positionals }) => {
      let value = flags.value ?? positionals[0] ?? null;
      let expr = flags.expr ?? null;
      return { name: 'setInputValue', params: { value, expr, cur: flags.cur || 'master' } };
    },
    format: formatSelectionResult,
  },
  'set-disabled': {
    description: 'Set a wf-disabled expression.',
    build: ({ flags, positionals }) => {
      let expr = flags.expr ?? positionals.join(' ');
      if (!expr) throw new Error('Provide expression via --expr or positional argument.');
      return { name: 'setDisabledExpression', params: { expr, cur: flags.cur || 'master' } };
    },
    format: makeExprFormatter('wf-disabled'),
  },
  'toggle-hidden': {
    description: 'Toggle the hidden attribute on the selected element.',
    build: ({ flags }) => ({ name: 'toggleHidden', params: { cur: flags.cur || 'master' } }),
    format: formatToggleHiddenResult,
  },
  'is-platform-preview': {
    description: 'Print IDE platform preview form factor (off, desktop, or mobile).',
    build: () => ({ name: 'isPlatformPreview' }),
    format: (result, io, argv) => {
      if (!result?.success) return die(result, io, argv);
      io.log(result.mode || 'off');
    },
  },
  'set-platform-preview': {
    description: 'Set IDE platform preview form factor to off, desktop, or mobile (off also returns the OS to web).',
    build: ({ flags, positionals }) => {
      let raw = String(flags.mode ?? flags.value ?? positionals[0] ?? '').trim().toLowerCase();
      if (!['off', 'desktop', 'mobile'].includes(raw)) {
        throw new Error('Specify off, desktop, or mobile (e.g. wf set-platform-preview desktop).');
      }
      return { name: 'setPlatformPreview', params: { mode: raw } };
    },
    format: (result, io, argv) => {
      if (!result?.success) return die(result, io, argv);
      io.log(`Platform Preview: ${result.mode || 'off'}`);
    },
  },
  'is-platform-os': {
    description: 'Print IDE platform preview OS (web, win, lin, mac, or android).',
    build: () => ({ name: 'isPlatformOs' }),
    format: (result, io, argv) => {
      if (!result?.success) return die(result, io, argv);
      io.log(result.os || 'web');
    },
  },
  'set-platform-os': {
    description: 'Set IDE platform preview OS: web (plain browser) or win, lin, mac, android (also enables native:* and a form factor).',
    build: ({ flags, positionals }) => {
      let raw = String(flags.os ?? flags.value ?? positionals[0] ?? '').trim().toLowerCase();
      if (!['web', 'win', 'lin', 'mac', 'android'].includes(raw)) {
        throw new Error('Specify web, win, lin, mac, or android (e.g. wf set-platform-os lin).');
      }
      return { name: 'setPlatformOs', params: { os: raw } };
    },
    format: (result, io, argv) => {
      if (!result?.success) return die(result, io, argv);
      io.log(`Platform OS: ${result.os || 'web'}`);
    },
  },
  'is-page-preview': {
    description: 'Print the open page mode: preview (page runs live) or edit (visual editor).',
    build: () => ({ name: 'isPagePreview' }),
    format: (result, io, argv) => {
      if (!result?.success) return die(result, io, argv);
      io.log(result.mode);
    },
  },
  'set-page-preview': {
    description: 'Switch the open page to preview or edit mode, or toggle between them.',
    build: ({ flags, positionals }) => {
      let raw = String(flags.mode ?? positionals[0] ?? '').trim().toLowerCase();
      if (raw !== 'preview' && raw !== 'edit' && raw !== 'toggle') {
        throw new Error('Specify preview, edit, or toggle (e.g. wf set-page-preview preview).');
      }
      return { name: 'setPagePreview', params: { mode: raw } };
    },
    format: (result, io, argv) => {
      if (!result?.success) return die(result, io, argv);
      io.log(`Page mode: ${result.mode}`);
    },
  },
  'change-html': {
    description: 'Replace the outer HTML of the selected element.',
    build: ({ flags }) => {
      let html = resolveHtml(flags);
      return { name: 'changeHtml', params: { html, cur: flags.cur || 'master' } };
    },
    format: formatSelectionResult,
  },
  'change-inner-html': {
    description: 'Replace the inner HTML of the selected element.',
    build: ({ flags }) => {
      let html = resolveHtml(flags);
      return { name: 'changeInnerHtml', params: { html, cur: flags.cur || 'master' } };
    },
    format: formatSelectionResult,
  },
  'change-form-method': {
    description: 'Update the method attribute on the selected form.',
    build: ({ flags, positionals }) => {
      let method = flags.method ?? positionals[0];
      if (!method) throw new Error('Specify --method <verb>.');
      return { name: 'changeFormMethod', params: { method, cur: flags.cur || 'master' } };
    },
    format: formatSelectionResult,
  },
  'set-if-expr': {
    description: 'Set the wf-if expression on the selection.',
    build: ({ flags, positionals }) => {
      let expr = flags.expr ?? positionals.join(' ');
      if (!expr) throw new Error('Provide expression via --expr or positional argument.');
      return { name: 'setIfExpression', params: { expr, cur: flags.cur || 'master' } };
    },
    format: makeExprFormatter('wf-if'),
  },
  'set-map-expr': {
    description: 'Set the wf-map expression on the selection.',
    build: ({ flags, positionals }) => {
      let expr = flags.expr ?? positionals.join(' ');
      if (!expr) throw new Error('Provide expression via --expr or positional argument.');
      return { name: 'setMapExpression', params: { expr, cur: flags.cur || 'master' } };
    },
    format: makeExprFormatter('wf-map'),
  },
  'set-event-handlers': {
    description: 'Replace all event handlers on the selected element.',
    build: ({ flags, positionals }) => {
      let handlers = parseHandlerSpecs(flags, positionals);
      return { name: 'setEventHandlers', params: { handlers, cur: flags.cur || 'master' } };
    },
    format: formatHandlersResult,
  },
  'add-event-handlers': {
    description: 'Add or overwrite specific event handlers on the selection.',
    build: ({ flags, positionals }) => {
      let handlers = parseHandlerSpecs(flags, positionals);
      return { name: 'addEventHandlers', params: { handlers, cur: flags.cur || 'master' } };
    },
    format: formatHandlersResult,
  },
  'rm-event-handlers': {
    description: 'Remove the specified event handlers from the selection.',
    build: ({ flags, positionals }) => {
      let events = parseEventNames(flags, positionals);
      return { name: 'removeEventHandlers', params: { events, cur: flags.cur || 'master' } };
    },
    format: formatHandlersResult,
  },
  'copy-selected': {
    description: 'Copy the currently selected element(s) to the clipboard.',
    build: ({ flags }) => ({ name: 'copySelected', params: { cur: flags.cur || 'master' } }),
    format: (result, io, argv) => {
      if (!result?.success) return die(result, io, argv);
      io.log('Copied selection to clipboard.');
      formatSelectionResult(result, io, argv);
    },
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
        html: resolveOptionalHtml(flags),
      },
    }),
    format: formatCreatedResult,
  };
}

function makePasteCommand(action, description) {
  return {
    description,
    build: ({ flags }) => ({
      name: action,
      params: {
        i: parseCount(flags.count),
        cur: flags.cur || 'master',
      },
    }),
    format: formatCreatedResult,
  };
}

function parseCount(value) {
  if (value == null) return 1;
  let n = Number(value);
  if (!Number.isFinite(n) || n < 1) throw new Error('count must be a positive integer');
  return Math.floor(n);
}

function parseTrueFalse(raw) {
  let s = String(raw).trim().toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  throw new Error(`Expected true or false, got: ${raw}`);
}

function gatherClasses(flags, positionals) {
  let classes = [];
  classes.push(...splitList(flags.classes));
  if (positionals.length) classes.push(...positionals);
  if (!classes.length) throw new Error('Provide classes via --classes "a b" or positional arguments.');
  return classes;
}

function splitList(value) {
  if (value == null) return [];
  let values = Array.isArray(value) ? value : [value];
  let out = [];
  for (let entry of values) {
    String(entry)
      .split(/[,\s]+/)
      .map(x => x.trim())
      .filter(Boolean)
      .forEach(val => out.push(val));
  }
  return out;
}

function parseFlags(args) {
  let flags = {};
  let positionals = [];
  for (let i = 0; i < args.length; i++) {
    let arg = args[i];
    if (arg.startsWith('--')) {
      let key = arg.slice(2);
      if (!key) throw new Error(`Invalid flag usage: ${arg}`);
      let next = args[i + 1];
      if (next && !next.startsWith('--')) {
        assignFlag(flags, key, next);
        i++;
      } else {
        assignFlag(flags, key, 'true');
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

function assignFlag(flags, key, value) {
  key = key.trim();
  if (!key) throw new Error('Flag name cannot be empty.');
  if (flags[key] === undefined) flags[key] = value;
  else if (Array.isArray(flags[key])) flags[key].push(value);
  else flags[key] = [flags[key], value];
}

function collectValues(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function formatChangeSelectionResult(result = {}, io, argv) {
  if (!result?.success) return die(result, io, argv);
  if (result.missingIds && result.missingIds.length) {
    io.error(`data-htmlsnap not found: ${result.missingIds.join(', ')}`);
    io.error('Run wf read-html to refresh the current markup snapshot.');
    io.code = 1;
  }
  formatSelectionResult(result, io, argv);
}

function formatSelectionResult(result = {}, io, argv) {
  if (!result?.success) return die(result, io, argv);
  io.log(`Selected: ${formatIds(result.selectedIds || [])}`);
}

function formatCreatedResult(result = {}, io, argv) {
  if (!result?.success) return die(result, io, argv);
  if (result.createdIds && result.createdIds.length) io.log(`Created: ${formatIds(result.createdIds)}`);
  formatSelectionResult(result, io, argv);
}

function formatHandlersResult(result = {}, io, argv) {
  if (!result?.success) return die(result, io, argv);
  let handlers = result.handlers || [];
  if (!handlers.length) io.log('Handlers: [none]');
  else {
    io.log('Handlers:');
    for (let { name, expr } of handlers) io.log(`  ${name} -> ${expr}`);
  }
  formatSelectionResult(result, io, argv);
}

function formatToggleHiddenResult(result = {}, io, argv) {
  if (!result?.success) return die(result, io, argv);
  io.log(`Hidden attribute: ${result.hidden ? 'yes' : 'no'}`);
  formatSelectionResult(result, io, argv);
}

function makeExprFormatter(label) {
  return (result, io, argv) => {
    if (result?.expr != null) io.log(`${label}: ${result.expr}`);
    formatSelectionResult(result, io, argv);
  };
}

function formatIds(ids) {
  return ids && ids.length ? ids.join(', ') : '[none]';
}

function parseHandlerSpecs(flags, positionals) {
  let specs = [];
  collectValues(flags.handler).forEach(v => specs.push(v));
  if (positionals.length) specs.push(...positionals);
  if (!specs.length) throw new Error('Provide handlers via --handler event=expression or positional arguments.');
  return specs.map(parseHandlerSpec);
}

function parseHandlerSpec(spec) {
  if (typeof spec !== 'string') throw new Error('Handler definitions must be in event=expression format.');
  let idx = spec.indexOf('=');
  if (idx === -1) throw new Error(`Handler must be in event=expression format: ${spec}`);
  let name = spec.slice(0, idx).trim();
  let expr = spec.slice(idx + 1).trim();
  if (!name || !expr) throw new Error(`Handler must include both event and expression: ${spec}`);
  return { name, expr };
}

function parseEventNames(flags, positionals) {
  let events = [];
  collectValues(flags.event).forEach(v => events.push(v));
  if (positionals.length) events.push(...positionals);
  events = events.map(v => String(v).trim()).filter(Boolean);
  if (!events.length) throw new Error('Provide events via --event name or positional arguments.');
  return events;
}

function resolveHtml(flags) {
  let html = collectValues(flags.html)[0];
  if (html != null) return html;
  throw new Error('Provide --html "<markup>".');
}

function resolveOptionalHtml(flags) {
  if (flags.html == null && flags.file == null) return undefined;
  return resolveHtml(flags);
}

function die(result, io, argv) {
  try {
    let shown = (argv || []).map(x => {
      let s = String(x);
      return s.length > 64 ? s.slice(0, 61) + '...' : s;
    });
    io.error(`wf ${shown.join(' ')}`);
  } catch {}
  let errText = '';
  if (typeof result?.error === 'string') errText = result.error;
  if (!errText && Array.isArray(result?.errors)) errText = result.errors.filter(Boolean).join('\n');
  if (!errText) errText = 'Command failed.';
  io.error(errText);
  let err = new Error(errText);
  err.wfExit = 1;
  throw err;
}

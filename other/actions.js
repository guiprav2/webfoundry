import codex from './codex.js';
import complete from './complete.js';
import confetti from 'https://esm.run/canvas-confetti';
import rfiles from '../repos/rfiles.js';
import { applyPatch } from './diff.js';
import { getOpenAIKey, complete as openaiComplete } from './openai.js';
import { loadman, joinPath } from '../other/util.js';
import { lookup as mimeLookup } from 'https://esm.run/mrmime';
import { minimatch } from 'https://esm.run/minimatch';

let TAILWIND_HUES = ['red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose', 'slate', 'gray', 'zinc', 'neutral', 'stone'];
let TAILWIND_SHADES = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'];
let TAILWIND_HUE_SET = new Set(TAILWIND_HUES);
let TAILWIND_SHADE_SET = new Set(TAILWIND_SHADES);
let TEXT_COLOR_RE = new RegExp(`^text-(${TAILWIND_HUES.join('|')})-(${TAILWIND_SHADES.join('|')})$`);
let BG_COLOR_RE = new RegExp(`^bg-(${TAILWIND_HUES.join('|')})-(${TAILWIND_SHADES.join('|')})$`);
let DEFAULT_SHADE = '500';

function getProjectPaths({ includeDirectories = false, excludeCurrent = false } = {}) {
  if (!state.projects?.current) return [];
  let entries = state.files?.list || [];
  let current = excludeCurrent ? state.files?.current : null;
  let found = [];
  for (let entry of entries) {
    if (!Array.isArray(entry)) continue;
    let [name, dir, isDir] = entry;
    if (!includeDirectories && isDir) continue;
    if (typeof name !== 'string') continue;
    let base = typeof dir === 'string' ? dir : '';
    let path = joinPath(base, name) || name || '';
    if (!path) continue;
    if (isDir && includeDirectories) path = `${path.replace(/\/+$/, '')}/`;
    if (excludeCurrent && current && path === current) continue;
    found.push(path);
  }
  return [...new Set(found)].sort();
}

let SHELL_COMMAND_GROUPS = [
  {
    heading: 'Project & Files',
    commands: [
      { syntax: 'selectFile [path]', description: 'Focus the specified file before reading or editing it.', tool: 'selectFile', args: [{ name: 'path', description: 'Relative path such as pages/index.html' }] },
      { syntax: 'createFile [path]', description: 'Create a new file (confirm directory in advance).', tool: 'createFile', args: [{ name: 'path', description: 'Full path of the new file' }] },
      { syntax: 'createDirectory [path]', description: 'Create a new directory.', tool: 'createDirectory', args: [{ name: 'path', description: 'Directory path to create' }] },
    ],
  },
  {
    heading: 'Designer Selection',
    commands: [
      { syntax: 'changeSelection [id ...]', description: 'Select elements by their data-htmlsnap IDs.', tool: 'changeSelection', args: [{ name: 'ids', description: 'One or more ids' }] },
      { syntax: 'toggleSelection', description: 'Toggle between the current selection and the previous one.', tool: 'toggleSelection' },
      { syntax: 'copySelected', description: 'Copy the current selection to the clipboard.', tool: 'copySelected' },
    ],
  },
  {
    heading: 'DOM Structure',
    commands: [
      { syntax: 'createFirstChild [--tag div] [--count 1]', description: 'Insert new first-child elements under the selection.', tool: 'createFirstChild' },
      { syntax: 'createLastChild [--tag div] [--count 1]', description: 'Insert new last-child elements under the selection.', tool: 'createLastChild' },
      { syntax: 'createNextSibling [--tag div] [--count 1]', description: 'Insert new sibling elements after the selection.', tool: 'createNextSibling' },
      { syntax: 'createPrevSibling [--tag div] [--count 1]', description: 'Insert new sibling elements before the selection.', tool: 'createPrevSibling' },
      { syntax: 'pasteNextSibling [--count 1]', description: 'Paste clipboard content after the selection.', tool: 'pasteNextSibling' },
      { syntax: 'pastePrevSibling [--count 1]', description: 'Paste clipboard content before the selection.', tool: 'pastePrevSibling' },
      { syntax: 'pasteFirstChild [--count 1]', description: 'Paste clipboard content as the first child.', tool: 'pasteFirstChild' },
      { syntax: 'pasteLastChild [--count 1]', description: 'Paste clipboard content as the last child.', tool: 'pasteLastChild' },
      { syntax: 'wrap [--tag div]', description: 'Wrap the selection inside a new element.', tool: 'wrap' },
      { syntax: 'unwrap', description: 'Unwrap the current selection.', tool: 'unwrap' },
      { syntax: 'deleteSelected', description: 'Delete the current selection.', tool: 'deleteSelected' },
      { syntax: 'changeHtml --html "<...>"', description: 'Replace the outer HTML of the selection.', tool: 'changeHtml' },
      { syntax: 'changeInnerHtml --html "<...>"', description: 'Replace the inner HTML of the selection.', tool: 'changeInnerHtml' },
    ],
  },
  {
    heading: 'Styling & Attributes',
    commands: [
      { syntax: 'changeElementTag --tag span', description: 'Change the tag name of selected elements.', tool: 'changeElementTag', args: [{ name: 'tag', description: 'New tag name' }] },
      { syntax: 'changeElementId --id header', description: 'Update the id attribute on the selection.', tool: 'changeElementId', args: [{ name: 'id', description: 'New id value' }] },
      { syntax: 'addCssClasses class...', description: 'Add Tailwind utility classes.', tool: 'addCssClasses', args: [{ name: 'cls', description: 'Classes to add' }] },
      { syntax: 'removeCssClasses class...', description: 'Remove specific classes.', tool: 'removeCssClasses', args: [{ name: 'cls', description: 'Classes to remove' }] },
      { syntax: 'replaceCssClasses --old old --classes "new"', description: 'Replace classes matching an existing string or /regex/.', tool: 'replaceCssClasses', args: [
        { name: 'old', description: 'Existing class string or /regex/' },
        { name: 'cls', description: 'Replacement classes' },
      ] },
      { syntax: 'replaceText "text"', description: 'Replace text content inside the selection.', tool: 'replaceTextContent', args: [{ name: 'text', description: 'New text content' }] },
      { syntax: 'setPlaceholder "text"', description: 'Set the placeholder attribute.', tool: 'changeInputPlaceholder', args: [{ name: 'placeholder', description: 'Placeholder text' }] },
      { syntax: 'setHref [url]', description: 'Set the href attribute on anchors.', tool: 'changeLinkUrl', args: [{ name: 'url', description: 'Link URL' }] },
      { syntax: 'setSrc [url] [expr]', description: 'Set the src attribute or wf-src binding.', tool: 'changeMediaSrc', args: [
        { name: 'url', description: 'Asset URL' },
        { name: 'expr', description: 'Optional wf-src expression' },
      ] },
      { syntax: 'setInputValue [value] [expr]', description: 'Set value or wf-value binding on inputs.', tool: 'setInputValue', args: [
        { name: 'value', description: 'Static value' },
        { name: 'expr', description: 'Binding expression' },
      ] },
      { syntax: 'changeFormMethod --method post', description: 'Update the method attribute on the selected form.', tool: 'changeFormMethod', args: [{ name: 'method', description: 'New form method' }] },
      { syntax: 'toggleHidden', description: 'Toggle the hidden attribute (useful alongside wf-if to declutter overlays).', tool: 'toggleHidden' },
      { syntax: 'setDisabledExpression expr', description: 'Set the wf-disabled expression.', tool: 'setDisabledExpression', args: [{ name: 'expr', description: 'Expression' }] },
      { syntax: 'isPlatformPreview', description: 'IDE platform preview form factor: off, desktop, or mobile (native:*/desktop:*/mobile:* in the designer).', tool: 'isPlatformPreview' },
      { syntax: 'setPlatformPreview off|desktop|mobile', description: 'Set IDE platform preview form factor for native:*/desktop:*/mobile:* utilities.', tool: 'setPlatformPreview', args: [{ name: 'mode', description: 'off, desktop, or mobile' }] },
      { syntax: 'isPlatformOs', description: 'IDE platform preview OS: web, win, lin, mac, or android.', tool: 'isPlatformOs' },
      { syntax: 'setPlatformOs web|win|lin|mac|android', description: 'Set IDE platform preview OS for win:*/lin:*/mac:*/android:* utilities (web = plain browser).', tool: 'setPlatformOs', args: [{ name: 'os', description: 'web, win, lin, mac, or android' }] },
      { syntax: 'isPagePreview', description: 'Current page mode: preview (page runs live) or edit (visual editor).', tool: 'isPagePreview' },
      { syntax: 'setPagePreview preview|edit|toggle', description: 'Switch the open page between preview and edit modes.', tool: 'setPagePreview', args: [{ name: 'mode', description: 'preview, edit, or toggle' }] },
    ],
  },
  {
    heading: 'Events & Interaction',
    commands: [
      { syntax: 'setIfExpression expr', description: 'Set the wf-if expression.', tool: 'setIfExpression', args: [{ name: 'expr', description: 'Condition expression' }] },
      { syntax: 'setMapExpression expr', description: 'Set the wf-map expression.', tool: 'setMapExpression', args: [{ name: 'expr', description: 'Loop expression' }] },
      { syntax: 'setEventHandlers handler=expr ...', description: 'Replace all event handlers on the selection.', tool: 'setEventHandlers', args: [{ name: 'handler', description: 'event=expression pair' }] },
      { syntax: 'addEventHandlers handler=expr ...', description: 'Add or overwrite specific event handlers.', tool: 'addEventHandlers', args: [{ name: 'handler', description: 'event=expression pair' }] },
      { syntax: 'removeEventHandlers event ...', description: 'Remove specific event handlers from the selection.', tool: 'removeEventHandlers', args: [{ name: 'event', description: 'Event name(s) to remove' }] },
    ],
  },
];
let actions = window.actions = {
  selectPanel: {
    description: `Only use upon user request or as a means to call user attention to something`,
    codexHidden: () => true,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: ['projects', 'files', 'styles', 'settings'] },
      },
    },
    handler: async ({ name }) => await post('app.selectPanel', name),
  },

  createProject: {
    disabled: () => [state.collab.uid !== 'master' && `Peers can't create projects.`],
    codexHidden: () => true,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: `New project name (prefer hostname/domain-like; empty prompts user)` },
      },
    },
    handler: async ({ name = null } = {}) => await post('projects.create', name),
  },

  listProjects: {
    disabled: () => [state.collab.uid !== 'master' && `Peers can't list projects.`],
    codexHidden: () => true,
    handler: () => ({ success: true, names: state.projects.list.map(x => x.split(':')[0]) }),
  },

  selectProject: {
    description: `Confirm exact requested project name by calling listProjects first.`,
    disabled: () => [state.collab.uid !== 'master' && `Peers can't select projects.`],
    codexHidden: () => true,
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
    },
    handler: async ({ name }) => await post('projects.select', state.projects.list.find(x => x.split(':')[0] === name)),
  },

  renameProject: {
    disabled: () => [state.collab.uid !== 'master' && `Peers can't create projects.`],
    codexHidden: () => true,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: `Project to rename (defaults to current)` },
        newName: { type: 'string', description: `New name (empty prompts user)` },
      },
    },
    handler: async ({ name = null, newName = null } = {}) => {
      let project = name ? state.projects.list.find(x => x.split(':')[0] === name) : state.projects.current;
      if (!project) throw new Error(`Project not found: ${name}`);
      return await post('projects.mv', project, newName);
    },
  },

  rmProject: {
    disabled: () => [state.collab.uid !== 'master' && `Peers can't create projects.`],
    codexHidden: () => true,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: `Project to remove (defaults to current)` },
      },
    },
    handler: async ({ name = null, newName = null } = {}) => {
      let project = name ? state.projects.list.find(x => x.split(':')[0] === name) : state.projects.current;
      if (!project) throw new Error(`Project not found: ${name}`);
      return await post('projects.rm', project);
    },
  },

  togglePreview: {
    disabled: () => [
      !state.designer.open && `Designer closed.`,
      state.collab.uid !== 'master' && `Peers can't toggle preview.`,
    ],
    codexHidden: () => true,
    handler: async () => await post('designer.togglePreview'),
  },

  toggleShell: { codexHidden: () => true, handler: async () => await post('shell.toggle') },

  createFile: {
    description: `Root files are rare; confirm in which directory to place the new file with user. When asked to "create a page" with a given name, this is probably what the user means.`,
    disabled: () => [
      !state.projects.current && `Project not open`,
      state.collab.uid !== 'master' && `Peers can't create files.`,
    ],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: `Full path to new file with extension (empty prompts user)` },
      },
    },
    handler: async ({ path = null } = {}) => {
      await post('files.create', path?.split?.('/')?.slice?.(0, -1)?.join?.('/'), path?.split?.('/')?.at?.(-1));
      return { success: true, path };
    },
  },

  createDirectory: {
    description: `Confirm in which directory to place the new directory with user.`,
    disabled: () => [
      !state.projects.current && `Project not open`,
      state.collab.uid !== 'master' && `Peers can't create directories.`,
    ],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: `Full path to new file with extension (empty prompts user)` },
      },
    },
    handler: async ({ path = null } = {}) => await post('files.create', path?.split?.('/')?.slice?.(0, -1)?.join?.('/'), path?.split?.('/')?.at?.(-1), 'dir'),
  },

  listFiles: {
    disabled: () => [!state.projects.current && `Project not open`],
    codexHidden: () => true,
    handler: () => {
      state.assistant.codexListBlock = true;
      return { success: true, paths: state.files.list.map(x => `${(x[2] ? 'd' : '-') + `rwxr-${x[2] ? 'x' : '-'}r-${x[2] ? 'x' : '-'}`}\t${joinPath(x[1], x[0])}`).join('\n') };
    },
  },

  mvFile: {
    disabled: () => [
      !state.projects.current && `Project not open`,
      state.collab.uid !== 'master' && `Peers can't move files.`,
    ],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: `File path to rename (defaults to current)` },
        newPath: { type: 'string', description: `New full file path (empty prompts user for simple rename on same path)` },
      },
    },
    handler: async ({ path = null, newPath = null } = {}) => await post('files.mv', path, newPath),
  },

  rmFile: {
    disabled: () => [
      !state.projects.current && `Project not open`,
      state.collab.uid !== 'master' && `Peers can't remove files.`,
    ],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: `Full path to remove (defaults to current)` },
      },
    },
    handler: async ({ path = state.files.current } = {}) => await post('files.rm', path),
  },

  selectFile: {
    description: `User may specify a file without the full path; use listFiles to find the right one if not ambiguous.`,
    disabled: () => [
      !state.projects.current && `Project not open`,
      state.collab.uid !== 'master' && `Peers can't select files.`,
    ],
    parameters: () => {
      let options = getProjectPaths({ includeDirectories: false, excludeCurrent: true });
      let pathProp = { type: 'string', description: `Full path to select` };
      if (options.length) pathProp.enum = options;
      return {
        type: 'object',
        properties: { path: pathProp },
      };
    },
    handler: async ({ path }) => {
      if (!path) throw new Error('No file specified.');
      if (path === state.files.current) return { success: true, path, note: 'File already selected.' };
      await post('files.select', path);
      return { success: true, path };
    },
  },

  getFileLineCount: {
    description: `LLM-only. Returns the total number of lines in a project file.`,
    disabled: () => [
      !state.projects.current && `Project not open`,
      state.collab.uid !== 'master' && `Peers can't read files.`,
    ],
    codexHidden: ({ path = state.files.current } = {}) => path?.endsWith?.('.html'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: `Full path relative to project root (defaults to the currently selected file)` },
      },
    },
    handler: async ({ path = state.files.current } = {}) => {
      if (!path) throw new Error('No file specified or selected.');
      let { lineCount } = await loadFileLines(path);
      return { success: true, path, lineCount };
    },
  },

  readFileLines: {
    description: `LLM-only. Reads a specific inclusive 1-based line range from a file.`,
    disabled: () => [
      !state.projects.current && `Project not open`,
      state.collab.uid !== 'master' && `Peers can't read files.`,
    ],
    codexHidden: ({ path = state.files.current } = {}) => path?.endsWith?.('.html'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: `Full path relative to project root (defaults to the currently selected file)` },
        startLine: { type: 'number', description: `First line to read (1-based, defaults to 1)` },
        endLine: { type: 'number', description: `Last line to read (inclusive)` },
        count: { type: 'number', description: `Number of lines to read starting at startLine (ignored if endLine provided)` },
      },
    },
    handler: async ({ path = state.files.current, startLine = 1, endLine = null, count = null } = {}) => {
      if (!path) throw new Error('No file specified or selected.');
      if (path.endsWith('.html')) return { success: false, error: `To read HTML, use selectFile instead` };
      let start = Number(startLine);
      if (!Number.isFinite(start)) start = 1;
      start = Math.max(1, Math.floor(start));
      let resolvedEnd = endLine;
      if (count != null) {
        let span = Number(count);
        if (!Number.isFinite(span) || span < 0) throw new Error('count must be a positive integer.');
        span = Math.floor(span);
        resolvedEnd = start + span - 1;
      }
      if (resolvedEnd == null) resolvedEnd = start;
      let end = Number(resolvedEnd);
      if (!Number.isFinite(end)) end = start;
      end = Math.max(start, Math.floor(end));
      let { lines, lineCount } = await loadFileLines(path);
      if (lineCount === 0) {
        return { success: true, path, totalLines: 0, startLine: null, endLine: null, hasMoreBefore: false, hasMoreAfter: false, lines: [] };
      }
      let maxLine = lineCount;
      let actualStart = Math.max(1, Math.min(start, maxLine));
      let actualEnd = Math.max(actualStart, Math.min(end, maxLine));
      let slice = [];
      for (let idx = actualStart - 1; idx < actualEnd; idx++) {
        let content = lines[idx] ?? '';
        slice.push({ lineNumber: idx + 1, content });
      }
      return slice.map(x => x.content).join('\n');
    },
  },

  applyPatch: {
    description: `Patches a file using GitHub's diff format. E.g.:
*** Begin patch
*** Update file: example.txt
@@
- A
+ B
*** End patch`,
    disabled: ({ path = state.files.current } = {}) => [
      !state.projects.current && `Project not open`,
      state.collab.uid !== 'master' && `Peers can't patch files.`,
      path?.endsWith?.('.html') && `Use other tools to edit HTML files.`,
    ],
    codexOnly: true,
    codexHidden: ({ path = state.files.current } = {}) => path?.endsWith?.('.html') || state.files.current !== path,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: `Full path relative to project root (defaults to the currently selected file)` },
        patch: { type: 'string', description: `Strict unified diff patch to apply` },
      },
      required: ['patch'],
    },
    handler: async ({ path = state.files.current, patch } = {}) => {
      let project = state.projects.current;
      let text = await (await rfiles.load(project, path)).text();
      let patched = applyPatch(patch.replaceAll(/ data-htmlsnap="[^"]+"/g, ''), { [path]: text });
      console.log('Patched', path, ':', patched[path]);
      if (!patched?.[path]) return { success: false, error: `Patch failed` };
      await rfiles.save(project, path, new Blob([patched[path]], { type: mimeLookup(path) }));
      let entry = state.codeEditor.docs.get(rawctrls.codeEditor.docKey(project, path));
      entry?.doc?.transact?.(() => { entry.text.delete(0, entry.text.length); entry.text.insert(0, patched[path]) }, 'applyPatch');
    },
  },

  writeFile: {
    description: `Creates and/or overwrites a file completely.`,
    disabled: ({ path = state.files.current } = {}) => [
      !state.projects.current && `Project not open`,
      state.collab.uid !== 'master' && `Peers can't write files.`,
      path?.endsWith?.('.html') && `Use other tools to edit HTML files.`,
    ],
    codexOnly: true,
    codexHidden: ({ path = state.files.current } = {}) => path?.endsWith?.('.html') || state.files.current !== path,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: `Full path relative to project root (defaults to the currently selected file)` },
        content: { type: 'string', description: `New file contents` },
      },
      required: ['content'],
    },
    handler: async ({ path = state.files.current, content } = {}) => {
      let project = state.projects.current;
      await rfiles.save(project, path, new Blob([content], { type: mimeLookup(path) }));
      let entry = state.codeEditor.docs.get(rawctrls.codeEditor.docKey(project, path));
      entry?.doc?.transact?.(() => { entry.text.delete(0, entry.text.length); entry.text.insert(0, content) }, 'writeFile');
    },
  },

  /*
  readFile: {
    description: `LLM-only. Reads the entire contents of a text file.`,
    disabled: () => [
      !state.projects.current && `Project not open`,
      state.collab.uid !== 'master' && `Peers can't read files.`,
    ],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: `Full path relative to project root (defaults to the currently selected file)` },
      },
    },
    handler: async ({ path = state.files.current } = {}) => {
      if (!path) throw new Error('No file specified or selected.');
      let { text, lineCount } = await loadFileLines(path);
      return { success: true, path, lineCount, content: text };
    },
  },
  */

  searchFilesSubstring: {
    description: `Searches project files for a substring and returns surrounding context lines.`,
    disabled: () => [
      !state.projects.current && `Project not open`,
      state.collab.uid !== 'master' && `Peers can't read files.`,
    ],
    parameters: () => {
      let fileOptions = getProjectPaths({ includeDirectories: false });
      let pathItem = { type: 'string' };
      if (fileOptions.length) pathItem.enum = fileOptions;
      return {
        type: 'object',
        properties: {
          query: { type: 'string', description: `Substring to search for (required)` },
          context: { type: 'number', description: `Number of context lines to include before and after each match (defaults to 2)` },
          caseSensitive: { type: 'boolean', description: `If true, match using case-sensitive comparison (defaults to false)` },
          paths: { type: 'array', items: pathItem, description: `Optional list of file paths to limit the search (don't forget file extensions)` },
          maxResults: { type: 'number', description: `Maximum number of matches to return (defaults to 20)` },
        },
        required: ['query'],
      };
    },
    handler: async ({ query, context = 2, caseSensitive = false, paths = [], maxResults = 20 } = {}) => {
      let textQuery = query == null ? '' : String(query);
      if (!textQuery.length) throw new Error('query must be a non-empty string.');
      let radius = Number(context);
      if (!Number.isFinite(radius) || radius < 0) radius = 2;
      radius = Math.floor(radius);
      let limit = Number(maxResults);
      if (!Number.isFinite(limit) || limit < 1) limit = 20;
      limit = Math.floor(limit);
      let pathFilter = null;
      if (Array.isArray(paths) && paths.length) {
        let sanitizedPaths = [];
        for (let value of paths) {
          if (value == null) continue;
          let str = String(value);
          if (!str.length) continue;
          sanitizedPaths.push(str);
        }
        if (sanitizedPaths.length) pathFilter = new Set(sanitizedPaths);
      }
      let project = state.projects.current;
      let allPaths = await rfiles.list(project);
      if (pathFilter) {
        let availablePaths = new Set(allPaths);
        for (let candidate of pathFilter) {
          if (!availablePaths.has(candidate)) throw new Error(`File not found: ${candidate}`);
        }
      }
      let needle = caseSensitive ? textQuery : textQuery.toLowerCase();
      let results = [];
      let scannedFiles = 0;
      let truncated = false;
      for (let path of allPaths) {
        if (pathFilter && !pathFilter.has(path)) continue;
        if (shouldSkipSearchPath(path)) continue;
        let type = mimeLookup(path) || '';
        if (!isLikelyTextFile(path, type)) continue;
        let fileData;
        try {
          fileData = await loadFileLines(path);
        } catch (err) {
          continue;
        }
        let lines = fileData.lines;
        let lineCount = fileData.lineCount;
        scannedFiles++;
        if (lineCount === 0) continue;
        for (let idx = 0; idx < lineCount; idx++) {
          let line = lines[idx] ?? '';
          let hay = caseSensitive ? line : line.toLowerCase();
          if (!hay.includes(needle)) continue;
          let from = Math.max(0, idx - radius);
          let to = Math.min(lineCount - 1, idx + radius);
          let snippet = [];
          for (let j = from; j <= to; j++) snippet.push({ lineNumber: j + 1, content: lines[j] ?? '' });
          let matchCount = 0;
          let searchIndex = 0;
          while (needle.length) {
            let foundIndex = hay.indexOf(needle, searchIndex);
            if (foundIndex === -1) break;
            matchCount++;
            searchIndex = foundIndex + needle.length;
          }
          results.push({ path, lineNumber: idx + 1, line, context: snippet, matchCountInLine: matchCount });
          if (results.length >= limit) { truncated = true; break; }
        }
        if (truncated) break;
      }
      return {
        success: true,
        query: textQuery,
        caseSensitive,
        context: radius,
        maxResults: limit,
        scannedFiles,
        totalFiles: allPaths.length,
        truncated,
        results,
      };
    },
  },

  /*
  getVisibleEditorContext: {
    description: `LLM-only. Returns the lines currently visible in the code editor plus optional surrounding context.`,
    disabled: () => [
      !rawctrls?.codeEditor?.state?.currentPath && `No file open in the code editor.`,
    ],
    parameters: {
      type: 'object',
      properties: {
        context: { type: 'number', description: `Number of extra lines to include before and after the visible region (defaults to 3)` },
      },
    },
    handler: async ({ context = 3 } = {}) => {
      let editorCtrl = rawctrls?.codeEditor;
      if (!editorCtrl) throw new Error('Code editor unavailable.');
      let path = editorCtrl.state.currentPath;
      if (!path) throw new Error('Code editor is not focused on a file.');
      let project = editorCtrl.state.currentProject;
      let radius = Number(context);
      if (!Number.isFinite(radius) || radius < 0) radius = 3;
      radius = Math.floor(radius);
      let cm = editorCtrl.currentDocEntry?.cm;
      if (cm) {
        let totalLines = cm.lineCount();
        let viewport = cm.getViewport ? cm.getViewport() : null;
        if (!viewport) throw new Error('Unable to determine visible range.');
        let firstVisible = Math.max(0, Math.min(viewport.from ?? 0, totalLines ? totalLines - 1 : 0));
        let lastVisible = Math.max(firstVisible, Math.min((viewport.to ?? firstVisible + 1) - 1, totalLines - 1));
        let startIndex = Math.max(0, firstVisible - radius);
        let endIndex = Math.min(totalLines - 1, lastVisible + radius);
        let lines = [];
        for (let idx = startIndex; idx <= endIndex; idx++) {
          let content = cm.getLine(idx) ?? '';
          lines.push({ lineNumber: idx + 1, content });
        }
        return {
          success: true,
          path,
          project,
          totalLines,
          firstVisibleLine: firstVisible + 1,
          lastVisibleLine: lastVisible + 1,
          contextRadius: radius,
          lines,
        };
      }
      if (editorCtrl.state.fallbackTextarea) {
        let text = editorCtrl.state.fallbackTextarea.value ?? '';
        let lines = splitLines(text).map((content, idx) => ({ lineNumber: idx + 1, content }));
        return {
          success: true,
          path,
          project,
          totalLines: lines.length,
          firstVisibleLine: 1,
          lastVisibleLine: lines.length,
          contextRadius: radius,
          lines,
          note: 'CodeMirror inactive; returning entire fallback textarea contents.',
        };
      }
      throw new Error('Code editor not ready.');
    },
  },

  jumpToEditorLine: {
    description: `LLM-only. Moves the cursor to the requested line (and optional column) in the active code editor without altering content.`,
    disabled: () => [
      !rawctrls?.codeEditor?.state?.currentPath && `No file open in the code editor.`,
    ],
    parameters: {
      type: 'object',
      properties: {
        line: { type: 'number', description: `1-based line to jump to (required)` },
        column: { type: 'number', description: `1-based column to focus (defaults to 1)` },
      },
      required: ['line'],
    },
    handler: async ({ line, column = 1 } = {}) => {
      let ctx = ensureEditorContext();
      let requestedLine = Number(line);
      if (!Number.isFinite(requestedLine)) throw new Error('line must be a number.');
      let requestedColumn = column == null ? 1 : Number(column);
      if (!Number.isFinite(requestedColumn)) requestedColumn = 1;
      requestedLine = Math.max(1, Math.floor(requestedLine));
      requestedColumn = Math.max(1, Math.floor(requestedColumn));
      let cm = ctx.cm;
      if (cm) {
        let totalLines = cm.lineCount();
        let zeroLine = Math.max(0, Math.min(requestedLine - 1, Math.max(0, totalLines - 1)));
        let lineText = cm.getLine(zeroLine) || '';
        let maxColumn = lineText.length + 1;
        let targetColumn = Math.max(1, Math.min(requestedColumn, maxColumn));
        let ch = targetColumn - 1;
        cm.focus();
        cm.setCursor({ line: zeroLine, ch });
        if (cm.scrollIntoView) cm.scrollIntoView({ line: zeroLine, ch }, 100);
        return { success: true, path: ctx.path, project: ctx.project, line: zeroLine + 1, column: ch + 1, totalLines, columnClamped: targetColumn !== requestedColumn };
      }
      if (ctx.textarea) {
        let raw = ctx.textarea.value || '';
        let lines = fallbackBuildLineIndex(raw);
        let pos = fallbackResolveLinePosition(lines, requestedLine, requestedColumn);
        ctx.textarea.focus();
        ctx.textarea.setSelectionRange(pos.index, pos.index);
        return { success: true, path: ctx.path, project: ctx.project, line: pos.lineNumber, column: pos.column, totalLines: lines.length, columnClamped: pos.column !== requestedColumn };
      }
      throw new Error('Code editor not ready.');
    },
  },

  setEditorSelection: {
    description: `LLM-only. Updates the selection range in the active code editor using 1-based line and column coordinates.`,
    disabled: () => [
      !rawctrls?.codeEditor?.state?.currentPath && `No file open in the code editor.`,
    ],
    parameters: {
      type: 'object',
      properties: {
        startLine: { type: 'number', description: `1-based starting line (required)` },
        startColumn: { type: 'number', description: `1-based starting column (defaults to 1)` },
        endLine: { type: 'number', description: `1-based ending line (defaults to startLine)` },
        endColumn: { type: 'number', description: `1-based ending column (defaults to startColumn)` },
      },
      required: ['startLine'],
    },
    handler: async ({ startLine, startColumn = 1, endLine = null, endColumn = null } = {}) => {
      let ctx = ensureEditorContext();
      let sLine = Number(startLine);
      if (!Number.isFinite(sLine)) throw new Error('startLine must be a number.');
      let sCol = startColumn == null ? 1 : Number(startColumn);
      if (!Number.isFinite(sCol)) sCol = 1;
      let eLine = endLine == null ? sLine : Number(endLine);
      if (!Number.isFinite(eLine)) eLine = sLine;
      let eCol = endColumn == null ? (endLine == null ? sCol : 1) : Number(endColumn);
      if (!Number.isFinite(eCol)) eCol = 1;
      sLine = Math.max(1, Math.floor(sLine));
      eLine = Math.max(1, Math.floor(eLine));
      sCol = Math.max(1, Math.floor(sCol));
      eCol = Math.max(1, Math.floor(eCol));
      let cm = ctx.cm;
      if (cm) {
        let totalLines = cm.lineCount();
        let startZero = Math.max(0, Math.min(sLine - 1, Math.max(0, totalLines - 1)));
        let endZero = Math.max(0, Math.min(eLine - 1, Math.max(0, totalLines - 1)));
        let startText = cm.getLine(startZero) || '';
        let endText = cm.getLine(endZero) || '';
        let startMaxCol = startText.length + 1;
        let endMaxCol = endText.length + 1;
        let startCh = Math.max(0, Math.min(sCol - 1, startMaxCol - 1));
        let endCh = Math.max(0, Math.min(eCol - 1, endMaxCol - 1));
        let anchor = { line: startZero, ch: startCh };
        let head = { line: endZero, ch: endCh };
        cm.focus();
        cm.setSelection(anchor, head);
        if (cm.scrollIntoView) {
          cm.scrollIntoView(anchor, 80);
          if (endLine != null || endColumn != null) cm.scrollIntoView(head, 80);
        }
        return {
          success: true,
          path: ctx.path,
          project: ctx.project,
          startLine: anchor.line + 1,
          startColumn: anchor.ch + 1,
          endLine: head.line + 1,
          endColumn: head.ch + 1,
          totalLines,
        };
      }
      if (ctx.textarea) {
        let raw = ctx.textarea.value || '';
        let lines = fallbackBuildLineIndex(raw);
        let startPos = fallbackResolveLinePosition(lines, sLine, sCol);
        let endPos = fallbackResolveLinePosition(lines, eLine, eCol);
        let anchorIndex = Math.min(startPos.index, endPos.index);
        let headIndex = Math.max(startPos.index, endPos.index);
        ctx.textarea.focus();
        ctx.textarea.setSelectionRange(anchorIndex, headIndex);
        if (ctx.entry) ctx.entry.lastSelection = { anchor: anchorIndex, head: headIndex };
        return {
          success: true,
          path: ctx.path,
          project: ctx.project,
          startLine: anchorIndex === startPos.index ? startPos.lineNumber : endPos.lineNumber,
          startColumn: anchorIndex === startPos.index ? startPos.column : endPos.column,
          endLine: headIndex === endPos.index ? endPos.lineNumber : startPos.lineNumber,
          endColumn: headIndex === endPos.index ? endPos.column : startPos.column,
          totalLines: lines.length,
        };
      }
      throw new Error('Code editor not ready.');
    },
  },

  insertTextAtCursor: {
    description: `LLM-only. Inserts or replaces text at the current cursor/selection without recreating the entire document.`,
    disabled: () => [
      !rawctrls?.codeEditor?.state?.currentPath && `No file open in the code editor.`,
      state.collab?.uid && state.collab.uid !== 'master' && `Peers can't edit files.`,
    ],
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: `Text to insert (required)` },
        replaceSelection: { type: 'boolean', description: `When false, collapses selection before inserting` },
        selectInserted: { type: 'boolean', description: `If true, select the inserted text` },
      },
      required: ['text'],
    },
    handler: async ({ text, replaceSelection = true, selectInserted = false } = {}) => {
      let payload = text == null ? '' : String(text);
      let ctx = ensureEditorContext({ requireWritable: true });
      let cm = ctx.cm;
      if (cm) {
        cm.focus();
        if (!replaceSelection && cm.somethingSelected && cm.somethingSelected()) {
          let collapses = cm.listSelections().map(sel => ({ anchor: sel.head, head: sel.head }));
          cm.setSelections(collapses, 0);
        }
        let selectionMode = selectInserted ? 'around' : 'end';
        cm.replaceSelection(payload, selectionMode);
        let cursor = cm.getCursor();
        return {
          success: true,
          path: ctx.path,
          project: ctx.project,
          cursorLine: cursor.line + 1,
          cursorColumn: cursor.ch + 1,
          length: payload.length,
        };
      }
      if (ctx.textarea) {
        let textarea = ctx.textarea;
        textarea.focus();
        let start = textarea.selectionStart ?? 0;
        let end = textarea.selectionEnd ?? start;
        if (!replaceSelection) end = start;
        textarea.setRangeText(payload, start, end, selectInserted ? 'select' : 'end');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        let newPos = textarea.selectionStart ?? 0;
        let raw = textarea.value || '';
        let lines = fallbackBuildLineIndex(raw);
        let cursorInfo = fallbackLineColumnFromIndex(lines, newPos);
        if (ctx.entry) ctx.entry.lastSelection = { anchor: textarea.selectionStart, head: textarea.selectionEnd };
        return {
          success: true,
          path: ctx.path,
          project: ctx.project,
          cursorLine: cursorInfo.line,
          cursorColumn: cursorInfo.column,
          length: payload.length,
        };
      }
      throw new Error('Code editor not ready.');
    },
  },
  */

  undo: {
    shortcut: ['Ctrl-z', 'z'],
    disabled: () => [!state.designer.open && `Designer closed.`],
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string', description: `Whose history to undo (defaults to master)` },
      },
    },
    handler: async ({ cur = 'master' } = {}) => {
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'undo' });
      let frame = state.designer.current;
      if (!frame.history[cur] || frame.ihistory[cur] < 1) return;
      --frame.ihistory[cur];
      await frame.history[cur][frame.ihistory[cur]](false);
    },
  },

  redo: {
    shortcut: ['Ctrl-y', 'y'],
    disabled: () => [!state.designer.open && `Designer closed.`],
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string', description: `Whose history to redo (defaults to master)` },
      },
    },
    handler: async ({ cur = 'master' } = {}) => {
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'redo' });
      let frame = state.designer.current;
      if (!frame.history[cur] || !frame.history[cur][frame.ihistory[cur]]) return;
      await frame.history[cur][frame.ihistory[cur]](true);
      ++frame.ihistory[cur];
    },
  },

  changeSelection: {
    description: `Select elements based on their data-htmlsnap IDs`,
    disabled: () => [!state.designer.open && `Designer closed.`],
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string', description: `Whose cursor to move (defaults to master)` },
        s: { type: 'array', items: { type: 'string' }, description: `IDs to select` },
      },
      required: ['s'],
    },
    handler: async ({ cur = 'master', s } = {}) => {
      if (document.activeElement.tagName !== 'BODY') document.activeElement.blur();
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'changeSelection', cur, s });
      let frame = state.designer.current;
      let requested = Array.isArray(s) ? s.map(x => String(x)) : [];
      let prevSelection = frame.cursors[cur] || [];
      let seen = new Set();
      let resolved = [];
      let missing = [];
      for (let id of requested) {
        let el = frame.map.get(id);
        if (!el || !frame.root.contains(el)) {
          console.log(id, el);
          missing.push(id);
          continue;
        }
        let key = frame.map.getKey(el);
        if (key && !seen.has(key)) {
          seen.add(key);
          resolved.push(key);
        }
      }
      if (!resolved.length) frame.lastCursors[cur] = prevSelection;
      frame.cursors[cur] = resolved;
      d.update();
      if (state.collab.uid === cur) await post('designer.toggleMobileKeyboard');
      await post('designer.sync', state.designer.current);
      await post('collab.sync');
      state.event.bus.emit('actions:changeSelection:ready', { s });
      let result = { success: true, selectedIds: [...frame.cursors[cur]] };
      if (missing.length) result.missingIds = missing;
      result.previousIds = [...prevSelection];
      return result;
    },
  },

  toggleSelection: {
    description: [
      `Toggles the current element selections;`,
      `if there is a selection, it unselects;`,
      `otherwise it restores the previous selection;`,
      `only use upon explicit user request`,
    ].join(' '),
    shortcut: 'Escape',
    disabled: () => [!state.designer.open && `Designer closed.`],
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string', description: `Whose cursor to toggle (defaults to master)` },
      },
    },
    handler: async ({ cur = 'master' } = {}) => {
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'toggleSelection', cur });
      let frame = state.designer.current;
      let sel = frame.cursors[cur] || [];
      if (sel.length) await actions.changeSelection.handler({ cur, s: [] });
      else if (frame.lastCursors[cur]?.length) await actions.changeSelection.handler({ cur, s: frame.lastCursors[cur] });
    },
  },

  selectParentElement: {
    description: `Moves selection to the parent element`,
    shortcut: ['ArrowLeft', 'h'],
    disabled: ({ cur = 'master' } = {}) => [
      !state.designer.open && `Designer closed.`,
      state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`,
    ],
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string', description: `Whose cursor to move (defaults to master)` },
        i: { type: 'number', description: `How far to go (defaults to 1)` },
      },
    },
    handler: async ({ cur = 'master', i = 1 } = {}) => {
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'selectParentElement', cur, i });
      let k = 'parentElement';
      let frame = state.designer.current;
      if (frame.cursors[cur].length !== 1) return;
      while (i-- > 0) {
        let s = frame.map.get(frame.cursors[cur][0]);
        s[k] && frame.root.contains(s[k]) && await actions.changeSelection.handler({ cur, s: [frame.map.getKey(s[k])] });
      }
    },
  },

  selectNextSibling: {
    shortcut: ['ArrowDown', 'j'],
    disabled: ({ cur = 'master' } = {}) => [
      !state.designer.open && `Designer closed.`,
      state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`,
    ],
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string', description: `Whose cursor to move (defaults to master)` },
        i: { type: 'number', description: `How far to go (defaults to 1)` },
      },
    },
    handler: async ({ cur = 'master', i = 1 } = {}) => {
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'selectNextSibling', cur, i });
      let k = 'nextElementSibling';
      let frame = state.designer.current;
      if (frame.cursors[cur].length !== 1) return;
      while (i-- > 0) {
        let s = frame.map.get(frame.cursors[cur][0]);
        s[k] && frame.root.contains(s[k]) && await actions.changeSelection.handler({ cur, s: [frame.map.getKey(s[k])] });
      }
    },
  },

  selectPrevSibling: {
    shortcut: ['ArrowUp', 'k'],
    disabled: ({ cur = 'master' } = {}) => [
      !state.designer.open && `Designer closed.`,
      state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`,
    ],
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string', description: `Whose cursor to move (defaults to master)` },
        i: { type: 'number', description: `How far to go (defaults to 1)` },
      },
    },
    handler: async ({ cur = 'master', i = 1 } = {}) => {
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'selectPrevSibling', cur, i });
      let k = 'previousElementSibling';
      let frame = state.designer.current;
      if (frame.cursors[cur].length !== 1) return;
      while (i-- > 0) {
        let s = frame.map.get(frame.cursors[cur][0]);
        s[k] && frame.root.contains(s[k]) && await actions.changeSelection.handler({ cur, s: [frame.map.getKey(s[k])] });
      }
    },
  },

  selectFirstChild: {
    shortcut: ['ArrowRight', 'l'],
    disabled: ({ cur = 'master' } = {}) => [
      !state.designer.open && `Designer closed.`,
      state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`,
    ],
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string', description: `Whose cursor to move (defaults to master)` },
        i: { type: 'number', description: `How far to go (defaults to 1)` },
      },
    },
    handler: async ({ cur = 'master', i = 1 } = {}) => {
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'selectFirstChild', cur, i });
      let k = 'firstElementChild';
      let frame = state.designer.current;
      if (frame.cursors[cur].length !== 1) return;
      while (i-- > 0) {
        let s = frame.map.get(frame.cursors[cur][0]);
        s[k] && frame.root.contains(s[k]) && await actions.changeSelection.handler({ cur, s: [frame.map.getKey(s[k])] });
      }
    },
  },

  selectLastChild: {
    shortcut: ['ArrowRight', 'l'],
    disabled: ({ cur = 'master' } = {}) => [
      !state.designer.open && `Designer closed.`,
      state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`,
    ],
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string', description: `Whose cursor to move (defaults to master)` },
        i: { type: 'number', description: `How far to go (defaults to 1)` },
      },
    },
    handler: async ({ cur = 'master', i = 1 } = {}) => {
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'selectLastChild', cur, i });
      let k = 'lastElementChild';
      let frame = state.designer.current;
      if (frame.cursors[cur].length !== 1) return;
      while (i-- > 0) {
        let s = frame.map.get(frame.cursors[cur][0]);
        s[k] && frame.root.contains(s[k]) && await actions.changeSelection.handler({ cur, s: [frame.map.getKey(s[k])] });
      }
    },
  },

  createNextSibling: {
    shortcut: 'a',
    disabled: ({ cur = 'master' } = {}) => [!state.designer.open && `Designer closed.`, state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`],
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string', description: `Relative to whose cursor (defaults to master)` },
        tag: { type: 'string', description: `Tag name to create (defaults to div)` },
        html: { type: 'string', description: `Optional HTML to use for the new node(s) instead of an empty element` },
        i: { type: 'number', description: `How many to create (defaults to 1)` },
      },
    },
    handler: async ({ cur = 'master', tag = 'div', html = null, i = 1 } = {}) => {
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'createNextSibling', cur, tag, html, i });
      let frame = state.designer.current;
      if (frame.cursors[cur].length !== 1) return;
      let ref = frame.map.get(frame.cursors[cur][0]);
      if (!ref || ref === frame.root) return;
      let refKey = frame.map.getKey(ref);
      let createdKeys = [];

      await post('designer.pushHistory', cur, async apply => {
        if (apply && !createdKeys.length) {
          createdKeys = await ifeval(async ({ args }) => {
            let ref = state.map.get(args.refKey);
            if (!ref) return [];
            let made = [];
            for (let n = 0; n < args.count; n++) {
              if (args.html && args.html.trim()) {
                let tpl = document.createElement('template');
                tpl.innerHTML = args.html;
                let nodes = [...tpl.content.childNodes].reverse();
                for (let node of nodes) {
                  ref.parentElement.insertBefore(node, ref.nextSibling);
                  if (node.nodeType === 1) made.push(node);
                }
              } else {
                let el = document.createElement(args.tag);
                ref.insertAdjacentElement('afterend', el);
                made.push(el);
              }
            }
            await new Promise(pres => setTimeout(pres));
            return made.map(x => state.map.getKey(x));
          }, { refKey, tag, html, count: i });
          await actions.changeSelection.handler({ cur, s: createdKeys });
        } else if (apply) {
          await ifeval(({ args }) => {
            let ref = state.map.get(args.refKey);
            if (!ref) return;
            for (let id of args.createdKeys) {
              let el = state.map.get(id);
              if (el) ref.insertAdjacentElement('afterend', el);
            }
          }, { refKey, createdKeys });
          await actions.changeSelection.handler({ cur, s: createdKeys });
        } else {
          await ifeval(({ args }) => { for (let id of args.createdKeys) state.map.get(id)?.remove(); }, { createdKeys });
          await actions.changeSelection.handler({ cur, s: [refKey] });
        }
      });
      let selectionIds = [...(frame.cursors[cur] || [])];
      let created = createdKeys.length ? createdKeys : selectionIds;
      return { success: true, createdIds: created, selectedIds: selectionIds };
    },
  },

  createPrevSibling: {
    shortcut: 'A',
    disabled: ({ cur = 'master' } = {}) => [!state.designer.open && `Designer closed.`, state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`],
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string', description: `Relative to whose cursor (defaults to master)` },
        tag: { type: 'string', description: `Tag name to create (defaults to div)` },
        html: { type: 'string', description: `Optional HTML to use for the new node(s) instead of an empty element` },
        i: { type: 'number', description: `How many to create (defaults to 1)` },
      },
    },
    handler: async ({ cur = 'master', tag = 'div', html = null, i = 1 } = {}) => {
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'createPrevSibling', cur, tag, i });
      let frame = state.designer.current;
      if (frame.cursors[cur].length !== 1) return;
      let ref = frame.map.get(frame.cursors[cur][0]);
      if (!ref || ref === frame.root) return;
      let refKey = frame.map.getKey(ref);
      let createdKeys = [];

      await post('designer.pushHistory', cur, async apply => {
        if (apply && !createdKeys.length) {
          createdKeys = await ifeval(async ({ args }) => {
            let ref = state.map.get(args.refKey);
            if (!ref) return [];
            let made = [];
            for (let n = 0; n < args.count; n++) {
              if (args.html && args.html.trim()) {
                let tpl = document.createElement('template');
                tpl.innerHTML = args.html;
                let nodes = [...tpl.content.childNodes];
                for (let node of nodes) {
                  ref.parentElement.insertBefore(node, ref);
                  if (node.nodeType === 1) made.push(node);
                }
              } else {
                let el = document.createElement(args.tag);
                ref.insertAdjacentElement('beforebegin', el);
                made.push(el);
              }
            }
            await new Promise(pres => setTimeout(pres));
            return made.map(x => state.map.getKey(x));
          }, { refKey, tag, html, count: i });
          await actions.changeSelection.handler({ cur, s: createdKeys });
        } else if (apply) {
          await ifeval(({ args }) => {
            let ref = state.map.get(args.refKey);
            if (!ref) return;
            for (let id of args.createdKeys) {
              let el = state.map.get(id);
              if (el) ref.insertAdjacentElement('beforebegin', el);
            }
          }, { refKey, createdKeys });
          await actions.changeSelection.handler({ cur, s: createdKeys });
        } else {
          await ifeval(({ args }) => { for (let id of args.createdKeys) state.map.get(id)?.remove(); }, { createdKeys });
          await actions.changeSelection.handler({ cur, s: [refKey] });
        }
      });
      let selectionIds = [...(frame.cursors[cur] || [])];
      let created = createdKeys.length ? createdKeys : selectionIds;
      return { success: true, createdIds: created, selectedIds: selectionIds };
    },
  },

  createLastChild: {
    shortcut: 'i',
    disabled: ({ cur = 'master' } = {}) => [!state.designer.open && `Designer closed.`, state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`],
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string', description: `Relative to whose cursor (defaults to master)` },
        tag: { type: 'string', description: `Tag name to create (defaults to div)` },
        html: { type: 'string', description: `Optional HTML for created node(s)` },
        i: { type: 'number', description: `How many to create (defaults to 1)` },
      },
    },
    handler: async ({ cur = 'master', tag = 'div', html = null, i = 1 } = {}) => {
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'createLastChild', cur, tag, html, i });
      let frame = state.designer.current;
      if (frame.cursors[cur].length !== 1) return;
      let parent = frame.map.get(frame.cursors[cur][0]);
      if (!parent) return;
      let parentKey = frame.map.getKey(parent);
      let createdKeys = [];

      await post('designer.pushHistory', cur, async apply => {
        if (apply && !createdKeys.length) {
          createdKeys = await ifeval(async ({ args }) => {
            let parent = state.map.get(args.parentKey);
            if (!parent) return [];
            let made = [];
            for (let n = 0; n < args.count; n++) {
              if (args.html && args.html.trim()) {
                let tpl = document.createElement('template');
                tpl.innerHTML = args.html;
                let nodes = [...tpl.content.childNodes];
                for (let node of nodes) {
                  parent.appendChild(node);
                  if (node.nodeType === 1) made.push(node);
                }
              } else {
                let el = document.createElement(args.tag);
                parent.insertAdjacentElement('beforeend', el);
                made.push(el);
              }
            }
            await new Promise(pres => setTimeout(pres));
            return made.map(x => state.map.getKey(x));
          }, { parentKey, tag, html, count: i });
          await actions.changeSelection.handler({ cur, s: createdKeys });
        } else if (apply) {
          await ifeval(({ args }) => {
            let parent = state.map.get(args.parentKey);
            if (!parent) return;
            for (let id of args.createdKeys) {
              let el = state.map.get(id);
              if (el) parent.insertAdjacentElement('beforeend', el);
            }
          }, { parentKey, createdKeys });
          await actions.changeSelection.handler({ cur, s: createdKeys });
        } else {
          await ifeval(({ args }) => { for (let id of args.createdKeys) state.map.get(id)?.remove(); }, { createdKeys });
          await actions.changeSelection.handler({ cur, s: [parentKey] });
        }
      });
      let selectionIds = [...(frame.cursors[cur] || [])];
      let created = createdKeys.length ? createdKeys : selectionIds;
      return { success: true, createdIds: created, selectedIds: selectionIds };
    },
  },

  createFirstChild: {
    shortcut: 'I',
    disabled: ({ cur = 'master' } = {}) => [!state.designer.open && `Designer closed.`, state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`],
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string', description: `Relative to whose cursor (defaults to master)` },
        tag: { type: 'string', description: `Tag name to create (defaults to div)` },
        html: { type: 'string', description: `Optional HTML for created node(s)` },
        i: { type: 'number', description: `How many to create (defaults to 1)` },
      },
    },
    handler: async ({ cur = 'master', tag = 'div', html = null, i = 1 } = {}) => {
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'createFirstChild', cur, tag, html, i });
      let frame = state.designer.current;
      if (frame.cursors[cur].length !== 1) return;
      let parent = frame.map.get(frame.cursors[cur][0]);
      if (!parent) return;
      let parentKey = frame.map.getKey(parent);
      let createdKeys = [];

      await post('designer.pushHistory', cur, async apply => {
        if (apply && !createdKeys.length) {
          createdKeys = await ifeval(async ({ args }) => {
            let parent = state.map.get(args.parentKey);
            if (!parent) return [];
            let made = [];
            for (let n = 0; n < args.count; n++) {
              if (args.html && args.html.trim()) {
                let tpl = document.createElement('template');
                tpl.innerHTML = args.html;
                let nodes = [...tpl.content.childNodes].reverse();
                for (let node of nodes) {
                  parent.insertBefore(node, parent.firstChild);
                  if (node.nodeType === 1) made.push(node);
                }
              } else {
                let el = document.createElement(args.tag);
                parent.insertAdjacentElement('afterbegin', el);
                made.push(el);
              }
            }
            await new Promise(pres => setTimeout(pres));
            return made.map(x => state.map.getKey(x));
          }, { parentKey, tag, html, count: i });
          await actions.changeSelection.handler({ cur, s: createdKeys });
        } else if (apply) {
          await ifeval(({ args }) => {
            let parent = state.map.get(args.parentKey);
            if (!parent) return;
            for (let id of args.createdKeys) {
              let el = state.map.get(id);
              if (el) parent.insertAdjacentElement('afterbegin', el);
            }
          }, { parentKey, createdKeys });
          await actions.changeSelection.handler({ cur, s: createdKeys });
        } else {
          await ifeval(({ args }) => { for (let id of args.createdKeys) state.map.get(id)?.remove(); }, { createdKeys });
          await actions.changeSelection.handler({ cur, s: [parentKey] });
        }
      });
      let selectionIds = [...(frame.cursors[cur] || [])];
      let created = createdKeys.length ? createdKeys : selectionIds;
      return { success: true, createdIds: created, selectedIds: selectionIds };
    },
  },

  changeElementId: {
    shortcut: 'g',
    disabled: ({ cur = 'master' } = {}) => [
      !state.designer.open && `Designer closed.`,
      state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`,
    ],
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string', description: `Whose selection to change ID (defaults to master)` },
        id: { type: 'string', description: `New element ID (default prompts user)` },
      },
    },
    handler: async ({ cur = 'master', id = null } = {}) => {
      let frame = state.designer.current;
      let targets = frame.cursors[cur].map(x => frame.map.get(x)).filter(Boolean);
      if (!targets.length) return;
      if (id == null) {
        let [btn, val] = await showModal('PromptDialog', {
          title: 'Change element ID',
          label: 'New ID',
          initialValue: targets[0].id || '',
        });
        if (btn !== 'ok') return;
        id = val.trim();
      }
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'changeElementId', cur, id });
      let targetKeys = targets.map(x => frame.map.getKey(x));
      let prev = targets.map(x => x.getAttribute('id'));
      await post('designer.pushHistory', cur, async apply => {
        await ifeval(({ args }) => {
          for (let n = 0; n < args.targets.length; n++) {
            let el = state.map.get(args.targets[n]);
            if (!el) continue;
            let nv = args.apply ? args.newId : args.prev[n];
            if (nv) el.setAttribute('id', nv);
            else el.removeAttribute('id');
          }
        }, { targets: targetKeys, newId: id, prev, apply });
        await actions.changeSelection.handler({ cur, s: targetKeys });
      });
    },
  },

  changeElementTag: {
    shortcut: 'e',
    disabled: ({ cur = 'master' } = {}) => [!state.designer.open && `Designer closed.`, state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`],
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string', description: `Whose selection to change tag (defaults to master)` },
        tag: { type: 'string', description: `New tag name (default prompts user)` },
      },
    },
    handler: async ({ cur = 'master', tag = null } = {}) => {
      let frame = state.designer.current;
      let targets = frame.cursors[cur].map(x => frame.map.get(x)).filter(Boolean);
      if (!targets.length) return;

      if (!tag) {
        let [btn, val] = await showModal('PromptDialog', { title: 'Change tag', label: 'Tag name', initialValue: targets[0].tagName.toLowerCase() });
        if (btn !== 'ok' || !val.trim()) return;
        tag = val.trim();
      }

      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'changeElementTag', cur, tag });

      let targetKeys = targets.map(x => frame.map.getKey(x));
      let parentKeys = targets.map(x => frame.map.getKey(x.parentElement));
      let idxs = targets.map(x => [...x.parentElement.children].indexOf(x));
      let newKeys = [];

      await post('designer.pushHistory', cur, async apply => {
        if (apply && !newKeys.length) {
          newKeys = await ifeval(async ({ args }) => {
            let created = [];
            for (let n = 0; n < args.targets.length; n++) {
              let el = state.map.get(args.targets[n]);
              let p = state.map.get(args.parents[n]);
              let i = args.idxs[n];
              if (!el || !p) continue;
              if (el.tagName.toLowerCase() === args.tag) {
                created.push(state.map.getKey(el));
                continue;
              }
              let clone = document.createElement(args.tag);
              for (let a of el.attributes) clone.setAttribute(a.name, a.value);
              clone.innerHTML = el.innerHTML;
              if (p.children[i] === el) p.replaceChild(clone, el);
              created.push(clone);
            }
            await new Promise(pres => setTimeout(pres));
            return created.map(x => state.map.getKey(x));
          }, { targets: targetKeys, parents: parentKeys, idxs, tag });
          await actions.changeSelection.handler({ cur, s: newKeys });
        } else if (apply) {
          await ifeval(({ args }) => {
            for (let n = 0; n < args.targets.length; n++) {
              let el = state.map.get(args.targets[n]);
              let p = state.map.get(args.parents[n]);
              let i = args.idxs[n];
              let clone = state.map.get(args.newKeys[n]);
              if (!el || !p || !clone) continue;
              if (p.children[i] === el && el.tagName.toLowerCase() !== clone.tagName.toLowerCase()) p.replaceChild(clone, el);
            }
          }, { targets: targetKeys, parents: parentKeys, idxs, newKeys });
          await actions.changeSelection.handler({ cur, s: newKeys });
        } else {
          await ifeval(({ args }) => {
            for (let n = 0; n < args.targets.length; n++) {
              let el = state.map.get(args.targets[n]);
              let p = state.map.get(args.parents[n]);
              let i = args.idxs[n];
              let clone = state.map.get(args.newKeys[n]);
              if (!el || !p || !clone) continue;
              if (p.children[i] === clone && clone.tagName.toLowerCase() !== el.tagName.toLowerCase()) p.replaceChild(el, clone);
            }
          }, { targets: targetKeys, parents: parentKeys, idxs, newKeys });
          await actions.changeSelection.handler({ cur, s: targetKeys });
        }
      });
    },
  },

  copySelected: {
    description: `Copies currently selected element(s)`,
    shortcut: 'c',
    disabled: ({ cur = 'master' } = {}) => [
      !state.designer.open && `Designer closed.`,
      state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`,
    ],
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string', description: `Whose selection to copy (defaults to master)` },
      },
    },
    handler: async ({ cur = 'master' } = {}) => {
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'copySelected', cur });
      let frame = state.designer.current;
      let els = frame.cursors[cur].map(id => frame.map.get(id)).filter(Boolean);
      for (let x of els) { x.removeAttribute('data-htmlsnap'); x.querySelectorAll('*').forEach(y => y.removeAttribute('data-htmlsnap')) }
      let html = els.map(n => n.outerHTML).join('\n');
      state.designer.clipboards[cur] = html;
      localStorage.setItem('webfoundry:clipboard', html);
      d.update();
      await post('collab.sync');
    },
  },

  deleteSelected: {
    description: `Deletes and copies currently selected element(s)`,
    shortcut: 'd',
    disabled: ({ cur = 'master' } = {}) => [
      !state.designer.open && `Designer closed.`,
      state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`,
    ],
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string', description: `Relative to whose cursor (defaults to master)` },
        i: { type: 'number', description: `How many times to delete (defaults to 1)` },
      },
    },
    handler: async ({ cur = 'master', i = 1 } = {}) => {
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'deleteSelected', cur, i });
      let frame = state.designer.current;
      await actions.copySelected.handler({ cur });
      while (i-- > 0) {
        let cursors = frame.cursors[cur];
        let ss = cursors.map(x => frame.map.get(x)).filter(x => x && x !== frame.root && x !== frame.root && x !== frame.head);
        if (!ss.length) return;
        let removedKeys = ss.map(x => frame.map.getKey(x));
        let parentKeys = ss.map(x => frame.map.getKey(x.parentElement));
        let idxs = ss.map(x => [...x.parentElement.children].indexOf(x));
        let selectKeys = [];
        await post('designer.pushHistory', cur, async apply => {
          if (apply && !selectKeys.length) {
            let result = await ifeval(async ({ args }) => {
              let select = new Set();
              let removed = [];
              for (let n = 0; n < args.removed.length; n++) {
                let el = state.map.get(args.removed[n]);
                let p = state.map.get(args.parents[n]);
                let idx = args.idxs[n];
                if (!el || !p) continue;
                removed.push(state.map.getKey(el));
                el.remove();
                let next = p.children[idx] || p.children[idx - 1];
                if (next && !args.removed.includes(state.map.getKey(next))) select.add(next);
                else select.add(p);
              }
              await new Promise(pres => setTimeout(pres));
              return { removed, select: [...select].map(x => state.map.getKey(x)) };
            }, { removed: removedKeys, parents: parentKeys, idxs });
            removedKeys = result.removed;
            selectKeys = result.select;
            await actions.changeSelection.handler({ cur, s: selectKeys });
          } else if (apply) {
            let result = await ifeval(async ({ args }) => {
              let select = new Set();
              for (let n = 0; n < args.removed.length; n++) {
                let el = state.map.get(args.removed[n]);
                let p = state.map.get(args.parents[n]);
                let idx = args.idxs[n];
                if (!el || !p) continue;
                el.remove();
                let next = p.children[idx] || p.children[idx - 1];
                if (next && !args.removed.includes(state.map.getKey(next))) select.add(next);
                else select.add(p);
              }
              await new Promise(pres => setTimeout(pres));
              return [...select].map(x => state.map.getKey(x));
            }, { removed: removedKeys, parents: parentKeys, idxs });
            selectKeys = result;
            await actions.changeSelection.handler({ cur, s: selectKeys });
          } else {
            await ifeval(({ args }) => {
              for (let n = 0; n < args.removed.length; n++) {
                let el = state.map.get(args.removed[n]);
                let p = state.map.get(args.parents[n]);
                let idx = args.idxs[n];
                if (!p || !el) continue;
                if (p.children[idx]) p.insertBefore(el, p.children[idx]);
                else p.appendChild(el);
              }
            }, { removed: removedKeys, parents: parentKeys, idxs });
            await actions.changeSelection.handler({ cur, s: removedKeys });
          }
        });
      }
    },
  },

  pasteNextSibling: {
    description: `Pastes copied elements as the next sibling`,
    shortcut: 'p',
    disabled: ({ cur = 'master' } = {}) => [
      !state.designer.open && `Designer closed.`,
      state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`,
    ],
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string', description: `Target cursor for paste (defaults to master)` },
        i: { type: 'number', description: `How many copies to paste (defaults to 1)` },
      },
    },
    handler: async ({ cur = 'master', i = 1 } = {}) => {
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'pasteNextSibling', cur, i });
      let frame = state.designer.current;
      let html = state.designer.clipboards[cur] || localStorage.getItem('webfoundry:clipboard');
      if (!html) return;
      let pos = 'afterend';
      let cursors = [...frame.cursors[cur] || []];
      if (!cursors.length) return;
      let cloneIds = [];
      await post('designer.pushHistory', cur, async apply => {
        if (apply && !cloneIds.length) {
          cloneIds = await ifeval(async ({ args }) => {
            let template = document.createElement('template');
            template.innerHTML = args.html;
            let frags = [...template.content.children];
            if (!frags.length) return [];
            let reversed = args.pos === 'afterbegin';
            let items = reversed ? [...args.cursors].reverse() : args.cursors;
            let added = [];
            for (let i = 0; i < items.length; i++) {
              let f = frags[i % frags.length].cloneNode(true);
              state.map.get(items[i]).insertAdjacentElement(args.pos, f);
              added.push(f);
            }
            await new Promise(pres => setTimeout(pres));
            return added.map(x => state.map.getKey(x));
          }, { html, cursors, pos });
          await actions.changeSelection.handler({ cur, s: cloneIds });
        } else if (apply) {
          await ifeval(({ args }) => { for (let id of args.cloneIds) state.map.get(args.cursors[0])?.insertAdjacentElement?.(args.pos, state.map.get(id)) }, { cloneIds, cursors, pos });
          await actions.changeSelection.handler({ cur, s: cloneIds });
        } else {
          await ifeval(({ args }) => { for (let id of args.cloneIds) state.map.get(id)?.remove?.() }, { cloneIds });
          await actions.changeSelection.handler({ cur, s: cursors.map(x => frame.map.get(x)).filter(Boolean).map(x => frame.map.getKey(x)) });
        }
      });
    },
  },

  pastePrevSibling: {
    description: `Pastes copied elements as the previous sibling`,
    shortcut: 'P',
    disabled: ({ cur = 'master' } = {}) => [
      !state.designer.open && `Designer closed.`,
      state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`,
    ],
    parameters: {
      type: 'object',
      properties: { cur: { type: 'string', description: `Target cursor for paste (defaults to master)` }, i: { type: 'number', description: `How many copies to paste (defaults to 1)` } },
    },
    handler: async ({ cur = 'master', i = 1 } = {}) => {
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'pastePrevSibling', cur, i });
      let frame = state.designer.current; let html = state.designer.clipboards[cur] || localStorage.getItem('webfoundry:clipboard'); if (!html) return;
      let pos = 'beforebegin'; let cursors = [...frame.cursors[cur] || []]; if (!cursors.length) return; let cloneIds = [];
      await post('designer.pushHistory', cur, async apply => {
        if (apply && !cloneIds.length) {
          cloneIds = await ifeval(async ({ args }) => {
            let template = document.createElement('template'); template.innerHTML = args.html; let frags = [...template.content.children]; if (!frags.length) return [];
            let reversed = args.pos === 'afterbegin'; let items = reversed ? [...args.cursors].reverse() : args.cursors; let added = [];
            for (let i = 0; i < items.length; i++) { let f = frags[i % frags.length].cloneNode(true); state.map.get(items[i]).insertAdjacentElement(args.pos, f); added.push(f); }
            await new Promise(pres => setTimeout(pres)); return added.map(x => state.map.getKey(x));
          }, { html, cursors, pos });
          await actions.changeSelection.handler({ cur, s: cloneIds });
        } else if (apply) {
          await ifeval(({ args }) => { for (let id of args.cloneIds) state.map.get(args.cursors[0])?.insertAdjacentElement?.(args.pos, state.map.get(id)) }, { cloneIds, cursors, pos });
          await actions.changeSelection.handler({ cur, s: cloneIds });
        } else {
          await ifeval(({ args }) => { for (let id of args.cloneIds) state.map.get(id)?.remove?.() }, { cloneIds });
          await actions.changeSelection.handler({ cur, s: cursors.map(x => frame.map.get(x)).filter(Boolean).map(x => frame.map.getKey(x)) });
        }
      });
    },
  },

  pasteLastChild: {
    description: `Pastes copied elements as the last child`,
    shortcut: 'o',
    disabled: ({ cur = 'master' } = {}) => [
      !state.designer.open && `Designer closed.`,
      state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`,
    ],
    parameters: {
      type: 'object',
      properties: { cur: { type: 'string', description: `Target cursor for paste (defaults to master)` }, i: { type: 'number', description: `How many copies to paste (defaults to 1)` } },
    },
    handler: async ({ cur = 'master', i = 1 } = {}) => {
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'pasteLastChild', cur, i });
      let frame = state.designer.current; let html = state.designer.clipboards[cur] || localStorage.getItem('webfoundry:clipboard'); if (!html) return;
      let pos = 'beforeend'; let cursors = [...frame.cursors[cur] || []]; if (!cursors.length) return; let cloneIds = [];
      await post('designer.pushHistory', cur, async apply => {
        if (apply && !cloneIds.length) {
          cloneIds = await ifeval(async ({ args }) => {
            let template = document.createElement('template'); template.innerHTML = args.html; let frags = [...template.content.children]; if (!frags.length) return [];
            let reversed = args.pos === 'afterbegin'; let items = reversed ? [...args.cursors].reverse() : args.cursors; let added = [];
            for (let i = 0; i < items.length; i++) { let f = frags[i % frags.length].cloneNode(true); state.map.get(items[i]).insertAdjacentElement(args.pos, f); added.push(f); }
            await new Promise(pres => setTimeout(pres)); return added.map(x => state.map.getKey(x));
          }, { html, cursors, pos });
          await actions.changeSelection.handler({ cur, s: cloneIds });
        } else if (apply) {
          await ifeval(({ args }) => { for (let id of args.cloneIds) state.map.get(args.cursors[0])?.insertAdjacentElement?.(args.pos, state.map.get(id)) }, { cloneIds, cursors, pos });
          await actions.changeSelection.handler({ cur, s: cloneIds });
        } else {
          await ifeval(({ args }) => { for (let id of args.cloneIds) state.map.get(id)?.remove?.() }, { cloneIds });
          await actions.changeSelection.handler({ cur, s: cursors.map(x => frame.map.get(x)).filter(Boolean).map(x => frame.map.getKey(x)) });
        }
      });
    },
  },

  pasteFirstChild: {
    description: `Pastes copied elements as the first child`,
    shortcut: 'O',
    disabled: ({ cur = 'master' } = {}) => [
      !state.designer.open && `Designer closed.`,
      state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`,
    ],
    parameters: {
      type: 'object',
      properties: { cur: { type: 'string', description: `Target cursor for paste (defaults to master)` }, i: { type: 'number', description: `How many copies to paste (defaults to 1)` } },
    },
    handler: async ({ cur = 'master', i = 1 } = {}) => {
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'pasteFirstChild', cur, i });
      let frame = state.designer.current; let html = state.designer.clipboards[cur] || localStorage.getItem('webfoundry:clipboard'); if (!html) return;
      let pos = 'afterbegin'; let cursors = [...frame.cursors[cur] || []]; if (!cursors.length) return; let cloneIds = [];
      await post('designer.pushHistory', cur, async apply => {
        if (apply && !cloneIds.length) {
          cloneIds = await ifeval(async ({ args }) => {
            let template = document.createElement('template'); template.innerHTML = args.html; let frags = [...template.content.children]; if (!frags.length) return [];
            let reversed = args.pos === 'afterbegin'; let items = reversed ? [...args.cursors].reverse() : args.cursors; let added = [];
            for (let i = 0; i < items.length; i++) { let f = frags[i % frags.length].cloneNode(true); state.map.get(items[i]).insertAdjacentElement(args.pos, f); added.push(f); }
            await new Promise(pres => setTimeout(pres)); return added.map(x => state.map.getKey(x));
          }, { html, cursors, pos });
          await actions.changeSelection.handler({ cur, s: cloneIds });
        } else if (apply) {
          await ifeval(({ args }) => { for (let id of args.cloneIds) state.map.get(args.cursors[0])?.insertAdjacentElement?.(args.pos, state.map.get(id)) }, { cloneIds, cursors, pos });
          await actions.changeSelection.handler({ cur, s: cloneIds });
        } else {
          await ifeval(({ args }) => { for (let id of args.cloneIds) state.map.get(id)?.remove?.() }, { cloneIds });
          await actions.changeSelection.handler({ cur, s: cursors.map(x => frame.map.get(x)).filter(Boolean).map(x => frame.map.getKey(x)) });
        }
      });
    },
  },

  wrap: {
    description: `Wraps selected elements with a new element`,
    shortcut: 'w',
    disabled: ({ cur = 'master' } = {}) => [
      !state.designer.open && `Designer closed.`,
      state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`,
    ],
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string', description: `Whose selection to wrap (defaults to master)` },
        tag: { type: 'string', description: `Tag to wrap with (defaults to div)` },
        i: { type: 'number', description: `How many wraps (defaults to 1)` },
      },
    },
    handler: async ({ cur = 'master', tag = 'div', i = 1 } = {}) => {
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'wrap', cur, tag, i });
      let frame = state.designer.current;
      let els = frame.cursors[cur].map(id => frame.map.get(id)).filter(Boolean);
      if (!els.length) return;
      let wrapIds = [];
      let parentIds = els.map(x => frame.map.getKey(x.parentElement));
      let idxs = els.map(x => [...x.parentElement.children].indexOf(x));
      let elIds = els.map(x => frame.map.getKey(x));
      await post('designer.pushHistory', cur, async apply => {
        if (apply && !wrapIds.length) {
          wrapIds = await ifeval(async ({ args }) => {
            let wrapped = [];
            for (let n = 0; n < args.els.length; n++) {
              let el = state.map.get(args.els[n]);
              let p = state.map.get(args.parents[n]);
              if (!el || !p) continue;
              let before = p.children[args.idxs[n]];
              let outer = document.createElement(args.tag);
              let last = outer;
              for (let j = 1; j < args.i; j++) { let inner = document.createElement(args.tag); last.appendChild(inner); last = inner }
              p.insertBefore(outer, before);
              last.appendChild(el);
              wrapped.push(outer);
            }
            await new Promise(pres => setTimeout(pres));
            return wrapped.map(x => state.map.getKey(x));
          }, { els: elIds, parents: parentIds, idxs, tag, i });
          await actions.changeSelection.handler({ cur, s: wrapIds });
        } else if (apply) {
          await ifeval(({ args }) => {
            for (let n = 0; n < args.wrapIds.length; n++) {
              let w = state.map.get(args.wrapIds[n]);
              let p = state.map.get(args.parents[n]);
              let before = p.children[args.idxs[n]];
              if (!w || !p) continue;
              if (before) p.insertBefore(w, before); else p.appendChild(w);
              let inner = w;
              while (inner.firstElementChild && inner.firstElementChild.children.length === 1) inner = inner.firstElementChild;
              let el = state.map.get(args.els[n]);
              if (el) inner.appendChild(el);
            }
          }, { wrapIds, parents: parentIds, idxs, els: elIds });
          await actions.changeSelection.handler({ cur, s: wrapIds });
        } else {
          let unwrapped = await ifeval(async ({ args }) => {
            let result = [];
            for (let n = args.wrapIds.length - 1; n >= 0; n--) {
              let w = state.map.get(args.wrapIds[n]);
              let p = state.map.get(args.parents[n]);
              if (!w || !p) continue;
              let before = p.children[args.idxs[n]];
              let inner = w.firstElementChild;
              if (inner) { p.insertBefore(inner, before); result.push(state.map.getKey(inner)) }
              else {
                let children = [...w.childNodes];
                let anyElements = false;
                for (let c of children) { p.insertBefore(c, before); c.nodeType === 1 && result.push(state.map.getKey(c)); anyElements = true }
                if (!anyElements) result.push(state.map.getKey(p));
              }
              w.remove();
            }
            return result;
          }, { wrapIds, parents: parentIds, idxs });
          await actions.changeSelection.handler({ cur, s: unwrapped });
        }
      });
    },
  },

  unwrap: {
    description: `Unwraps selected element(s), promoting children to their level`,
    shortcut: 'W',
    disabled: ({ cur = 'master' } = {}) => [
      !state.designer.open && `Designer closed.`,
      state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`,
    ],
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string', description: `Whose selection to unwrap (defaults to master)` },
        i: { type: 'number', description: `How many unwraps (defaults to 1)` },
      },
    },
    handler: async ({ cur = 'master', i = 1 } = {}) => {
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'unwrap', cur, i });
      let frame = state.designer.current;
      let wrappers = frame.cursors[cur].map(id => frame.map.get(id)).filter(Boolean);
      if (!wrappers.length) return;
      let wrapIds = wrappers.map(x => frame.map.getKey(x));
      let parentIds = wrappers.map(x => frame.map.getKey(x.parentElement));
      let idxs = wrappers.map(x => [...x.parentElement.children].indexOf(x));
      await post('designer.pushHistory', cur, async apply => {
        if (apply) {
          await ifeval(async ({ args }) => {
            window.__unwrappedChildren ??= new Map(); // FIXME
            for (let n = args.wrapIds.length - 1; n >= 0; n--) {
              let w = state.map.get(args.wrapIds[n]);
              let p = state.map.get(args.parents[n]);
              if (!w || !p) continue;
              let before = p.children[args.idxs[n]];
              let children = [...w.childNodes];
              window.__unwrappedChildren.set(args.wrapIds[n], children);
              for (let c of children) p.insertBefore(c, before);
              w.remove();
            }
          }, { wrapIds, parents: parentIds, idxs });
          let promoted = await ifeval(({ args }) => {
            let result = [];
            for (let id of args.wrapIds) {
              let kids = window.__unwrappedChildren?.get(id) || [];
              for (let c of kids) if (c.nodeType === 1 && c.isConnected) result.push(state.map.getKey(c));
            }
            return result.length ? result : args.parents;
          }, { wrapIds, parents: parentIds });
          await actions.changeSelection.handler({ cur, s: promoted });
        } else {
          await ifeval(({ args }) => {
            let map = window.__unwrappedChildren;
            if (!map) return;
            for (let n = 0; n < args.wrapIds.length; n++) {
              let w = state.map.get(args.wrapIds[n]);
              let p = state.map.get(args.parents[n]);
              if (!w || !p) continue;
              let before = p.children[args.idxs[n]];
              if (before) p.insertBefore(w, before); else p.appendChild(w);
              let kids = map.get(args.wrapIds[n]);
              if (kids?.length) for (let c of kids) w.appendChild(c);
            }
          }, { wrapIds, parents: parentIds, idxs });
          await actions.changeSelection.handler({ cur, s: wrapIds });
        }
      });
    },
  },

  addCssClasses: {
    disabled: ({ cur = 'master' } = {}) => [!state.designer.open && `Designer closed.`, state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`],
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string', description: `Whose selection to use (defaults to master)` },
        cls: { type: 'array', items: { type: 'string' } },
      },
      required: ['cls'],
    },
    handler: async ({ cur = 'master', cls } = {}) => {
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'addCssClasses', cur, cls });
      let frame = state.designer.current;
      let targets = frame.cursors[cur].map(x => frame.map.get(x)).filter(Boolean);
      if (!targets.length) return;
      if (Array.isArray(cls)) cls = cls.join(' ');
      if (typeof cls === 'string') cls = cls.trim();
      let tokens = [];
      let re = /{{(?:[^{}]|{{[^}]*}})*}}|[^\s]+/g;
      let m;
      while (m = re.exec(cls)) tokens.push(m[0]);
      let exprs = tokens.filter(c => c.startsWith('{{') && c.endsWith('}}'));
      let normal = tokens.filter(c => !(c.startsWith('{{') && c.endsWith('}}')));
      let targetIds = targets.map(x => frame.map.getKey(x));
      await post('designer.pushHistory', cur, async apply => {
        await ifeval(({ args }) => {
          self.__wfExprChanges ??= new Map();
          for (let id of args.targets) {
            let el = state.map.get(id);
            if (!el) continue;
            let attr = el.getAttribute('wf-class') || '';
            let existing = attr.length ? attr.split(/}}\s+(?={{)/).map(s => s.trim()).filter(Boolean) : [];
            if (args.apply) {
              for (let y of args.normal) el.classList.add(y);
              if (args.exprs.length) {
                let added = new Set();
                for (let e of args.exprs) if (!existing.includes(e)) added.add(e);
                let joined = existing.concat([...added]).join(' ');
                el.setAttribute('wf-class', joined.trim());
                self.__wfExprChanges.set(id, { added, removed: new Set() });
              }
            } else {
              for (let y of args.normal) el.classList.remove(y);
              if (args.exprs.length && el.hasAttribute('wf-class')) {
                let current = el.getAttribute('wf-class') || '';
                let parts = current.split(/}}\s+(?={{)/).map(s => s.trim()).filter(Boolean);
                let change = self.__wfExprChanges.get(id);
                let toRemove = change ? [...change.added] : args.exprs;
                let next = parts.filter(e => !toRemove.includes(e));
                el.setAttribute('wf-class', next.join(' '));
                if (change) change.removed = new Set(toRemove);
              }
            }
          }
        }, { targets: targetIds, normal, exprs, apply });
        await post('collab.sync');
      });
    },
  },

  removeCssClasses: {
    disabled: ({ cur = 'master' } = {}) => [!state.designer.open && `Designer closed.`, state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`],
    parameters: { type: 'object', properties: { cur: { type: 'string', description: `Whose selection to use (defaults to master)` }, cls: { type: 'array', items: { type: 'string' } } }, required: ['cls'] },
    handler: async ({ cur = 'master', cls } = {}) => {
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'removeCssClasses', cur, cls });
      let frame = state.designer.current; let targets = frame.cursors[cur].map(x => frame.map.get(x)).filter(Boolean); if (!targets.length) return;
      if (Array.isArray(cls)) cls = cls.join(' ');
      if (typeof cls === 'string') cls = cls.trim();
      let tokens = []; let re = /{{(?:[^{}]|{{[^}]*}})*}}|[^\s]+/g; let m; while (m = re.exec(cls)) tokens.push(m[0]);
      let exprs = tokens.filter(c => c.startsWith('{{') && c.endsWith('}}')); let normal = tokens.filter(c => !(c.startsWith('{{') && c.endsWith('}}')));
      let targetIds = targets.map(x => frame.map.getKey(x));
      await post('designer.pushHistory', cur, async apply => {
        await ifeval(({ args }) => {
          self.__wfExprChanges ??= new Map();
          for (let id of args.targets) {
            let el = state.map.get(id); if (!el) continue;
            if (args.apply) {
              for (let y of args.normal) el.classList.remove(y);
              if (args.exprs.length && el.hasAttribute('wf-class')) {
                let current = el.getAttribute('wf-class') || '';
                let parts = current.split(/}}\s+(?={{)/).map(s => s.trim()).filter(Boolean);
                let removed = new Set(), remaining = [];
                for (let p of parts) if (args.exprs.includes(p)) removed.add(p); else remaining.push(p);
                el.setAttribute('wf-class', remaining.join(' '));
                self.__wfExprChanges.set(id, { added: new Set(), removed });
              }
            } else {
              for (let y of args.normal) el.classList.add(y);
              if (args.exprs.length) {
                let change = self.__wfExprChanges.get(id);
                let readd = change ? [...change.removed] : args.exprs;
                let existing = (el.getAttribute('wf-class') || '').split(/}}\s+(?={{)/).map(s => s.trim()).filter(Boolean);
                let joined = existing.concat(readd).join(' ');
                el.setAttribute('wf-class', joined.trim());
              }
            }
          }
        }, { targets: targetIds, normal, exprs, apply });
        await post('collab.sync');
      });
    },
  },

  replaceCssClasses: {
    disabled: ({ cur = 'master' } = {}) => [
      !state.designer.open && `Designer closed.`,
      state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`,
    ],
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string', description: `Whose selection to use (defaults to master)` },
        old: { type: 'array', items: { type: 'string' } },
        cls: { type: 'array', items: { type: 'string' } },
      },
      required: ['cls'],
    },
    handler: async ({ cur = 'master', old, cls } = {}) => {
      if (old?.startsWith?.('wfregexp:')) old = new RegExp(old.slice('wfregexp:'.length + 1, -1));
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'replaceCssClasses', cur, old: old instanceof RegExp ? `wfregexp:${old}` : old, cls });
      let frame = state.designer.current;
      let targets = frame.cursors[cur].map(x => frame.map.get(x)).filter(Boolean);
      if (!targets.length) return;
      if (Array.isArray(cls)) cls = cls.join(' ');
      if (typeof cls === 'string') cls = cls.trim();
      let tokens = [];
      let re = /{{(?:[^{}]|{{[^}]*}})*}}|[^\s]+/g;
      let m;
      while (m = re.exec(cls)) tokens.push(m[0]);
      let exprs = tokens.filter(c => c.startsWith('{{') && c.endsWith('}}'));
      let normal = tokens.filter(c => !(c.startsWith('{{') && c.endsWith('}}')));
      let clsSet = new Set(normal);
      let targetIds = targets.map(x => frame.map.getKey(x));
      let removedBy = {};
      await post('designer.pushHistory', cur, async apply => {
        if (apply && !Object.keys(removedBy).length) {
          removedBy = await ifeval(async ({ args }) => {
            let out = {};
            for (let id of args.targets) {
              let el = state.map.get(id);
              if (!el) continue;
              let removed = [];
              if (args.old?.startsWith?.('wfregexp:')) {
                let re = new RegExp(args.old.slice('wfregexp:'.length + 1, -1));
                for (let c of [...el.classList]) if (re.test(c)) { el.classList.remove(c); removed.push(c) }
              }
              else if (args.old) {
                let olds = Array.isArray(args.old) ? args.old : args.old.split(/\s+/);
                for (let c of olds) if (el.classList.contains(c)) { el.classList.remove(c); removed.push(c) }
              }
              for (let c of args.cls) el.classList.add(c);
              if (args.exprs.length) {
                let current = el.getAttribute('wf-class') || '';
                let parts = current.split(/}}\s+(?={{)/).map(s => s.trim()).filter(Boolean);
                let added = new Set();
                for (let e of args.exprs) if (!parts.includes(e)) added.add(e);
                el.setAttribute('wf-class', parts.concat([...added]).join(' '));
              }
              out[id] = removed;
            }
            return out;
          }, { targets: targetIds, old: typeof old === 'string' ? old : (old instanceof RegExp ? `wfregexp:${old}` : ''), cls: [...clsSet], exprs });
        } else if (apply) {
          await ifeval(({ args }) => {
            for (let id of Object.keys(args.removedBy)) {
              let el = state.map.get(id);
              if (!el) continue;
              for (let c of args.removedBy[id] || []) el.classList.remove(c);
              for (let c of args.cls) el.classList.add(c);
            }
          }, { cls: [...clsSet], removedBy });
        } else {
          await ifeval(({ args }) => {
            for (let id of Object.keys(args.removedBy)) {
              let el = state.map.get(id); if (!el) continue;
              for (let c of args.cls) el.classList.remove(c);
              for (let c of args.removedBy[id] || []) el.classList.add(c);
            }
          }, { cls: [...clsSet], removedBy });
        }
        await post('collab.sync');
      });
    },
  },

  toggleCssClass: {
    description: `Toggles a single Tailwind class, optionally removing conflicting ones`,
    disabled: ({ cur = 'master' } = {}) => [
      !state.designer.open && `Designer closed.`,
      state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`,
    ],
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string', description: `Whose selection to affect (defaults to current user)` },
        cls: { type: 'string', description: `Class to toggle (e.g. text-lg, font-bold)` },
        conflict: { type: 'string', enum: ['textSize', 'fontWeight', 'italic', 'tracking', 'decoration', 'gfont'] },
      },
      required: ['cls'],
    },
    handler: async ({ cur = state.collab.uid, cls, conflict = null } = {}) => {
      let frame = state.designer.current;
      let ids = frame.cursors[cur] || [];
      if (!ids.length) return;
      let allUnset = ids.every(id => {
        let el = frame.map.get(id);
        return el && !el.classList.contains(cls);
      });
      let conflictRegex = {
        textSize: /^text-(xs|sm|base|md|lg|[234567]?xl)$/,
        fontWeight: /^font-(thin|extralight|light|normal|medium|semibold|bold)$/,
        italic: /^italic|not-italic$/,
        tracking: /^tracking-(tighter|tight|normal|wide|wider|widest)$/,
        decoration: /^underline|line-through$/,
        gfont: /^gfont-/,
      }[conflict] || null;
      if (allUnset) {
        await actions.replaceCssClasses.handler({ cur, old: conflictRegex, cls: [cls] });
      } else {
        await actions.removeCssClasses.handler({ cur, cls: [cls] });
      }
    },
  },

  toggleHue: {
    description: `Toggles Tailwind text hue for selected elements`,
    disabled: ({ cur = 'master' } = {}) => [
      !state.designer.open && `Designer closed.`,
      state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`,
    ],
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string', description: `Whose selection to affect (defaults to master)` },
        hue: { type: 'string', description: `Tailwind hue (e.g. red, blue, green)` },
      },
      required: ['hue'],
    },
    handler: async ({ cur = 'master', hue } = {}) => {
      let fallbackCur = state.collab?.uid ?? 'master';
      cur ||= fallbackCur;
      hue = hue?.toString();
      if (!TAILWIND_HUE_SET.has(hue)) return;
      let { elements, matches, regex } = getTailwindColorInfo('text', cur);
      if (!elements.length) return;
      let allSameHue = matches.length && matches.every(m => m && m.hue === hue);
      if (allSameHue) return await actions.replaceCssClasses.handler({ cur, old: regex, cls: [] });
      let shade = matches.find(m => m)?.shade;
      if (!TAILWIND_SHADE_SET.has(shade)) shade = DEFAULT_SHADE;
      await actions.replaceCssClasses.handler({ cur, old: regex, cls: [`text-${hue}-${shade}`] });
    },
  },

  setShade: {
    description: `Sets Tailwind text shade for selected elements`,
    disabled: ({ cur = 'master' } = {}) => [
      !state.designer.open && `Designer closed.`,
      state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`,
    ],
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string', description: `Whose selection to affect (defaults to master)` },
        shade: { type: 'string', description: `Tailwind shade (e.g. 100, 500, 900)` },
      },
      required: ['shade'],
    },
    handler: async ({ cur = 'master', shade } = {}) => {
      let fallbackCur = state.collab?.uid ?? 'master';
      cur ||= fallbackCur;
      shade = shade?.toString();
      if (!TAILWIND_SHADE_SET.has(shade)) return;
      let { elements, matches, regex } = getTailwindColorInfo('text', cur);
      if (!elements.length) return;
      let match = matches.find(m => m);
      if (!match || !TAILWIND_HUE_SET.has(match.hue)) return;
      await actions.replaceCssClasses.handler({ cur, old: regex, cls: [`text-${match.hue}-${shade}`] });
    },
  },

  toggleBgHue: {
    description: `Toggles Tailwind background hue for selected elements`,
    disabled: ({ cur = 'master' } = {}) => [
      !state.designer.open && `Designer closed.`,
      state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`,
    ],
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string', description: `Whose selection to affect (defaults to master)` },
        hue: { type: 'string', description: `Tailwind hue (e.g. red, blue, green)` },
      },
      required: ['hue'],
    },
    handler: async ({ cur = 'master', hue } = {}) => {
      let fallbackCur = state.collab?.uid ?? 'master';
      cur ||= fallbackCur;
      hue = hue?.toString();
      if (!TAILWIND_HUE_SET.has(hue)) return;
      let { elements, matches, regex } = getTailwindColorInfo('bg', cur);
      if (!elements.length) return;
      let allSameHue = matches.length && matches.every(m => m && m.hue === hue);
      if (allSameHue) return await actions.replaceCssClasses.handler({ cur, old: regex, cls: [] });
      let shade = matches.find(m => m)?.shade;
      if (!TAILWIND_SHADE_SET.has(shade)) shade = DEFAULT_SHADE;
      await actions.replaceCssClasses.handler({ cur, old: regex, cls: [`bg-${hue}-${shade}`] });
    },
  },

  setBgShade: {
    description: `Sets Tailwind background shade for selected elements`,
    disabled: ({ cur = 'master' } = {}) => [
      !state.designer.open && `Designer closed.`,
      state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`,
    ],
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string', description: `Whose selection to affect (defaults to master)` },
        shade: { type: 'string', description: `Tailwind shade (e.g. 100, 500, 900)` },
      },
      required: ['shade'],
    },
    handler: async ({ cur = 'master', shade } = {}) => {
      let fallbackCur = state.collab?.uid ?? 'master';
      cur ||= fallbackCur;
      shade = shade?.toString();
      if (!TAILWIND_SHADE_SET.has(shade)) return;
      let { elements, matches, regex } = getTailwindColorInfo('bg', cur);
      if (!elements.length) return;
      let match = matches.find(m => m);
      if (!match || !TAILWIND_HUE_SET.has(match.hue)) return;
      await actions.replaceCssClasses.handler({ cur, old: regex, cls: [`bg-${match.hue}-${shade}`] });
    },
  },

  changeHtml: {
    description: `Changes the outer HTML of selected elements (prompts if not provided)`,
    shortcut: 'm',
    disabled: ({ cur = 'master' } = {}) => [
      !state.designer.open && `Designer closed.`,
      state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`,
    ],
    codexOnly: true,
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string', description: `Whose selected elements to change (defaults to master)` },
        html: { type: 'string', description: `Adapted/replacement HTML (defaults to opening a modal for user editing)` },
      },
    },
    handler: async ({ cur = 'master', html } = {}) => {
      let frame = state.designer.current;
      let cursors = frame.cursors[cur];
      if (!cursors?.length) return;
      let replaced = cursors.map(id => frame.map.get(id)).filter(Boolean);
      let parents = replaced.map(x => x.parentElement);
      let order = replaced.map((el, n) => ({ el, p: parents[n], n }));
      order.sort((a, b) => {
        if (a.p === b.p) return a.i - b.i;
        return a.p.compareDocumentPosition(b.p) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
      if (html == null) {
        let combined = order.map(o => {
          let clone = o.el.cloneNode(true);
          clone.removeAttribute('data-htmlsnap');
          clone.querySelectorAll('*').forEach(x => x.removeAttribute('data-htmlsnap'));
          return clone.outerHTML;
        }).join('\n');
        let [btn, val] = await showModal('CodeDialog', { title: 'Change HTML', initialValue: combined });
        if (btn !== 'ok') return;
        html = val;
      }
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'changeHtml', cur, html });
      let orderKeys = order.map(x => frame.map.getKey(x.el));
      let addedKeys = [];
      await post('designer.pushHistory', cur, async apply => {
        if (apply && !addedKeys.length) {
          addedKeys = await ifeval(async ({ args }) => {
            let template = document.createElement('template');
            template.innerHTML = args.html;
            let newEls = [...template.content.children];
            let added = [];
            for (let n = 0; n < args.order.length; n++) {
              let el = state.map.get(args.order[n]);
              let newEl = newEls[n];
              if (!newEl) { el.remove(); continue }
              el.replaceWith(newEl);
              added.push(newEl);
            }
            await new Promise(pres => setTimeout(pres));
            return added.map(x => state.map.getKey(x));
          }, { html, order: order.map(x => frame.map.getKey(x.el)) });
          await actions.changeSelection.handler({ cur, s: addedKeys });
        } else if (apply) {
          await ifeval(({ args }) => { for (let n = 0; n < args.order.length; n++) state.map.get(args.order[n]).replaceWith(state.map.get(args.added[n])) }, { order: orderKeys, added: addedKeys });
          await actions.changeSelection.handler({ cur, s: addedKeys });
        } else {
          await ifeval(({ args }) => { for (let n = 0; n < args.added.length; n++) state.map.get(args.added[n]).replaceWith(state.map.get(args.order[n])) }, { order: orderKeys, added: addedKeys });
          await actions.changeSelection.handler({ cur, s: orderKeys });
        }
      });
      let selectionIds = [...(frame.cursors[cur] || [])];
      let created = addedKeys.length ? addedKeys : selectionIds;
      return { success: true, createdIds: created, selectedIds: selectionIds };
    },
  },

  changeInnerHtml: {
    description: `Changes the inner HTML of selected elements (prompts if not provided)`,
    shortcut: 'M',
    disabled: ({ cur = 'master' } = {}) => [
      !state.designer.open && `Designer closed.`,
      state.designer.open && state.designer.current.cursors[cur]?.length !== 1 && `A single element must be selected.`,
    ],
    parameters: {
      type: 'object',
      properties: {
        cur: { type: 'string' },
        desc: { type: 'string', description: `Detailed user request decription for HTML generation model` },
      },
      required: ['desc'],
    },
    handler: async ({ cur = 'master', desc = null, html = null } = {}) => {
      let frame = state.designer.current;
      let targets = frame.cursors[cur].map(x => frame.map.get(x)).filter(Boolean);
      if (!targets.length) return;
      let prev = targets.map(x => x.innerHTML);
      desc && await loadman.run('actions.changeInnerHtml.aigen', async () => {
        html = await openaiComplete([{
          role: 'system',
          content: [
            `You're an HTML artisan. You can only use Tailwind classes, no style attributes.`,
            `Take the page HTML, selection htmlsnap IDs, and user request`,
            `and generate a bare *INNER* HTML replacement with no Markdown code block wrappers.`,
          ],
        }, {
          role: 'user',
          content: [
            `Page HTML: ${state.designer.current.snap}`,
            `---`,
            `Selection htmlsnap IDs: ${targets.map(x => frame.map.getKey(x)).join(', ')}`,
            `---`,
            `User request: ${desc}`,
          ],
        }], { model: 'gpt-5.1-codex' });
      });
      if (html == null) {
        let [btn, val] = await showModal('CodeDialog', { title: 'Change HTML (inner)', initialValue: prev.join('\n') });
        if (btn !== 'ok') return;
        html = val;
      }
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'changeInnerHtml', cur, html });
      let targetKeys = targets.map(x => frame.map.getKey(x));
      await post('designer.pushHistory', cur, async apply => {
        await ifeval(({ args }) => {
          for (let n = 0; n < args.targets.length; n++) {
            let el = state.map.get(args.targets[n]);
            if (!el) continue;
            el.innerHTML = args.apply ? args.html : args.prev[n];
          }
        }, { targets: targetKeys, html, prev, apply });
        await actions.changeSelection.handler({ cur, s: targetKeys });
      });
      return { success: true, selectedIds: targetKeys };
    },
  },

  changeInputPlaceholder: {
    shortcut: '@',
    disabled: ({ cur = 'master' } = {}) => [!state.designer.open && `Designer closed.`, state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`],
    parameters: { type: 'object', properties: { cur: { type: 'string' }, placeholder: { type: 'string' } } },
    handler: async ({ cur = 'master', placeholder = null } = {}) => {
      let frame = state.designer.current;
      let targets = frame.cursors[cur].map(x => frame.map.get(x)).filter(x => /^HTML(InputElement|TextAreaElement)$/.test(x.constructor.name));
      if (!targets.length) return;
      let prev = targets.map(x => x.placeholder);
      if (placeholder == null) {
        let [btn, val] = await showModal('PromptDialog', { title: 'Change input placeholder', label: 'Placeholder text', initialValue: prev[0] });
        if (btn !== 'ok') return;
        placeholder = val;
      }
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'changeInputPlaceholder', cur, placeholder });
      let targetKeys = targets.map(x => frame.map.getKey(x));
      await post('designer.pushHistory', cur, async apply => {
        await ifeval(({ args }) => {
          for (let n = 0; n < args.targets.length; n++) {
            let el = state.map.get(args.targets[n]);
            if (!el) continue;
            let nv = args.apply ? args.placeholder : args.prev[n];
            nv ? el.setAttribute('placeholder', nv) : el.removeAttribute('placeholder');
          }
        }, { targets: targetKeys, placeholder, prev, apply });
      });
    },
  },

  changeFormMethod: {
    description: `Changes a form element's method attribute`,
    shortcut: 'N',
    disabled: ({ cur = 'master' } = {}) => [!state.designer.open && `Designer closed.`, state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`],
    parameters: { type: 'object', properties: { cur: { type: 'string' }, method: { type: 'string' } } },
    handler: async ({ cur = 'master', method } = {}) => {
      let frame = state.designer.current;
      let targets = frame.cursors[cur].map(x => frame.map.get(x)).filter(x => x?.tagName === 'FORM');
      if (!targets.length) return;
      let prev = targets.map(x => x.getAttribute('method'));
      if (method == null) {
        let [btn, val] = await showModal('PromptDialog', { title: 'Change form method', label: 'Method', initialValue: prev[0] });
        if (btn !== 'ok') return;
        method = val;
      }
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'changeFormMethod', cur, method });
      let targetKeys = targets.map(x => frame.map.getKey(x));
      await post('designer.pushHistory', cur, async apply => {
        await ifeval(({ args }) => {
          for (let n = 0; n < args.targets.length; n++) {
            let el = state.map.get(args.targets[n]);
            if (!el) continue;
            let nv = args.apply ? args.method : args.prev[n];
            nv ? el.setAttribute('method', nv) : el.removeAttribute('method');
          }
        }, { targets: targetKeys, method, prev, apply });
      });
    },
  },

  toggleHidden: {
    description: `Toggles visibility of selected elements (via hidden attribute)`,
    shortcut: 'x',
    disabled: ({ cur = 'master' } = {}) => [!state.designer.open && `Designer closed.`, state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`],
    parameters: { type: 'object', properties: { cur: { type: 'string' } } },
    handler: async ({ cur = 'master' } = {}) => {
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'toggleHidden', cur });
      let frame = state.designer.current;
      let targets = frame.cursors[cur].map(x => frame.map.get(x)).filter(Boolean);
      if (!targets.length) return;
      let prev = targets.map(x => x.hidden);
      let targetKeys = targets.map(x => frame.map.getKey(x));
      await post('designer.pushHistory', cur, async apply => {
        await ifeval(({ args }) => {
          for (let n = 0; n < args.targets.length; n++) {
            let el = state.map.get(args.targets[n]);
            if (el) el.hidden = args.apply ? !args.prev[n] : args.prev[n];
          }
        }, { targets: targetKeys, prev, apply });
      });
    },
  },

  isPlatformPreview: {
    description: `Returns the IDE platform preview form factor (off | desktop | mobile) for native:*/desktop:*/mobile:* utilities`,
    parameters: { type: 'object', properties: {} },
    handler: async () => {
      return { success: true, mode: state.designer.platformForm };
    },
  },

  setPlatformPreview: {
    description: `Set the IDE platform preview form factor to off, desktop, or mobile so native:*/desktop:*/mobile:* utilities apply in the designer iframe (off also returns the OS to web)`,
    parameters: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['off', 'desktop', 'mobile'] } },
      required: ['mode'],
    },
    handler: async ({ mode } = {}) => {
      if (!['off', 'desktop', 'mobile'].includes(mode)) {
        throw new Error('mode must be off, desktop, or mobile');
      }
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'setPlatformPreview', mode });
      await post('designer.setPlatformPreview', mode);
      return { success: true, mode };
    },
  },

  isPlatformOs: {
    description: `Returns the IDE platform preview OS (web | win | lin | mac | android) for win:*/lin:*/mac:*/android:* utilities`,
    parameters: { type: 'object', properties: {} },
    handler: async () => ({ success: true, os: state.designer.platformOs }),
  },

  setPlatformOs: {
    description: `Set the IDE platform preview OS: web (plain browser, no platform variants) or win, lin, mac, android (enables that OS's variants plus native:* and a form factor, desktop by default, mobile for android)`,
    parameters: {
      type: 'object',
      properties: { os: { type: 'string', enum: ['web', 'win', 'lin', 'mac', 'android'] } },
      required: ['os'],
    },
    handler: async ({ os } = {}) => {
      if (!['web', 'win', 'lin', 'mac', 'android'].includes(os)) {
        throw new Error('os must be web, win, lin, mac, or android');
      }
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'setPlatformOs', os });
      await post('designer.setPlatformOs', os);
      return { success: true, os };
    },
  },

  isPagePreview: {
    description: `Returns the open page's mode: preview (page runs live) or edit (visual editor)`,
    disabled: () => [!state.designer.open && `Designer closed.`],
    parameters: { type: 'object', properties: {} },
    handler: async () => ({ success: true, mode: state.designer.current?.preview ? 'preview' : 'edit' }),
  },

  setPagePreview: {
    description: `Switch the open page between preview (page runs live) and edit (visual editor) modes`,
    disabled: () => [
      !state.designer.open && `Designer closed.`,
      state.collab.uid !== 'master' && `Peers can't toggle preview.`,
    ],
    parameters: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['preview', 'edit', 'toggle'] } },
      required: ['mode'],
    },
    handler: async ({ mode } = {}) => {
      if (mode !== 'preview' && mode !== 'edit' && mode !== 'toggle') throw new Error('mode must be preview, edit, or toggle');
      let current = state.designer.current?.preview ? 'preview' : 'edit';
      if (mode === 'toggle') mode = current === 'preview' ? 'edit' : 'preview';
      if (mode !== current) await post('designer.togglePreview');
      return { success: true, mode: state.designer.current?.preview ? 'preview' : 'edit' };
    },
  },

  replaceTextContent: {
    description: `If no text is provided, a single-line input modal is shown`,
    shortcut: 't',
    disabled: ({ cur = 'master' } = {}) => [!state.designer.open && `Designer closed.`, state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`],
    parameters: { type: 'object', properties: { cur: { type: 'string' }, text: { type: 'string' } } },
    handler: async ({ cur = 'master', text } = {}) => {
      let frame = state.designer.current;
      let targets = frame.cursors[cur].map(x => frame.map.get(x)).filter(Boolean);
      if (!targets.length) return;
      let prev = targets.map(x => x.textContent);
      if (text == null) {
        let [btn, val] = await showModal('PromptDialog', { title: 'Set text', label: 'Text', initialValue: prev[0] });
        if (btn !== 'ok') return;
        text = val;
      }
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'replaceTextContent', cur, text });
      let targetKeys = targets.map(x => frame.map.getKey(x));
      await post('designer.pushHistory', cur, async apply => {
        await ifeval(({ args }) => {
          for (let n = 0; n < args.targets.length; n++) {
            let el = state.map.get(args.targets[n]);
            if (el) el.textContent = args.apply ? args.text : args.prev[n];
          }
        }, { targets: targetKeys, text, prev, apply });
      });
    },
  },

  replaceMultilineTextContent: {
    description: `Replaces the selected element's content with multiline input; prompts textarea if no text is provided`,
    shortcut: 'T',
    disabled: ({ cur = 'master' } = {}) => [!state.designer.open && `Designer closed.`, state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`],
    parameters: { type: 'object', properties: { cur: { type: 'string' }, text: { type: 'string' } } },
    handler: async ({ cur = 'master', text } = {}) => {
      let frame = state.designer.current;
      let targets = frame.cursors[cur].map(x => frame.map.get(x)).filter(Boolean);
      if (!targets.length) return;
      let prev = targets.map(x => x.textContent);
      if (text == null) {
        let [btn, val] = await showModal('PromptDialog', { title: 'Set text (multiline)', label: 'Text', initialValue: prev.join('\n'), multiline: true });
        if (btn !== 'ok') return;
        text = val;
      }
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'replaceMultilineTextContent', cur, text });
      let targetKeys = targets.map(x => frame.map.getKey(x));
      await post('designer.pushHistory', cur, async apply => {
        await ifeval(({ args }) => {
          for (let n = 0; n < args.targets.length; n++) {
            let el = state.map.get(args.targets[n]);
            if (el) el.textContent = args.apply ? args.text : args.prev[n];
          }
        }, { targets: targetKeys, text, prev, apply });
      });
    },
  },

  setInputValue: {
    shortcut: '#',
    disabled: ({ cur = 'master' } = {}) => [
      !state.designer.open && `Designer closed.`,
      state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`,
    ],
    parameters: { type: 'object', properties: { cur: { type: 'string' }, value: { type: ['string', 'null'] }, expr: { type: ['string', 'null'] } } },
    handler: async ({ cur = 'master', value, expr } = {}) => {
      let frame = state.designer.current;
      let targets = frame.cursors[cur].map(x => frame.map.get(x)).filter(x => x && x.tagName === 'INPUT');
      if (!targets.length) return;
      let prevValues = targets.map(x => x.getAttribute('value'));
      let prevExprs = targets.map(x => x.getAttribute('wf-value'));
      if (value == null && expr == null) {
        let first = targets[0];
        let initialValue = first.getAttribute('value');
        if (initialValue == null && typeof first.value === 'string') initialValue = first.value;
        let initialExpr = first.getAttribute('wf-value') || '';
        let [btn, nextValue, nextExpr] = await showModal('SetValueDialog', { initialValue: initialValue || '', initialExprValue: initialExpr || '' });
        if (btn !== 'ok') return;
        value = nextValue;
        expr = nextExpr;
      }
      let normalizedValue = typeof value === 'string' ? value.trim() : '';
      let normalizedExpr = typeof expr === 'string' ? expr.trim() : '';
      let newValue = normalizedValue || null;
      let newExpr = normalizedExpr || null;
      let unchanged = targets.every((_, idx) => {
        let prevValue = prevValues[idx] ?? null;
        let prevExpr = prevExprs[idx] ?? null;
        return prevValue === newValue && prevExpr === newExpr;
      });
      if (unchanged) return;
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'setInputValue', cur, value: newValue, expr: newExpr });
      let targetKeys = targets.map(x => frame.map.getKey(x));
      await post('designer.pushHistory', cur, async apply => {
        await ifeval(({ args }) => {
          for (let n = 0; n < args.targets.length; n++) {
            let el = state.map.get(args.targets[n]);
            if (!el) continue;
            let val = args.apply ? args.newValue : args.prevValues[n];
            let exprVal = args.apply ? args.newExpr : args.prevExprs[n];
            if (exprVal) el.setAttribute('wf-value', exprVal); else el.removeAttribute('wf-value');
            if (val != null) el.setAttribute('value', val); else el.removeAttribute('value');
            if (typeof el.value === 'string') el.value = val != null ? val : '';
          }
        }, { targets: targetKeys, prevValues, prevExprs, newValue, newExpr, apply });
      });
    },
  },

  changeLinkUrl: {
    shortcut: 'H',
    disabled: ({ cur = 'master' } = {}) => [!state.designer.open && `Designer closed.`, state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`],
    parameters: { type: 'object', properties: { cur: { type: 'string' }, url: { type: 'string' } } },
    handler: async ({ cur = 'master', url } = {}) => {
      let frame = state.designer.current;
      let targets = frame.cursors[cur].map(x => frame.map.get(x)).filter(x => x.tagName === 'A');
      if (!targets.length) return;
      let prev = targets.map(x => x.getAttribute('href'));
      if (url == null) {
        let [btn, val] = await showModal('PromptDialog', { title: 'Change link URL', label: 'URL', initialValue: prev[0] });
        if (btn !== 'ok') return;
        url = val;
      }
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'changeLinkUrl', cur, url });
      let targetKeys = targets.map(x => frame.map.getKey(x));
      await post('designer.pushHistory', cur, async apply => {
        await ifeval(({ args }) => {
          for (let n = 0; n < args.targets.length; n++) {
            let el = state.map.get(args.targets[n]);
            if (!el) continue;
            let nv = args.apply ? args.url : args.prev[n];
            nv ? el.setAttribute('href', nv) : el.removeAttribute('href');
          }
        }, { targets: targetKeys, url, prev, apply });
      });
    },
  },

  changeMediaSrc: {
    shortcut: 's',
    disabled: ({ cur = 'master' } = {}) => [!state.designer.open && `Designer closed.`, state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`],
    parameters: { type: 'object', properties: { cur: { type: 'string' }, src: { type: ['string', 'null'] }, expr: { type: ['string', 'null'] } } },
    handler: async ({ cur = 'master', src, expr } = {}) => {
      let frame = state.designer.current;
      let targets = frame.cursors[cur].map(x => frame.map.get(x)).filter(Boolean);
      if (!targets.length) return;
      let prevSrcs = targets.map(x => x.getAttribute('src'));
      let prevExprs = targets.map(x => x.getAttribute('wf-src'));
      if (src == null && expr == null) {
        let [btn, nextSrc, nextExpr] = await showModal('SetSrcDialog', { initialSrcValue: prevSrcs[0] || '', initialExprValue: prevExprs[0] || '' });
        if (btn !== 'ok') return;
        src = nextSrc;
        expr = nextExpr;
      }
      let normalizedSrc = typeof src === 'string' ? src.trim() : '';
      let normalizedExpr = typeof expr === 'string' ? expr.trim() : '';
      let newSrc = normalizedSrc || null;
      let newExpr = normalizedExpr || null;
      let unchanged = targets.every((_, idx) => {
        let prevSrc = prevSrcs[idx] ?? null;
        let prevExpr = prevExprs[idx] ?? null;
        return prevSrc === newSrc && prevExpr === newExpr;
      });
      if (unchanged) return;
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'changeMediaSrc', cur, src: newSrc, expr: newExpr });

      let mimeSource = newExpr ? null : newSrc;
      let mime = mimeSource ? mimeLookup(mimeSource) : null;
      let newTag = mime?.startsWith?.('audio/') ? 'audio' : mime?.startsWith?.('video/') ? 'video' : mimeSource ? 'img' : null;
      let targetKeys = targets.map(x => frame.map.getKey(x));
      let parentKeys = targets.map(x => frame.map.getKey(x.parentElement));
      let idxs = targets.map(x => [...x.parentElement.children].indexOf(x));
      let newKeys = [];

      await post('designer.pushHistory', cur, async apply => {
        if (apply && !newKeys.length) {
          newKeys = await ifeval(async ({ args }) => {
            let setSrcAttr = (node, srcVal, exprVal) => {
              if (!node) return;
              if (exprVal) {
                node.setAttribute('wf-src', exprVal);
              } else {
                node.removeAttribute('wf-src');
              }
              let resolved = srcVal != null ? srcVal : null;
              if (resolved) node.setAttribute('src', resolved);
              else node.removeAttribute('src');
            };
            let result = [];
            for (let n = 0; n < args.targets.length; n++) {
              let el = state.map.get(args.targets[n]);
              let p = state.map.get(args.parents[n]);
              let i = args.idxs[n];
              if (!el || !p) continue;
              let tag = args.newTag && args.newTag !== el.tagName.toLowerCase() ? args.newTag : el.tagName.toLowerCase();
              if (tag === el.tagName.toLowerCase()) {
                setSrcAttr(el, args.src, args.expr);
                result.push(state.map.getKey(el));
                continue;
              }
              let clone = document.createElement(tag);
              for (let a of el.attributes) clone.setAttribute(a.name, a.value);
              clone.className = el.className;
              clone.innerHTML = el.innerHTML;
              setSrcAttr(clone, args.src, args.expr);
              if (p.children[i] === el) p.replaceChild(clone, el);
              else p.insertBefore(clone, p.children[i] || null);
              result.push(clone);
            }
            await new Promise(pres => setTimeout(pres));
            return result.map(x => state.map.getKey(x));
          }, { targets: targetKeys, parents: parentKeys, idxs, src: newSrc, expr: newExpr, newTag });
          await actions.changeSelection.handler({ cur, s: newKeys });
        } else if (apply) {
          await ifeval(({ args }) => {
            let setSrcAttr = (node, srcVal, exprVal) => {
              if (!node) return;
              if (exprVal) {
                node.setAttribute('wf-src', exprVal);
              } else {
                node.removeAttribute('wf-src');
              }
              let resolved = srcVal != null ? srcVal : null;
              if (resolved) node.setAttribute('src', resolved);
              else node.removeAttribute('src');
            };
            for (let n = 0; n < args.targets.length; n++) {
              let el = state.map.get(args.targets[n]);
              let clone = state.map.get(args.newKeys[n]);
              let p = state.map.get(args.parents[n]);
              let i = args.idxs[n];
              if (!p) continue;
              if (clone && el && el.tagName.toLowerCase() !== clone.tagName.toLowerCase()) {
                if (p.children[i] === el) p.replaceChild(clone, el);
              }
              setSrcAttr(clone || el, args.src, args.expr);
            }
          }, { targets: targetKeys, parents: parentKeys, idxs, newKeys, src: newSrc, expr: newExpr });
          await actions.changeSelection.handler({ cur, s: newKeys });
        } else {
          await ifeval(({ args }) => {
            let setSrcAttr = (node, srcVal, exprVal) => {
              if (!node) return;
              if (exprVal) {
                node.setAttribute('wf-src', exprVal);
              } else {
                node.removeAttribute('wf-src');
              }
              let resolved = srcVal != null ? srcVal : null;
              if (resolved) node.setAttribute('src', resolved);
              else node.removeAttribute('src');
            };
            for (let n = 0; n < args.targets.length; n++) {
              let el = state.map.get(args.targets[n]);
              let clone = state.map.get(args.newKeys[n]);
              let p = state.map.get(args.parents[n]);
              let i = args.idxs[n];
              if (!p) continue;
              if (clone && el && clone.tagName.toLowerCase() !== el.tagName.toLowerCase()) {
                if (p.children[i] === clone) p.replaceChild(el, clone);
              }
              let prevSrc = args.prevSrcs[n] || null;
              let prevExpr = args.prevExprs[n] || null;
              setSrcAttr(el, prevSrc, prevExpr);
            }
          }, { targets: targetKeys, parents: parentKeys, idxs, newKeys, prevSrcs, prevExprs });
          await actions.changeSelection.handler({ cur, s: targetKeys });
        }
      });
    },
  },

  // TODO: Test if possible to create a "list gallery media" function and reply using the success object in a usable way.
  setMediaSrcFromGallery: {
    shortcut: 'S',
    disabled: ({ cur = 'master' } = {}) => [!state.designer.open && `Designer closed.`, state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`],
    parameters: { type: 'object', properties: { cur: { type: 'string' } } },
    handler: async ({ cur = 'master' } = {}) => {
      let frame = state.designer.current;
      let [btn, url] = await showModal('MediaGalleryDialog');
      if (btn !== 'ok' || !url) return;
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'setMediaSrcFromGallery', cur, url });

      let mime = mimeLookup(url);
      let newTag = mime?.startsWith?.('audio/') ? 'audio' : mime?.startsWith?.('video/') ? 'video' : 'img';
      let targets = frame.cursors[cur].map(x => frame.map.get(x)).filter(Boolean);
      if (!targets.length) return;
      let prevSrcs = targets.map(x => x.getAttribute('src'));
      let targetKeys = targets.map(x => frame.map.getKey(x));
      let parentKeys = targets.map(x => frame.map.getKey(x.parentElement));
      let idxs = targets.map(x => [...x.parentElement.children].indexOf(x));
      let newKeys = [];

      await post('designer.pushHistory', cur, async apply => {
        if (apply && !newKeys.length) {
          newKeys = await ifeval(async ({ args }) => {
            let result = [];
            for (let n = 0; n < args.targets.length; n++) {
              let el = state.map.get(args.targets[n]);
              let p = state.map.get(args.parents[n]);
              let i = args.idxs[n];
              if (!el || !p) continue;
              let tag = args.newTag && args.newTag !== el.tagName.toLowerCase() ? args.newTag : el.tagName.toLowerCase();
              if (tag === el.tagName.toLowerCase()) {
                el.setAttribute('src', args.url);
                result.push(state.map.getKey(el));
                continue;
              }
              let clone = document.createElement(tag);
              for (let a of el.attributes) clone.setAttribute(a.name, a.value);
              clone.className = el.className;
              clone.innerHTML = el.innerHTML;
              clone.setAttribute('src', args.url);
              if (p.children[i] === el) p.replaceChild(clone, el);
              else p.insertBefore(clone, p.children[i] || null);
              result.push(clone);
            }
            await new Promise(pres => setTimeout(pres));
            return result.map(x => state.map.getKey(x));
          }, { targets: targetKeys, parents: parentKeys, idxs, url, newTag });
          await actions.changeSelection.handler({ cur, s: newKeys });
        } else if (apply) {
          await ifeval(({ args }) => {
            for (let n = 0; n < args.targets.length; n++) {
              let el = state.map.get(args.targets[n]);
              let clone = state.map.get(args.newKeys[n]);
              let p = state.map.get(args.parents[n]);
              let i = args.idxs[n];
              if (!p) continue;
              if (clone && el && el.tagName.toLowerCase() !== clone.tagName.toLowerCase()) {
                if (p.children[i] === el) p.replaceChild(clone, el);
              }
              let target = clone || el;
              if (!target) continue;
              target.setAttribute('src', args.url);
            }
          }, { targets: targetKeys, parents: parentKeys, idxs, newKeys, url });
          await actions.changeSelection.handler({ cur, s: newKeys });
        } else {
          await ifeval(({ args }) => {
            for (let n = 0; n < args.targets.length; n++) {
              let el = state.map.get(args.targets[n]);
              let clone = state.map.get(args.newKeys[n]);
              let p = state.map.get(args.parents[n]);
              let i = args.idxs[n];
              if (!p) continue;
              if (clone && el && clone.tagName.toLowerCase() !== el.tagName.toLowerCase()) {
                if (p.children[i] === clone) p.replaceChild(el, clone);
              }
              let prev = args.prevSrcs[n];
              if (prev) el.setAttribute('src', prev); else el.removeAttribute('src');
            }
          }, { targets: targetKeys, parents: parentKeys, idxs, newKeys, prevSrcs, prevExprs });
          await actions.changeSelection.handler({ cur, s: targetKeys });
        }
      });
    },
  },

  changeMediaFromPexels: {
    disabled: ({ cur = 'master' } = {}) => [!state.designer.open && `Designer closed.`, state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`],
    parameters: { type: 'object', properties: { cur: { type: 'string' }, query: { type: 'string' } } },
    handler: async ({ cur = 'master', query = '' } = {}) => {
      let [btn, url] = await showModal('PexelsGalleryDialog', { query, mode: 'media' });
      if (btn !== 'ok' || !url) return;
      await actions.changeMediaSrc.handler({ cur, src: url });
    },
  },

  changeBackgroundUrl: {
    shortcut: 'b',
    disabled: ({ cur = 'master' } = {}) => [!state.designer.open && `Designer closed.`, state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`],
    parameters: { type: 'object', properties: { cur: { type: 'string' }, url: { type: 'string' } } },
    handler: async ({ cur = 'master', url = null } = {}) => {
      let frame = state.designer.current;
      let targets = frame.cursors[cur].map(x => frame.map.get(x)).filter(Boolean);
      if (!targets.length) return;
      let prev = targets.map(x => x.style.backgroundImage);
      if (url == null) {
        let [btn, val] = await showModal('PromptDialog', { title: 'Change background image', label: 'Image URL', initialValue: prev[0]?.replace(/^url\(["']?|["']?\)$/g, '') });
        if (btn !== 'ok') return;
        url = val;
      }
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'changeBackgroundUrl', cur, url });
      let targetKeys = targets.map(x => frame.map.getKey(x));
      let newBg = url ? `url("${url}")` : '';
      await post('designer.pushHistory', cur, async apply => {
        await ifeval(({ args }) => {
          for (let n = 0; n < args.targets.length; n++) {
            let el = state.map.get(args.targets[n]);
            if (el) el.style.backgroundImage = args.apply ? args.newBg : args.prev[n];
          }
        }, { targets: targetKeys, newBg, prev, apply });
        await actions.changeSelection.handler({ cur, s: targetKeys });
      });
    },
  },

  changeBackgroundFromGallery: {
    shortcut: 'B',
    disabled: ({ cur = 'master' } = {}) => [!state.designer.open && `Designer closed.`, state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`],
    parameters: { type: 'object', properties: { cur: { type: 'string' } } },
    handler: async ({ cur = 'master' } = {}) => {
      let frame = state.designer.current;
      let [btn, url] = await showModal('MediaGalleryDialog');
      if (btn !== 'ok' || !url) return;
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'changeBackgroundFromGallery', cur, url });
      let targets = frame.cursors[cur].map(x => frame.map.get(x)).filter(Boolean);
      if (!targets.length) return;
      let prev = targets.map(x => x.style.backgroundImage);
      let targetKeys = targets.map(x => frame.map.getKey(x));
      let newBg = url ? `url("${url}")` : '';
      await post('designer.pushHistory', cur, async apply => {
        await ifeval(({ args }) => {
          for (let n = 0; n < args.targets.length; n++) {
            let el = state.map.get(args.targets[n]);
            if (el) el.style.backgroundImage = args.apply ? args.newBg : args.prev[n];
          }
        }, { targets: targetKeys, newBg, prev, apply });
        await actions.changeSelection.handler({ cur, s: targetKeys });
      });
    },
  },

  changeBackgroundFromPexels: {
    disabled: ({ cur = 'master' } = {}) => [!state.designer.open && `Designer closed.`, state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`],
    parameters: { type: 'object', properties: { cur: { type: 'string' }, query: { type: 'string' } } },
    handler: async ({ cur = 'master', query = '' } = {}) => {
      let [btn, url] = await showModal('PexelsGalleryDialog', { query, mode: 'background' });
      if (btn !== 'ok' || !url) return;
      await actions.changeBackgroundUrl.handler({ cur, url });
    },
  },

  setIfExpression: {
    description: `Sets conditional expression for displaying elements (prompts if not provided)`,
    shortcut: 'C',
    disabled: ({ cur = 'master' } = {}) => [!state.designer.open && `Designer closed.`, state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`],
    parameters: { type: 'object', properties: { cur: { type: 'string' }, expr: { type: 'string' } } },
    handler: async ({ cur = 'master', expr = null } = {}) => {
      let frame = state.designer.current;
      let targets = frame.cursors[cur].map(x => frame.map.get(x)).filter(Boolean);
      if (!targets.length) return;
      if (expr == null) {
        let initial = targets[0].getAttribute('wf-if');
        let [btn, val] = await showModal('PromptDialog', { title: 'Set if expression', placeholder: 'Expression', initialValue: initial });
        if (btn !== 'ok') return;
        expr = val.trim();
      }
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'setIfExpression', cur, expr });
      let targetKeys = targets.map(x => frame.map.getKey(x));
      let prev = targets.map(x => x.getAttribute('wf-if'));
      let newVal = expr;
      await post('designer.pushHistory', cur, async apply => {
        await ifeval(({ args }) => {
          for (let n = 0; n < args.targets.length; n++) {
            let el = state.map.get(args.targets[n]);
            if (!el) continue;
            let nv = args.apply ? args.newVal : args.prev[n];
            nv ? el.setAttribute('wf-if', nv) : el.removeAttribute('wf-if');
          }
        }, { targets: targetKeys, newVal, prev, apply });
        await actions.changeSelection.handler({ cur, s: targetKeys });
      });
      return { success: true, expr: newVal };
    },
  },

  setMapExpression: {
    description: `Sets map expression for repeating elements (prompts if not provided)`,
    shortcut: 'n',
    disabled: ({ cur = 'master' } = {}) => [!state.designer.open && `Designer closed.`, state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`],
    parameters: { type: 'object', properties: { cur: { type: 'string' }, expr: { type: 'string' } } },
    handler: async ({ cur = 'master', expr = null } = {}) => {
      let frame = state.designer.current;
      let targets = frame.cursors[cur].map(x => frame.map.get(x)).filter(Boolean);
      if (!targets.length) return;
      if (expr == null) {
        let initial = targets[0].getAttribute('wf-map');
        let [btn, val] = await showModal('PromptDialog', { title: 'Set map expression', placeholder: 'Expression (item of expr)', initialValue: initial });
        if (btn !== 'ok') return;
        expr = val.trim();
      }
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'setMapExpression', cur, expr });
      let targetKeys = targets.map(x => frame.map.getKey(x));
      let prev = targets.map(x => x.getAttribute('wf-map'));
      let newVal = expr;
      await post('designer.pushHistory', cur, async apply => {
        await ifeval(({ args }) => {
          for (let n = 0; n < args.targets.length; n++) {
            let el = state.map.get(args.targets[n]);
            if (!el) continue;
            let nv = args.apply ? args.newVal : args.prev[n];
            nv ? el.setAttribute('wf-map', nv) : el.removeAttribute('wf-map');
          }
        }, { targets: targetKeys, newVal, prev, apply });
        await actions.changeSelection.handler({ cur, s: targetKeys });
      });
      return { success: true, expr: newVal };
    },
  },

  setEventHandlers: {
    shortcut: 'E',
    disabled: ({ cur = 'master' } = {}) => [!state.designer.open && `Designer closed.`, state.designer.open && state.designer.current.cursors[cur]?.length !== 1 && `A single element must be selected.`],
    parameters: { type: 'object', properties: { cur: { type: 'string' } } },
    handler: async ({ cur = 'master', handlers } = {}) => {
      let frame = state.designer.current;
      let el = frame.map.get(frame.cursors[cur][0]);
      if (!el) return;
      let prevHandlers = getElementEventHandlers(el);
      let nextHandlers;
      if (handlers) {
        nextHandlers = normalizeEventHandlersInput(handlers);
      } else {
        let [btn, ...val] = await showModal('EventHandlersDialog', { handlers: prevHandlers });
        if (btn !== 'ok') return;
        nextHandlers = normalizeEventHandlersInput(val);
      }
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'setEventHandlers', cur, handlers: nextHandlers });
      let targetKey = frame.map.getKey(el);
      await post('designer.pushHistory', cur, async apply => {
        await ifeval(({ args }) => {
          let el = state.map.get(args.target);
          if (!el) return;
          for (let attr of [...el.attributes]) if (attr.name.startsWith('wf-on')) el.removeAttribute(attr.name);
          let list = args.apply ? args.next : args.prev;
          for (let h of list) if (h.name && h.expr) el.setAttribute(`wf-on${h.name}`, h.expr);
        }, { target: targetKey, prev: prevHandlers, next: nextHandlers, apply });
      });
      return { success: true, handlers: nextHandlers };
    },
  },

  addEventHandlers: {
    description: `Adds event handlers to the selected element without prompting.`,
    disabled: ({ cur = 'master' } = {}) => [!state.designer.open && `Designer closed.`, state.designer.open && state.designer.current.cursors[cur]?.length !== 1 && `A single element must be selected.`],
    parameters: { type: 'object', properties: { cur: { type: 'string' }, handlers: { type: 'array', items: { type: 'object' } } }, required: ['handlers'] },
    handler: async ({ cur = 'master', handlers } = {}) => {
      let frame = state.designer.current;
      let el = frame.map.get(frame.cursors[cur][0]);
      if (!el) return;
      let additions = normalizeEventHandlersInput(handlers);
      if (!additions.length) return { success: true, handlers: getElementEventHandlers(el) };
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'addEventHandlers', cur, handlers: additions });
      let targetKey = frame.map.getKey(el);
      let prev = getElementEventHandlers(el);
      let next = mergeEventHandlers(prev, additions);
      await post('designer.pushHistory', cur, async apply => {
        await ifeval(({ args }) => {
          let el = state.map.get(args.target);
          if (!el) return;
          for (let attr of [...el.attributes]) if (attr.name.startsWith('wf-on')) el.removeAttribute(attr.name);
          let list = args.apply ? args.next : args.prev;
          for (let h of list) if (h.name && h.expr) el.setAttribute(`wf-on${h.name}`, h.expr);
        }, { target: targetKey, prev, next, apply });
      });
      return { success: true, handlers: next };
    },
  },

  removeEventHandlers: {
    description: `Removes specific event handlers from the selected element.`,
    disabled: ({ cur = 'master' } = {}) => [!state.designer.open && `Designer closed.`, state.designer.open && state.designer.current.cursors[cur]?.length !== 1 && `A single element must be selected.`],
    parameters: { type: 'object', properties: { cur: { type: 'string' }, events: { type: 'array', items: { type: 'string' } } }, required: ['events'] },
    handler: async ({ cur = 'master', events } = {}) => {
      let frame = state.designer.current;
      let el = frame.map.get(frame.cursors[cur][0]);
      if (!el) return;
      let names = Array.isArray(events) ? events.map(x => String(x).trim()).filter(Boolean) : [];
      if (!names.length) throw new Error('events must include at least one handler name.');
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'removeEventHandlers', cur, events: names });
      let targetKey = frame.map.getKey(el);
      let prev = getElementEventHandlers(el);
      let next = filterEventHandlers(prev, names);
      await post('designer.pushHistory', cur, async apply => {
        await ifeval(({ args }) => {
          let el = state.map.get(args.target);
          if (!el) return;
          for (let attr of [...el.attributes]) if (attr.name.startsWith('wf-on')) el.removeAttribute(attr.name);
          let list = args.apply ? args.next : args.prev;
          for (let h of list) if (h.name && h.expr) el.setAttribute(`wf-on${h.name}`, h.expr);
        }, { target: targetKey, prev, next, apply });
      });
      return { success: true, handlers: next };
    },
  },

  setComponent: {
    shortcut: 'V',
    disabled: ({ cur = 'master' } = {}) => [!state.designer.open && `Designer closed.`, state.designer.open && state.designer.current.cursors[cur]?.length !== 1 && `A single element must be selected.`],
    parameters: { type: 'object', properties: { cur: { type: 'string' }, component: { type: 'string' }, componentProps: { type: 'object' } } },
    handler: async ({ cur = 'master', component, componentProps } = {}) => {
      let frame = state.designer.current;
      let el = frame.map.get(frame.cursors[cur][0]);
      if (!el) return;
      let prevComponent = el.getAttribute('wf-component');
      let prevComponentId = typeof prevComponent === 'string' && prevComponent.includes('#') ? prevComponent.split('#').pop().trim() : (prevComponent?.trim?.() || null);
      let prevPropsAttr = el.getAttribute('wf-props');
      let prevProps = null;
      try {
        prevProps = prevPropsAttr ? JSON.parse(prevPropsAttr) : null;
      } catch (err) {
        prevProps = null;
      }
      if (component === undefined && componentProps === undefined) {
        let [btn, nextComponent, nextProps] = await showModal('SetComponentDialog', { component: prevComponentId, componentProps: prevProps });
        if (btn !== 'ok') return;
        component = nextComponent;
        componentProps = nextProps;
      }
      let normalizedComponent = typeof component === 'string' ? component.trim() : component;
      if (normalizedComponent === '') normalizedComponent = null;
      if (normalizedComponent !== null && normalizedComponent !== undefined && typeof normalizedComponent !== 'string') normalizedComponent = String(normalizedComponent);
      if (normalizedComponent === undefined) normalizedComponent = prevComponentId ?? null;
      if (typeof normalizedComponent === 'string' && normalizedComponent.includes('#')) normalizedComponent = normalizedComponent.split('#').pop();
      let propsObject = null;
      if (Array.isArray(componentProps)) {
        let entries = {};
        for (let item of componentProps) {
          if (!item) continue;
          let name = typeof item.name === 'string' ? item.name.trim() : '';
          let expr = item.expr;
          let exprStr = expr == null ? '' : String(expr).trim();
          if (!name || !exprStr) continue;
          let asNumber = /^-?\d+(?:\.\d+)?$/.test(exprStr) ? Number(exprStr) : null;
          entries[name] = asNumber !== null ? asNumber : exprStr;
        }
        if (Object.keys(entries).length) propsObject = entries;
      } else if (componentProps && typeof componentProps === 'object') {
        let entries = {};
        for (let [name, expr] of Object.entries(componentProps)) {
          let propName = typeof name === 'string' ? name.trim() : '';
          let propExpr = expr == null ? '' : String(expr).trim();
          if (!propName || !propExpr) continue;
          let asNumber = /^-?\d+(?:\.\d+)?$/.test(propExpr) ? Number(propExpr) : null;
          entries[propName] = asNumber !== null ? asNumber : propExpr;
        }
        if (Object.keys(entries).length) propsObject = entries;
      }
      if (!normalizedComponent) propsObject = null;
      let nextComponentAttr = normalizedComponent ? normalizedComponent : null;
      let nextPropsAttr = propsObject ? JSON.stringify(propsObject) : null;
      if ((prevComponent || null) === (nextComponentAttr || null) && (prevPropsAttr || null) === (nextPropsAttr || null)) return;
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'setComponent', cur, component: nextComponentAttr, componentProps: propsObject });
      let targetKey = frame.map.getKey(el);
      await post('designer.pushHistory', cur, async apply => {
        await ifeval(({ args }) => {
          let el = state.map.get(args.target);
          if (!el) return;
          let componentVal = args.apply ? args.nextComponent : args.prevComponent;
          let propsVal = args.apply ? args.nextProps : args.prevProps;
          if (componentVal) el.setAttribute('wf-component', componentVal); else el.removeAttribute('wf-component');
          if (propsVal) el.setAttribute('wf-props', propsVal); else el.removeAttribute('wf-props');
        }, { target: targetKey, prevComponent, prevProps: prevPropsAttr, nextComponent: nextComponentAttr, nextProps: nextPropsAttr, apply });
      });
    },
  },

  setDisabledExpression: {
    shortcut: 'D',
    disabled: ({ cur = 'master' } = {}) => [!state.designer.open && `Designer closed.`, state.designer.open && !state.designer.current.cursors[cur]?.length && `No elements selected.`],
    parameters: { type: 'object', properties: { cur: { type: 'string' }, expr: { type: 'string' } } },
    handler: async ({ cur = 'master', expr = null } = {}) => {
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'setDisabledExpression', cur, expr });
      let frame = state.designer.current;
      let targets = frame.cursors[cur].map(x => frame.map.get(x)).filter(Boolean);
      if (!targets.length) return;
      if (expr == null) {
        let initial = targets[0].getAttribute('wf-disabled');
        let [btn, val] = await showModal('PromptDialog', { title: 'Set disabled expression', placeholder: 'Expression (e.g. !form.valid)', initialValue: initial });
        if (btn !== 'ok') return;
        expr = val.trim();
      }
      let targetKeys = targets.map(x => frame.map.getKey(x));
      let prev = targets.map(x => x.getAttribute('wf-disabled'));
      let newVal = expr;
      await post('designer.pushHistory', cur, async apply => {
        await ifeval(({ args }) => {
          for (let n = 0; n < args.targets.length; n++) {
            let el = state.map.get(args.targets[n]);
            if (!el) continue;
            let nv = args.apply ? args.newVal : args.prev[n];
            nv ? el.setAttribute('wf-disabled', nv) : el.removeAttribute('wf-disabled');
          }
        }, { targets: targetKeys, newVal, prev, apply });
        await actions.changeSelection.handler({ cur, s: targetKeys });
      });
      return { success: true, expr: newVal };
    },
  },

  normalizeStylesUnion: {
    description: `Makes all selected elements have the union of their classes`,
    shortcut: 'Alt-u',
    disabled: ({ cur = 'master' } = {}) => [!state.designer.open && `Designer closed.`, state.designer.open && (state.designer.current.cursors[cur]?.length || 0) < 2 && `At least 2 elements must be selected.`],
    parameters: { type: 'object', properties: { cur: { type: 'string' } } },
    handler: async ({ cur = 'master' } = {}) => {
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'normalizeStylesUnion', cur });
      let frame = state.designer.current;
      let all = frame.cursors[cur].map(x => frame.map.get(x)).filter(Boolean);
      if (!all.length) return;
      let targetKeys = all.map(x => frame.map.getKey(x));
      let prev = all.map(x => x.className);
      let union = new Set();
      for (let el of all) for (let c of el.classList) union.add(c);
      let merged = [...union].join(' ').trim();
      await post('designer.pushHistory', cur, async apply => {
        await ifeval(({ args }) => {
          for (let n = 0; n < args.targets.length; n++) {
            let el = state.map.get(args.targets[n]);
            if (el) el.className = args.apply ? args.merged : args.prev[n];
          }
        }, { targets: targetKeys, merged, prev, apply });
      });
    },
  },

  normalizeStylesIntersect: {
    description: `Makes all selected elements have the intersection of their classes`,
    shortcut: 'Alt-U',
    disabled: ({ cur = 'master' } = {}) => [
      !state.designer.open && `Designer closed.`,
      state.designer.open && (state.designer.current.cursors[cur]?.length || 0) < 2 && `At least 2 elements must be selected.`,
    ],
    parameters: { type: 'object', properties: { cur: { type: 'string' } } },
    handler: async ({ cur = 'master' } = {}) => {
      if (state.collab.uid !== 'master') return state.collab.rtc.send({ type: 'cmd', k: 'normalizeStylesIntersect', cur });
      let frame = state.designer.current;
      let all = frame.cursors[cur].map(x => frame.map.get(x)).filter(Boolean);
      if (!all.length) return;
      let targetKeys = all.map(x => frame.map.getKey(x));
      let prev = all.map(x => x.className);
      let intersection = new Set(all[0].classList);
      for (let i = 1; i < all.length; i++) for (let c of [...intersection]) if (!all[i].classList.contains(c)) intersection.delete(c);
      let merged = [...intersection].join(' ').trim();
      await post('designer.pushHistory', cur, async apply => {
        await ifeval(({ args }) => {
          for (let n = 0; n < args.targets.length; n++) {
            let el = state.map.get(args.targets[n]);
            if (el) el.className = args.apply ? args.merged : args.prev[n];
          }
        }, { targets: targetKeys, merged, prev, apply });
      });
    },
  },

  updatePlan: {
    description: "Updates the task plan.\nProvide an optional explanation and a list of plan items, each with a step and status.\nAt most one step can be in_progress at a time.\n",
    codexOnly: true,
    parameters: {
      "type": "object",
      "properties": {
        "explanation": {
          "type": "string"
        },
        "plan": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "status": {
                "type": "string",
                "description": "One of: pending, in_progress, completed"
              },
              "step": {
                "type": "string"
              }
            },
            "required": [
              "step",
              "status"
            ],
            "additionalProperties": false
          },
          "description": "The list of steps"
        }
      },
      "required": [
        "plan"
      ],
      "additionalProperties": false
    },
    handler: ({ plan }) => { state.assistant.plan = plan; console.log(`Plan updated:\n${plan.map((x, i) => `- ${i + 1}. ${x.step} [${x.status}]}`).join('\n')}`); return `Plan updated` },
  },

  refresh: {
    shortcut: 'r',
    disabled: () => [!state.designer.open && `Designer closed.`],
    codexHidden: () => true,
    handler: async () => {
      if (state.collab.uid !== 'master') return;
      await post('designer.refresh');
    },
  },

  throwConfetti: { description: `Use only when dictated by cue instructions or the user really deserves it or sounds excited.`, codexHidden: () => true, handler: () => { confetti() } },
};

function getTailwindColorInfo(prefix, cur = state.collab.uid) {
  let frame = state.designer.current;
  let regex = prefix === 'bg' ? BG_COLOR_RE : TEXT_COLOR_RE;
  if (!frame) return { frame: null, elements: [], matches: [], regex };
  let ids = frame.cursors[cur] || [];
  let elements = ids.map(id => frame.map.get(id)).filter(Boolean);
  let matches = elements.map(el => {
    for (let cls of el?.classList || []) {
      let match = cls.match(regex);
      if (match) return { className: match[0], hue: match[1], shade: match[2] };
    }
    return null;
  });
  return { frame, elements, matches, regex };
}

async function loadFileText(path) {
  if (state.collab?.uid && state.collab.uid !== 'master') throw new Error(`Peers can't read files directly.`);
  if (!state.projects.current) throw new Error('Project not open.');
  if (!path) throw new Error('No file specified.');
  if (path.endsWith('/')) throw new Error(`Path is a directory: ${path}`);
  let project = state.projects.current;
  let blob = await rfiles.load(project, path);
  if (!blob) throw new Error(`File not found: ${path}`);
  let type = mimeLookup(path) || blob.type || '';
  if (!isLikelyTextFile(path, type)) return null;
  try {
    return await blob.text();
  } catch (err) {
    throw new Error(`Unable to read ${path}: ${err?.message || err}`);
  }
}

async function loadFileLines(path) {
  try {
    let text = await loadFileText(path);
    let lines = splitLines(text);
    return { text, lines, lineCount: lines.length };
  } catch (err) {
    console.error(err);
    return null;
  }
}

function splitLines(text) {
  if (text == null) return [];
  let normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized === '') return [];
  return normalized.split('\n');
}

function isLikelyTextFile(path, type = '') {
  if (!path) return false;
  let lower = path.toLowerCase();
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return true;
  if (!type) {
    if (/(\.png|\.jpe?g|\.gif|\.bmp|\.ico|\.pdf|\.zip|\.rar|\.7z|\.mp[34]|\.ogg|\.wav|\.flac|\.woff2?|\.ttf|\.eot|\.otf)$/i.test(lower)) return false;
    return true;
  }
  if (/^text\//i.test(type)) return true;
  if (/(javascript|json|xml|svg|yaml|x-sh|x-python|x-shellscript)/i.test(type)) return true;
  if (/(image|audio|video|font|zip|gzip|pdf|msword|vnd)/i.test(type)) return false;
  return true;
}

function shouldSkipSearchPath(path) {
  if (!path) return true;
  if (path.endsWith('/')) return true;
  if (/^webfoundry\//.test(path)) return true;
  if (/^wf\.uiconfig\.json$/i.test(path)) return true;
  if (/\.sw.$/.test(path)) return true;
  if (/^index\.html$/i.test(path)) return true;
  if (/^\.git\//.test(path)) return true;
  if (/(^|\/)node_modules\//.test(path)) return true;
  return false;
}

function ensureEditorContext({ requireWritable = false } = {}) {
  let editorCtrl = rawctrls?.codeEditor;
  if (!editorCtrl) throw new Error('Code editor unavailable.');
  let path = editorCtrl.state.currentPath;
  if (!path) throw new Error('Code editor is not focused on a file.');
  if (requireWritable && state.collab?.uid && state.collab.uid !== 'master') throw new Error(`Peers can't edit files.`);
  let entry = editorCtrl.currentDocEntry || null;
  let cm = entry?.cm || null;
  let textarea = editorCtrl.state.fallbackTextarea || null;
  return { editorCtrl, entry, cm, textarea, path, project: editorCtrl.state.currentProject };
}

function fallbackBuildLineIndex(text) {
  let lines = [];
  let start = 0;
  let len = text.length;
  for (let i = 0; i < len; i++) {
    let ch = text[i];
    if (ch === '\r') {
      lines.push({ start, end: i });
      if (text[i + 1] === '\n') i++;
      start = i + 1;
      continue;
    }
    if (ch === '\n') {
      lines.push({ start, end: i });
      start = i + 1;
    }
  }
  if (start <= len) lines.push({ start, end: len });
  if (!lines.length) lines.push({ start: 0, end: len });
  return lines;
}

function fallbackResolveLinePosition(lines, line, column) {
  let totalLines = lines.length;
  let requestedLine = Math.max(1, Math.min(Math.floor(line) || 1, totalLines));
  let info = lines[requestedLine - 1];
  let lineLength = Math.max(0, info.end - info.start);
  let requestedColumn = column == null ? 1 : Number(column);
  if (!Number.isFinite(requestedColumn) || requestedColumn < 1) requestedColumn = 1;
  if (requestedColumn > lineLength + 1) requestedColumn = lineLength + 1;
  let index = info.start + requestedColumn - 1;
  return { index, lineNumber: requestedLine, column: requestedColumn, lineLength };
}

function fallbackLineColumnFromIndex(lines, index) {
  if (!lines.length) return { line: 1, column: 1 };
  let last = lines[lines.length - 1];
  let maxIndex = last.end;
  let clampedIndex = Math.max(0, Math.min(Number(index) || 0, maxIndex));
  for (let i = 0; i < lines.length; i++) {
    let info = lines[i];
    if (clampedIndex <= info.end) {
      return { line: i + 1, column: clampedIndex - info.start + 1 };
    }
  }
  return { line: lines.length, column: last.end - last.start + 1 };
}

function getElementEventHandlers(el) {
  let handlers = [];
  if (!el) return handlers;
  for (let attr of el.attributes) {
    if (attr.name.startsWith('wf-on')) {
      handlers.push({ name: attr.name.slice(5), expr: attr.value });
    }
  }
  return handlers;
}

function normalizeEventHandlersInput(list) {
  if (!Array.isArray(list)) throw new Error('handlers must be an array of { name, expr }');
  let normalized = [];
  for (let item of list) {
    if (!item) continue;
    if (Array.isArray(item)) {
      for (let entry of normalizeEventHandlersInput(item)) normalized.push(entry);
      continue;
    }
    let name = item.name ?? item.event ?? item.type;
    let expr = item.expr ?? item.expression ?? item.handler;
    if (typeof name !== 'string') name = name != null ? String(name) : '';
    if (typeof expr !== 'string') expr = expr != null ? String(expr) : '';
    name = name.trim();
    expr = expr.trim();
    if (!name || !expr) continue;
    normalized.push({ name, expr });
  }
  return normalized;
}

function mergeEventHandlers(prev, additions) {
  let additionsMap = new Map();
  for (let h of additions) additionsMap.set(h.name, h.expr);
  let next = prev.map(h => additionsMap.has(h.name) ? { name: h.name, expr: additionsMap.get(h.name) } : { ...h });
  let prevNames = new Set(prev.map(h => h.name));
  for (let h of additions) if (!prevNames.has(h.name)) next.push({ name: h.name, expr: h.expr });
  return next;
}

function filterEventHandlers(prev, names) {
  let nameSet = new Set(names.map(n => n.toLowerCase()));
  return prev.filter(h => !nameSet.has(h.name.toLowerCase()));
}

let ifeval = (fn, args) => new Promise((resolve, reject) => {
  let frame = state.designer.current;
  let iforigin = new URL(frame.el.src).origin;
  let rpcid = crypto.randomUUID();
  let body = fn.toString().replace(/^async\s*/, '').replace(/^[^(]*\([^)]*\)\s*=>\s*\{?/, '').replace(/\}$/, '').trim();
  let listener = ev => {
    if (ev.origin !== iforigin || ev.data.type !== 'eval:res' || ev.data.rpcid !== rpcid) return;
    removeEventListener('message', listener);
    if (ev.data.error) reject(new Error(ev.data.error));
    else resolve(ev.data.result);
  };
  addEventListener('message', listener);
  frame.el.contentWindow.postMessage({ type: 'eval', fn: body, rpcid, args }, iforigin);
});

function patchWfClass(el, { add = [], remove = [], replace = null }) {
  let attr = el.getAttribute('wf-class');
  if (!attr) return;
  let pieces = [...attr.matchAll(/{{[\s\S]*?}}/g)].map(m => m[0]);
  let newPieces = [];
  for (let p of pieces) {
    let expr = p;
    for (let c of remove) expr = expr.replaceAll(new RegExp(`['"\`]${c}['"\`]`, 'g'), "''");
    if (replace?.old && replace?.cls) for (let oldC of replace.old) for (let newC of replace.cls) expr = expr.replaceAll(new RegExp(`['"\`]${oldC}['"\`]`, 'g'), `'${newC}'`);
    if (add.length && !/['"]/.test(expr)) {
      let additions = add.map(c => `'${c}'`).join(' + " " + ');
      expr = `(${expr}) + " " + (${additions})`;
    }
    newPieces.push(expr);
  }
  el.setAttribute('wf-class', newPieces.join(' '));
}

export default actions;

import { isMedia, debounce } from '../other/util.js';
import { mountCodeMirror } from '../other/codemirror.js';
import rfiles from '../repos/rfiles.js';
import { lookup as mimeLookup } from 'https://esm.sh/mrmime';
import * as Y from 'https://esm.sh/yjs@13.6.12?bundle';
import { CodemirrorBinding } from 'https://esm.sh/y-codemirror?bundle';

let UPDATE_SOURCE_REMOTE = Symbol('codeEditor.remote');
let COLOR_MAP = {
  'red-600': '#dc2626',
  'red-800': '#991b1b',
  'orange-600': '#ea580c',
  'orange-800': '#9a3412',
  'amber-600': '#d97706',
  'amber-800': '#92400e',
  'yellow-600': '#ca8a04',
  'yellow-800': '#854d0e',
  'lime-600': '#65a30d',
  'lime-800': '#3f6212',
  'green-600': '#16a34a',
  'green-800': '#166534',
  'emerald-600': '#059669',
  'emerald-800': '#065f46',
  'teal-600': '#0d9488',
  'teal-800': '#115e59',
  'cyan-600': '#0891b2',
  'cyan-800': '#155e75',
  'sky-600': '#0284c7',
  'sky-800': '#075985',
  'blue-600': '#2563eb',
  'blue-800': '#1e40af',
  'indigo-600': '#4f46e5',
  'indigo-800': '#3730a3',
  'violet-600': '#7c3aed',
  'violet-800': '#5b21b6',
  'purple-600': '#9333ea',
  'purple-800': '#6b21a8',
  'fuchsia-600': '#c026d3',
  'fuchsia-800': '#86198f',
  'pink-600': '#db2777',
  'pink-800': '#9d174d',
  'rose-600': '#e11d48',
  'rose-800': '#9f1239',
};

let encodeUpdate = update => {
  if (!update) return '';
  let chars = Array.from(update, x => String.fromCharCode(x));
  return btoa(chars.join(''));
};

let decodeUpdate = encoded => {
  if (!encoded) return new Uint8Array();
  let chars = atob(encoded);
  let view = new Uint8Array(chars.length);
  for (let i = 0; i < chars.length; i++) view[i] = chars.charCodeAt(i);
  return view;
};

let resolveColor = (name, alpha = 1) => {
  let hex = COLOR_MAP[name] || '#94a3b8';
  if (alpha >= 1) return hex;
  let r = parseInt(hex.slice(1, 3), 16);
  let g = parseInt(hex.slice(3, 5), 16);
  let b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

export default class CodeEditor {
  state = {
    target(path) {
      let isHtmlTemplate = ((/^components\//.test(path) || /^pages\//.test(path)) && path.endsWith('.html'));
      return path && !isMedia(path) && !isHtmlTemplate;
    },
    ready: false,
    pendingOpen: false,
    currentProject: null,
    currentPath: null,
    hostElement: null,
    placeholderElement: null,
    editorMount: null,
    editorContainer: null,
    currentValue: '',
    initialValue: '',
    dirty: false,
    loading: false,
    saving: false,
    externalChange: false,
    handlersAttached: false,
    busSubscribed: false,
    fallbackTextarea: null,
    recentSaveAt: 0,
    docs: new Map(),
    collabBound: false,
  };

  currentDocEntry = null;
  boundRTC = null;

  waitForWrapper = async () => {
    // Wait for the CodeEditor host element to exist (peers can receive events before it renders).
    let wrapper = document.querySelector('#CodeEditor');
    if (wrapper) {
      return wrapper;
    }
    if (!document.body) {
      return null;
    }
    let resolveWrapper;
    let timeoutId;
    let promise = new Promise(resolve => {
      resolveWrapper = resolve;
    });
    let observer = new MutationObserver(() => {
      let found = document.querySelector('#CodeEditor');
      if (!found) {
        return;
      }
      observer.disconnect();
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      resolveWrapper(found);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    timeoutId = setTimeout(() => {
      observer.disconnect();
      resolveWrapper(null);
    }, 500);
    let result = await promise;
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    return result;
  };

  renderPlaceholder = async message => {
    let wrapper = await this.waitForWrapper();
    if (!wrapper) {
      return null;
    }
    this.destroyEditorUI();
    if (!this.state.placeholderElement) {
      let placeholder = d.el('div', {
        class: 'CodeEditor-placeholder flex flex-1 items-center justify-center bg-black/20 p-6 text-center text-sm italic',
      });
      this.state.placeholderElement = placeholder;
    }
    let placeholder = this.state.placeholderElement;
    placeholder.textContent = message;
    wrapper.replaceChildren(placeholder);
    return placeholder;
  };

  destroyEditorUI = () => {
    if (this.currentDocEntry) {
      let entry = this.currentDocEntry;
      if (state.collab?.rtc) {
        try {
          state.collab.rtc.send({ type: 'codeEditor:selection', project: entry.project, path: entry.path, anchor: null, head: null });
        } catch (err) {
          console.error('CodeEditor selection clear failed', err);
        }
      }
      if (entry.cursorHandler && entry.cm) {
        entry.cm.off('cursorActivity', entry.cursorHandler);
      }
      if (entry.binding && entry.binding.destroy) {
        entry.binding.destroy();
      }
      this.clearLocalSelection(entry);
      this.clearPeerSelections(entry);
      entry.cm = null;
      entry.binding = null;
      entry.cursorHandler = null;
      this.currentDocEntry = null;
    }
    if (this.state.editorMount) {
      this.state.editorMount.destroy();
    }
    if (this.state.fallbackTextarea) {
      this.state.fallbackTextarea.removeEventListener('input', this.handleFallbackInput);
    }
    this.state.hostElement = null;
    this.state.editorMount = null;
    this.state.editorContainer = null;
    this.state.fallbackTextarea = null;
  };

  docKey = (project, path) => `${project}:${path}`;

  getDocEntry = (project, path) => {
    let key = this.docKey(project, path);
    let entry = this.state.docs.get(key);
    if (!entry) {
      let doc = new Y.Doc();
      let text = doc.getText('codemirror');
      let undoManager = new Y.UndoManager(text);
      entry = {
        key,
        project,
        path,
        doc,
        text,
        undoManager,
        binding: null,
        cm: null,
        cursorHandler: null,
        selectionMarkers: new Map(),
        selfSelection: null,
        selectionBroadcastTimer: null,
        bootstrapPromise: null,
        initialized: false,
        lastSelection: null,
        lastSelectionBroadcastAt: 0,
      };
      doc.on('update', (update, origin) => this.handleYDocUpdate(entry, update, origin));
      text.observe(() => this.handleYTextChange(entry));
      this.state.docs.set(key, entry);
    }
    return entry;
  };

  initializeDoc = async (entry, initialText = '') => {
    if (entry.initialized) {
      if ((state.collab?.uid == null || state.collab.uid === 'master') && initialText !== undefined) {
        let existing = entry.text.toString();
        if (existing !== initialText) {
          entry.doc.transact(() => {
            entry.text.delete(0, entry.text.length);
            if (initialText) entry.text.insert(0, initialText);
          }, 'bootstrap');
          entry.undoManager?.clear?.();
        }
      }
      return entry;
    }
    if (entry.bootstrapPromise) {
      await entry.bootstrapPromise;
      return entry;
    }
    entry.bootstrapPromise = (async () => {
      if (!state.collab?.rtc || state.collab.uid === 'master') {
        entry.doc.transact(() => {
          entry.text.delete(0, entry.text.length);
          if (initialText) entry.text.insert(0, initialText);
        }, 'bootstrap');
        entry.initialized = true;
        entry.undoManager?.clear?.();
        return entry;
      }
      try {
        let encoded = await post('collab.rpc', 'codeEditorState', { project: entry.project, path: entry.path });
        if (encoded) {
          let update = decodeUpdate(encoded);
          Y.applyUpdate(entry.doc, update, UPDATE_SOURCE_REMOTE);
          entry.initialized = true;
          entry.undoManager?.clear?.();
          return entry;
        }
      } catch (err) {
        console.error('CodeEditor doc sync failed', err);
      }
      entry.doc.transact(() => {
        entry.text.delete(0, entry.text.length);
        if (initialText) entry.text.insert(0, initialText);
      }, 'bootstrap');
      entry.initialized = true;
      entry.undoManager?.clear?.();
      return entry;
    })();
    await entry.bootstrapPromise;
    entry.bootstrapPromise = null;
    return entry;
  };

  handleYDocUpdate = (entry, update, origin) => {
    if (!update?.length) {
      return;
    }
    if (origin === UPDATE_SOURCE_REMOTE) {
      return;
    }
    if (!state.collab?.rtc || !this.state.collabBound) {
      return;
    }
    let payload = {
      type: 'codeEditor:update',
      project: entry.project,
      path: entry.path,
      update: encodeUpdate(update),
    };
    try {
      state.collab.rtc.send(payload);
    } catch (err) {
      console.error('CodeEditor broadcast failed', err);
    }
  };

  handleYTextChange = entry => {
    if (this.state.currentProject !== entry.project || this.state.currentPath !== entry.path) {
      return;
    }
    this.state.currentValue = entry.text.toString();
    this.updateDirtyState();
    if (state.collab?.uid == null || state.collab.uid === 'master') {
      this.scheduleSave();
    }
  };

  applyRemoteUpdate = async ({ project, path, update }) => {
    try {
      let entry = this.getDocEntry(project, path);
      let decoded = decodeUpdate(update);
      Y.applyUpdate(entry.doc, decoded, UPDATE_SOURCE_REMOTE);
      entry.initialized = true;
    } catch (err) {
      console.error('CodeEditor apply update failed', err);
    }
  };

  ensureCollabListeners = () => {
    let rtc = state.collab?.rtc;
    if (!rtc || !rtc.events) {
      return;
    }
    if (this.boundRTC === rtc) {
      return;
    }
    this.boundRTC = rtc;
    this.state.collabBound = true;
    rtc.events.on('codeEditor:update', async payload => await this.applyRemoteUpdate(payload));
    rtc.events.on('codeEditor:selection', payload => this.applyRemoteSelection(payload));
    rtc.events.on('presence:leave', () => this.cleanupPeerSelections());
    rtc.events.on('presence:update', () => this.cleanupPeerSelections());
  };

  bindEditorToDoc = entry => {
    if (!this.state.editorMount?.editor) {
      return;
    }
    let cm = this.state.editorMount.editor;
    if (entry.binding && entry.binding.destroy) {
      entry.binding.destroy();
    }
    if (entry.cursorHandler && entry.cm) {
      entry.cm.off('cursorActivity', entry.cursorHandler);
    }
    let currentValue = entry.text.toString();
    if (cm.getValue() !== currentValue) {
      cm.setValue(currentValue);
    }
    entry.binding = new CodemirrorBinding(entry.text, cm, undefined, { yUndoManager: entry.undoManager });
    entry.cm = cm;
    entry.cursorHandler = () => this.handleCursorActivity(entry);
    cm.on('cursorActivity', entry.cursorHandler);
    this.currentDocEntry = entry;
    this.state.currentValue = currentValue;
    this.handleCursorActivity(entry);
    this.broadcastSelection(entry);
  };

  handleCursorActivity = entry => {
    if (!entry?.cm) {
      return;
    }
    let selections = entry.cm.listSelections();
    if (!selections?.length) {
      return;
    }
    let primary = selections[0];
    let anchorIndex = entry.cm.indexFromPos(primary.anchor);
    let headIndex = entry.cm.indexFromPos(primary.head);
    entry.lastSelection = { anchor: anchorIndex, head: headIndex };
    this.renderLocalSelection(entry, anchorIndex, headIndex);
    this.scheduleSelectionBroadcast(entry);
  };

  scheduleSelectionBroadcast = entry => {
    if (!state.collab?.rtc || !state.collab.rtc.send) {
      return;
    }
    if (!entry.lastSelection) {
      return;
    }
    if (entry.selectionBroadcastTimer) {
      return;
    }
    entry.selectionBroadcastTimer = setTimeout(() => {
      entry.selectionBroadcastTimer = null;
      this.broadcastSelection(entry);
    }, 60);
  };

  broadcastSelection = entry => {
    if (!state.collab?.rtc || !entry.lastSelection) {
      return;
    }
    try {
      state.collab.rtc.send({
        type: 'codeEditor:selection',
        project: entry.project,
        path: entry.path,
        anchor: entry.lastSelection.anchor,
        head: entry.lastSelection.head,
      });
    } catch (err) {
      console.error('CodeEditor selection broadcast failed', err);
    }
  };

  applyRemoteSelection = payload => {
    if (!payload) {
      return;
    }
    let peer = payload.peer;
    if (!peer || peer === state.collab?.uid) {
      return;
    }
    let entry = this.currentDocEntry;
    if (!entry || !entry.cm) {
      return;
    }
    if (entry.project !== payload.project || entry.path !== payload.path) {
      return;
    }
    let markers = entry.selectionMarkers || new Map();
    if (markers.has(peer)) {
      let prev = markers.get(peer);
      prev.mark?.clear?.();
      prev.caret?.clear?.();
    }
    if (payload.anchor == null || payload.head == null) {
      markers.delete(peer);
      return;
    }
    let cm = entry.cm;
    let anchor = Math.max(0, Math.min(payload.anchor, cm.getValue().length));
    let head = Math.max(0, Math.min(payload.head, cm.getValue().length));
    let from = cm.posFromIndex(Math.min(anchor, head));
    let to = cm.posFromIndex(Math.max(anchor, head));
    let caretPos = cm.posFromIndex(head);
    let presenceColor = state.collab?.rtc?.presence?.find?.(x => x.user === peer)?.color;
    let mark = null;
    if (anchor !== head) {
      mark = cm.markText(from, to, {
        css: `background: ${resolveColor(presenceColor, 0.25)}; border-radius: 2px;`,
      });
    }
    let caretEl = document.createElement('span');
    caretEl.className = 'CodeEditor-peerCaret animate-pulse pointer-events-none';
    caretEl.style.display = 'block';
    caretEl.style.position = 'absolute';
    caretEl.style.left = '-1px';
    caretEl.style.top = '0';
    caretEl.style.height = `${cm.defaultTextHeight()}px`;
    caretEl.style.borderLeft = `2px solid ${resolveColor(presenceColor, 1)}`;
    caretEl.style.pointerEvents = 'none';
    caretEl.style.transform = 'translate(0, -0.75rem)';
    let container = document.createElement('span');
    container.style.position = 'relative';
    container.style.display = 'inline-block';
    container.style.width = '0';
    container.style.height = '0';
    container.append(caretEl);
    let caret = cm.setBookmark(caretPos, { widget: container, insertLeft: true, handleMouseEvents: false });
    markers.set(peer, { mark, caret, color: presenceColor });
    entry.selectionMarkers = markers;
  };

  cleanupPeerSelections = () => {
    let entry = this.currentDocEntry;
    if (!entry) {
      return;
    }
    if (!state.collab?.rtc) {
      this.clearPeerSelections(entry);
      this.boundRTC = null;
      return;
    }
    let active = new Set((state.collab.rtc.presence || []).map(x => x.user));
    for (let [peer, handles] of entry.selectionMarkers.entries()) {
      if (!active.has(peer)) {
        handles.mark?.clear?.();
        handles.caret?.clear?.();
        entry.selectionMarkers.delete(peer);
      }
    }
  };

  clearPeerSelections = entry => {
    if (!entry?.selectionMarkers) {
      return;
    }
    if (entry.selectionBroadcastTimer) {
      clearTimeout(entry.selectionBroadcastTimer);
      entry.selectionBroadcastTimer = null;
    }
    for (let [, handles] of entry.selectionMarkers.entries()) {
      handles.mark?.clear?.();
      handles.caret?.clear?.();
    }
    entry.selectionMarkers.clear();
  };

  clearLocalSelection = entry => {
    if (!entry?.selfSelection) {
      return;
    }
    entry.selfSelection.mark?.clear?.();
    entry.selfSelection.caret?.clear?.();
    entry.selfSelection = null;
  };

  renderLocalSelection = (entry, anchor, head) => {
    if (!entry?.cm) {
      return;
    }
    this.clearLocalSelection(entry);
    let cm = entry.cm;
    let valueLength = cm.getValue().length;
    let anchorIndex = Math.max(0, Math.min(anchor ?? 0, valueLength));
    let headIndex = Math.max(0, Math.min(head ?? anchorIndex, valueLength));
    let colorName = state.collab?.rtc?.color || 'sky-600';
    let from = cm.posFromIndex(Math.min(anchorIndex, headIndex));
    let to = cm.posFromIndex(Math.max(anchorIndex, headIndex));
    let caretPos = cm.posFromIndex(headIndex);
    let mark = null;
    if (anchorIndex !== headIndex) {
      mark = cm.markText(from, to, {
        css: `background: ${resolveColor(colorName, 0.25)}; border-radius: 2px;`,
      });
    }
    let caretEl = document.createElement('span');
    caretEl.className = 'CodeEditor-selfCaret animate-pulse';
    caretEl.style.display = 'block';
    caretEl.style.position = 'absolute';
    caretEl.style.left = '-1px';
    caretEl.style.top = '0';
    caretEl.style.height = `${cm.defaultTextHeight()}px`;
    caretEl.style.borderLeft = `2px solid ${resolveColor(colorName, 1)}`;
    caretEl.style.pointerEvents = 'none';
    caretEl.style.transform = 'translate(0, -0.75rem)';
    let container = document.createElement('span');
    container.style.position = 'relative';
    container.style.display = 'inline-block';
    container.style.width = '0';
    container.style.height = '0';
    container.append(caretEl);
    let caret = cm.setBookmark(caretPos, { widget: container, insertLeft: true, handleMouseEvents: false });
    entry.selfSelection = { mark, caret };
  };

  buildEditorShell = async () => {
    let wrapper = await this.waitForWrapper();
    if (!wrapper) {
      return null;
    }
    this.destroyEditorUI();
    this.state.placeholderElement = null;
    let root = d.el('div', { class: 'CodeEditor-root flex h-full flex-col bg-black/20' });
    let editorContainer = d.el('div', { class: 'CodeEditor-editor relative flex flex-1 min-h-0 overflow-hidden' });
    let editorInner = d.el('div', { class: 'CodeEditor-editorInner flex-1 min-h-0' });
    editorContainer.append(editorInner);
    root.append(editorContainer);
    wrapper.replaceChildren(root);
    this.state.hostElement = root;
    this.state.editorContainer = editorInner;
    return root;
  };

  resolveMode = path => {
    if (!path) {
      return null;
    }
    let lower = path.toLowerCase();
    if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'htmlmixed';
    if (lower.endsWith('.css')) return 'css';
    if (lower.endsWith('.json')) return 'json';
    if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
    if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs') || lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'javascript';
    return null;
  };

  resolveTabSize = path => {
    if (!path) return 2;
    let lower = path.toLowerCase();
    if (lower.endsWith('.py')) return 4;
    if (lower.endsWith('.go')) return 4;
    return 2;
  };

  shouldIndentWithTabs = path => {
    if (!path) return false;
    let lower = path.toLowerCase();
    if (lower.endsWith('.go') || lower.endsWith('.makefile')) return true;
    return false;
  };

  mountEditor = async (value, path) => {
    if (!this.state.editorContainer) {
      return;
    }
    this.state.editorContainer.innerHTML = '';
    this.state.fallbackTextarea = null;
    try {
      this.state.editorMount = await mountCodeMirror(this.state.editorContainer, {
        value,
        mode: this.resolveMode(path),
        theme: 'monokai',
        keyMap: state.settings?.opt?.vim ? 'vim' : 'default',
        lineNumbers: true,
        lineWrapping: true,
        tabSize: this.resolveTabSize(path),
        indentUnit: this.resolveTabSize(path),
        indentWithTabs: this.shouldIndentWithTabs(path),
        autofocus: true,
        onChange: editorInstance => this.handleEditorChange(editorInstance),
      });
      queueMicrotask(() => this.state.editorMount?.editor?.refresh?.());
    } catch (err) {
      console.error(err);
      let textarea = d.el('textarea', {
        class: 'CodeEditor-fallback w-full flex-1 min-h-0 resize-none bg-transparent p-4 text-sm text-slate-100 font-mono outline-none',
      });
      textarea.value = value;
      textarea.addEventListener('input', this.handleFallbackInput);
      this.state.editorContainer.append(textarea);
      this.state.fallbackTextarea = textarea;
      this.state.editorMount = null;
    }
  };

  handleEditorChange = editorInstance => {
    if (!editorInstance) {
      return;
    }
    let value = editorInstance.getValue();
    if (value == null) {
      value = '';
    }
    this.state.currentValue = value;
    this.updateDirtyState();
    this.scheduleSave();
  };

  handleFallbackInput = ev => {
    this.state.currentValue = ev.target.value;
    this.updateDirtyState();
    this.scheduleSave();
  };

  updateDirtyState = () => {
    let dirty = this.state.currentValue !== this.state.initialValue;
    if (dirty !== this.state.dirty) {
      this.state.dirty = dirty;
    }
  };

  getCurrentValue = () => {
    if (this.state.editorMount?.editor) {
      let value = this.state.editorMount.editor.getValue();
      return value == null ? '' : value;
    }
    if (this.state.fallbackTextarea) {
      return this.state.fallbackTextarea.value ?? '';
    }
    if (this.state.currentValue != null) {
      return this.state.currentValue;
    }
    return '';
  };

  scheduleSave = () => {
    if (state.collab?.uid && state.collab.uid !== 'master') {
      return;
    }
    if (!this.state.dirty || this.state.loading || this.state.saving) {
      return;
    }
    if (!this.debouncedAutoSave) {
      this.debouncedAutoSave = debounce(async () => {
        if (state.collab?.uid && state.collab.uid !== 'master') {
          return;
        }
        if (!this.state.dirty || this.state.loading || this.state.saving) {
          return;
        }
        await this.actions.save({ reason: 'auto' });
      }, 200);
    }
    this.debouncedAutoSave();
  };

  applyVim = async () => {
    let enabled = !!state.settings?.opt?.vim;
    if (this.state.editorMount) {
      await this.state.editorMount.setKeyMap(enabled ? 'vim' : 'default');
    }
  };

  handleSettingsOption = async ({ k }) => {
    if (k !== 'vim') {
      return;
    }
    await this.applyVim();
  };

  handleKeyDown = ev => {
    if (!this.state.hostElement || !this.state.hostElement.isConnected) {
      return;
    }
    if (!this.state.currentPath) {
      return;
    }
    let key = (ev.key || '').toLowerCase();
    if ((ev.metaKey || ev.ctrlKey) && key === 's') {
      ev.preventDefault();
      this.actions.save();
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.shiftKey && key === 'r') {
      ev.preventDefault();
      this.actions.revert();
    }
  };

  attachHandlers = () => {
    if (!this.state.handlersAttached) {
      addEventListener('keydown', this.handleKeyDown);
      this.state.handlersAttached = true;
    }
    let bus = state.event?.bus;
    if (bus && !this.state.busSubscribed) {
      bus.on('settings:global:option:ready', this.handleSettingsOption);
      bus.on('collab:presence:update', () => {
        this.ensureCollabListeners();
        this.cleanupPeerSelections();
      });
      bus.on('collab:apply:ready', () => this.ensureCollabListeners());
      this.state.busSubscribed = true;
    }
    this.ensureCollabListeners();
  };

  actions = {
    init: () => {
      let bus = state.event?.bus;
      if (!bus) {
        return;
      }
      if (this.state.ready) {
        return;
      }
      document.head.append(d.el('style', `
        .CodeMirror { background-color: transparent !important }
        .CodeMirror-cursors { position: absolute !important }
        .CodeMirror-cursor { opacity: 0 !important }
        .CodeMirror-selected { background: transparent !important }
        .CodeMirror-measure { display: none }
        .CodeMirror-lines > [role="presentation"] > :nth-child(3) { position: absolute !important; pointer-events: none }
        .CodeMirror-line { padding-left: 3rem !important }
        .CodeMirror-activeline-background { background-color: #060a0f80 !important }
      `));
      bus.on('files:select:ready', async ({ path }) => {
        if (!path) {
          await post('codeEditor.reset');
          return;
        }
        await post('codeEditor.open');
      });
      this.attachHandlers();
      this.state.ready = true;
      bus.emit('codeEditor:init:ready');
      if (this.state.pendingOpen) {
        this.state.pendingOpen = false;
        queueMicrotask(async () => await post('codeEditor.open'));
        return;
      }
    },

    open: async () => {
      if (!this.state.ready) {
        this.state.pendingOpen = true;
        return;
      }
      let project = state.projects.current;
      let path = state.files.current;
      if (!project || !path || !this.state.target(path)) {
        await post('codeEditor.reset');
        return;
      }
      this.state.loading = true;
      let placeholder = await this.renderPlaceholder(`Loading ${path}…`);
      if (!placeholder) {
        this.state.loading = false;
        return;
      }
      try {
        let text = '';
        if (!state.collab?.uid || state.collab.uid === 'master') {
          let blob = await rfiles.load(project, path);
          if (!blob) {
            throw new Error('File not found');
          }
          text = await blob.text();
        }
        this.state.currentProject = project;
        this.state.currentPath = path;
        let entry = this.getDocEntry(project, path);
        await this.initializeDoc(entry, text);
        this.state.initialValue = entry.text.toString();
        this.state.currentValue = entry.text.toString();
        this.state.dirty = false;
        this.state.externalChange = false;
        let shell = await this.buildEditorShell();
        if (!shell) {
          this.state.loading = false;
          return;
        }
        await this.mountEditor(this.state.currentValue, path);
        if (this.state.editorMount?.editor) {
          this.bindEditorToDoc(entry);
          this.cleanupPeerSelections();
          await this.applyVim();
        }
        this.state.loading = false;
        if (state.collab?.uid == null || state.collab.uid === 'master') {
          this.scheduleSave();
        }
      } catch (err) {
        console.error(err);
        this.state.loading = false;
        this.state.currentProject = null;
        this.state.currentPath = null;
        await this.renderPlaceholder('Failed to load file.');
      }
    },

    reset: async () => {
      this.state.currentProject = null;
      this.state.currentPath = null;
      this.state.initialValue = '';
      this.state.currentValue = '';
      this.state.dirty = false;
      this.state.loading = false;
      this.state.saving = false;
      this.state.externalChange = false;
      this.destroyEditorUI();
    },

    save: async ({ reason } = {}) => {
      if (state.collab?.uid && state.collab.uid !== 'master') {
        return;
      }
      if (!this.state.currentProject || !this.state.currentPath) {
        return;
      }
      if (this.state.loading || this.state.saving) {
        return;
      }
      this.state.currentValue = this.getCurrentValue();
      if (!this.state.dirty && this.state.currentValue === this.state.initialValue) {
        return;
      }
      this.state.saving = true;
      this.state.externalChange = false;
      try {
        let project = this.state.currentProject;
        let path = this.state.currentPath;
        let value = this.state.currentValue;
        let type = typeof mimeLookup === 'function' ? mimeLookup(path) : null;
        if (!type) {
          type = 'text/plain';
        }
        let blob = new Blob([value], { type });
        await rfiles.save(project, path, blob);
        this.state.initialValue = value;
        this.state.dirty = false;
        this.state.recentSaveAt = performance.now();
        let projectName = project.split(':')[0];
        let bus = state.event?.bus;
        if (bus) {
          bus.emit('files:change', { path: `${projectName}/${path}` });
        }
      } catch (err) {
        console.error(err);
      } finally {
        this.state.saving = false;
      }
    },

    revert: async () => {
      if (!this.state.currentPath) {
        return;
      }
      await this.actions.open();
    },

    exportState: async ({ project, path }) => {
      if (!project || !path) {
        return '';
      }
      let entry = this.getDocEntry(project, path);
      if (!entry.initialized) {
        try {
          let blob = await rfiles.load(project, path);
          let text = blob ? await blob.text() : '';
          await this.initializeDoc(entry, text);
        } catch (err) {
          console.error('CodeEditor exportState load failed', err);
          await this.initializeDoc(entry, '');
        }
      }
      let update = Y.encodeStateAsUpdate(entry.doc);
      return encodeUpdate(update);
    },

    change: async () => {},
  };
}

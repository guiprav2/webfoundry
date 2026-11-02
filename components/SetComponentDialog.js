import * as pako from 'https://esm.run/pako';
import rfiles from '../repos/rfiles.js';

let componentEntriesFromTemplates = templates => {
  let entries = [];
  let seen = new Set();
  for (let [path, html] of Object.entries(templates || {})) {
    if (!path.startsWith('components/')) {
      continue;
    }
    let doc = new DOMParser().parseFromString(html, 'text/html');
    if (!doc.body) {
      continue;
    }
    let candidates = doc.body.querySelectorAll('[id]');
    for (let el of candidates) {
      let parent = el.parentElement;
      let hasAncestorId = false;
      while (parent && parent !== doc.body) {
        if (parent.id) {
          hasAncestorId = true;
          break;
        }
        parent = parent.parentElement;
      }
      if (hasAncestorId) {
        continue;
      }
      if (!el.id) {
        continue;
      }
      if (seen.has(el.id)) {
        continue;
      }
      seen.add(el.id);
      let file = path.slice('components/'.length);
      entries.push({ value: el.id, label: `${el.id} (${file})`, id: el.id });
    }
  }
  return entries.sort((a, b) => a.label.localeCompare(b.label));
};

let normalizeComponentValue = (value, entries) => {
  if (typeof value !== 'string') {
    return '';
  }
  let cleaned = value.trim();
  if (!cleaned) {
    return '';
  }
  let candidate = cleaned.includes('#') ? cleaned.split('#').pop() : cleaned;
  let exact = entries.find(x => x.value === candidate) || entries.find(x => x.value === cleaned);
  if (exact) {
    return exact.value;
  }
  let fallback = entries.find(x => x.id === candidate) || entries.find(x => x.id === cleaned);
  if (fallback) {
    return fallback.value;
  }
  let lowerCandidate = candidate.toLowerCase ? candidate.toLowerCase() : candidate;
  let ciMatch = entries.find(x => (x.value || '').toLowerCase() === lowerCandidate);
  if (ciMatch) {
    return ciMatch.value;
  }
  let ciFallback = entries.find(x => (x.id || '').toLowerCase() === lowerCandidate);
  if (ciFallback) {
    return ciFallback.value;
  }
  return candidate;
};

class SetComponentDialog {
  components = [];

  constructor(props) {
    this.props = props || {};
    this.component = typeof this.props.component === 'string' ? this.props.component.trim() : '';
    this.componentProps = this.normalizeProps(this.props.componentProps);
    this.ensureTrailingBlank(false);
    this.loadComponents();
    setTimeout(() => d.el(this.root.querySelector('select'), { value: d.binding({ get: () => this.component, set: x => this.component = x }) }));
  }

  loadComponents = async () => {
    let entries = [];
    try {
      let project = state.projects?.current;
      if (project) {
        let text = '';
        if (!state.collab || state.collab.uid === 'master') {
          let blob = await rfiles.load(project, 'webfoundry/templates.json');
          if (blob) {
            text = await blob.text();
          }
        } else {
          let encoded = await post('collab.rpc', 'fetch', { project, path: 'webfoundry/templates.json' });
          if (encoded) {
            try {
              let binary = atob(encoded);
              let zipped = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) {
                zipped[i] = binary.charCodeAt(i);
              }
              let inflated = pako.ungzip(zipped);
              let decoder = new TextDecoder();
              text = decoder.decode(inflated);
            } catch (err) {
              console.error('Failed to decode templates JSON via collab', err);
            }
          }
        }
        if (text) {
          let templates = {};
          try {
            templates = JSON.parse(text);
          } catch (err) {
            console.error('Failed to parse templates JSON', err);
          }
          entries = componentEntriesFromTemplates(templates);
        }
      }
    } catch (err) {
      console.error('Failed to load project templates', err);
    }
    this.components = entries;
    this.component = normalizeComponentValue(this.component, entries);
    d.update();
  };

  normalizeProps = props => {
    let list = [];
    if (Array.isArray(props)) {
      for (let item of props) {
        if (!item) {
          continue;
        }
        let name = typeof item.name === 'string' ? item.name : '';
        let expr = item.expr == null ? '' : String(item.expr);
        list.push({ name, expr });
      }
    } else if (props && typeof props === 'object') {
      for (let [name, expr] of Object.entries(props)) {
        list.push({ name, expr: expr == null ? '' : String(expr) });
      }
    }
    if (!list.length) {
      list.push({ name: '', expr: '' });
    }
    return list.map(item => ({ name: item.name ?? '', expr: item.expr ?? '' }));
  };

  ensureTrailingBlank = (notify = true) => {
    if (!Array.isArray(this.componentProps)) {
      this.componentProps = [{ name: '', expr: '' }];
    }
    let hasBlank = false;
    for (let prop of this.componentProps) {
      if (!prop.name && !prop.expr) {
        hasBlank = true;
        break;
      }
    }
    if (!hasBlank) {
      this.componentProps.push({ name: '', expr: '' });
    }
    let firstBlank = this.componentProps.findIndex(prop => !prop.name && !prop.expr);
    if (firstBlank >= 0) {
      this.componentProps.splice(firstBlank + 1);
    }
    if (notify) {
      d.update();
    }
  };

  onKeyUp = () => this.ensureTrailingBlank();

  onKeyDown = ev => {
    if (ev.key !== 'Enter') {
      return;
    }
    ev.preventDefault();
    ev.target.closest('form').querySelector('[value="ok"]').click();
  };

  onSubmit = ev => {
    ev.preventDefault();
    this.ensureTrailingBlank();
    let props = {};
    for (let prop of this.componentProps) {
      let name = (prop.name ?? '').trim();
      let expr = (prop.expr ?? '').trim();
      if (!name || !expr) {
        continue;
      }
      props[name] = expr;
    }
    let keys = Object.keys(props);
    let component = (this.component ?? '').trim();
    let dialog = this.root?.parentElement;
    if (!dialog) {
      return;
    }
    dialog.returnDetail = [component || null, keys.length ? props : null];
    dialog.close(ev.submitter.value);
  };
}

export default SetComponentDialog;

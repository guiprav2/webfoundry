let clone = x => JSON.parse(JSON.stringify(x));
let KEY_RE = /^[\p{L}_$][\p{L}\p{N}_$-]*$/u;

class HookDialog {
  constructor(props) {
    this.props = props;
    let { info, hook } = props;
    this.info = info;
    this.key = hook?.key ?? info.key;
    this.parent = info.parentId ?? '';
    this.lastParent = this.parent;
    this.load(hook?.target ?? info.target, info);
    this.pagesMode = hook?.pages?.mode ?? 'path';
    this.pagesValue = hook?.pages?.value ?? (this.pagesMode === 'glob' ? '' : info.path);
    this.lastMatchMode = this.matchMode;
    this.result = null;
    this.lastJson = null;
  }

  load(saved, info) {
    let target = clone(saved);
    this.css = target.css ?? '';
    this.useText = !!target.text?.value;
    this.textValue = target.text?.value ?? (info.ownText || info.fullText);
    this.textMode = target.text?.mode ?? 'contains';
    this.textSource = target.text?.source ?? (info.ownText ? 'own' : 'full');
    this.ignoreCase = target.text?.ignoreCase ?? true;
    this.withinCss = target.within?.css ?? '';
    this.withinText = target.within?.text?.value ?? '';
    this.nth = target.nth ?? '';
    this.matchMode = target.multiple ? 'all' : target.nth != null && target.nth !== '' ? 'nth' : 'single';
    this.attrs = info.attrs.map(x => {
      let attr = target.attrs?.find(y => y.name === x.name);
      return { ...x, on: !!attr, mode: attr?.mode ?? 'exact' };
    });
  }

  get target() {
    let out = { css: this.css.trim(), attrs: this.attrs.filter(x => x.on).map(({ name, value, mode }) => ({ name, value, mode })), within: {}, multiple: this.matchMode === 'all', nth: this.matchMode === 'nth' ? Number(this.nth) || 0 : null };
    if (this.useText && this.textValue.trim()) out.text = { value: this.textValue.trim(), mode: this.textMode, source: this.textSource, ignoreCase: this.ignoreCase };
    if (this.withinCss.trim()) out.within.css = this.withinCss.trim();
    if (this.withinText.trim()) out.within.text = { value: this.withinText.trim(), mode: 'contains', source: 'full', ignoreCase: true };
    return out;
  }

  get pages() {
    if (this.parent || this.pagesMode === 'site') return { mode: 'site' };
    return { mode: this.pagesMode, value: this.pagesMode === 'path' ? this.info.path : this.pagesValue.trim() };
  }

  get isConstrained() {
    let t = this.target;
    return !!(t.css || t.text || t.attrs.length || t.within.css || t.within.text);
  }

  get valid() {
    return KEY_RE.test(this.key.trim()) && this.isConstrained && !this.result?.error && this.result?.count > 0 && (this.parent || this.pagesMode !== 'glob' || this.pagesValue.trim());
  }

  get summary() {
    let r = this.result;
    if (!this.isConstrained) return 'No conditions';
    if (!r) return '…';
    if (r.error) return r.error;
    if (r.status === 'ambiguous') return `Ambiguous: ${r.total} matches`;
    if (!r.count) return 'No matches';
    return `${r.count} match${r.count === 1 ? '' : 'es'}${r.includesSelected ? '' : ', selected element excluded'}`;
  }

  get summaryClass() {
    return this.valid && this.result?.includesSelected ? 'text-green-400' : 'text-amber-400';
  }

  get nthHint() {
    return this.result?.index >= 0 ? `Selected: ${this.result.index}` : '';
  }

  // Inputs only write their bindings; this picks up every change for a live preview in the page.
  start = () => {
    this.poll = setInterval(async () => {
      if (this.parent !== this.lastParent) {
        this.lastParent = this.parent;
        this.info = await this.props.describe(this.parent || null);
        this.load(this.info.target, this.info);
        this.lastMatchMode = this.matchMode;
        this.lastJson = null;
      }
      if (this.matchMode !== this.lastMatchMode) {
        this.lastMatchMode = this.matchMode;
        this.matchModeChanged();
      }
      let json = JSON.stringify([this.target, this.parent]);
      if (json === this.lastJson || !this.isConstrained) return;
      this.lastJson = json;
      let result = await this.props.test(this.target, this.parent || null);
      if (json !== this.lastJson) return;
      this.result = result;
      d.update();
    }, 200);
  };

  stop = () => clearInterval(this.poll);

  // Switching a repeated target to one element needs a selector that can't match its repeats.
  matchModeChanged = () => {
    if (this.matchMode === 'single' && this.css === this.info.repeat?.css) this.css = this.info.single.css;
    if (this.matchMode === 'all' && this.css === this.info.single.css && this.info.repeat) this.css = this.info.repeat.css;
  };

  useNth = () => {
    this.matchMode = 'nth';
    if (this.result?.index >= 0) this.nth = this.result.index;
  };

  onSubmit = ev => {
    ev.preventDefault();
    let dialog = this.root.parentElement;
    if (ev.submitter.value === 'ok') dialog.returnDetail = [{ key: this.key.trim(), parent: this.parent || null, target: this.target, pages: this.pages }];
    dialog.close(ev.submitter.value);
  };
}

export default HookDialog;

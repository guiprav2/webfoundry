const RESIZABLE_MODES = new Set(['both', 'horizontal', 'vertical', 'none']);
const ORIENTATIONS = new Set(['auto', 'portrait', 'landscape']);

const DEFAULTS = {
  width: 1280,
  height: 800,
  startMaximized: false,
  rememberDimensions: true,
  borderless: false,
  dragAnywhere: false,
  resizable: 'both',
  orientation: 'auto',
  documentClassNames: '',
};

function normalizeResizable(value) {
  let mode = String(value ?? DEFAULTS.resizable).trim().toLowerCase();
  return RESIZABLE_MODES.has(mode) ? mode : DEFAULTS.resizable;
}

function normalizeOrientation(value) {
  let mode = String(value ?? DEFAULTS.orientation).trim().toLowerCase();
  return ORIENTATIONS.has(mode) ? mode : DEFAULTS.orientation;
}

function normalizeClassNames(value) {
  return String(value ?? '')
    .trim()
    .split(/[\t\n\f\r ]+/)
    .filter(Boolean)
    .join(' ');
}

function clampDim(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(200, Math.min(10000, Math.round(n)));
}

class NativeExportDialog {
  constructor(props) {
    this.props = props;
    const saved = state.settings?.popt?.nativeExport || {};
    this.target = saved.target || 'linux-x64';
    this.width = clampDim(saved.width, DEFAULTS.width);
    this.height = clampDim(saved.height, DEFAULTS.height);
    this.startMaximized = saved.startMaximized ?? DEFAULTS.startMaximized;
    this.rememberDimensions = saved.rememberDimensions ?? DEFAULTS.rememberDimensions;
    this.borderless = saved.borderless ?? DEFAULTS.borderless;
    this.dragAnywhere = saved.dragAnywhere ?? DEFAULTS.dragAnywhere;
    this.resizable = normalizeResizable(saved.resizable ?? DEFAULTS.resizable);
    this.orientation = normalizeOrientation(saved.orientation ?? DEFAULTS.orientation);
    this.documentClassNames = normalizeClassNames(
      saved.documentClassNames ?? DEFAULTS.documentClassNames,
    );
    // Stable array identity — a getter that returns a fresh array each read
    // makes Dominant wf-map thrash and can freeze/crash the tab.
    this.targets = [
      { id: 'linux-x64', label: 'Linux x64', available: true },
      { id: 'win-x64', label: 'Windows x64 (coming soon)', available: false },
      { id: 'android-arm64', label: 'Android arm64', available: true },
    ];
    if (!this.targets.some(t => t.id === this.target && t.available)) {
      this.target = 'linux-x64';
    }
  }

  get isAndroid() {
    return this.target === 'android-arm64';
  }

  get isDesktop() {
    return this.target === 'linux-x64' || this.target === 'win-x64';
  }

  get valid() {
    const targetOk = this.targets.some(t => t.id === this.target && t.available);
    if (!targetOk) return false;
    if (this.isAndroid) return ORIENTATIONS.has(this.orientation);
    const w = Number(this.width);
    const h = Number(this.height);
    return Number.isFinite(w) && w >= 200 && Number.isFinite(h) && h >= 200;
  }

  select = id => {
    const t = this.targets.find(x => x.id === id);
    if (!t?.available) return;
    this.target = id;
    d.update();
  };

  onSubmit = async ev => {
    ev.preventDefault();
    if (ev.submitter?.value !== 'ok') {
      this.root.parentElement.close(ev.submitter?.value || 'cancel');
      return;
    }
    if (!this.valid) return;
    const opts = this.isAndroid
      ? {
          target: this.target,
          orientation: normalizeOrientation(this.orientation),
          documentClassNames: normalizeClassNames(this.documentClassNames),
        }
      : {
          target: this.target,
          width: clampDim(this.width, DEFAULTS.width),
          height: clampDim(this.height, DEFAULTS.height),
          startMaximized: !!this.startMaximized,
          rememberDimensions: !!this.rememberDimensions,
          borderless: !!this.borderless,
          dragAnywhere: !!this.dragAnywhere,
          resizable: normalizeResizable(this.resizable),
          documentClassNames: normalizeClassNames(this.documentClassNames),
        };
    try {
      await post('settings.projectOption', 'nativeExport', opts);
    } catch (err) {
      console.error('Failed to save native export options', err);
    }
    this.root.parentElement.returnDetail = opts;
    this.root.parentElement.close('ok');
  };
}

export default NativeExportDialog;

class NetlifyDeploy {
  constructor(props) {
    this.props = props;
    this.newSiteName = '';
    this.deployType = this.props.mode || 'production';
    this.init();
  }

  async init() {
    this.error = null;
    try {
      let res = await fetch('https://api.netlify.com/api/v1/sites', {
        headers: { Authorization: `Bearer ${this.props.key}` }
      });
      if (!res.ok) {
        let body = await res.json().catch(() => null);
        throw new Error(body?.message || body?.error || `${res.status} ${res.statusText}`.trim());
      }
      this.sites = await res.json();
      this.selected = this.props.id || 'new';
    } catch (err) {
      console.error('Error loading Netlify sites:', err);
      this.error = err?.message || String(err);
    } finally {
      d.update();
    }
  }

  retry = () => {
    this.error = null;
    d.update();
    this.init();
  };

  get valid() {
    return this.selected || this.newSiteName.trim();
  }

  setDeployType = type => {
    this.deployType = type;
    d.update();
  };

  onKeyDown = ev => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    ev.target.closest('form').querySelector('[value="ok"]').click();
  };

  onSubmit = ev => {
    ev.preventDefault();
    this.root.parentElement.returnDetail = this.selected !== 'new'
      ? ['existing', this.selected, this.deployType]
      : ['new', this.newSiteName.trim(), this.deployType];
    this.root.parentElement.close(ev.submitter.value);
  };
}

export default NetlifyDeploy;

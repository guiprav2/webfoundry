import { getOpenAIKey, setOpenAIKey } from '../other/openai.js';

let editorOrigin = 'https://www.webfoundry.app/';

export default class Landing {
  state = {
    templates: [
      {
        id: 'self',
        label: 'Webfoundry itself',
        href: `${editorOrigin}editor.html?demo&autoplay&git=https://github.com/guiprav2/webfoundry57.git`,
      },
    ],
    currentTemplate: 'self',
    currentKey: '',
    pendingKey: '',
    frameSrc: `${editorOrigin}editor.html?demo&autoplay&git=https://github.com/guiprav2/webfoundry57.git`,
    frameCaption: 'editor.html?demo&autoplay&git=https://github.com/guiprav2/webfoundry57.git',
    frameLoaded: false,
    showKeyModal: false,
    showDemoModal: false,
    mobileMenuOpen: false,
    year: new Date().getFullYear(),
  };

  actions = {
    init: () => {
      this.loadPersistedKey();
      this.setFrameSrc();
      document.addEventListener('keydown', ev => {
        if (ev.key === 'Escape' && this.state.showDemoModal) this.actions.closeDemoModal();
      });
    },
    selectTemplate: (id, scroll = false) => {
      if (!this.state.templates.some(x => x.id === id)) return;
      this.state.currentTemplate = id;
      this.setFrameSrc();
      if (scroll) this.actions.scrollToDemo();
    },
    reloadFrame: () => {
      let src = this.buildFrameUrl();
      this.state.frameLoaded = false;
      this.state.frameSrc = 'about:blank';
      setTimeout(() => (this.state.frameSrc = src));
    },
    frameLoaded: () => {
      if (this.state.frameSrc === 'about:blank') return;
      this.state.frameLoaded = true;
    },
    openKeyModal: () => {
      this.state.pendingKey = this.state.currentKey;
      this.state.showKeyModal = true;
    },
    closeKeyModal: () => {
      this.state.showKeyModal = false;
    },
    applyKey: () => {
      this.state.currentKey = (this.state.pendingKey || '').trim();
      setOpenAIKey(this.state.currentKey);
      this.state.showKeyModal = false;
      this.setFrameSrc();
    },
    popout: () => {
      window.open(this.buildFrameUrl(), '_blank', 'noopener,noreferrer');
    },
    openDemoModal: () => {
      this.state.showDemoModal = true;
      document.body.classList.add('overflow-hidden');
    },
    closeDemoModal: () => {
      this.state.showDemoModal = false;
      document.body.classList.remove('overflow-hidden');
    },
    toggleMobileMenu: () => {
      this.state.mobileMenuOpen = !this.state.mobileMenuOpen;
    },
    closeMobileMenu: () => {
      this.state.mobileMenuOpen = false;
    },
    scrollToDemo: () => {
      let section = document.getElementById('try');
      if (!section) return;
      let reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      section.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    },
  };

  setFrameSrc() {
    let src = this.buildFrameUrl();
    if (src !== this.state.frameSrc) this.state.frameLoaded = false;
    this.state.frameSrc = src;
    this.state.frameCaption = this.selectedHref().replace(editorOrigin, '');
  }

  loadPersistedKey() {
    let stored = (getOpenAIKey() || '').trim();
    if (!stored) return;
    this.state.currentKey = stored;
    this.state.pendingKey = stored;
  }

  selectedHref() {
    let selected = this.state.templates.find(
      template => template.id === this.state.currentTemplate,
    );
    return selected ? selected.href : `${editorOrigin}editor.html`;
  }

  buildFrameUrl() {
    let base = this.selectedHref();
    if (!this.state.currentKey) return base;
    let join = base.includes('?') ? '&' : '?';
    return `${base}${join}oaiKey=${encodeURIComponent(this.state.currentKey)}`;
  }
}

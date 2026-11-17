// Load the editor from whatever origin is serving this page, so the demo runs this same build.
// Demos are archives built by other/build-demos.js, served by this site (no Git CORS proxy on each visit).
let editorOrigin = `${location.origin}/`;

let templates = [
  {
    id: 'counter',
    label: 'Counter',
    href: `${editorOrigin}editor.html?demo&autoplay&zip=demos/counter.zip`,
  },
  {
    id: 'todomvc',
    label: 'TodoMVC',
    href: `${editorOrigin}editor.html?demo&autoplay&zip=demos/todomvc.zip`,
  },
  {
    id: 'self',
    label: 'Webfoundry itself',
    href: `${editorOrigin}editor.html?demo&autoplay&zip=demos/webfoundry.zip`,
  },
];
let defaultTemplate = templates.find(x => x.id === 'counter');

export default class Landing {
  state = {
    templates,
    currentTemplate: defaultTemplate.id,
    frameSrc: defaultTemplate.href,
    frameCaption: defaultTemplate.href.replace(editorOrigin, ''),
    editorHost: location.host,
    frameLoaded: false,
    showDemoModal: false,
    mobileMenuOpen: false,
    year: new Date().getFullYear(),
  };

  actions = {
    init: () => {
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

  selectedHref() {
    let selected = this.state.templates.find(
      template => template.id === this.state.currentTemplate,
    );
    return selected ? selected.href : `${editorOrigin}editor.html`;
  }

  // The iframe is same-origin, so it already shares the visitor's stored API keys; none go in the URL.
  buildFrameUrl() {
    return this.selectedHref();
  }
}

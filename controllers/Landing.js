import { getOpenAIKey, setOpenAIKey } from '../other/openai.js';

export default class Landing {
  state = {
    templates: [
      {
        id: 'super-todomvc',
        label: 'Super TodoMVC',
        href: 'editor.html?demo&autoplay&git=https://github.com/guiprav2/super-todomvc.git',
      },
      {
        id: 'kankan',
        label: 'Kankan (P2P Kanban Board)',
        href: 'editor.html?demo&autoplay&git=https://github.com/guiprav2/kankan.git',
      },
      /*
      {
        id: 'mailbox',
        label: 'Mailbox Client',
        href: 'editor.html?demo&autoplay&git=https://github.com/guiprav2/mailbox.git',
      },
      */
      {
        id: 'subgpt',
        label: 'SubGPT (LLM Client)',
        href: 'editor.html?demo&autoplay&git=https://github.com/guiprav2/subgpt.git',
      },
      {
        id: 'clean',
        label: 'Clean Slate',
        href: 'editor.html?demo',
      },
    ],
    currentTemplate: 'super-todomvc',
    currentKey: '',
    pendingKey: '',
    frameSrc: 'editor.html?demo&autoplay&git=https://github.com/guiprav2/super-todomvc.git',
    showKeyModal: false,
    showDemoModal: false,
    year: new Date().getFullYear(),
  };

  actions = {
    init: () => {
      this.loadPersistedKey();
      this.setFrameSrc();
    },
    selectTemplate: id => {
      this.state.currentTemplate = id;
      this.setFrameSrc();
      let mobileMedia =
        typeof window !== 'undefined' && window.matchMedia
          ? window.matchMedia('(max-width: 639px)')
          : null;
      this.state.showDemoModal = Boolean(mobileMedia?.matches);
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
    closeDemoModal: () => {
      this.state.showDemoModal = false;
    },
    scrollToDemo: () => {
      let section = document.getElementById('projectArea');
      if (section) section.scrollIntoView({ behavior: 'smooth' });
    },
  };

  setFrameSrc() {
    this.state.frameSrc = this.buildFrameUrl();
  }

  loadPersistedKey() {
    let stored = (getOpenAIKey() || '').trim();
    if (!stored) return;
    this.state.currentKey = stored;
    this.state.pendingKey = stored;
  }

  buildFrameUrl() {
    let selected = this.state.templates.find(
      template => template.id === this.state.currentTemplate,
    );
    let base = selected ? selected.href : 'editor.html';
    if (!this.state.currentKey) return base;
    let join = base.includes('?') ? '&' : '?';
    return `${base}${join}oaiKey=${encodeURIComponent(this.state.currentKey)}`;
  }
}

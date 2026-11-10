import actions from '../other/actions.js';
import { userAction } from '../other/shadowEditors.js';

export default class Styles {
  state = {
    get list() {
      let ss = state.designer.current.cursors[state.collab.uid] || [];
      let map = state.designer.current.map;
      let ssclasses = ss.map(x => [...(map.get(x)?.classList || [])]);
      let classes;
      for (let ssc of ssclasses) classes = classes ? new Set([...classes].filter(c => ssc.includes(c))) : new Set(ssc);
      let wfclasses = [];
      for (let x of ss) {
        let el = map.get(x);
        if (!el) continue;
        let attr = el.getAttribute('wf-class');
        if (!attr) continue;
        let pieces = [...attr.matchAll(/{{[\s\S]*?}}/g)].map(m => m[0]);
        wfclasses.push(...pieces);
      }
      let list = [...(classes || []), ...wfclasses];
      // Decoration projects: the site's read-only classes come first.
      return state.decoration?.frame ? [...list.filter(this.readOnly), ...list.filter(x => !this.readOnly(x))] : list;
    },

    readOnly: x => !!state.decoration?.readOnlyClass(x),
    get canAdd() { return state.decoration?.canAddClass ?? true },
  };

  actions = {
    init: () => {
      state.event.bus.on('designer:open:ready', () => this.state.replacing = null);
    },

    addKeyUp: async ev => {
      if (ev.key !== 'Enter') return;
      await post('styles.add', ev.target.value);
      ev.target.value = '';
    },

    add: async cls => await userAction(() => actions.addCssClasses.handler({ cur: state.collab.uid, cls })),
    rm: async cls => await userAction(() => actions.removeCssClasses.handler({ cur: state.collab.uid, cls })),
    edit: x => (this.state.replacing = x),
    replaceKeyDown: ev => ev.key === 'Enter' && ev.target.blur(),

    replaceBlur: async ev => {
      await userAction(() => actions.replaceCssClasses.handler({ cur: state.collab.uid, old: this.state.replacing, cls: ev.target.value.trim() }));
      this.state.replacing = null;
      ev.target.value = '';
    },
  };
}

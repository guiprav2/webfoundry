import { normalizeOrigin } from '../other/util.js';

class CreateProjectDialog {
  name = '';
  origin = '';

  get taken() {
    return state.projects.list.some(x => x.split(':')[0] === this.name.trim());
  }

  get originValid() {
    return !this.origin.trim() || !!normalizeOrigin(this.origin);
  }

  get valid() {
    return this.name.trim() && !this.taken && this.originValid;
  }

  onKeyDown = ev => {
    if (ev.key !== 'Enter' || ev.target.tagName !== 'INPUT') return;
    ev.preventDefault();
    if (this.valid) ev.target.closest('form').querySelector('[value="ok"]').click();
  };

  onSubmit = ev => {
    ev.preventDefault();
    let dialog = this.root.parentElement;
    if (ev.submitter.value === 'ok') dialog.returnDetail = [{ name: this.name.trim(), origin: this.origin.trim() ? normalizeOrigin(this.origin) : null }];
    dialog.close(ev.submitter.value);
  };
}

export default CreateProjectDialog;

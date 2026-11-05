class XAIKeyDialog {
  constructor(props) {
    this.props = props;
    this.value = this.props.key || '';
  }

  get valid() {
    return !!this.value.trim();
  }

  onKeyDown = ev => {
    if (ev.key !== 'Enter' || this.props.multiline) return;
    ev.preventDefault();
    ev.target.closest('form').querySelector('[value="ok"]').click();
  };

  onSubmit = ev => {
    ev.preventDefault();
    this.root.parentElement.returnDetail = this.value.trim();
    this.root.parentElement.close(ev.submitter.value);
  };

  onRemove = ev => {
    ev.preventDefault();
    this.root.parentElement.returnDetail = '';
    this.root.parentElement.close('ok');
  };
}

export default XAIKeyDialog;

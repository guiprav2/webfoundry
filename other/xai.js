let STORAGE_KEY = 'webfoundry:xaiApiKey';

let emitKeyChange = hasKey => {
  if (state?.settings) state.settings.hasXAIKey = hasKey;
  state?.event?.bus?.emit?.('settings:xaiKey:changed', { hasKey });
};

let getXAIKey = () => localStorage.getItem(STORAGE_KEY) || '';

let setXAIKey = key => {
  let next = (key || '').trim();
  if (next) localStorage.setItem(STORAGE_KEY, next);
  else localStorage.removeItem(STORAGE_KEY);
  emitKeyChange(!!next);
};

let promptForXAIKey = async () => {
  let current = getXAIKey();
  let [btn, value] = await showModal('XAIKeyDialog', { key: current });
  if (btn === 'remove') {
    setXAIKey('');
    return '';
  }
  if (btn !== 'ok') return null;
  setXAIKey(value);
  return getXAIKey();
};

let ensureXAIKey = async () => {
  let key = getXAIKey();
  while (!key) {
    let result = await promptForXAIKey();
    if (result == null) throw new Error('xAI API key required.');
    key = result;
  }
  return key;
};

export { getXAIKey, setXAIKey, promptForXAIKey, ensureXAIKey };
export default { getXAIKey, setXAIKey, promptForXAIKey, ensureXAIKey };

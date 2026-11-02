let STORAGE_KEY = 'webfoundry:openaiApiKey';
let OPENAI_ENDPOINT = 'https://api.openai.com/v1/responses';
let DEFAULT_MODEL = 'gpt-6-luna';

let arrayify = value => Array.isArray(value) ? value : value == null ? [] : [value];

let emitKeyChange = hasKey => {
  if (state?.settings) state.settings.hasOpenAIKey = hasKey;
  state?.event?.bus?.emit?.('settings:openaiKey:changed', { hasKey });
};

let getOpenAIKey = () => localStorage.getItem(STORAGE_KEY) || '';

let setOpenAIKey = key => {
  let next = (key || '').trim();
  if (next) localStorage.setItem(STORAGE_KEY, next);
  else localStorage.removeItem(STORAGE_KEY);
  emitKeyChange(!!next);
};

let promptForOpenAIKey = async () => {
  let current = getOpenAIKey();
  let [btn, value] = await showModal('OpenAIKeyDialog', { key: current });
  if (btn === 'remove') {
    setOpenAIKey('');
    return '';
  }
  if (btn !== 'ok') return null;
  setOpenAIKey(value);
  return getOpenAIKey();
};

let ensureOpenAIKey = async () => {
  let key = getOpenAIKey();
  while (!key) {
    let result = await promptForOpenAIKey();
    if (result == null) throw new Error('OpenAI API key required.');
    key = result;
  }
  return key;
};

let normalizeContentParts = content => {
  if (Array.isArray(content)) {
    return content.map(part => typeof part === 'string' ? { type: 'input_text', text: part } : part);
  }
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  if (content && typeof content === 'object') return [content];
  return [{ type: 'input_text', text: `${content ?? ''}` }];
};

let normalizeMessages = messages => arrayify(messages).map(message => ({
  role: message?.role || 'user',
  content: normalizeContentParts(message?.content ?? message?.text ?? ''),
}));

let requestOpenAIResponse = async (messages = [], options = {}) => {
  let key = await ensureOpenAIKey();
  let { model = DEFAULT_MODEL } = options || {};
  let payload = { model, input: normalizeMessages(messages) };
  let res;
  try {
    res = await fetch(OPENAI_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new Error(`Failed to reach OpenAI: ${err.message || err}`);
  }
  if (!res.ok) {
    let detail;
    try {
      let data = await res.json();
      detail = data?.error?.message || data?.message;
    } catch {
      detail = await res.text();
    }
    if (res.status === 401 || res.status === 403) setOpenAIKey('');
    throw new Error(detail || `OpenAI request failed (${res.status})`);
  }
  let data = await res.json();
  let text = '';
  if (Array.isArray(data.output_text) && data.output_text.length) text = data.output_text.join('\n').trim();
  if (!text && Array.isArray(data.output)) {
    text = data.output
      .map(entry => arrayify(entry?.content).map(part => part?.text ?? part?.content ?? '').join(''))
      .join('\n')
      .trim();
  }
  if (!text && data.content) text = arrayify(data.content).map(part => part?.text ?? '').join('').trim();
  return { text, data };
};

let complete = async (messages, options) => {
  let { text } = await requestOpenAIResponse(messages, options);
  return text;
};

export { getOpenAIKey, setOpenAIKey, promptForOpenAIKey, ensureOpenAIKey, requestOpenAIResponse, complete };
export default { getOpenAIKey, setOpenAIKey, promptForOpenAIKey, ensureOpenAIKey, requestOpenAIResponse, complete };

// providers/xai.js
import base from './responses-api.js';
import { xaiError, xaiStreamError } from './errors.js';
export default {
  ...base,
  name: 'xAI',
  parseError: xaiError,
  streamError: xaiStreamError,
  endpoint: 'https://api.x.ai/v1/responses',
  modelsEndpoint: 'https://api.x.ai/v1/models',
  get key() { return globalThis.process?.env?.XAI_KEY; },
};

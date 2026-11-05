// image_analyze, image_generate, and image_edit. Outside CLI mode the image argument is only
// data URIs. CLI mode also accepts paths relative to the working directory
// and absolute paths. image_edit returns a data URI. In CLI mode an optional
// output path writes the edited image and the tool returns that absolute path.

export function imageInputDescription(cli) {
  return cli ? 'data URIs, relative, or absolute paths' : 'only data URIs';
}

let DATA_IMAGE = /^data:image\/[a-z0-9.+-]+(?:;[^;,]+)*;base64,/i;

// Ratios accepted by grok-imagine-image-2.0. Omit the argument to keep the source image's ratio.
export let ASPECT_RATIOS = [
  '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2',
  '19.5:9', '9:19.5', '20:9', '9:20', '21:9', '5:2', 'auto',
];

function requireAspect(value) {
  if (value == null || !String(value).trim()) return '';
  let ratio = String(value).trim();
  if (!ASPECT_RATIOS.includes(ratio)) throw new Error(`aspect_ratio must be one of ${ASPECT_RATIOS.join(', ')}`);
  return ratio;
}

function env(name) {
  return globalThis.process?.env?.[name] || '';
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  return undefined;
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let bin = '';
  let size = 0x8000;
  for (let i = 0; i < bytes.length; i += size) bin += String.fromCharCode(...bytes.subarray(i, i + size));
  return btoa(bin);
}

function mimeFor(bytes, file) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
  let ext = String(file || '').split('.').pop().toLowerCase();
  let map = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
  return map[ext] || 'image/png';
}

let PROVIDERS = {
  xai: {
    base: 'https://api.x.ai/v1',
    analyze: 'responses',
    edit: 'xai',
    keyName: 'XAI_KEY',
    key() { return env('XAI_KEY') || env('XAI_API_KEY'); },
  },
  oai: {
    base: 'https://api.openai.com/v1',
    analyze: 'responses',
    edit: 'openai',
    keyName: 'OPENAI_API_KEY',
    key() { return env('OPENAI_API_KEY'); },
  },
  oail: {
    base: 'https://api.openai.com/v1',
    analyze: 'chat',
    edit: 'openai',
    keyName: 'OPENAI_API_KEY',
    key() { return env('OPENAI_API_KEY'); },
  },
};

function readOpt(value) {
  let current = typeof value === 'function' ? value() : value;
  return current == null ? '' : String(current).trim();
}

function parseSpec(spec) {
  let value = String(spec || '').trim();
  let idx = value.indexOf(':');
  if (idx === -1) return { provider: '', model: value };
  return { provider: value.slice(0, idx), model: value.slice(idx + 1) };
}

function openAiSize(ratio) {
  if (!ratio) return '';
  if (ratio === 'auto') return 'auto';
  let [w, h] = ratio.split(':').map(Number);
  if (!w || !h) return '';
  if (Math.abs(w / h - 1) < 0.02) return '1024x1024';
  return w > h ? '1536x1024' : '1024x1536';
}

function dataUriBytes(uri) {
  let match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(uri);
  if (!match) throw new Error('image is not a data URI');
  let mime = match[1].toLowerCase();
  let b64 = match[2].replace(/\s/g, '');
  let bytes = typeof Buffer !== 'undefined' ? Buffer.from(b64, 'base64') : Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
  let ext = mime === 'image/jpeg' ? 'jpg' : (mime.split('/')[1] || 'png');
  return { mime, bytes, ext };
}

function formBody(fields, file) {
  let boundary = `kitty${Math.random().toString(16).slice(2)}`;
  let chunks = [];
  let push = part => chunks.push(typeof part === 'string' ? Buffer.from(part) : part);
  for (let [name, value] of Object.entries(fields)) {
    if (value == null || value === '') continue;
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  push(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="image.${file.ext}"\r\nContent-Type: ${file.mime}\r\n\r\n`);
  push(file.bytes);
  push(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function readJson(res) {
  let text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { error: text }; }
  if (!res.ok) {
    let detail = data?.error?.message || data?.error || data?.message || text || res.statusText;
    throw new Error(`Image request failed (${res.status}): ${String(detail).slice(0, 500)}`);
  }
  return data;
}

function responseText(data) {
  let chunks = [];
  let visit = node => {
    if (!node) return;
    if (typeof node === 'string') { chunks.push(node); return; }
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node.type === 'reasoning') return;
    if (typeof node.text === 'string' && node.type !== 'input_text') chunks.push(node.text);
    if (Array.isArray(node.content)) visit(node.content);
    if (Array.isArray(node.output)) visit(node.output);
  };
  visit(data?.output);
  let fromOutput = chunks.join('\n').trim();
  if (fromOutput) return fromOutput;
  return typeof data?.output_text === 'string' ? data.output_text.trim() : '';
}

function resolvePath(file) {
  return import('node:path').then(path => path.isAbsolute(file) ? path.resolve(file) : path.resolve(process.cwd(), file));
}

async function pathToDataUri(file) {
  let fs = await import('node:fs/promises');
  let abs = await resolvePath(file);
  let buf = await fs.readFile(abs);
  if (!buf.length) throw new Error('image file is empty');
  return `data:${mimeFor(buf, abs)};base64,${buf.toString('base64')}`;
}

async function writeDataUri(file, dataUri) {
  let fs = await import('node:fs/promises');
  let path = await import('node:path');
  let match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUri);
  if (!match) throw new Error('edited image is not a data URI');
  let abs = await resolvePath(file);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, Buffer.from(match[2].replace(/\s/g, ''), 'base64'));
  return abs;
}

export function createImageTools(options = {}) {
  let cli = !!options.cli;
  let doFetch = options.fetch || globalThis.fetch;
  let imageDescription = imageInputDescription(cli);

  async function loadImage(image) {
    if (typeof image !== 'string' || !image.trim()) throw new Error('image is required');
    let value = image.trim();
    if (DATA_IMAGE.test(value)) return value;
    if (!cli) throw new Error('image accepts only data URIs');
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) throw new Error('image accepts data URIs, relative, or absolute paths');
    return pathToDataUri(value);
  }

  function requirePrompt(prompt) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt is required');
    return prompt;
  }

  function pickSpec(kind) {
    let override = readOpt(options.imageModel);
    let chat = readOpt(options.model);
    let parsed = override ? parseSpec(override) : { provider: '', model: '' };
    if (!parsed.provider) parsed.provider = parseSpec(chat).provider || 'xai';
    // Chat models are not valid on images/generations or images/edits.
    if (kind !== 'analyze') {
      let requested = parsed.model;
      let looksImage = /imagine|image|dall-e|gpt-image/i.test(requested);
      if (!requested || !looksImage) {
        parsed.model = env('XAI_IMAGE_MODEL') || env('IMAGE_MODEL') || 'grok-imagine-image-2.0';
        if (!override && parsed.provider !== 'xai' && parsed.provider !== 'oai' && parsed.provider !== 'oail') {
          parsed.provider = 'xai';
        }
      }
    } else if (!parsed.model) {
      parsed.model = parseSpec(chat).model || options.visionModel || env('XAI_VISION_MODEL') || 'grok-4.7';
    }
    if (!parsed.model) throw new Error(kind === 'analyze' ? 'vision model required' : '--image-model needs an image model id');
    if (!PROVIDERS[parsed.provider]) throw new Error(`Unknown provider: ${parsed.provider}`);
    return parsed;
  }

  async function target(kind) {
    let spec = pickSpec(kind);
    let info = PROVIDERS[spec.provider];
    if (!info) throw new Error(`Unknown provider: ${spec.provider}`);
    let key = options.key == null ? '' : String((typeof options.key === 'function' ? await options.key() : options.key) || '').trim();
    if (!key) key = String(info.key() || '').trim();
    if (!key) throw new Error(`Missing ${info.keyName}`);
    return { ...info, ...spec, key };
  }

  async function api(url, body, key, headers) {
    let res = await doFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, ...headers },
      body,
      signal: timeoutSignal(180000),
    });
    return readJson(res);
  }

  function chatText(data) {
    let content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) return content.map(part => part?.text || (typeof part === 'string' ? part : '')).join('\n').trim();
    return '';
  }

  let imageSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['image', 'prompt'],
    properties: {
      image: { type: 'string', description: imageDescription },
      prompt: { type: 'string', description: 'Instruction or question about the image' },
    },
  };
  let editSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['image', 'prompt'],
    properties: {
      image: { type: 'string', description: imageDescription },
      prompt: { type: 'string', description: 'Instruction for the edit' },
      aspect_ratio: {
        type: 'string',
        description: `Optional aspect ratio: ${ASPECT_RATIOS.join(', ')}. Omit to keep the source image ratio.`,
      },
    },
  };
  if (cli) {
    editSchema.properties.output = {
      type: 'string',
      description: 'Optional relative or absolute path to write the edited image',
    };
  }

  return {
    image_analyze: {
      description: 'Answer a prompt about one image. Returns the answer text.',
      parameters: imageSchema,
      handler: async ({ image, prompt } = {}) => {
        let dataUri = await loadImage(image);
        let asked = requirePrompt(prompt);
        let dest = await target('analyze');
        let data;
        if (dest.analyze === 'chat') {
          data = await api(`${dest.base}/chat/completions`, JSON.stringify({
            model: dest.model,
            messages: [{
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: dataUri } },
                { type: 'text', text: asked },
              ],
            }],
          }), dest.key, { 'Content-Type': 'application/json' });
          let text = chatText(data);
          if (!text) throw new Error('image_analyze returned no text');
          return text;
        }
        data = await api(`${dest.base}/responses`, JSON.stringify({
          model: dest.model,
          store: false,
          input: [{
            role: 'user',
            content: [
              { type: 'input_image', image_url: dataUri, detail: 'auto' },
              { type: 'input_text', text: asked },
            ],
          }],
        }), dest.key, { 'Content-Type': 'application/json' });
        let text = responseText(data);
        if (!text) throw new Error('image_analyze returned no text');
        return text;
      },
    },
    image_generate: {
      description: cli
        ? 'Generate one image from a prompt. Returns a data URI, or writes the image and returns its absolute path when output is set.'
        : 'Generate one image from a prompt. Returns a data URI.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['prompt'],
        properties: {
          prompt: { type: 'string', description: 'What to generate' },
          aspect_ratio: {
            type: 'string',
            description: `Optional aspect ratio: ${ASPECT_RATIOS.join(', ')}.`,
          },
          ...(cli ? {
            output: { type: 'string', description: 'Optional relative or absolute path to write the generated image' },
          } : {}),
        },
      },
      handler: async ({ prompt, output, aspect_ratio } = {}) => {
        if (!cli && output != null && String(output).trim()) throw new Error('output path is only available in CLI mode');
        let asked = requirePrompt(prompt);
        let ratio = requireAspect(aspect_ratio);
        let dest = await target('edit');
        let data;
        if (dest.edit === 'openai') {
          data = await api(`${dest.base}/images/generations`, JSON.stringify({
            model: dest.model,
            prompt: asked,
            n: 1,
            size: openAiSize(ratio),
            response_format: 'b64_json',
          }), dest.key, { 'Content-Type': 'application/json' });
        } else {
          data = await api(`${dest.base}/images/generations`, JSON.stringify({
            model: dest.model,
            prompt: asked,
            n: 1,
            response_format: 'b64_json',
            ...(ratio ? { aspect_ratio: ratio } : {}),
          }), dest.key, { 'Content-Type': 'application/json' });
        }
        let item = data?.data?.[0];
        if (!item) throw new Error('image_generate returned no image');
        let uri;
        if (item.b64_json) {
          let mime = String(item.mime_type || 'image/png').split(';')[0].trim() || 'image/png';
          uri = `data:${mime};base64,${item.b64_json}`;
        } else if (typeof item.url === 'string' && item.url.startsWith('data:image/')) {
          uri = item.url;
        } else if (!item.url) {
          throw new Error('image_generate returned no image');
        } else {
          let downloaded = await doFetch(item.url, { signal: timeoutSignal(60000) });
          if (!downloaded.ok) throw new Error(`image_generate download failed (${downloaded.status})`);
          let mime = String(downloaded.headers?.get?.('content-type') || item.mime_type || 'image/png').split(';')[0].trim() || 'image/png';
          if (!mime.startsWith('image/')) mime = 'image/png';
          let bytes = new Uint8Array(await downloaded.arrayBuffer());
          if (!bytes.length) throw new Error('image_generate download was empty');
          uri = `data:${mime};base64,${bytesToBase64(bytes)}`;
        }
        if (!cli || output == null || !String(output).trim()) return uri;
        let outputPath = String(output).trim();
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(outputPath)) throw new Error('output accepts relative or absolute paths');
        return writeDataUri(outputPath, uri);
      },
    },
    image_edit: {
      description: cli
        ? 'Edit one image from a prompt. Returns a data URI, or writes the image and returns its absolute path when output is set.'
        : 'Edit one image from a prompt. Returns a data URI of the edited image.',
      parameters: editSchema,
      handler: async ({ image, prompt, output, aspect_ratio } = {}) => {
        if (!cli && output != null && String(output).trim()) throw new Error('output path is only available in CLI mode');
        let dataUri = await loadImage(image);
        let asked = requirePrompt(prompt);
        let ratio = requireAspect(aspect_ratio);
        let dest = await target('edit');
        let data;
        if (dest.edit === 'openai') {
          let file = dataUriBytes(dataUri);
          let form = formBody({
            model: dest.model,
            prompt: asked,
            n: '1',
            size: openAiSize(ratio),
          }, file);
          data = await api(`${dest.base}/images/edits`, form.body, dest.key, { 'Content-Type': form.contentType });
        } else {
          data = await api(`${dest.base}/images/edits`, JSON.stringify({
            model: dest.model,
            prompt: asked,
            n: 1,
            response_format: 'b64_json',
            image: { url: dataUri, type: 'image_url' },
            ...(ratio ? { aspect_ratio: ratio } : {}),
          }), dest.key, { 'Content-Type': 'application/json' });
        }
        let item = data?.data?.[0];
        if (!item) throw new Error('image_edit returned no image');
        let uri;
        if (item.b64_json) {
          let mime = String(item.mime_type || 'image/png').split(';')[0].trim() || 'image/png';
          uri = `data:${mime};base64,${item.b64_json}`;
        } else if (typeof item.url === 'string' && item.url.startsWith('data:image/')) {
          uri = item.url;
        } else if (!item.url) {
          throw new Error('image_edit returned no image');
        } else {
          let downloaded = await doFetch(item.url, { signal: timeoutSignal(60000) });
          if (!downloaded.ok) throw new Error(`image_edit download failed (${downloaded.status})`);
          let mime = String(downloaded.headers?.get?.('content-type') || item.mime_type || 'image/png').split(';')[0].trim() || 'image/png';
          if (!mime.startsWith('image/')) mime = 'image/png';
          let bytes = new Uint8Array(await downloaded.arrayBuffer());
          if (!bytes.length) throw new Error('image_edit download was empty');
          uri = `data:${mime};base64,${bytesToBase64(bytes)}`;
        }
        if (!cli || output == null || !String(output).trim()) return uri;
        let outputPath = String(output).trim();
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(outputPath)) throw new Error('output accepts relative or absolute paths');
        return writeDataUri(outputPath, uri);
      },
    },
  };
}

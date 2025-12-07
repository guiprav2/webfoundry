let tap = x => (console.log(x), x);

function resolve(x) {
  if (typeof x === 'function') return x();
  let visited = new Set();
  function walk(value) {
    if (value && typeof value === 'object') {
      if (visited.has(value)) return;
      visited.add(value);
      for (let key of Object.keys(value)) {
        if (typeof value[key] === "function") value[key] = value[key]();
        walk(value[key]);
      }
    }
  }
  walk(x);
  return x;
}

let cfg = {
  oai: {
    endpoint: 'https://api.openai.com/v1/responses',
    modelsEndpoint: 'https://api.openai.com/v1/models',
    apiKey: globalThis.process?.env?.OPENAI_API_KEY,
  },
  oail: {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    modelsEndpoint: 'https://api.openai.com/v1/models',
    apiKey: globalThis.process?.env?.OPENAI_API_KEY,
  },
  xai: {
    endpoint: 'https://api.x.ai/v1/chat/completions',
    modelsEndpoint: 'https://api.x.ai/v1/models',
    apiKey: globalThis.process?.env?.XAI_KEY,
  },
};

export default async function complete(logs, { model, apiKey, n, rolemap, tools, choice, simple, signal } = {}) {
  let provmod = (model || 'xai:grok-4-1-fast-non-reasoning').split(':');
  let provider = provmod[0];
  model = provmod[1];
  let { endpoint } = cfg[provider];
  apiKey ??= cfg[provider].apiKey;
  let messages = logs.map(x => {
    if (!rolemap || /system|assistant|user/.test(x.role)) return { ...x, tools: undefined };
    return { role: null, ...x, role: rolemap[x.role], tools: undefined };
  }).filter(x => x.role !== 'drop').map(x => ({ role: x.role, content: Array.isArray(x.content) ? x.content.filter(Boolean).join('\n') : x.content }));
  let tries = 1;
  if (choice === 'required') messages.unshift({ role: 'system', content: `Tool calling is MANDATORY.` });
  switch (provider) {
    case 'oai': {
      if (n != null) throw new Error(`OpenAI Responses API doesn't support parameter 'n'`);
      let ctools = [...Object.entries(tools || {})]
        .filter(xs => typeof xs[1] === 'function' ? xs[1]() : xs[1])
        .map(([name, spec]) => ({ type: 'function', name, parameters: {}, ...(typeof spec === 'function' ? spec() : spec), handler: undefined }))
        .map(spec => resolve(spec));
      //console.log(ctools.filter(x => x.parameters?.properties?.path?.enum).map(x => `- ${x.name}: ${x.parameters.properties.path.enum.filter(x => !x.startsWith('webfoundry/') && !x.endsWith('/.keep')).join(' | ')}`).join('\n'));
      for (let x of ctools) {
        x.parameters.type ??= 'object';
        x.parameters.properties ??= {};
        //x.parameters.properties.reason ??= { type: 'string', description: `Describe why you're taking this action` };
        //x.parameters.required ??= [];
        //x.parameters.required.push('reason');
      }
      let cchoice = !choice || /^auto|required|none$/.test(choice) ? choice : (choice ? { type: 'function', name: choice } : 'auto');
      let payload = { model, input: messages, tools: ctools, tool_choice: cchoice };
      let res = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
      if (res.headers.get('Content-Type') === 'application/json') res = await res.json();
      else res = await res.text();
      if (typeof res === 'string') return [res.status, res];
      !res.output && console.log(res);
      res.output = await Promise.all(res.output.map(async x => {
        if (x.type !== 'function_call') return x;
        x.arguments = JSON.parse(x.arguments);
        let tool = typeof tools[x.name] === 'function' ? tools[x.name]() : tools[x.name];
        let handler = tool.handler;
        //console.log('calling:', x.name, x.arguments);
        if (!handler) return x;
        let result = await handler(x.arguments);
        if (result != null) x.result = result;
        return x;
      }));
      if (simple) {
        let choices = res.output.map(x => {
          if (x.type !== 'function_call') {
            x.content = x.content.map(x => x.text);
            return { role: x.role, content: x.content.length === 1 ? x.content[0] : x.content };
          }
          let ret = { role: 'assistant', tools: {} };
          ret.tools[x.name] = { arguments: x.arguments };
          if (x.result != null) ret.tools[x.name].result = x.result;
          return ret;
        });
        if (!choices.length) return null;
        if (choices.length === 1) return choices[0];
        return choices;
      }
      return res;
    }
    case 'oail': {
      let ctools = [...Object.entries(tools || {})]
        .filter(xs => typeof xs[1] === 'function' ? xs[1]() : xs[1])
        .filter(xs => xs[1])
        .map(([name, spec]) => ({ type: 'function', function: { name: null, parameters: {}, ...spec, name, handler: undefined } }))
        .map(spec => resolve(spec));
      let cchoice = !choice || /^auto|required|none$/.test(choice) ? choice : (choice ? { type: 'function', name: choice } : 'auto');
      let res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ n: n ?? 1, model, messages, tools: ctools, tool_choice: cchoice }),
        signal,
      });
      if (res.headers.get('Content-Type') === 'application/json') res = await res.json();
      else res = await res.text();
      if (typeof res === 'string') return [res.status, res];
      res.choices = await Promise.all(res.choices.map(async x => {
        x.message.content = x.message.content?.replaceAll?.(/\n+/, '\n')?.trim?.();
        if (!x.message.tool_calls) return x;
        x.message.tool_calls = await Promise.all(x.message.tool_calls.map(async y => {
          if (y.type !== 'function') return y;
          y.function.arguments = JSON.parse(y.function.arguments);
          let handler = tools[y.function.name].handler;
          //console.log('calling:', y.function.name, handler);
          let result = handler ? await handler(y.function.arguments) : y.function.arguments;
          if (result != null) y.function.result = result;
          return y;
        }));
        return x;
      }));
      if (simple) {
        let choices = res.choices.map(x => {
          let ret = x.message
          if (ret.tool_calls) {
            ret.tools = Object.fromEntries(ret.tool_calls.map(y => {
              if (y.type !== 'function') throw new Error(`Unknown tool call type: ${y.type}`);
              let { name } = y.function;
              delete y.function.name;
              return [name, y.function];
            }));
            delete ret.tool_calls;
          }
          delete ret.annotations;
          delete ret.refusal;
          return ret;
        });
        if (!choices.length) return null;
        if (choices.length === 1) return choices[0];
        return choices;
      }
      return res;
    }
    case 'xai': {
      let ctools = [...Object.entries(tools || {})]
        .filter(xs => typeof xs[1] === 'function' ? xs[1]() : xs[1])
        .filter(xs => xs[1])
        .map(([name, spec]) => ({ type: 'function', function: { name: null, parameters: {}, ...(typeof spec === 'function' ? spec() : spec), name, handler: undefined } }))
        .map(spec => resolve(spec));
      let cchoice = !choice || /^auto|required|none$/.test(choice) ? choice : (choice ? { type: 'function', name: choice } : 'auto');
      let payload = { n: n ?? 1, model, messages, tools: ctools, tool_choice: cchoice === 'required' ? 'auto' : cchoice };
      cchoice === 'required' && tries > 1 && messages.push({ role: 'system', content: `You have failed to produce a mandatory tool call (#${tries}, ${crypto.randomUUID()}).` });
      let fncall = false;
      while (true) {
        let res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal,
        });
        if (res.headers.get('Content-Type') === 'application/json') res = await res.json();
        else res = await res.text();
        if (typeof res === 'string') return [res.status, res];
        !res.choices && console.log(res, payload);
        res.choices = await Promise.all(res.choices.map(async x => {
          x.message.content = x.message.content?.replaceAll?.('<has_function_call>', '')?.replaceAll?.(/\n+/g, '\n')?.trim?.();
          if (!x.message.tool_calls) return x;
          x.message.tool_calls = await Promise.all(x.message.tool_calls.map(async y => {
            if (y.type !== 'function') return y;
            y.function.arguments = JSON.parse(y.function.arguments);
            //y.function.arguments.reason = x.message.content;
            let tool = typeof tools[y.function.name] === 'function' ? tools[y.function.name]() : tools[y.function.name];
            let handler = tool.handler;
            console.log('calling:', y.function.name, y.function.arguments);
            let result = handler ? await handler(y.function.arguments) : y.function.arguments;
            if (result != null) y.function.result = result;
            fncall = true;
            return y;
          }));
          return x;
        }));
        if (cchoice === 'required' && !fncall) {
          console.log(`Tool call failed with message:`, res.choices[0].message.content);
          console.log();
          await new Promise(pres => setTimeout(pres, 1000));
          tries++;
          continue;
        }
        if (simple) {
          let choices = res.choices.map(x => {
            let ret = x.message;
            if (ret.tool_calls) {
              ret.tools = Object.fromEntries(ret.tool_calls.map(y => {
                if (y.type !== 'function') throw new Error(`Unknown tool call type: ${y.type}`);
                let { name } = y.function;
                delete y.function.name;
                return [name, y.function];
              }));
              delete ret.tool_calls;
            }
            delete ret.refusal;
            return ret;
          });
          if (!choices.length) return null;
          if (choices.length === 1) return choices[0];
          return choices;
        }
        return res;
      }
    }
  }
};

export async function listModels({ oaiKey, xaiKey }) {
  let models = [];
  try {
    oaiKey ??= cfg.oai.apiKey;
    if (oaiKey) {
      let res = await fetch(cfg.oai.modelsEndpoint, {
        headers: { Authorization: `Bearer ${oaiKey}`, 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error(`OpenAI list models error: ${JSON.stringify(await res.json(), null, 2)}`);
      for (let x of (await res.json()).data || []) models.push({ id: `${x.created >= 1754073306 ? 'oai' : 'oail'}:${x.id}`, created: x.created });
    }
  } catch (err) {
    console.error(err);
  }
  try {
    xaiKey ??= cfg.xai.apiKey;
    if (xaiKey) {
      let res = await fetch(cfg.xai.modelsEndpoint, {
        headers: { Authorization: `Bearer ${xaiKey}`, 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error(`xAI list models error: ${JSON.stringify(await res.json(), null, 2)}`);
      for (let x of (await res.json()).data || []) models.push({ id: `xai:${x.id}`, created: x.created });
    }
  } catch (err) {
    console.error(err);
  }
  return models.sort((a, b) => b.created - a.created);
};

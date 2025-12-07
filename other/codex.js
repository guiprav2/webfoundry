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
  endpoint: 'https://api.openai.com/v1/responses',
  apiKey: globalThis.process?.env?.OPENAI_API_KEY,
};

export default async function codex(logs, { apiKey, instructions, rolemap, preamble, tools, choice, reasoning, signal } = {}) {
  let { endpoint } = cfg;
  apiKey ??= cfg.apiKey;
  let messages = logs.map(x => {
    if (x.type && x.type !== 'message') return x;
    if (!rolemap || /system|assistant|user/.test(x.role)) return { ...x, tools: undefined };
    return { role: null, ...x, role: rolemap[x.role], tools: undefined };
  }).filter(x => x.role !== 'drop').map(x => x.type && x.type !== 'message' ? x : ({ role: x.role, content: Array.isArray(x.content) ? x.content.filter(Boolean).join('\n') : x.content }));
  let ctools = [...Object.entries(tools || {})]
    .filter(xs => typeof xs[1] === 'function' ? xs[1]() : xs[1])
    .map(([name, spec]) => ({ type: 'function', name, parameters: {}, ...(typeof spec === 'function' ? spec() : spec), handler: undefined }));
  let cchoice = !choice || /^auto|required|none$/.test(choice) ? choice : (choice ? { type: 'function', name: choice } : 'auto');
  while (true) {
    let payload = { model: 'gpt-5.1-codex', instructions, input: [...preamble?.() || [], ...messages], tools: ctools, tool_choice: cchoice, reasoning: { effort: 'high', summary: 'auto' } };
    console.log(payload);
    let res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    if (res.headers.get('Content-Type') === 'application/json') res = await res.json();
    else res = await res.text();
    if (typeof res === 'string') return [res.status, res];
    if (res.error) return console.error(res.error);
    res.output = (await Promise.all(res.output.map(async item => {
      if (item.type === 'reasoning') { delete item.id; reasoning?.(item.summary.filter(x => x.type === 'summary_text')[0]?.text?.split?.('\n')?.[0]); messages.push(item); return }
      if (item.type !== "function_call") return item;
      let args = {};
      try { args = JSON.parse(item.arguments); } catch {}
      const tool = typeof tools[item.name] === "function" ? tools[item.name]() : tools[item.name];
      const handler = tool?.handler;
      if (!handler) return;
      messages.push({ type: 'function_call', name: item.name, arguments: item.arguments, call_id: item.call_id });
      let result = await handler(args);
      console.log(item.name, '(', args, ')', ':', result);
      if (typeof result === 'object' || result == null) messages.push({ type: 'function_call_output', call_id: item.call_id, output: result ? JSON.stringify(result) : 'OK' });
      else messages.push({ type: 'function_call_output', call_id: item.call_id, output: result });
    }))).filter(Boolean);
    if (res.output.at(-1)?.type === 'assistant') return res;
    if (state.assistant.plan?.every?.(x => x.status === 'completed')) return;
    await new Promise(pres => setTimeout(pres, 500));
  }
};

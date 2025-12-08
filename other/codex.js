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

export default async function codex(logs, { apiKey, instructions, rolemap, preamble, tools, reasoning, signal } = {}) {
  let { endpoint } = cfg;
  apiKey ??= cfg.apiKey;
  let messages = logs.map(x => {
    if (x.type && x.type !== 'message') return x;
    if (!rolemap || /system|assistant|user/.test(x.role)) return { ...x, tools: undefined };
    return { role: null, ...x, role: rolemap[x.role], tools: undefined };
  }).filter(x => x.role !== 'drop').map(x => x.type && x.type !== 'message' ? x : ({ role: x.role, content: Array.isArray(x.content) ? x.content.filter(Boolean).join('\n') : x.content }));
  while (true) {
    try {
      let ctools = [...Object.entries(typeof tools === 'function' ? tools() || {} : tools || {})]
        .filter(xs => typeof xs[1] === 'function' ? xs[1]() : xs[1])
        .map(([name, spec]) => ({ type: 'function', name, parameters: {}, ...(typeof spec === 'function' ? spec() : spec), handler: undefined }));
      for (let [i, x] of ctools.entries()) ctools[i] = resolve(x);
      //console.log(ctools.map(x => `- ${x.name}: ${x.description}`).join('\n'));
      let payload = {
        model: state.files.current?.endsWith?.('.html') ? 'gpt-5.1' : 'gpt-5.1-codex',
        instructions,
        input: [...preamble?.() || [], ...messages],
        tools: ctools,
        tool_choice: 'required',
        reasoning: state.files.current?.endsWith?.('.html') ? undefined : { effort: 'high', summary: 'auto' },
      };
      console.log(payload);
      let res = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
      if (res.headers.get('Content-Type') === 'application/json') res = await res.json();
      else res = await res.text();
      if (typeof res === 'string') throw new Error(res);
      if (res.error) throw new Error(JSON.stringify(res.error));
      res.output = (await Promise.all(res.output.map(async item => {
        if (item.type === 'reasoning') { delete item.id; reasoning?.(item.summary.filter(x => x.type === 'summary_text')[0]?.text?.split?.('\n')?.[0]); messages.push(item); return }
        if (item.type !== "function_call") return item;
        let args = {};
        try { args = JSON.parse(item.arguments); } catch {}
        let rawtools = typeof tools === 'function' ? tools() : tools;
        const tool = typeof rawtools[item.name] === "function" ? rawtools[item.name]() : rawtools[item.name];
        const handler = tool?.handler;
        if (!handler) return;
        state.assistant.codexListBlock = false;
        messages.push({ type: 'function_call', name: item.name, arguments: item.arguments, call_id: item.call_id });
        let result = await handler(args);
        console.log(item.name, '(', args, ')', ':', result);
        if (typeof result === 'object' || result == null) messages.push({ type: 'function_call_output', call_id: item.call_id, output: result ? JSON.stringify(result) : 'OK' });
        else messages.push({ type: 'function_call_output', call_id: item.call_id, output: result });
      }))).filter(Boolean);
      console.log(res);
      if (res.output.at(-1)?.type === 'assistant') return { success: true, note: res.content };
      if (state.assistant.plan?.length && state.assistant.plan.every(x => x.status === 'completed')) return { success: true, note: `All planned items completed` };
      await new Promise(pres => setTimeout(pres, 500));
    } catch (err) {
      console.error(err);
      try { reasoning?.(err.toString()) } catch (err) { console.error(err) }
      await new Promise(pres => setTimeout(pres, 5000));
    }
  }
  return { success: true, note: `Codex loop finished` };
};

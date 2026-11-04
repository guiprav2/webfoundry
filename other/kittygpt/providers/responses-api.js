// providers/responses-api.js
import { openaiError, openaiStreamError } from './errors.js';

let arrayify = x => Array.isArray(x) ? x : [x];

let spawnAgentSchema = {
  type: 'function',
  name: 'spawn_agent',
  description: 'Spawns a sub-agent with a fresh thread for an independent subtask. Multiple spawn_agent calls in the same batch run concurrently; each returns status "started" immediately while it works in the background. Results arrive later as user messages "[subagent <name> finished]…". Do not redo a spawned subtask yourself. You may keep doing unrelated work in parallel; if you have nothing else to do, end your turn with a short no-tools message and wait for those results, then consolidate.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short identifier for this sub-agent (shown in progress output)' },
      description: { type: 'string', description: 'One-line summary of what this sub-agent will do (shown in progress output)' },
      prompt: { type: 'string', description: 'The task for the sub-agent' },
      instructions: { type: 'string', description: 'System instructions (optional, defaults to parent)' },
      model: { type: 'string', description: 'Model override (optional, defaults to parent)' },
    },
    required: ['name', 'description', 'prompt'],
  },
};

let defineToolSchema = {
  type: 'function',
  name: 'define_tool',
  description: 'Define a new meta tool',
  parameters: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      tool_description: { type: 'string' },
      parameters_schema: { type: 'object', properties: {}, additionalProperties: true },
    },
    required: ['tool_name', 'tool_description', 'parameters_schema'],
  },
};

let provider = {
  name: 'OpenAI',
  parseError: openaiError,
  streamError: openaiStreamError,
  endpoint: null,
  modelsEndpoint: null,
  key: null,
  supportsStreamingWithTools: true,

  fmt(x) {
    switch (x.type) {
      case 'message': {
        let m = { type: 'message', role: x.role, content: x.content.flatMap(y => this.fmtc(x.role, y)) };
        // gpt-5.3-codex+: preserve assistant message phase on follow-up turns
        if (x.phase) m.phase = x.phase;
        return m;
      }
      case 'tool_call':
        return x.calls.map(y => ({ type: 'function_call', name: y.name, arguments: JSON.stringify(y.args), call_id: y.call }));
      case 'tool_call_result': {
        let output = x.output == null ? 'OK' : typeof x.output === 'string' ? x.output : JSON.stringify(x.output);
        return { type: 'function_call_output', call_id: x.call, output };
      }
      case 'reasoning':
        return { type: 'reasoning', id: x.id, summary: x.summary || [], encrypted_content: x.encrypted_content };
      default:
        throw new Error(`Unknown message type: ${x.type}`);
    }
  },

  fmtc(role, x) {
    if (typeof x === 'string') return [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: x }];
    if (!Array.isArray(x)) {
      switch (x.type) {
        case 'img':   return [{ type: 'input_image', image_url: x.url }];
        case 'audio': return [{ type: 'input_audio', audio_url: x.url }];
        case 'video': return [{ type: 'input_video', video_url: x.url }];
        case 'json':  return [{ type: 'input_json', json: x.data }];
        default: throw new Error(`Unknown content type: ${x.type}`);
      }
    }
    return x.flatMap(y => this.fmtc(role, y));
  },

  defmt(x) {
    switch (x.type || 'message') {
      case 'message': {
        let content = Array.isArray(x.content) ? x.content.map(c => this.defmtc(c)) : [x.content == null ? '' : String(x.content)];
        let m = { type: 'message', role: x.role, content };
        if (x.phase) m.phase = x.phase;
        return m;
      }
      case 'function_call': {
        let args = x.arguments;
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { args = {}; }
        } else if (args == null || typeof args !== 'object') {
          args = {};
        }
        return { type: 'tool_call', calls: [{ name: x.name, call: x.call_id || x.id, args }] };
      }
      case 'custom_tool_call':
      case 'local_shell_call': {
        // Treat as tool_call when we can map a name; otherwise skip.
        let name = x.name || (x.type === 'local_shell_call' ? 'local_shell' : null);
        if (!name) return { type: 'ignored', rawType: x.type };
        let args = x.arguments ?? x.input ?? x.action ?? {};
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { args = { input: args }; }
        }
        return { type: 'tool_call', calls: [{ name, call: x.call_id || x.id, args }] };
      }
      case 'function_call_output': {
        let output; try { output = JSON.parse(x.output); } catch { output = x.output; }
        return { type: 'tool_call_result', call: x.call_id, output };
      }
      case 'reasoning':
        return { type: 'reasoning', id: x.id, summary: x.summary || [], encrypted_content: x.encrypted_content };
      case 'web_search_call':
      case 'file_search_call':
      case 'code_interpreter_call':
      case 'image_generation_call':
      case 'mcp_call':
      case 'mcp_list_tools':
        // Server-side / hosted tools: not executed by Kitty; keep transcript continuity only.
        return { type: 'ignored', rawType: x.type };
      default:
        // Never crash the agent loop on provider-specific output items (xAI extensions, etc.).
        return { type: 'ignored', rawType: x.type || 'unknown' };
    }
  },

  defmtc(x) {
    if (x == null) return '';
    if (typeof x === 'string') return x;
    switch (x.type) {
      case 'input_text':
      case 'output_text': return x.text ?? '';
      case 'input_image': return { type: 'img', url: x.image_url };
      case 'input_audio': return { type: 'audio', url: x.audio_url };
      case 'input_video': return { type: 'video', url: x.video_url };
      case 'input_json':  return { type: 'json', data: x.json };
      default:
        // Refusal / annotations / unknown parts — keep text if any, else empty.
        if (typeof x.text === 'string') return x.text;
        if (typeof x.refusal === 'string') return x.refusal;
        return '';
    }
  },

  buildPayload(msgs, preamble, opts) {
    let toolDefs = Object.entries(typeof opts.tools === 'function' ? opts.tools() : opts.tools || {})
      .map(([name, spec]) => ({ type: 'function', name, parameters: {}, ...spec, handler: undefined }));

    if (opts.metanull) toolDefs.push(defineToolSchema);
    if (opts.subagents) toolDefs.push(spawnAgentSchema);

    let toolChoice = !opts.call || /^(auto|required|none)$/.test(opts.call)
      ? (opts.call || 'auto')
      : { type: 'function', name: opts.call };

    let fmtPreamble = (typeof preamble === 'function' ? preamble() : preamble || [])
      .map(x => ({ ...x, type: x.type || 'message' }))
      .flatMap(x => this.fmt(x));

    return {
      model: opts.cmodel,
      input: [...fmtPreamble, ...msgs],
      instructions: opts.instructions || undefined,
      tools: toolDefs.length ? toolDefs : undefined,
      tool_choice: toolDefs.length ? toolChoice : undefined,
      parallel_tool_calls: true,
      stream: opts.stream ?? true,
      reasoning: opts.reasoning ? { ...opts.reasoning, callback: undefined } : undefined,
      include: opts.reasoning ? ['reasoning.encrypted_content'] : undefined,
    };
  },

  buildHeaders(opts) {
    let headers = { 'Content-Type': 'application/json' };
    let key = opts.key || this.key;
    if (key) headers['Authorization'] = `Bearer ${key}`;
    if (opts.reasoning) Object.assign(headers, {
      'OpenAI-Beta': 'responses=experimental',
      conversation_id: opts.cid,
      session_id: opts.cid,
    });
    return headers;
  },

  async stream(body, { text, reasoning, tool } = {}) {
    let reader = body.getReader();
    let decoder = new TextDecoder('utf-8');
    let buffer = '';
    let pendingCalls = {};
    let emittedCallIds = new Set();
    // OpenAI (end_turn/phase) + xAI/Grok Build (stop_reason/status/tool_calls) sampling meta.
    let meta = {
      endTurn: undefined,
      phases: [],
      hadToolEvents: false,
      stopReason: undefined,
      finishReason: undefined,
      status: undefined,
      pendingToolWires: [], // function_call items on completed output not yet emitted via stream deltas
      assistantTextFallback: '', // if provider only sent full text on completed output items
      usage: undefined, // { input_tokens, output_tokens, total_tokens }
    };
    let sawTextDelta = false;

    while (true) {
      let { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line || line === 'data: [DONE]') continue;

        let payload;
        try { payload = JSON.parse(line.replace(/^data:\s*/, '')); } catch { continue; }

        let { type } = payload;
        if (type === 'error' || type === 'response.failed') throw this.streamError(payload);
        if (type === 'response.output_text.delta' || type === 'response.content_part.delta') {
          let d = payload.delta ?? payload.text ?? (typeof payload.part?.text === 'string' ? payload.part.text : '');
          if (d) { sawTextDelta = true; await text?.('delta', d); }
        }
        else if (type === 'response.output_text.done' || type === 'response.content_part.done') {
          let d = payload.text ?? payload.part?.text;
          if (d) await text?.('done', d);
        }
        else if (type === 'response.output_item.added' && payload.item?.type === 'function_call') {
          meta.hadToolEvents = true;
          pendingCalls[payload.item.id] = { type: 'function_call', name: payload.item.name, call_id: payload.item.call_id };
        }
        else if (type === 'response.output_item.done' && payload.item) {
          let item = payload.item;
          if (item.type === 'message' && item.role === 'assistant' && item.phase) {
            meta.phases.push(item.phase);
          }
          if (item.type === 'function_call' || item.type === 'custom_tool_call' || item.type === 'local_shell_call') {
            meta.hadToolEvents = true;
            // Some providers (incl. xAI) finalize the whole call on output_item.done.
            if (item.type === 'function_call' && item.name && item.arguments != null) {
              let callId = item.call_id || item.id;
              if (callId && !emittedCallIds.has(callId)) {
                emittedCallIds.add(callId);
                let wire = {
                  type: 'function_call',
                  name: item.name,
                  call_id: callId,
                  arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments),
                };
                // Prefer immediate emit so core sees toolsInvoked before completed.
                await tool?.('done', wire);
                delete pendingCalls[payload.item?.id || item.id];
              }
            }
          }
        }
        else if (type === 'response.function_call_arguments.done') {
          meta.hadToolEvents = true;
          let call = pendingCalls[payload.item_id];
          if (call) {
            call.arguments = payload.arguments;
            if (call.call_id) emittedCallIds.add(call.call_id);
            await tool?.('done', call);
            delete pendingCalls[payload.item_id];
          }
        }
        else if (type === 'response.reasoning_summary_text.delta') await reasoning?.('delta', payload.delta);
        else if (type === 'response.reasoning_summary_text.done') await reasoning?.('done', payload.text);
        else if (type === 'response.completed' || type === 'response.incomplete') {
          let resp = payload.response || payload;
          // OpenAI/Codex: end_turn === false ⇒ another sample.
          if (Object.prototype.hasOwnProperty.call(resp, 'end_turn')) meta.endTurn = resp.end_turn;
          else if (Object.prototype.hasOwnProperty.call(payload, 'end_turn')) meta.endTurn = payload.end_turn;

          // xAI / shared Responses fields
          if (resp.status != null) meta.status = resp.status;
          else if (type === 'response.incomplete') meta.status = meta.status || 'incomplete';

          let sr = resp.stop_reason ?? resp.stopReason ?? payload.stop_reason;
          if (sr != null) meta.stopReason = sr;
          let fr = resp.finish_reason ?? resp.finishReason ?? payload.finish_reason;
          if (fr != null) meta.finishReason = fr;

          let u = resp.usage || payload.usage;
          if (u && typeof u === 'object') {
            let input = u.input_tokens ?? u.prompt_tokens ?? u.input ?? 0;
            let output = u.output_tokens ?? u.completion_tokens ?? u.output ?? 0;
            let total = u.total_tokens ?? (Number(input) + Number(output));
            meta.usage = {
              input_tokens: Number(input) || 0,
              output_tokens: Number(output) || 0,
              total_tokens: Number(total) || 0,
            };
          }

          // Grok Build: tool calls on the final output win even if stream deltas were thin.
          let output = resp.output;
          if (Array.isArray(output)) {
            for (let item of output) {
              if (!item || typeof item !== 'object') continue;
              if (item.type === 'message' && item.role === 'assistant' && item.phase) {
                meta.phases.push(item.phase);
              }
              if (item.type === 'function_call' || item.type === 'custom_tool_call' || item.type === 'local_shell_call') {
                meta.hadToolEvents = true;
                let callId = item.call_id || item.id;
                if (
                  item.type === 'function_call'
                  && item.name
                  && item.arguments != null
                  && callId
                  && !emittedCallIds.has(callId)
                ) {
                  emittedCallIds.add(callId);
                  meta.pendingToolWires.push({
                    type: 'function_call',
                    name: item.name,
                    call_id: callId,
                    arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments),
                  });
                }
              }
            }
          }
          // Normalize xAI-style: presence of tools ⇒ tool_calls stop reason if unset
          if (meta.hadToolEvents && meta.stopReason == null && meta.finishReason == null) {
            meta.stopReason = 'tool_calls';
          }
          // Fallback assistant text when deltas never arrived (some xAI payloads).
          if (!sawTextDelta && Array.isArray(output)) {
            let bits = [];
            for (let item of output) {
              if (item?.type === 'message' && item.role === 'assistant' && Array.isArray(item.content)) {
                for (let part of item.content) {
                  if (typeof part?.text === 'string') bits.push(part.text);
                  else if (part?.type === 'output_text' && part.text) bits.push(part.text);
                }
              }
            }
            if (bits.length) meta.assistantTextFallback = bits.join('');
          }
        }
      }
    }

    // Flush completed-output tool calls that never got function_call_arguments.done
    for (let wire of meta.pendingToolWires) {
      await tool?.('done', wire);
    }
    meta.pendingToolWires = [];
    return meta;
  },
};

export default provider;

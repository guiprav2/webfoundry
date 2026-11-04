// core.js
import oai from './providers/oai.js';
import xai from './providers/xai.js';
import oail from './providers/oail.js';
import { ProviderError, networkError } from './providers/errors.js';
import { createImageTools } from './image_tools.js';

export { createImageTools };

/** Per-run report sink so nested spawn_agent tools do not paint the parent status line. */
let runReportStore = null;
if (typeof process !== 'undefined' && process.versions?.node) {
  let { AsyncLocalStorage } = await import('node:async_hooks');
  runReportStore = new AsyncLocalStorage();
}

/** Current run's `opts.report`, if any (nested runs shadow the parent). */
export function getRunReport() {
  return runReportStore?.getStore()?.getReport?.() ?? null;
}

export function attachImageTools(opts = {}) {
  if (opts.images === false) return opts;
  let original = opts.tools;
  let extra = createImageTools({
    cli: !!opts.cli,
    model: typeof opts.model === 'function' ? opts.model : () => opts.model,
    imageModel: opts.imageModel,
  });
  let tools = () => {
    let current = typeof original === 'function' ? original() : original;
    let t = { ...(current || {}) };
    if (!t.image_analyze) t.image_analyze = extra.image_analyze;
    if (!t.image_edit) t.image_edit = extra.image_edit;
    return t;
  };
  return { ...opts, tools };
}
let { lookup: mimeLookup } = await (typeof process !== 'undefined' && process.versions?.node
  ? import('mrmime')
  : import('https://esm.sh/mrmime'));

let arrayify = x => Array.isArray(x) ? x : [x];
let STATUS_MAX = 64;

let providerMap = { oai, xai, oail };

export { ProviderError };

let RETRY_MAX_DELAY_MS = 60_000;

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    let t = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
    let onAbort = () => { clearTimeout(t); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function isAbort(err, signal) {
  return signal?.aborted || err?.name === 'AbortError';
}

/** Map a non-OK response to a ProviderError using the provider's own parser. */
async function errorFromResponse(provider, res) {
  let bodyText = '';
  try { bodyText = await res.text(); } catch {}
  if (typeof provider.parseError === 'function') return provider.parseError(res.status, bodyText, res.headers);
  return new ProviderError({
    provider: provider.name || 'provider',
    status: res.status,
    summary: 'request failed',
    detail: bodyText.slice(0, 500),
    retryable: res.status === 429 || res.status >= 500,
  });
}

/**
 * POST with per-provider error mapping and retries (exponential backoff, honors Retry-After).
 * Only transient errors (rate limits, 5xx, network) are retried; billing/auth/request errors throw at once.
 */
async function sendRequest(provider, url, init, { signal, report = () => {}, maxRetries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let err;
    try {
      let res = await fetch(url, { ...init, signal });
      if (res.ok) return res;
      err = await errorFromResponse(provider, res);
    } catch (e) {
      if (isAbort(e, signal)) throw e;
      err = e instanceof ProviderError ? e : networkError(provider.name || 'provider', e);
    }
    let delay = err.retryAfterMs ?? Math.min(1000 * 2 ** attempt, 30_000) + Math.floor(Math.random() * 250);
    if (!err.retryable || attempt >= maxRetries || delay > RETRY_MAX_DELAY_MS) {
      report(err.short);
      throw err;
    }
    report(`${err.short}, retrying in ${Math.ceil(delay / 1000)}s (${attempt + 1}/${maxRetries})`);
    await abortableSleep(delay, signal);
  }
}

function resolveProvider(model) {
  let [prov, ...rest] = model.split(':');
  let cmodel = rest.join(':');
  let provider = providerMap[prov];
  if (!provider) throw new Error(`Unknown provider: ${prov}`);
  return { provider, cmodel };
}

/** Compact single-line preview: `{ x: 1, reason: "Long text" }`. */
function previewValue(v, depth = 0) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'function') return '[Function]';
  if (depth > 3) return Array.isArray(v) ? '[…]' : '{…}';
  if (Array.isArray(v)) {
    return `[${v.map(x => previewValue(x, depth + 1)).join(', ')}]`;
  }
  if (typeof v === 'object') {
    let parts = Object.entries(v).map(([k, val]) => `${k}: ${previewValue(val, depth + 1)}`);
    return `{ ${parts.join(', ')} }`;
  }
  try {
    return String(v);
  } catch {
    return '[unprintable]';
  }
}

/** `Calling name { args } ...` — fixed trailing ellipsis; trim args to fit STATUS_MAX. */
function formatToolCalling(name, args) {
  let prefix = `Calling ${name} `;
  let suffix = ' ...';
  let budget = STATUS_MAX - prefix.length - suffix.length;
  let body = previewValue(args ?? {});
  if (body.length > budget) body = body.slice(0, Math.max(0, budget));
  return prefix + body + suffix;
}

/** `Called name: result` — ellipsis only if result was truncated. */
function formatToolCalled(name, result) {
  let prefix = `Called ${name}: `;
  let budget = STATUS_MAX - prefix.length;
  let body = previewValue(result);
  if (body.length > budget) {
    let ell = '\u2026';
    body = body.slice(0, Math.max(0, budget - ell.length)) + ell;
  }
  return prefix + body;
}

let silentTools = new Set(['shell', 'update_plan', 'spawn_agent']);
let subAgentSeq = 0;


/** Provider-agnostic sampling follow-up (OpenAI/Codex + xAI/Grok Build + Pi-style tools).
 *  Continue the agent loop when any apply:
 *   - tools ran / tool events seen (model must see outputs)
 *   - OpenAI: end_turn === false
 *   - OpenAI: message phase commentary | partial_answer
 *   - xAI/Grok: stop_reason or finish_reason is tool_calls (or function_call)
 *  No prose heuristics. Missing signals ⇒ assistant-only stop (Pi default).
 */
function sampleNeedsFollowUp({
  toolsInvoked = false,
  endTurn,
  phases = [],
  stopReason,
  finishReason,
  status,
} = {}) {
  if (toolsInvoked) return true;
  if (endTurn === false) return true;

  for (let p of phases) {
    let n = String(p || '').toLowerCase().replace(/-/g, '_');
    if (n === 'commentary' || n === 'partial_answer') return true;
  }

  let reason = stopReason ?? finishReason;
  if (reason != null) {
    let r = String(reason).toLowerCase().replace(/-/g, '_');
    if (r === 'tool_calls' || r === 'tool_call' || r === 'function_call') return true;
  }

  void status;
  return false;
}

/** True when the sample had no hard continue/end flags and ended as plain assistant text. */
function isAmbiguousPlainStop({
  toolsInvoked = false,
  endTurn,
  phases = [],
  stopReason,
  finishReason,
  hadAssistantText = false,
} = {}) {
  if (!hadAssistantText) return false;
  if (toolsInvoked) return false;
  if (endTurn === false) return false;
  if (endTurn === true) return false;
  for (let p of phases) {
    let n = String(p || '').toLowerCase().replace(/-/g, '_');
    if (n === 'commentary' || n === 'partial_answer' || n === 'final_answer') return false;
  }
  let reason = stopReason ?? finishReason;
  if (reason != null) {
    let r = String(reason).toLowerCase().replace(/-/g, '_');
    if (r === 'tool_calls' || r === 'tool_call' || r === 'function_call') return false;
  }
  return true;
}

const COMPLETION_PROBE =
  "This is a harness-generated prompt, not the user. Do you have work left to do that doesn't depend on any further instructions from the user? Respond bare YES or NO, nothing else.";

const HARNESS_CONTINUE_PROMPT = 'Continue (harness request)';

const MAX_AMBIGUOUS_CONTINUES = 4;

/** Parse bare YES/NO from a short model reply. */
function parseYesNo(text) {
  let t = String(text || '').trim();
  let line = t.split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';
  let m = line.match(/\b(yes|no)\b/i) || t.match(/\b(yes|no)\b/i);
  if (!m) return null;
  return m[1].toLowerCase() === 'yes';
}

/** Merge provider usage into opts.tokenUsage (session totals). */
function accumulateUsage(opts, usage) {
  if (!usage || !opts) return;
  let tu = opts.tokenUsage || (opts.tokenUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 });
  let inp = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
  let out = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
  let tot = Number(usage.total_tokens ?? (inp + out)) || 0;
  tu.input_tokens = (tu.input_tokens || 0) + inp;
  tu.output_tokens = (tu.output_tokens || 0) + out;
  tu.total_tokens = (tu.total_tokens || 0) + tot;
  opts.onTokenUsage?.(tu, usage);
}

/** Extract usage from a non-stream Responses/Chat JSON body. */
function usageFromResponseData(data) {
  if (!data || typeof data !== 'object') return null;
  let u = data.usage || data.response?.usage;
  if (!u && data.choices?.[0]?.usage) u = data.choices[0].usage;
  if (!u) return null;
  let input = u.input_tokens ?? u.prompt_tokens ?? 0;
  let output = u.output_tokens ?? u.completion_tokens ?? 0;
  let total = u.total_tokens ?? (Number(input) + Number(output));
  return {
    input_tokens: Number(input) || 0,
    output_tokens: Number(output) || 0,
    total_tokens: Number(total) || 0,
  };
}


export async function runTools(calls, toolset, opts) {
  let report = typeof opts.report === 'function' ? opts.report : () => {};
  let shouldReport = name => !silentTools.has(name);
  opts.toolBatch?.(true);
  try {
    let execute = async call => {
      try {
        if (call.name === 'define_tool') {
          return await opts.metanull?.({
            meta: true,
            name: call.args.tool_name,
            description: call.args.tool_description,
            parameters: call.args.parameters_schema,
          });
        }
        if (toolset?.[call.name]?.meta) return await opts.metainvoke?.(call.name, call.args);
        // Layer B: returns immediately; result is absorbed later into the parent loop.
        if (call.name === 'spawn_agent' && opts.subagents) {
          return spawnAgent(call.args, opts, { call: call.call });
        }
        // shell reports Running:/Ran:; update_plan stays off the status line
        if (shouldReport(call.name)) report(formatToolCalling(call.name, call.args));
        try {
          let ret = await toolset?.[call.name]?.handler?.(call.args);
          if (shouldReport(call.name)) report(formatToolCalled(call.name, ret));
          return ret;
        } catch (err) {
          if (shouldReport(call.name)) report(formatToolCalled(call.name, err?.message || String(err)));
          throw err;
        }
      } catch (err) {
        return { success: false, error: err.toString() };
      }
    };
    return await Promise.all(calls.map(execute));
  } finally {
    opts.toolBatch?.(false);
  }
}

/**
 * Start a subagent without blocking the parent tool batch.
 * Returns `{ status: 'started', id, name, description }` immediately.
 * When finished, queues a result for the enclosing `run()` to absorb.
 */
export function spawnAgent({ name, description, prompt, instructions, model }, parentOpts, callMeta = {}) {
  let id = `sub_${++subAgentSeq}_${Date.now().toString(36)}`;
  let handle = parentOpts.subagentStart?.({ id, name, description, prompt });
  // Legacy one-shot hook (dim stdout, etc.)
  parentOpts.subagent?.(description || prompt, name);

  let resolvedModel = !model ? parentOpts.model
    : model.includes(':') ? model
    : parentOpts.model.split(':')[0] + ':' + model;

  let promise = (async () => {
    try {
      let subLogs = [{ type: 'message', role: 'user', content: [prompt] }];
      let [resultLogs] = await run(subLogs, {
        ...parentOpts,
        model: resolvedModel,
        instructions: instructions !== undefined ? instructions : parentOpts.instructions,
        // Nested runs keep their own pending-subagent maps; do not reuse parent UI hooks.
        absorbInjects: undefined,
        beginIteration: undefined,
        flushReports: undefined,
        toolBatch: undefined,
        text: undefined,
        img: undefined,
        narration: undefined,
        report: msg => handle?.update?.(msg),
        subagentStart: parentOpts.subagentStart,
      });
      let last = resultLogs.at(-1);
      let output = last?.content?.join?.('\n') || 'No response';
      handle?.done?.(output);
      parentOpts.queueSubagentResult?.({ id, name, call: callMeta.call, output });
      return output;
    } catch (err) {
      let output = { success: false, error: err?.toString?.() || String(err) };
      handle?.fail?.(err);
      parentOpts.queueSubagentResult?.({ id, name, call: callMeta.call, output });
      return output;
    }
  })();

  parentOpts.registerSubagent?.({ id, name, promise });
  return {
    status: 'started',
    id,
    name,
    description,
    note: 'Sub-agent is running in the background. Its result will arrive later as a user message starting with "[subagent ' + name + ' finished]". Do not redo this sub-agent\'s task yourself. You may do unrelated work in parallel, or end your turn with a short message and no tool calls to wait for results.',
  };
}

function automedia(x) {
  if (!Array.isArray(x.content)) return x;
  let media = [];
  for (let part of x.content) {
    if (typeof part !== 'string') continue;
    let urls = part.match(/\bhttps?:\/\/[^\s<>"']+/gi);
    if (!urls) continue;
    for (let url of urls) {
      let mime = mimeLookup(url);
      if (!mime) continue;
      if (mime.startsWith('image/')) media.push({ type: 'img', url });
      else if (mime.startsWith('audio/')) media.push({ type: 'audio', url });
      else if (mime.startsWith('video/')) media.push({ type: 'video', url });
    }
  }
  if (!media.length) return x;
  return { ...x, content: [...x.content, ...media] };
}

export async function run(logs, opts = {}) {
  opts = attachImageTools(opts);
  let model = opts.model || 'oai:gpt-5';
  let { provider, cmodel } = resolveProvider(model);
  let resolvedOpts = { ...opts, cmodel };

  let enter = runReportStore
    ? fn => runReportStore.run({ getReport: () => resolvedOpts.report }, fn)
    : fn => fn();
  return enter(() => runLoop(logs, opts, resolvedOpts, provider));
}

async function runLoop(logs, opts, resolvedOpts, provider) {
  let toolResults = [];
  let signal = opts.signal;
  let ambiguousContinues = 0;

  function checkAbort() {
    if (!signal?.aborted) return false;
    if (signal.reason != null) throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));
    return true;
  }

  // Normalize logs
  for (let [i, x] of logs.entries()) {
    if (x.type) continue;
    if (!Array.isArray(x.content)) x.content = [x.content];
    logs[i] = { type: 'message', ...x };
  }

  // Automedia expansion
  if (opts.automedia) {
    for (let i = 0; i < logs.length; i++) {
      if (logs[i].role !== 'user') continue;
      let expanded = automedia(logs[i]);
      if (expanded !== logs[i]) logs[i] = expanded;
    }
  }

  let msgs = logs.flatMap(m => provider.fmt(m)).filter(Boolean);
  let toolset = typeof opts.tools === 'function' ? opts.tools() : opts.tools;

  /** Rebuild wire msgs from the live `logs` array (active window after rollover). */
  function rebuildMsgsFromLogs() {
    msgs = logs.flatMap(m => {
      try { return arrayify(provider.fmt(m)); }
      catch { return []; }
    }).filter(Boolean);
  }

  /** Run context fill check; if the host seals the window, resync msgs to the new active log. */
  async function contextCheck(phase) {
    let rolled = await opts.onContextCheck?.({ phase, logs, msgs });
    if (rolled) rebuildMsgsFromLogs();
    return !!rolled;
  }
  /** Background spawn_agent tasks started from this run. */
  let pendingSubagents = new Map(); // id -> { name, promise }
  let subagentResultQueue = [];

  resolvedOpts.registerSubagent = ({ id, name, promise }) => {
    pendingSubagents.set(id, { name, promise });
  };
  resolvedOpts.queueSubagentResult = result => {
    subagentResultQueue.push(result);
  };

  /** Mid-loop user prompts queued by the UI; append into logs/msgs without aborting. */
  async function absorbInjects() {
    let batch = opts.absorbInjects?.();
    if (!batch?.length) return false;
    // Mid-loop user prompts are still "new prompts" — rollover only here, not mid-tools.
    await contextCheck('before_prompt');
    for (let text of batch) {
      let userMsg = { type: 'message', role: 'user', content: Array.isArray(text) ? text : [String(text)] };
      if (opts.automedia) userMsg = automedia(userMsg);
      logs.push(userMsg);
      msgs.push(...arrayify(provider.fmt(userMsg)));
    }
    return true;
  }

  /** Fold finished subagent outputs into logs as user messages (tool result already returned "started"). */
  function absorbSubagentResults() {
    if (!subagentResultQueue.length) return false;
    let batch = subagentResultQueue.splice(0);
    for (let r of batch) {
      pendingSubagents.delete(r.id);
      let body = typeof r.output === 'string' ? r.output : JSON.stringify(r.output, null, 2);
      let userMsg = {
        type: 'message',
        role: 'user',
        content: [`[subagent ${r.name} finished]\n${body}`],
        subagentResult: true,
      };
      logs.push(userMsg);
      msgs.push(...arrayify(provider.fmt(userMsg)));
      toolResults.push({ name: 'spawn_agent', args: { name: r.name }, output: r.output });
    }
    return true;
  }

  /** Before leaving the loop: wait for every background subagent, absorb, and continue once. */
  async function settleAllSubagents() {
    let absorbed = absorbSubagentResults();
    if (!pendingSubagents.size) return absorbed;
    // Don't hang forever if the parent was aborted while a sub is still running.
    if (signal?.aborted) {
      checkAbort();
      return absorbed;
    }
    let settled = Promise.allSettled([...pendingSubagents.values()].map(p => p.promise));
    if (!signal) {
      await settled;
    } else {
      await Promise.race([
        settled,
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            try { checkAbort(); } catch (err) { reject(err); return; }
            reject(new Error('aborted'));
          }, { once: true });
        }),
      ]);
    }
    return absorbSubagentResults() || absorbed;
  }


  function cloneLogsForProbe() {
    return logs
      .filter(m => m && m.type !== 'ignored')
      .map(m => {
        try {
          return typeof structuredClone === 'function'
            ? structuredClone(m)
            : JSON.parse(JSON.stringify(m));
        } catch {
          return m;
        }
      });
  }

  async function probeWorkRemaining() {
    checkAbort();
    opts.beforeAmbiguousProbe?.();
    opts.beginIteration?.();

    let sideLogs = cloneLogsForProbe();
    sideLogs.push({
      type: 'message',
      role: 'user',
      content: [COMPLETION_PROBE],
      harnessProbe: true,
    });

    let sideMsgs = sideLogs.flatMap(m => {
      try { return arrayify(provider.fmt(m)); }
      catch { return []; }
    }).filter(Boolean);

    let sideResolved = {
      ...resolvedOpts,
      stream: false,
      call: 'none',
      tools: {},
    };
    let payload = provider.buildPayload(sideMsgs, opts.preamble, sideResolved);
    payload.stream = false;
    if ('tools' in payload) delete payload.tools;
    if ('tool_choice' in payload) payload.tool_choice = 'none';
    if ('parallel_tool_calls' in payload) delete payload.parallel_tool_calls;

    let headers = provider.buildHeaders(sideResolved);
    let res = await fetch(opts.endpoint || provider.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok) {
      try { await res.text(); } catch {}
      return false;
    }

    let ctHdr = res.headers.get('content-type') || '';
    let textOut = '';
    if (ctHdr.includes('application/json') || !ctHdr.includes('text/event-stream')) {
      let data = await res.json();
      if (data.output) {
        for (let item of data.output) {
          try {
            let internal = provider.defmt(item);
            if (internal.type === 'message') textOut += (internal.content || []).join('');
          } catch {}
        }
      } else if (data.choices?.[0]?.message) {
        let msg = data.choices[0].message;
        textOut = typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map(p => (typeof p === 'string' ? p : p?.text || '')).join('')
            : '';
      }
    } else if (res.body && provider.stream) {
      let chunks = [];
      await provider.stream(res.body, {
        text: (kind, chunk) => { if (kind === 'delta' && chunk) chunks.push(chunk); },
      });
      textOut = chunks.join('');
    }

    return parseYesNo(textOut) === true;
  }

  async function afterPlainAssistantStop(sampleMeta = {}) {
    if (await absorbInjects() || absorbSubagentResults()) return 'continue';
    if (await settleAllSubagents()) {
      opts.checkpoint?.(logs);
      return 'continue';
    }

    if (!isAmbiguousPlainStop(sampleMeta)) return 'stop';
    if (opts.ambiguousContinue === false) return 'stop';
    if (ambiguousContinues >= MAX_AMBIGUOUS_CONTINUES) return 'stop';

    let workLeft = false;
    try {
      workLeft = await probeWorkRemaining();
    } catch (e) {
      if (signal?.aborted) throw e;
      workLeft = false;
    }
    if (checkAbort()) return 'stop';
    if (!workLeft) return 'stop';

    ambiguousContinues++;
    let userMsg = {
      type: 'message',
      role: 'user',
      content: [HARNESS_CONTINUE_PROMPT],
      harnessContinue: true,
    };
    logs.push(userMsg);
    msgs.push(...arrayify(provider.fmt(userMsg)));
    opts.checkpoint?.(logs);
    return 'continue';
  }

  while (true) {
    if (checkAbort()) return [logs, ...toolResults];

    opts.beginIteration?.();
    await absorbInjects();
    absorbSubagentResults();

    let useStream = (opts.stream ?? true) && provider.supportsStreamingWithTools !== false;
    let payload = provider.buildPayload(msgs, opts.preamble, { ...resolvedOpts, stream: useStream });
    let headers = provider.buildHeaders(resolvedOpts);

    let res = await sendRequest(
      provider,
      opts.endpoint || provider.endpoint,
      { method: 'POST', headers, body: JSON.stringify(payload) },
      {
        signal,
        report: typeof resolvedOpts.report === 'function' ? resolvedOpts.report : () => {},
        maxRetries: opts.maxRetries ?? 4,
      },
    );

    // ── Streaming path ─────────────────────────────────────────
    if (useStream && !res.headers.get('content-type')?.startsWith?.('application/json')) {
      if (!res.body) throw new Error('Missing streaming body');

      let assembled = [];
      let pendingCalls = [];
      let toolsInvoked = false;

      let streamMeta = await provider.stream(res.body, {
        text: (kind, chunk) => {
          // Live deltas only — final vs preamble decided after tools/end_turn are known.
          if (kind === 'delta') {
            assembled.push(chunk);
            opts.text?.('delta', chunk);
          }
        },
        reasoning: (kind, chunk) => {
          if (kind === 'done') {
            let msg = { type: 'reasoning', summary: [{ type: 'summary_text', text: chunk }] };
            logs.push(msg);
            msgs.push(...arrayify(provider.fmt(msg)));
          }
          opts.reasoning?.callback?.(kind, chunk);
        },
        tool: async (_, wireCall) => {
          toolsInvoked = true;
          let internal;
          try { internal = provider.defmt(wireCall); }
          catch (e) {
            pendingCalls.push({
              wire: wireCall,
              call: {
                name: wireCall.name,
                call: wireCall.call_id,
                args: (() => { try { return JSON.parse(wireCall.arguments || '{}'); } catch { return {}; } })(),
              },
            });
            logs.push({ type: 'tool_call', calls: [pendingCalls.at(-1).call] });
            msgs.push(wireCall);
            return;
          }
          if (internal.type === 'ignored' || !internal.calls?.[0]) return;
          logs.push(internal);
          msgs.push(wireCall);
          pendingCalls.push({ wire: wireCall, call: internal.calls[0] });
        },
      }) || {};

      // Execute all tool calls in parallel (spawn_agent starts concurrently, returns "started").
      if (pendingCalls.length) {
        let rawCalls = pendingCalls.map(p => p.call);
        let outputs = await runTools(rawCalls, toolset, resolvedOpts);
        for (let [i, { call }] of pendingCalls.entries()) {
          let output = outputs[i] ?? 'OK';
          toolResults.push({ name: call.name, args: call.args, output });
          let resultMsg = { type: 'tool_call_result', call: call.call, output };
          logs.push(resultMsg);
          msgs.push(...arrayify(provider.fmt(resultMsg)));
        }
        opts.checkpoint?.(logs);
        await opts.flushReports?.();
      }

      accumulateUsage(opts, streamMeta.usage);

      let text = assembled.join('') || streamMeta.assistantTextFallback || '';
      let needsFollowUp = sampleNeedsFollowUp({
        toolsInvoked: toolsInvoked || !!streamMeta.hadToolEvents || (pendingCalls.length > 0),
        endTurn: streamMeta.endTurn,
        phases: streamMeta.phases,
        stopReason: streamMeta.stopReason,
        finishReason: streamMeta.finishReason,
        status: streamMeta.status,
      });

      if (text) {
        let assistantMsg = { type: 'message', role: 'assistant', content: [text] };
        let phase = [...(streamMeta.phases || [])].reverse().find(Boolean);
        if (phase) assistantMsg.phase = phase;
        logs.push(assistantMsg);
        msgs.push(...arrayify(provider.fmt(assistantMsg)));
        if (needsFollowUp) {
          opts.text?.('preamble', text);
          opts.narration?.(text);
        } else {
          opts.text?.('final', text);
          opts.checkpoint?.(logs);
        }
      } else {
        opts.checkpoint?.(logs);
      }

      // Rollover only after this sample (tools + assistant text) is fully committed.
      if (await contextCheck(pendingCalls.length ? 'after_tools' : 'after_sample')) {
        continue;
      }

      if (await absorbInjects() || absorbSubagentResults()) continue;
      if (needsFollowUp) {
        await contextCheck('before_follow_up');
        continue;
      }
      await contextCheck('before_ambiguous_probe');
      {
        let decision = await afterPlainAssistantStop({
          toolsInvoked: !!(toolsInvoked || streamMeta.hadToolEvents || pendingCalls.length),
          endTurn: streamMeta.endTurn,
          phases: streamMeta.phases,
          stopReason: streamMeta.stopReason,
          finishReason: streamMeta.finishReason,
          hadAssistantText: !!text,
        });
        if (decision === 'continue') continue;
      }
      return [logs, ...toolResults];
    }

    // ── Non-streaming path ─────────────────────────────────────
    let data = await res.json();
    let report = typeof resolvedOpts.report === 'function' ? resolvedOpts.report : () => {};
    if (data?.status === 'failed' && data.error && provider.streamError) {
      let err = provider.streamError({ type: 'response.failed', response: data });
      report(err.short);
      throw err;
    }
    if (!data.output && !data.choices) { report('Invalid response'); throw new Error('Invalid response'); }

    accumulateUsage(opts, usageFromResponseData(data));

    // Responses API (oai / xai)
    if (data.output) {
      let allCalls = [];
      let assistantText = null;

      for (let item of data.output) {
        if (checkAbort()) return [logs, ...toolResults];
        let internal;
        try { internal = provider.defmt(item); }
        catch (e) { report(`defmt skip: ${e.message}`); continue; }

        if (internal.type === 'ignored') continue;

        if (internal.type === 'reasoning') {
          internal.summary?.filter?.(s => s.type === 'summary_text').forEach(s => opts.reasoning?.callback?.('done', s.text));
          delete internal.id;
          logs.push(internal);
          msgs.push(...arrayify(provider.fmt(internal)));
          continue;
        }
        if (internal.type === 'tool_call') {
          logs.push(internal);
          msgs.push(...arrayify(provider.fmt(internal)));
          allCalls.push(...internal.calls);
          continue;
        }
        if (internal.type === 'message') {
          logs.push(internal);
          msgs.push(...arrayify(provider.fmt(internal)));
          assistantText = (internal.content || []).join('');
          // Defer preamble/final until tools + end_turn/phases are known.
          continue;
        }
      }

      if (allCalls.length) {
        let outputs = await runTools(allCalls, toolset, resolvedOpts);
        for (let [i, call] of allCalls.entries()) {
          let output = outputs[i] ?? 'OK';
          toolResults.push({ name: call.name, args: call.args, output });
          let resultMsg = { type: 'tool_call_result', call: call.call, output };
          logs.push(resultMsg);
          msgs.push(...arrayify(provider.fmt(resultMsg)));
        }
        opts.checkpoint?.(logs);
        await opts.flushReports?.();
        if (assistantText) {
          opts.text?.('preamble', assistantText);
          opts.narration?.(assistantText);
        }
        // Tools always need a follow-up sample (Codex needs_follow_up).
        if (await contextCheck('after_tools')) continue;
        if (await absorbInjects() || absorbSubagentResults()) continue;
        continue;
      }

      opts.checkpoint?.(logs);
      let phases = [];
      for (let item of data.output) {
        if ((item.type === 'message' || !item.type) && item.role === 'assistant' && item.phase) {
          phases.push(item.phase);
        }
      }
      let endTurn = data.end_turn;
      if (endTurn === undefined && data.response && 'end_turn' in data.response) endTurn = data.response.end_turn;
      let stopReason = data.stop_reason ?? data.stopReason;
      let finishReason = data.finish_reason ?? data.finishReason;
      let status = data.status;
      // Grok: tool-looking items already handled above; also treat explicit tool stop reasons.
      let needsFollowUp = sampleNeedsFollowUp({
        toolsInvoked: false,
        endTurn,
        phases,
        stopReason,
        finishReason,
        status,
      });
      if (assistantText) {
        if (needsFollowUp) {
          opts.text?.('preamble', assistantText);
          opts.narration?.(assistantText);
        } else {
          opts.text?.('final', assistantText);
        }
      }
      // Commit checkpoint then maybe seal window with full sample present.
      opts.checkpoint?.(logs);
      if (await contextCheck(needsFollowUp ? 'before_follow_up' : 'after_sample')) continue;
      if (await absorbInjects() || absorbSubagentResults()) continue;
      if (needsFollowUp) continue;
      await contextCheck('before_ambiguous_probe');
      {
        let decision = await afterPlainAssistantStop({
          toolsInvoked: false,
          endTurn,
          phases,
          stopReason,
          finishReason,
          hadAssistantText: !!assistantText,
        });
        if (decision === 'continue') continue;
      }
      let last = logs.at(-1);
      if (last?.type === 'message' && last.role === 'assistant') {
        return [logs, ...toolResults];
      }
      continue;
    }

    // Chat Completions (oail)
    if (data.choices) {
      accumulateUsage(opts, usageFromResponseData(data));
      let msg = data.choices?.[0]?.message;
      if (!msg) { report('Invalid response'); throw new Error('Invalid response'); }
      if (msg.role === 'assistant' && !msg.content?.trim()) { report('LLM got lazy, retrying...'); continue; }

      let internal = provider.defmt(msg);
      logs.push(internal);
      msgs.push(...arrayify(provider.fmt(internal)));

      if (internal.type === 'tool_call') {
        let outputs = await runTools(internal.calls, toolset, resolvedOpts);
        for (let [i, call] of internal.calls.entries()) {
          let output = outputs[i] ?? 'OK';
          toolResults.push({ name: call.name, args: call.args, output });
          let result = { type: 'tool_call_result', call: call.call, output };
          logs.push(result);
          msgs.push(...arrayify(provider.fmt(result)));
        }
        opts.checkpoint?.(logs);
        await opts.flushReports?.();
        if (await contextCheck('after_tools')) continue;
        continue;
      }

      opts.checkpoint?.(logs);
      let phases = msg.phase ? [msg.phase] : [];
      let endTurn = msg.end_turn;
      if (endTurn === undefined && data.end_turn !== undefined) endTurn = data.end_turn;
      let finishReason = data.choices?.[0]?.finish_reason ?? msg.finish_reason ?? data.finish_reason;
      let stopReason = msg.stop_reason ?? data.stop_reason;
      // finish_reason "stop" is terminal; tool_calls continues (also handled via internal.type).
      let needsFollowUp = sampleNeedsFollowUp({
        toolsInvoked: false,
        endTurn,
        phases,
        stopReason,
        finishReason,
        status: data.status,
      });
      if (await contextCheck(needsFollowUp ? 'before_follow_up' : 'after_sample')) continue;
      if (await absorbInjects() || absorbSubagentResults()) continue;
      if (needsFollowUp) continue;
      await contextCheck('before_ambiguous_probe');
      {
        let assistantText = internal.type === 'message'
          ? (internal.content || []).join('')
          : '';
        let decision = await afterPlainAssistantStop({
          toolsInvoked: false,
          endTurn,
          phases,
          stopReason,
          finishReason,
          hadAssistantText: !!assistantText,
        });
        if (decision === 'continue') continue;
      }
      return [logs, ...toolResults];
    }
  }
}

/**
 * Provider-neutral chat client: OpenAI-compatible, Anthropic Messages, Gemini, Chrome's
 * built-in model, and the on-device model. Streams where the platform allows.
 *
 * HTTP goes through fetch (streaming). In the Android, iOS and desktop apps, a provider known to block
 * browser CORS goes straight to native HTTP (no streaming). A provider whose CORS support is unknown
 * falls back to native HTTP only when fetch failed before any response arrived (the way a CORS refusal
 * fails), and is then sent natively for the rest of the session; a request that got a response is
 * never sent again. Every request gives up after AI_TIMEOUT_MS (streams: of silence).
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { desktopHttp } from '../platform/native';
import { aiSettings, resolveProvider, recordUsage, type ResolvedProvider } from './store';
import { providerById, type ProviderDef } from './providers';
import { AiError, AI_TIMEOUT_MS } from './errors';
import { planEnsemble, runEnsemble, type EnsembleInfo, type EnsemblePlan } from './ensemble';

export type ContentPart = { type: 'text'; text: string } | { type: 'image'; dataUrl: string };
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] }

export interface ChatRequest {
  messages: ChatMessage[];
  /** 'fast' uses the provider's fast model. */
  tier?: 'fast' | 'quality';
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onToken?: (delta: string, full: string) => void;
  /** Use a specific provider instead of the active one (never uses several AIs). */
  provider?: string;
  /** Progress lines while several AIs work on the request ("Asking 3 AIs…", "Round 2 of 3: 1 objection"). */
  onStatus?: (text: string) => void;
}

/** `truncated`: the answer stopped early (length limit, content filter), so it is not the whole text asked for. */
export interface ChatResult {
  text: string; model: string; provider: string; providerName: string; usage?: { in: number; out: number }; truncated?: boolean;
  /** Set when several AIs answered: each member's answer, the rounds and the outcome. model/provider then name the master or clerk. */
  ensemble?: EnsembleInfo;
}

/** Finish reasons (OpenAI, Anthropic, Gemini) meaning the model did not end the answer itself. */
const CUT = new Set(['length', 'content_filter', 'max_tokens', 'refusal', 'model_context_window_exceeded', 'MAX_TOKENS', 'SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'LANGUAGE']);
const cutShort = (reason: unknown) => typeof reason === 'string' && CUT.has(reason);

export { AiError };

/** Native HTTP (no CORS) exists: the Android or iOS app, or the desktop app. */
const isNativeApp = () => Capacitor.isNativePlatform() || !!desktopHttp;

// ------------------------------------------------------------------------------------------
// HTTP

interface HttpReq { url: string; method?: 'GET' | 'POST'; headers: Record<string, string>; body?: unknown; signal?: AbortSignal }
interface HttpRes { status: number; text: string }

/** Providers whose browser requests failed the way CORS refusals do: sent through native HTTP from then on (this session). */
const nativeNeeded = new Set<string>();

/**
 * Whether a failed fetch may be repeated through native HTTP: only in the apps, only for providers that
 * may block CORS, and only for a TypeError from fetch itself (no response arrived, so the server did
 * not answer the request). The desktop bridge only makes https requests.
 */
function mayRetryNative(def: ProviderDef, e: unknown, url: string): boolean {
  if (!isNativeApp() || !(e instanceof TypeError)) return false;
  if (def.cors !== 'no' && def.cors !== 'unknown' && def.cors !== 'local') return false;
  return !(desktopHttp && /^http:\/\//i.test(url));
}

/** The caller's signal plus a timeout; `poke()` restarts the timeout (a stream that is still sending). */
function timed(signal: AbortSignal | undefined, ms = AI_TIMEOUT_MS) {
  const ctl = new AbortController();
  let timedOut = false;
  const fire = () => { timedOut = true; ctl.abort(); };
  let timer = setTimeout(fire, ms);
  const onAbort = () => ctl.abort();
  if (signal?.aborted) ctl.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctl.signal,
    get timedOut() { return timedOut; },
    poke() { clearTimeout(timer); timer = setTimeout(fire, ms); },
    done() { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); },
  };
}

const stoppedError = () => new AiError('Stopped', 'aborted');
const timeoutError = (def: ProviderDef, ms = AI_TIMEOUT_MS) => new AiError(`${def.name} did not answer within ${Math.round(ms / 1000)} seconds.`, 'network');

/** Native requests cannot be canceled: Stop stops waiting for them, and the late answer is dropped. */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new AiError('Stopped', 'aborted'));
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new AiError('Stopped', 'aborted'));
    signal.addEventListener('abort', stop, { once: true });
    p.then((v) => { signal.removeEventListener('abort', stop); resolve(v); }, (e) => { signal.removeEventListener('abort', stop); reject(e); });
  });
}

async function viaNative(def: ProviderDef, r: HttpReq): Promise<HttpRes> {
  if (r.signal?.aborted) throw new AiError('Stopped', 'aborted');
  const req = desktopHttp
    ? desktopHttp({ url: r.url, method: r.method || 'GET', headers: r.headers, data: r.body, timeoutMs: AI_TIMEOUT_MS }, r.signal)
    : CapacitorHttp.request({ url: r.url, method: r.method || 'GET', headers: r.headers, data: r.body, responseType: 'text', connectTimeout: 30000, readTimeout: 180000 })
      .then((res) => ({ status: res.status, text: typeof res.data === 'string' ? res.data : JSON.stringify(res.data) }));
  try {
    return await abortable(req, r.signal);
  } catch (e) {
    if (e instanceof AiError) throw e;
    throw networkError(def, e, r.url, true);
  }
}

/** Plain request. In the apps, falls back to native HTTP when the browser layer refused before any response (see mayRetryNative). */
async function http(def: ProviderDef, r: HttpReq): Promise<HttpRes> {
  if (isNativeApp() && (def.cors === 'no' || nativeNeeded.has(def.id))) return viaNative(def, r);
  const t = timed(r.signal);
  let res: Response;
  try {
    res = await fetch(r.url, { method: r.method || 'GET', headers: r.headers, body: r.body == null ? undefined : JSON.stringify(r.body), signal: t.signal });
  } catch (e: any) {
    t.done();
    if (e?.name === 'AbortError') throw t.timedOut ? timeoutError(def) : stoppedError();
    if (mayRetryNative(def, e, r.url)) { nativeNeeded.add(def.id); return viaNative(def, r); }
    throw networkError(def, e, r.url);
  }
  // A response has started: whatever happens now, the request is not sent again.
  try {
    return { status: res.status, text: await res.text() };
  } catch (e: any) {
    if (e?.name === 'AbortError') throw t.timedOut ? timeoutError(def) : stoppedError();
    throw networkError(def, e, r.url);
  } finally {
    t.done();
  }
}

function networkError(def: ProviderDef, e: unknown, url = def.baseUrl, native = false): AiError {
  const why = String((e as Error)?.message || e);
  if (def.cors === 'no' && !native) return new AiError(`${def.name} cannot be called from a web browser (it does not allow cross-origin requests). Use the Android, iOS or desktop app, or another provider.`, 'cors');
  // The apps and https pages can use plain http only for a server on this device (Android
  // cleartext policy, mixed content, the desktop content policy).
  const httpPage = typeof location !== 'undefined' && location.protocol === 'http:';
  if (/^http:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2|\[::1\])([:/]|$)/i.test(url) && !httpPage) {
    return new AiError(`Could not reach ${url}: Anne\'s Stage can use plain http:// only for a server on this device (localhost). Serve the other computer's AI server over https instead. (${why})`, 'network');
  }
  if (def.kind === 'openai' && /localhost|127\.0\.0\.1|192\.168\.|10\./.test(url)) {
    return new AiError(`Could not reach the local server. Is it running, and is cross-origin access enabled? (${why})`, 'network');
  }
  return new AiError(`Could not reach ${def.name}: ${why}. Check the connection.`, 'network');
}

/** Splits complete server-sent-event blocks off the buffer. Events end with a blank line; servers mix \n and \r\n, so the separator is 2 to 4 characters. */
export function takeSseBlocks(buf: string): [string[], string] {
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = /\r?\n\r?\n/.exec(buf))) {
    blocks.push(buf.slice(0, m.index));
    buf = buf.slice(m.index + m[0].length);
  }
  return [blocks, buf];
}

/** Streaming SSE request; returns null if streaming is unavailable here (caller retries without). */
async function sse(def: ProviderDef, r: HttpReq, onEvent: (data: string, event: string) => void): Promise<{ status: number; text: string } | null> {
  if (isNativeApp() && (def.cors === 'no' || nativeNeeded.has(def.id))) return null;
  const t = timed(r.signal);
  let res: Response;
  try {
    res = await fetch(r.url, { method: 'POST', headers: r.headers, body: JSON.stringify(r.body), signal: t.signal });
  } catch (e: any) {
    t.done();
    if (e?.name === 'AbortError') throw t.timedOut ? timeoutError(def) : stoppedError();
    // Refused before any response: the caller sends it again without streaming, through native HTTP.
    if (mayRetryNative(def, e, r.url)) { nativeNeeded.add(def.id); return null; }
    throw networkError(def, e, r.url);
  }
  try {
    return await readSse(res, t, onEvent);
  } catch (e: any) {
    if (e?.name === 'AbortError') throw t.timedOut ? timeoutError(def) : stoppedError();
    if (e instanceof AiError) throw e;
    throw networkError(def, e, r.url);
  } finally {
    t.done();
  }
}

async function readSse(res: Response, t: ReturnType<typeof timed>, onEvent: (data: string, event: string) => void): Promise<{ status: number; text: string }> {
  if (!res.ok || !res.body) return { status: res.status, text: await res.text() };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const dispatch = (block: string) => {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length) onEvent(data.join('\n'), event);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      t.poke();
      buf += dec.decode(value, { stream: true });
      const [blocks, rest] = takeSseBlocks(buf);
      buf = rest;
      blocks.forEach(dispatch);
    }
    buf += dec.decode();
    if (buf.trim()) dispatch(buf);
  } catch (e: any) {
    void reader.cancel().catch(() => undefined);
    throw e;
  }
  return { status: 200, text: '' };
}

function httpError(def: ProviderDef, status: number, body: string, model: string): AiError {
  let msg = body;
  try {
    const j = JSON.parse(body);
    msg = j?.error?.message || j?.message || j?.error?.code || j?.detail || (typeof j?.error === 'string' ? j.error : '') || body;
  } catch { /* not JSON */ }
  msg = String(msg).slice(0, 400);
  if (status === 401 || status === 403) return new AiError(`${def.name} rejected the API key (${status}). ${msg}`, 'auth', status);
  if (status === 402 || status === 429) return new AiError(`${def.name}: quota or rate limit reached (${status}). ${msg}`, 'quota', status);
  if (status === 404 || /model.*(not found|does not exist|unknown|invalid)/i.test(msg)) return new AiError(`${def.name} does not offer the model "${model}". Choose another in AI ▸ Providers & Models. (${msg})`, 'model', status);
  return new AiError(`${def.name} error ${status}: ${msg}`, 'other', status);
}

// ------------------------------------------------------------------------------------------
// Adapters

const textOf = (c: ChatMessage['content']) => (typeof c === 'string' ? c : c.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n'));
const splitDataUrl = (u: string) => { const m = /^data:([^;,]+);base64,(.*)$/.exec(u); return m ? { mime: m[1], data: m[2] } : null; };

async function openaiChat(rp: ResolvedProvider, model: string, req: ChatRequest): Promise<ChatResult> {
  const { def, key, baseUrl } = rp;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(def.extraHeaders || {}) };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (def.id === 'azure' && key) headers['api-key'] = key;
  const messages = req.messages.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: p.dataUrl } })),
  }));
  const params: Record<string, unknown> = { model, messages };
  if (req.temperature != null) params.temperature = req.temperature;
  if (req.maxTokens) params[def.completionTokens ? 'max_completion_tokens' : 'max_tokens'] = req.maxTokens;
  const url = `${baseUrl}/chat/completions`;
  // Token usage in a stream: only the official OpenAI API is known to accept stream_options (some compatible servers reject unknown fields).
  let streamUsage = def.id === 'openai' && /^https:\/\/api\.openai\.com\//i.test(url);

  for (let attempt = 0; attempt < 4; attempt++) {
    let full = '';
    let finish: unknown = null;
    let usage: { in: number; out: number } | undefined;
    if (req.onToken) {
      const r = await sse(def, { url, headers, body: { ...params, stream: true, ...(streamUsage ? { stream_options: { include_usage: true } } : {}) }, signal: req.signal }, (data) => {
        if (data === '[DONE]') return;
        let j: any;
        try { j = JSON.parse(data); } catch { return; /* keep-alive or partial */ }
        // Gateways (OpenRouter...) report failures inside a 200 stream.
        if (j?.error) throw new AiError(`${def.name}: ${j.error.message || j.error.code || 'the answer failed'}`);
        const c = j?.choices?.[0];
        const d = c?.delta?.content;
        if (typeof d === 'string' && d) { full += d; req.onToken!(d, full); }
        if (c?.finish_reason) finish = c.finish_reason;
        if (j?.usage) usage = { in: j.usage.prompt_tokens || 0, out: j.usage.completion_tokens || 0 };
      });
      if (r && r.status === 200) return { text: full, model, provider: def.id, providerName: def.name, usage, truncated: cutShort(finish) };
      if (r) {
        if (streamUsage && r.status === 400 && /stream_options|include_usage/i.test(r.text)) { streamUsage = false; continue; }
        const retry = adjustParams(params, r.text);
        if (retry) continue;
        throw httpError(def, r.status, r.text, model);
      }
    }
    const r = await http(def, { url, method: 'POST', headers, body: { ...params, stream: false }, signal: req.signal });
    if (r.status >= 200 && r.status < 300) {
      const j = JSON.parse(r.text);
      if (j.error && !j.choices) throw new AiError(`${def.name}: ${j.error.message || j.error.code || 'the answer failed'}`);
      const msg = j.choices?.[0]?.message;
      const text = typeof msg?.content === 'string' ? msg.content : Array.isArray(msg?.content) ? msg.content.map((p: any) => p.text || '').join('') : '';
      if (j.usage) usage = { in: j.usage.prompt_tokens || 0, out: j.usage.completion_tokens || 0 };
      req.onToken?.(text, text);
      return { text, model, provider: def.id, providerName: def.name, usage, truncated: cutShort(j.choices?.[0]?.finish_reason) };
    }
    if (adjustParams(params, r.text)) continue;
    throw httpError(def, r.status, r.text, model);
  }
  throw new AiError(`${def.name} rejected the request parameters.`, 'other');
}

/** Retry once without parameters a model refuses (temperature, max_tokens naming). */
function adjustParams(params: Record<string, unknown>, body: string): boolean {
  if (/temperature/i.test(body) && 'temperature' in params) { delete params.temperature; return true; }
  if (/max_tokens/i.test(body) && 'max_tokens' in params) { params.max_completion_tokens = params.max_tokens; delete params.max_tokens; return true; }
  if (/max_completion_tokens/i.test(body) && 'max_completion_tokens' in params) { params.max_tokens = params.max_completion_tokens; delete params.max_completion_tokens; return true; }
  return false;
}

async function anthropicChat(rp: ResolvedProvider, model: string, req: ChatRequest): Promise<ChatResult> {
  const { def, key, baseUrl } = rp;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true',
  };
  const system = req.messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n\n');
  const messages = req.messages.filter((m) => m.role !== 'system').map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content.map((p) => {
      if (p.type === 'text') return { type: 'text', text: p.text };
      const d = splitDataUrl(p.dataUrl);
      return d ? { type: 'image', source: { type: 'base64', media_type: d.mime, data: d.data } } : { type: 'text', text: '[image]' };
    }),
  }));
  const body: Record<string, unknown> = { model, max_tokens: req.maxTokens || 4096, messages };
  if (system) body.system = system;
  if (req.temperature != null) body.temperature = req.temperature;
  const url = `${baseUrl}/messages`;
  let full = '';
  let stop: unknown = null;
  let usage = { in: 0, out: 0 };
  if (req.onToken) {
    const r = await sse(def, { url, headers, body: { ...body, stream: true }, signal: req.signal }, (data) => {
      try {
        const j = JSON.parse(data);
        if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') { full += j.delta.text; req.onToken!(j.delta.text, full); }
        if (j.type === 'message_start' && j.message?.usage) usage.in = j.message.usage.input_tokens || 0;
        if (j.type === 'message_delta' && j.usage) usage.out = j.usage.output_tokens || 0;
        if (j.type === 'message_delta' && j.delta?.stop_reason) stop = j.delta.stop_reason;
        if (j.type === 'error') throw new AiError(`${def.name}: ${j.error?.message || 'stream error'}`);
      } catch (e) { if (e instanceof AiError) throw e; }
    });
    if (r && r.status === 200) return { text: full, model, provider: def.id, providerName: def.name, usage, truncated: cutShort(stop) };
    if (r) throw httpError(def, r.status, r.text, model);
  }
  const r = await http(def, { url, method: 'POST', headers, body, signal: req.signal });
  if (r.status < 200 || r.status >= 300) throw httpError(def, r.status, r.text, model);
  const j = JSON.parse(r.text);
  const text = (j.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
  req.onToken?.(text, text);
  return { text, model, provider: def.id, providerName: def.name, usage: { in: j.usage?.input_tokens || 0, out: j.usage?.output_tokens || 0 }, truncated: cutShort(j.stop_reason) };
}

async function geminiChat(rp: ResolvedProvider, model: string, req: ChatRequest): Promise<ChatResult> {
  const { def, key, baseUrl } = rp;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-goog-api-key': key };
  const system = req.messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n\n');
  const contents = req.messages.filter((m) => m.role !== 'system').map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: typeof m.content === 'string' ? [{ text: m.content }] : m.content.map((p) => {
      if (p.type === 'text') return { text: p.text };
      const d = splitDataUrl(p.dataUrl);
      return d ? { inline_data: { mime_type: d.mime, data: d.data } } : { text: '[image]' };
    }),
  }));
  const body: Record<string, unknown> = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const gen: Record<string, unknown> = {};
  if (req.temperature != null) gen.temperature = req.temperature;
  if (req.maxTokens) gen.maxOutputTokens = req.maxTokens;
  if (Object.keys(gen).length) body.generationConfig = gen;
  const m = encodeURIComponent(model.replace(/^models\//, ''));
  let full = '';
  let finish: unknown = null;
  let usage: { in: number; out: number } | undefined;
  const take = (j: any) => {
    if (j?.error) throw new AiError(`${def.name}: ${j.error.message || 'the answer failed'}`);
    if (j?.promptFeedback?.blockReason) throw new AiError(`${def.name} blocked the request (${j.promptFeedback.blockReason}).`);
    const c = j?.candidates?.[0];
    const parts = c?.content?.parts || [];
    const t = parts.filter((p: any) => !p.thought).map((p: any) => p.text || '').join('');
    if (c?.finishReason) finish = c.finishReason;
    if (j?.usageMetadata) usage = { in: j.usageMetadata.promptTokenCount || 0, out: j.usageMetadata.candidatesTokenCount || 0 };
    return t;
  };
  if (req.onToken) {
    const r = await sse(def, { url: `${baseUrl}/models/${m}:streamGenerateContent?alt=sse`, headers, body, signal: req.signal }, (data) => {
      let j: any;
      try { j = JSON.parse(data); } catch { return; /* partial */ }
      const t = take(j);
      if (t) { full += t; req.onToken!(t, full); }
    });
    if (r && r.status === 200) return { text: full, model, provider: def.id, providerName: def.name, usage, truncated: cutShort(finish) };
    if (r) throw httpError(def, r.status, r.text, model);
  }
  const r = await http(def, { url: `${baseUrl}/models/${m}:generateContent`, method: 'POST', headers, body, signal: req.signal });
  if (r.status < 200 || r.status >= 300) throw httpError(def, r.status, r.text, model);
  const text = take(JSON.parse(r.text));
  req.onToken?.(text, text);
  return { text, model, provider: def.id, providerName: def.name, usage, truncated: cutShort(finish) };
}

async function builtinChat(model: string, req: ChatRequest): Promise<ChatResult> {
  const LM = (globalThis as any).LanguageModel;
  if (!LM) throw new AiError('This browser has no built-in AI model. It is available in desktop Chrome 148 or later on supported hardware; use another provider here.', 'unsupported');
  const avail = await LM.availability?.();
  if (avail === 'unavailable') throw new AiError('The browser reports its built-in model is unavailable on this device.', 'unsupported');
  const system = req.messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n\n');
  const turns = req.messages.filter((m) => m.role !== 'system');
  const last = turns.pop();
  const session = await LM.create({
    initialPrompts: [...(system ? [{ role: 'system', content: system }] : []), ...turns.map((t) => ({ role: t.role, content: textOf(t.content) }))],
    signal: req.signal,
  });
  try {
    const prompt = textOf(last?.content || '');
    if (req.onToken && session.promptStreaming) {
      let full = '';
      for await (const chunk of session.promptStreaming(prompt, { signal: req.signal })) {
        const c = String(chunk);
        // Older implementations stream the whole text so far; newer ones stream deltas.
        const delta = c.startsWith(full) ? c.slice(full.length) : c;
        full = c.startsWith(full) ? c : full + c;
        if (delta) req.onToken(delta, full);
      }
      return { text: full, model, provider: 'builtin', providerName: 'Built-in browser AI' };
    }
    const text = String(await session.prompt(prompt, { signal: req.signal }));
    req.onToken?.(text, text);
    return { text, model, provider: 'builtin', providerName: 'Built-in browser AI' };
  } finally {
    session.destroy?.();
  }
}

// ------------------------------------------------------------------------------------------
// Public API

/** The ensemble plan for normal commands (no provider named), or null for a single AI. */
export function activeEnsemble(req: Pick<ChatRequest, 'provider'> = {}): EnsemblePlan | null {
  const s = aiSettings();
  return planEnsemble(req, s.ensemble, (id) => {
    const def = providerById(id);
    const cfg = s.providers[id];
    return def && cfg ? { model: cfg.model || def.models.quality, sequential: def.kind === 'local' } : null;
  });
}

/**
 * Sends a request. Normal commands go to the active provider, or to several AIs when AI Settings ▸
 * "Use several AIs" is on; a request that names a provider (key tests, "Try it") always goes to
 * that provider alone.
 */
export async function chat(req: ChatRequest): Promise<ChatResult> {
  const plan = activeEnsemble(req);
  if (plan) {
    return runEnsemble(req, plan, (provider, model, r) => chatOne({ ...r, provider, model }), { name: (id) => providerById(id)?.name || id });
  }
  return chatOne(req);
}

async function chatOne(req: ChatRequest): Promise<ChatResult> {
  const rp = await resolveProvider(req.provider);
  if (!rp) throw new AiError('No AI provider is set up yet.', 'no-provider');
  const { def, cfg } = rp;
  const model = req.model || (req.tier === 'fast' ? cfg.fastModel || cfg.model : cfg.model) || def.models.quality;
  if (def.needsKey && !rp.key && def.id !== 'custom') throw new AiError(`${def.name} has no API key. Open AI ▸ Set Up AI to add one.`, 'auth');
  let res: ChatResult;
  if (def.kind === 'anthropic') res = await anthropicChat(rp, model, req);
  else if (def.kind === 'gemini') res = await geminiChat(rp, model, req);
  else if (def.kind === 'builtin') res = await builtinChat(model, req);
  else if (def.kind === 'local') {
    const { localChat } = await import('./local');
    res = await localChat(model, req);
  } else res = await openaiChat(rp, model, req);
  recordUsage(res.usage?.in || 0, res.usage?.out || 0);
  // An answer that arrives after Stop (a request that could not be canceled) is dropped.
  if (req.signal?.aborted) throw new AiError('Stopped', 'aborted');
  return res;
}

/** List models (validates the key at the same time). */
export async function listModels(rp: ResolvedProvider, signal?: AbortSignal): Promise<string[]> {
  const { def, key, baseUrl } = rp;
  if (def.kind === 'local') { const { LOCAL_MODELS } = await import('./local'); return LOCAL_MODELS.map((m) => m.id); }
  if (def.kind === 'builtin') {
    const LM = (globalThis as any).LanguageModel;
    if (!LM) throw new AiError('This browser has no built-in AI model (desktop Chrome 148+ only).', 'unsupported');
    const a = await LM.availability();
    if (a === 'unavailable') throw new AiError('The built-in model is unavailable on this device.', 'unsupported');
    return ['default'];
  }
  let url: string;
  const headers: Record<string, string> = { ...(def.extraHeaders || {}) };
  if (def.kind === 'anthropic') {
    url = `${baseUrl}/models?limit=100`;
    Object.assign(headers, { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' });
  } else if (def.kind === 'gemini') {
    url = `${baseUrl}/models?pageSize=200`;
    headers['x-goog-api-key'] = key;
  } else {
    url = `${baseUrl}/models`;
    if (key) headers.Authorization = `Bearer ${key}`;
    if (def.id === 'azure' && key) headers['api-key'] = key;
  }
  const r = await http(def, { url, method: 'GET', headers, signal });
  if (r.status < 200 || r.status >= 300) throw httpError(def, r.status, r.text, '');
  let j: any;
  try { j = JSON.parse(r.text); } catch { throw new AiError(`${def.name} returned an unexpected response.`); }
  if (def.kind === 'gemini') {
    return (j.models || []).filter((m: any) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent')).map((m: any) => String(m.name).replace(/^models\//, ''));
  }
  const list = Array.isArray(j) ? j : j.data || j.models || [];
  const ids = list.map((m: any) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
  // OpenRouter: put free models first so the free path is obvious.
  if (def.id === 'openrouter') {
    const free = list.filter((m: any) => m.id?.endsWith(':free') || (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0)).map((m: any) => m.id);
    return [...new Set(['openrouter/free', ...free, 'openrouter/auto', ...ids])];
  }
  return [...new Set(ids as string[])];
}

/** Pick sensible fast/quality models from a provider's list when the defaults are not offered. */
export function pickModels(def: ProviderDef, list: string[]): { fast: string; quality: string } {
  const has = (m: string) => list.includes(m);
  if (!list.length) return { fast: def.models.fast, quality: def.models.quality };
  const chatty = list.filter((m) => !/embed|whisper|tts|audio|image|vision-preview|moderation|rerank|guard|transcrib|dall-e|imagen|veo|search-preview/i.test(m));
  const pool = chatty.length ? chatty : list;
  const fast = has(def.models.fast) ? def.models.fast : pool.find((m) => /flash-lite|mini|luna|haiku|small|8b|20b|flash|lite|fast|instant/i.test(m)) || pool[0];
  const quality = has(def.models.quality) ? def.models.quality : pool.find((m) => /sonnet|sol|pro|large|medium|120b|70b|max|plus|flash-latest/i.test(m)) || fast;
  return { fast, quality };
}

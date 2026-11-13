/**
 * AI settings and API-key storage.
 *
 * Settings (which provider is active, models, options) live in localStorage. API keys never do:
 * on Android they are encrypted with a key held in the Android Keystore (QuillNative
 * secureSet/secureGet) and in the desktop app with the system keychain (safeStorage). When the
 * desktop has no keychain, the key is kept for this session only unless the user agrees to store
 * it unencrypted. In a browser keys go to IndexedDB under a separate key, so settings export,
 * drafts and documents never contain them; browser storage is not encrypted.
 */
import { kvGet, kvSet, kvDel } from '../util/store';
import { isNative, secureGet, secureSet, secureRemove } from '../platform/native';
import { providerById, type ProviderDef } from './providers';
import { defaultEnsemble, normalizeEnsemble, type EnsembleSettings } from './ensemble';

export interface ProviderConfig {
  id: string;
  /** Model for interactive commands. */
  model: string;
  /** Model for quick, cheap tasks (falls back to model). */
  fastModel?: string;
  baseUrl?: string;
  accountId?: string;
  resource?: string;
  region?: string;
  /** Last fetched model list. */
  models?: string[];
  verified?: number;
}

export interface SavedPrompt { id: string; name: string; prompt: string; input: 'selection' | 'document' | 'none'; output: 'replace' | 'insert' | 'pane' | 'comment' | 'newdoc' }

export interface AiSettings {
  enabled: boolean;
  active: string | null;
  providers: Record<string, ProviderConfig>;
  /** Insert AI edits as tracked changes by "AI (model)". */
  trackAsRevisions: boolean;
  /** Ask before sending the whole document to a cloud service. */
  confirmDocument: boolean;
  /** During setup, look for a copied key when returning to the app. */
  clipboardWatch: boolean;
  /** Remove a recognized key from the clipboard after saving it. */
  clearClipboard: boolean;
  /** Number of alternatives offered by Rewrite. */
  alternatives: number;
  /** Reply language for generated text: 'auto' follows the input. */
  language: string;
  styleGuide: string;
  voiceProfile: string;
  prompts: SavedPrompt[];
  usage: { requests: number; tokensIn: number; tokensOut: number; since: number };
  privacyAck: string[];
  /** Several AIs on one request (provider ids and models only; never keys). */
  ensemble: EnsembleSettings;
}

const KEY = 'quillstage.ai.v1';

export function defaultAiSettings(): AiSettings {
  return {
    enabled: true, active: null, providers: {}, trackAsRevisions: false, confirmDocument: true, clipboardWatch: true, clearClipboard: true,
    alternatives: 3, language: 'auto', styleGuide: '', voiceProfile: '', prompts: [],
    usage: { requests: 0, tokensIn: 0, tokensOut: 0, since: Date.now() }, privacyAck: [], ensemble: defaultEnsemble(),
  };
}

let cache: AiSettings | null = null;
/** The last save could not be written (storage full or blocked): the in-memory settings are newer than storage. */
let unsaved = false;
const listeners = new Set<() => void>();

/** One channel for sending and receiving: a channel does not receive its own messages, so a save here does not reload here. */
let channel: BroadcastChannel | null = null;
if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
  try {
    channel = new BroadcastChannel('quillstage-ai');
    // Settings changed in another tab (e.g. the OAuth callback tab): reload.
    channel.onmessage = () => reloadAiSettings();
    // Unref'd so tooling that imports this module under Node can exit.
    (channel as unknown as { unref?: () => void }).unref?.();
  } catch { channel = null; }
}

export function aiSettings(): AiSettings {
  if (cache) return cache;
  let s = defaultAiSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) s = { ...s, ...JSON.parse(raw) };
  } catch { /* corrupt or unavailable storage: defaults */ }
  if (!s.providers || typeof s.providers !== 'object') s.providers = {};
  if (!Array.isArray(s.prompts)) s.prompts = [];
  s.prompts = s.prompts.filter((p) => p && typeof p.name === 'string' && typeof p.prompt === 'string');
  s.ensemble = normalizeEnsemble(s.ensemble);
  cache = s;
  return s;
}

export function saveAiSettings(mut?: (s: AiSettings) => void): void {
  const s = aiSettings();
  mut?.(s);
  try { localStorage.setItem(KEY, JSON.stringify(s)); unsaved = false; } catch { unsaved = true; /* quota: keep the change in memory */ }
  if (!unsaved) { try { channel?.postMessage({ type: 'settings' }); } catch { /* closed */ } }
  listeners.forEach((f) => f());
}

export function onAiSettingsChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/**
 * Reload after another window (the OAuth callback tab) changed settings. Changes this window could
 * not write to storage are kept: they are written again on top of what the other window saved.
 */
export function reloadAiSettings(): void {
  if (unsaved && cache) {
    const mine = cache;
    cache = null;
    const theirs = aiSettings();
    cache = { ...theirs, ...mine, providers: { ...theirs.providers, ...mine.providers } };
    saveAiSettings();
    return;
  }
  cache = null;
  listeners.forEach((f) => f());
}

// ------------------------------------------------------------------------------------------
// Keys

const keyCache = new Map<string, string>();

export async function getApiKey(providerId: string): Promise<string> {
  if (keyCache.has(providerId)) return keyCache.get(providerId)!;
  let k = '';
  try {
    k = isNative() ? (await secureGet('ai.key.' + providerId)) || '' : ((await kvGet('aikey:' + providerId)) as string) || '';
  } catch { k = ''; }
  keyCache.set(providerId, k);
  return k;
}

/**
 * Where a key was put: 'secure' (encrypted by the system), 'plain' (the desktop app without a
 * keychain, stored unencrypted because the caller passed allowPlain), 'session' (not stored: the
 * system cannot encrypt it; it is kept until the app closes) or 'browser' (IndexedDB, unencrypted).
 */
export type KeyStorage = 'secure' | 'plain' | 'session' | 'browser';

export async function setApiKey(providerId: string, key: string, opts: { allowPlain?: boolean } = {}): Promise<KeyStorage> {
  keyCache.set(providerId, key);
  if (!isNative()) { await kvSet('aikey:' + providerId, key); return 'browser'; }
  const r = await secureSet('ai.key.' + providerId, key, opts);
  if (!r.stored) return 'session';
  return r.plaintext ? 'plain' : 'secure';
}

export async function deleteApiKey(providerId: string): Promise<void> {
  keyCache.delete(providerId);
  if (isNative()) await secureRemove('ai.key.' + providerId);
  else await kvDel('aikey:' + providerId);
}

export function maskKey(k: string): string {
  if (!k) return '';
  return k.length <= 12 ? '•'.repeat(k.length) : `${k.slice(0, 6)}…${k.slice(-4)}`;
}

// ------------------------------------------------------------------------------------------
// Resolved configuration

export interface ResolvedProvider { def: ProviderDef; cfg: ProviderConfig; key: string; baseUrl: string }

export function resolveBaseUrl(def: ProviderDef, cfg: Partial<ProviderConfig>): string {
  let url = (cfg.baseUrl || def.baseUrl || '').trim();
  url = url.replace('{accountId}', encodeURIComponent(cfg.accountId || '')).replace('{resource}', encodeURIComponent(cfg.resource || '')).replace('{region}', encodeURIComponent(cfg.region || 'us-east-1'));
  return url.replace(/\/+$/, '');
}

export async function resolveProvider(id?: string | null): Promise<ResolvedProvider | null> {
  const s = aiSettings();
  const pid = id || s.active;
  if (!pid) return null;
  const def = providerById(pid);
  const cfg = s.providers[pid];
  if (!def || !cfg) return null;
  const key = def.needsKey || pid === 'custom' || pid === 'ollama' || pid === 'lmstudio' ? await getApiKey(pid) : '';
  return { def, cfg, key, baseUrl: resolveBaseUrl(def, cfg) };
}

export function recordUsage(tokensIn: number, tokensOut: number): void {
  saveAiSettings((s) => { s.usage.requests++; s.usage.tokensIn += tokensIn || 0; s.usage.tokensOut += tokensOut || 0; });
}

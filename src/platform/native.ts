/**
 * Platform bridge. One API, three back ends:
 * - Android: the `QuillNative` Capacitor plugin (android/app/src/main/java/.../QuillNativePlugin.java)
 *   provides the Storage Access Framework (real Open / Save As dialogs, write-back to the same file),
 *   the system print service (which also offers "Save as PDF"), sharing, and files opened from other apps.
 * - Desktop (Windows, macOS, Linux, Raspberry Pi OS): the Electron preload (electron/preload.cjs)
 *   exposes the same interface as `window.quillDesktop`, backed by native file dialogs and the file system.
 * - Browser and iOS: <input type=file>, the File System Access API or downloads, and window.print().
 *   On iOS, saved files go to the app's Documents folder (Files ▸ On My iPhone ▸ Anne's Stage).
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { download, pickFile } from '../ui/dom';

export interface OpenedFile { name: string; data: ArrayBuffer; uri: string | null; mime?: string }

interface QuillNativePlugin {
  /** ACTION_OPEN_DOCUMENT. Resolves {canceled:true} when dismissed. */
  openDocument(opts: { mimeTypes: string[] }): Promise<{ canceled?: boolean; uri?: string; name?: string; mime?: string; data?: string /* base64 */ }>;
  /** ACTION_CREATE_DOCUMENT then write. */
  saveAs(opts: { name: string; mime: string; data: string /* base64 */ }): Promise<{ canceled?: boolean; uri?: string; name?: string }>;
  /** Overwrite an existing document URI obtained from openDocument/saveAs (persisted permission). */
  writeUri(opts: { uri: string; data: string /* base64 */ }): Promise<{ ok: boolean }>;
  /** Read a URI again (recent files). */
  readUri(opts: { uri: string }): Promise<{ name?: string; mime?: string; data: string }>;
  /** Print the current WebView through PrintManager. */
  print(opts: { jobName: string }): Promise<void>;
  /** Share a file through ACTION_SEND. */
  share(opts: { name: string; mime: string; data: string; title?: string }): Promise<void>;
  /** File the app was launched with (ACTION_VIEW / ACTION_SEND), consumed once. */
  getLaunchFile(): Promise<{ uri?: string; name?: string; mime?: string; data?: string }>;
  /** Keep the screen awake (read-aloud, teleprompter). */
  keepAwake(opts: { on: boolean }): Promise<void>;
  addListener(event: 'fileOpened', cb: (f: { uri?: string; name?: string; mime?: string; data?: string }) => void): Promise<{ remove: () => void }>;
  addListener(event: 'oauthCallback', cb: (r: { url: string }) => void): Promise<{ remove: () => void }>;
  /**
   * Android Keystore-backed encrypted preferences (API keys). The desktop app answers
   * {stored:false, reason:'no-encryption'} when the system has no keychain (Linux without a secret
   * service) unless `allowPlain` is set; then it stores the key unencrypted and says `plaintext`.
   */
  secureSet(opts: { key: string; value: string; allowPlain?: boolean }): Promise<void | SecureSetResult>;
  secureGet(opts: { key: string }): Promise<{ value?: string | null }>;
  secureRemove(opts: { key: string }): Promise<void>;
  /** ClipboardManager text (foreground app only; Android 12+ shows a "pasted" notice). */
  readClipboard(): Promise<{ text?: string | null }>;
  writeClipboard(opts: { text: string; sensitive?: boolean }): Promise<void>;
  /** One-shot http://127.0.0.1:<port>/ listener for OAuth redirects (OpenRouter PKCE); only requests for `path` count. */
  startLoopback(opts: { timeoutMs: number; successHtml?: string; path?: string }): Promise<{ port: number }>;
  stopLoopback(): Promise<void>;
  /** Android: hand a document to a sibling Anne's Office app (ACTION_VIEW with its package). */
  openInApp?(opts: { packageName: string; name: string; mime: string; data: string }): Promise<{ opened: boolean; reason?: string }>;
}

/** The desktop bridge adds what Android gets from Capacitor itself. */
interface DesktopBridge extends QuillNativePlugin {
  /** 'win32' | 'darwin' | 'linux' */
  platform: string;
  openExternal(opts: { url: string }): Promise<void>;
  /** HTTP from the main process (no CORS), for AI providers that block browsers. `id` lets httpAbort cancel it; `timeoutMs` gives up after that long. */
  http(opts: { url: string; method: string; headers: Record<string, string>; data?: unknown; id?: string; timeoutMs?: number }): Promise<{ status: number; text: string }>;
  /** Cancel the http request started with this id (Stop AI). Older desktop builds lack it. */
  httpAbort?(opts: { id: string }): Promise<void>;
  /** Write the document to a temporary file and open it with the program registered for its type. */
  openWith?(opts: { name: string; data: string }): Promise<{ ok: boolean; error?: string }>;
}

const desktop: DesktopBridge | undefined = typeof window !== 'undefined' ? (window as any).quillDesktop : undefined;
const Native: QuillNativePlugin = desktop || registerPlugin<QuillNativePlugin>('QuillNative');

/** Running in the Capacitor app shell (Android or iOS). */
export const isCapacitor = (): boolean => Capacitor.isNativePlatform();
/** A native bridge is present: real file dialogs, write-back, secure storage, OAuth loopback (Android app or desktop app). */
export const isNative = (): boolean => !!desktop || (Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('QuillNative'));
export const isDesktop = (): boolean => !!desktop;
export const isIOS = (): boolean => Capacitor.getPlatform() === 'ios';
/** 'android' | 'ios' | 'web' | 'windows' | 'macos' | 'linux' */
export const platformName = (): string => (desktop ? ({ win32: 'windows', darwin: 'macos' } as Record<string, string>)[desktop.platform] || 'linux' : Capacitor.getPlatform());
/** Desktop HTTP without CORS, or null when not on desktop. Aborting `signal` cancels the request in the main process. */
export const desktopHttp = desktop
  ? (o: { url: string; method: string; headers: Record<string, string>; data?: unknown; timeoutMs?: number }, signal?: AbortSignal): Promise<{ status: number; text: string }> => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const stop = () => { void desktop.httpAbort?.({ id })?.catch(() => undefined); };
    signal?.addEventListener('abort', stop, { once: true });
    return desktop.http({ ...o, id }).finally(() => signal?.removeEventListener('abort', stop));
  }
  : null;

// iOS: files live in the app's Documents folder, which the Files app shows.
const IOS_PREFIX = 'ios-doc:';
async function iosWrite(blob: Blob, name: string): Promise<string> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const safe = name.replace(/[\\/:*?"<>|]/g, '_') || 'document';
  await Filesystem.writeFile({ path: safe, data: b64FromBuffer(await blob.arrayBuffer()), directory: Directory.Documents });
  return safe;
}
/** Save As on iOS has no picker: never replace another document's file, use "Name (2).ext" instead. */
async function iosFreeName(name: string): Promise<string> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const safe = name.replace(/[\\/:*?"<>|]/g, '_') || 'document';
  const dot = safe.lastIndexOf('.');
  const base = dot > 0 ? safe.slice(0, dot) : safe, ext = dot > 0 ? safe.slice(dot) : '';
  for (let i = 1; i < 500; i++) {
    const candidate = i === 1 ? safe : `${base} (${i})${ext}`;
    try { await Filesystem.stat({ path: candidate, directory: Directory.Documents }); } catch { return candidate; }
  }
  return `${base} (${Date.now()})${ext}`;
}

export function b64FromBuffer(buf: ArrayBuffer): string {
  const u8 = new Uint8Array(buf);
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode(...u8.subarray(i, i + chunk));
  return btoa(s);
}

export function bufferFromB64(b64: string): ArrayBuffer {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8.buffer;
}

export async function openDocument(accept: string, mimeTypes: string[]): Promise<OpenedFile | null> {
  if (isNative()) {
    const r = await Native.openDocument({ mimeTypes });
    if (r.canceled || !r.data) return null;
    return { name: r.name || 'document', data: bufferFromB64(r.data), uri: r.uri || null, mime: r.mime };
  }
  const files = await pickFile(accept);
  if (!files.length) return null;
  return { name: files[0].name, data: await files[0].arrayBuffer(), uri: null, mime: files[0].type };
}

function toastSaved(name: string): void {
  import('../ui/dialog').then(({ toast }) => toast(`Saved "${name}" to Files ▸ On My iPhone ▸ Anne\'s Stage`)).catch(() => undefined);
}

export async function saveAs(blob: Blob, name: string): Promise<{ uri: string | null; name: string } | null> {
  if (isNative()) {
    const r = await Native.saveAs({ name, mime: blob.type || 'application/octet-stream', data: b64FromBuffer(await blob.arrayBuffer()) });
    if (r.canceled) return null;
    return { uri: r.uri || null, name: r.name || name };
  }
  if (isIOS()) {
    const n = await iosWrite(blob, await iosFreeName(name));
    toastSaved(n);
    return { uri: IOS_PREFIX + n, name: n };
  }
  const anyWin = window as any;
  if (anyWin.showSaveFilePicker) {
    try {
      const handle = await anyWin.showSaveFilePicker({ suggestedName: name });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return { uri: 'fsa:' + (await handleId(handle)), name: handle.name };
    } catch (e: any) {
      if (e?.name === 'AbortError') return null;
    }
  }
  download(blob, name);
  return { uri: null, name };
}

/** File System Access handles by id. Names alone are not unique: two folders can hold "Report.docx". */
const handles = new Map<string, any>();
let handleSeq = 0;
async function handleId(handle: any): Promise<string> {
  // The same file saved again keeps its id (and so its recent-files and version-history entries).
  for (const [id, h] of handles) {
    try { if (await h.isSameEntry?.(handle)) { handles.set(id, handle); return id; } } catch { /* stale handle */ }
  }
  // Unique per save, so two files with the same name in different folders never share a handle.
  const id = `${Date.now().toString(36)}${(++handleSeq).toString(36)}:${handle.name}`;
  handles.set(id, handle);
  return id;
}

export async function writeBack(uri: string, blob: Blob): Promise<boolean> {
  if (uri.startsWith('fsa:')) {
    const h = handles.get(uri.slice(4));
    if (!h) return false;
    const w = await h.createWritable();
    await w.write(blob);
    await w.close();
    return true;
  }
  if (uri.startsWith(IOS_PREFIX)) { await iosWrite(blob, uri.slice(IOS_PREFIX.length)); return true; }
  if (!isNative()) return false;
  const r = await Native.writeUri({ uri, data: b64FromBuffer(await blob.arrayBuffer()) });
  return !!r.ok;
}

export async function readUri(uri: string): Promise<OpenedFile | null> {
  if (uri.startsWith(IOS_PREFIX)) {
    try {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const r = await Filesystem.readFile({ path: uri.slice(IOS_PREFIX.length), directory: Directory.Documents });
      return { name: uri.slice(IOS_PREFIX.length), data: bufferFromB64(typeof r.data === 'string' ? r.data : b64FromBuffer(await (r.data as Blob).arrayBuffer())), uri };
    } catch { return null; }
  }
  if (!isNative()) return null;
  try {
    const r = await Native.readUri({ uri });
    return { name: r.name || 'document', data: bufferFromB64(r.data), uri, mime: r.mime };
  } catch {
    return null;
  }
}

export async function printDocument(jobName: string): Promise<void> {
  if (isNative()) { await Native.print({ jobName }); return; }
  window.print();
}

export async function shareFile(blob: Blob, name: string, title?: string): Promise<void> {
  if (isNative()) {
    await Native.share({ name, mime: blob.type || 'application/octet-stream', data: b64FromBuffer(await blob.arrayBuffer()), title });
    return;
  }
  if (isIOS()) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const w = await Filesystem.writeFile({ path: name.replace(/[\\/:*?"<>|]/g, '_') || 'document', data: b64FromBuffer(await blob.arrayBuffer()), directory: Directory.Cache });
    await Share.share({ title: title || name, files: [w.uri] });
    return;
  }
  const file = new File([blob], name, { type: blob.type });
  const nav = navigator as any;
  if (nav.canShare && nav.canShare({ files: [file] })) { await nav.share({ files: [file], title: title || name }); return; }
  download(blob, name);
}

/**
 * iOS has no QuillNative plugin: "Open in Anne's Stage" and Share arrive as file:// URLs through the
 * Capacitor App plugin. With LSSupportsOpeningDocumentsInPlace off, iOS copies the file into the app's
 * Documents/Inbox first, so it can be read without a security-scoped bookmark. There is no write-back
 * URI: Save on iOS goes through Save As / Share.
 */
let lastIosUrl = '';
async function readIosUrl(url: string): Promise<OpenedFile | null> {
  if (!/^file:/i.test(url) || url === lastIosUrl) return null;
  lastIosUrl = url;
  try {
    const { Filesystem } = await import('@capacitor/filesystem');
    const r = await Filesystem.readFile({ path: url });
    const data = typeof r.data === 'string' ? bufferFromB64(r.data) : await (r.data as Blob).arrayBuffer();
    let name = url.split(/[?#]/)[0].split('/').pop() || 'document';
    try { name = decodeURIComponent(name); } catch { /* keep the raw name */ }
    return { name, data, uri: null };
  } catch {
    return null;
  }
}

export async function launchFile(): Promise<OpenedFile | null> {
  if (isCapacitor() && isIOS() && !isNative()) {
    try {
      const { App } = await import('@capacitor/app');
      const r = await App.getLaunchUrl();
      return r?.url ? await readIosUrl(r.url) : null;
    } catch {
      return null;
    }
  }
  if (!isNative()) return null;
  try {
    const r = await Native.getLaunchFile();
    if (!r || !r.data) return null;
    return { name: r.name || 'document', data: bufferFromB64(r.data), uri: r.uri || null, mime: r.mime };
  } catch {
    return null;
  }
}

export function onFileOpened(cb: (f: OpenedFile) => void): void {
  if (isCapacitor() && isIOS() && !isNative()) {
    void import('@capacitor/app').then(({ App }) => App.addListener('appUrlOpen', (e) => { void readIosUrl(e.url).then((f) => { if (f) cb(f); }); }));
    return;
  }
  if (!isNative()) return;
  Native.addListener('fileOpened', (r) => { if (r.data) cb({ name: r.name || 'document', data: bufferFromB64(r.data), uri: r.uri || null, mime: r.mime }); });
}

export async function keepAwake(on: boolean): Promise<void> {
  if (!isNative()) {
    try { if (on) (window as any).__wake = await (navigator as any).wakeLock?.request('screen'); else (window as any).__wake?.release(); } catch { /* */ }
    return;
  }
  try { await Native.keepAwake({ on }); } catch { /* */ }
}

/** Open a URL outside the app (system browser, mail or phone app). */
export function openExternal(url: string): void {
  // Only hand ordinary web/mail/phone addresses to the system; never navigate this WebView to script.
  if (!/^(https?|mailto|tel|ftp|sms|geo):/i.test(url.trim())) return;
  if (desktop) { void desktop.openExternal({ url }); return; }
  if (isCapacitor()) { window.location.href = url; return; }
  window.open(url, '_blank', 'noopener');
}

export async function onBackButton(cb: () => boolean): Promise<void> {
  if (!isCapacitor() || isIOS()) return;
  const { App } = await import('@capacitor/app');
  App.addListener('backButton', () => { if (!cb()) App.minimizeApp(); });
}

export const OPEN_ACCEPT = '.pptx,.pptm,.ppsx,.ppsm,.potx,.potm,.ppt,.pps,.pot,.odp,.otp,.fodp,.sxi,.sti,.md,.markdown,.txt,.qsp,.qspe,.json,.xml,.html,.htm'
  // outlines and documents whose headings become slides
  + ',.docx,.odt,.rtf';
export const OPEN_MIMES = [
  'application/x-quillstage', 'application/x-quillstage-encrypted',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  'application/vnd.openxmlformats-officedocument.presentationml.template',
  'application/vnd.ms-powerpoint', 'application/vnd.oasis.opendocument.presentation', 'application/vnd.oasis.opendocument.flat-presentation',
  'application/vnd.sun.xml.impress', 'text/markdown', 'text/plain', 'text/html', 'application/xml', 'text/xml', 'application/json', 'application/octet-stream', '*/*',
];

// ------------------------------------------------------------------------------------------
// Sibling Anne's Office apps

export type QuillApp = 'Anne\'s Pen' | 'Anne\'s Post' | 'Anne\'s Grid';
export const QUILL_APP_IDS: Record<QuillApp, string> = {
  'Anne\'s Pen': 'io.github.socrtwo.quillpen', 'Anne\'s Post': 'io.github.socrtwo.quillpost', 'Anne\'s Grid': 'io.github.socrtwo.quillgrid',
};

/**
 * Opens a document in a sibling app: on Android the app itself (by package), on the desktop the
 * program registered for the file type. Browsers and iOS cannot hand files to other apps.
 */
export async function openInQuillApp(app: QuillApp, data: ArrayBuffer, name: string, mime: string): Promise<{ opened: boolean; reason: 'not-installed' | 'unsupported' | 'error' | ''; message?: string }> {
  try {
    if (desktop?.openWith) {
      const r = await desktop.openWith({ name, data: b64FromBuffer(data) });
      return r.ok ? { opened: true, reason: '' } : { opened: false, reason: 'not-installed', message: r.error };
    }
    if (isNative() && Native.openInApp) {
      const r = await Native.openInApp({ packageName: QUILL_APP_IDS[app], name, mime, data: b64FromBuffer(data) });
      return r.opened ? { opened: true, reason: '' } : { opened: false, reason: 'not-installed' };
    }
  } catch (e: any) {
    return { opened: false, reason: 'error', message: e?.message || String(e) };
  }
  return { opened: false, reason: 'unsupported' };
}

// ------------------------------------------------------------------------------------------
// Secure storage, clipboard, OAuth loopback, app resume (AI setup)

export interface SecureSetResult { stored?: boolean; plaintext?: boolean; reason?: string }

/** Stores a secret. Resolves {stored:false} when the system cannot encrypt it and `allowPlain` was not given (nothing was written). */
export async function secureSet(key: string, value: string, opts: { allowPlain?: boolean } = {}): Promise<{ stored: boolean; plaintext: boolean; reason?: string }> {
  const r = (await Native.secureSet({ key, value, ...(opts.allowPlain ? { allowPlain: true } : {}) })) || {};
  return { stored: r.stored !== false, plaintext: !!r.plaintext, reason: r.reason };
}
export async function secureGet(key: string): Promise<string | null> {
  return (await Native.secureGet({ key })).value ?? null;
}
export async function secureRemove(key: string): Promise<void> {
  await Native.secureRemove({ key });
}

/** Read clipboard text. Returns null when the platform refuses (no permission, no focus). */
export async function readClipboardText(): Promise<string | null> {
  try {
    if (isNative()) return (await Native.readClipboard()).text ?? null;
    if (navigator.clipboard?.readText) return await navigator.clipboard.readText();
  } catch { /* denied */ }
  return null;
}

export async function writeClipboardText(text: string, sensitive = false): Promise<boolean> {
  try {
    if (isNative()) { await Native.writeClipboard({ text, sensitive }); return true; }
    await navigator.clipboard.writeText(text);
    return true;
  } catch { return false; }
}

export async function startOAuthLoopback(timeoutMs: number, successHtml?: string, path?: string): Promise<number> {
  return (await Native.startLoopback({ timeoutMs, successHtml, path })).port;
}
export async function stopOAuthLoopback(): Promise<void> {
  try { await Native.stopLoopback(); } catch { /* not running */ }
}
export function onOAuthCallback(cb: (url: string) => void): Promise<{ remove: () => void }> {
  return Native.addListener('oauthCallback', (r) => cb(r.url));
}

/** Called when the app returns to the foreground (Android resume, browser tab visible again). */
export function onAppResume(cb: () => void): () => void {
  const vis = () => { if (document.visibilityState === 'visible') cb(); };
  document.addEventListener('visibilitychange', vis);
  let remove: (() => void) | null = null;
  if (isCapacitor()) {
    import('@capacitor/app').then(({ App }) => App.addListener('resume', cb)).then((h) => { remove = () => h.remove(); }).catch(() => undefined);
  }
  return () => { document.removeEventListener('visibilitychange', vis); remove?.(); };
}

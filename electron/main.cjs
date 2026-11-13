// Anne's Stage desktop app (Windows, macOS, Linux, Raspberry Pi OS): Electron main process.
//
// The web build (dist/) is served from the privileged app:// scheme so module workers, fetch and
// IndexedDB behave as on the web. The renderer is sandboxed with context isolation and no Node;
// electron/preload.cjs exposes `window.quillDesktop`, the same interface as the Android plugin.
// File access is limited to files the user opened or saved through a dialog, or opened the app
// with, so presentation content cannot use the bridge to read or overwrite arbitrary files.
'use strict';
const { app, BrowserWindow, protocol, net, ipcMain, dialog, shell, clipboard, safeStorage, powerSaveBlocker, Menu, screen } = require('electron');
const path = require('node:path');
// The data folder keeps the app's former name (QuillStage) so settings, drafts and keys stay where earlier versions put them. // rename:keep
app.setPath('userData', path.join(app.getPath('appData'), 'QuillStage')); // rename:keep
app.setPath('sessionData', app.getPath('userData')); // rename:keep
const fs = require('node:fs');

const http = require('node:http');
const { pathToFileURL, fileURLToPath } = require('node:url');

const DIST = path.join(__dirname, '..', 'dist');
const SCHEME = 'app';
const ORIGIN = `${SCHEME}://quillstage`;
const OPENABLE = ['pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm', 'ppt', 'pps', 'pot', 'odp', 'otp', 'fodp', 'sxi', 'sti', 'md', 'markdown', 'txt', 'qsp', 'qspe', 'json', 'xml'];
/** Documents, slides and mail the app can import or hand to a sibling Anne's Office app (never programs or scripts). */
const DOCUMENTS = ['docx', 'docm', 'dotx', 'doc', 'odt', 'fodt', 'rtf', 'pdf', 'html', 'htm', 'key', 'xlsx', 'ods', 'csv'];

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

if (!app.requestSingleInstanceLock()) app.quit();

/** @type {BrowserWindow | null} */
let win = null;
/** Files opened before the page could receive them. Flushed when the page registers its fileOpened listener. */
const pendingFiles = [];
let rendererReady = false;
let wakeId = -1;

// ------------------------------------------------------------------------------------------
// Files the renderer may read and write

const grantsFile = () => path.join(app.getPath('userData'), 'granted-files.json');
let grants = new Set();
function loadGrants() {
  try { grants = new Set(JSON.parse(fs.readFileSync(grantsFile(), 'utf8'))); } catch { grants = new Set(); }
}
function grant(p) {
  grants.add(path.resolve(p));
  // Keep the most recent 200 (enough for the recent-files list).
  const list = [...grants].slice(-200);
  grants = new Set(list);
  try { fs.writeFileSync(grantsFile(), JSON.stringify(list)); } catch { /* read-only profile */ }
}
function grantedPath(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file:')) throw new Error('Not a file address');
  const p = path.resolve(fileURLToPath(uri));
  if (!grants.has(p)) throw new Error('Anne\'s Stage has no permission for this file; open it again.');
  return p;
}
const MIME = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pptm: 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  ppsx: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  ppsm: 'application/vnd.ms-powerpoint.slideshow.macroEnabled.12',
  potx: 'application/vnd.openxmlformats-officedocument.presentationml.template',
  potm: 'application/vnd.ms-powerpoint.template.macroEnabled.12',
  ppt: 'application/vnd.ms-powerpoint', pps: 'application/vnd.ms-powerpoint', pot: 'application/vnd.ms-powerpoint',
  odp: 'application/vnd.oasis.opendocument.presentation',
  otp: 'application/vnd.oasis.opendocument.presentation-template',
  fodp: 'application/vnd.oasis.opendocument.flat-presentation',
  sxi: 'application/vnd.sun.xml.impress', sti: 'application/vnd.sun.xml.impress.template',
  md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', html: 'text/html', htm: 'text/html', xml: 'application/xml',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml', webm: 'video/webm', mp4: 'video/mp4', gif: 'image/gif',
  qsp: 'application/x-quillstage', qspe: 'application/x-quillstage-encrypted', json: 'application/json',
};
function fileResult(p) {
  const data = fs.readFileSync(p);
  const ext = path.extname(p).slice(1).toLowerCase();
  return { uri: pathToFileURL(p).href, name: path.basename(p), mime: MIME[ext] || 'application/octet-stream', data: data.toString('base64') };
}
function fileFromArgs(argv) {
  for (const a of argv.slice(1)) {
    if (!a || a.startsWith('-')) continue;
    const ext = path.extname(a).slice(1).toLowerCase();
    // Files are recognized by their contents, so names without an extension open too.
    const known = OPENABLE.includes(ext) || DOCUMENTS.includes(ext) || (!ext && !a.includes('desktop-app'));
    try { if (known && fs.statSync(a).isFile()) return path.resolve(a); } catch { /* not a file */ }
  }
  return null;
}
function openExternalFile(p) {
  grant(p);
  if (win && rendererReady) win.webContents.send('ql:fileOpened', fileResult(p));
  else pendingFiles.push(p);
  // macOS keeps running with no window: opening a file from Finder must bring one back.
  if (!win && app.isReady()) createWindow();
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
}
function flushPendingFiles() {
  while (win && rendererReady && pendingFiles.length) win.webContents.send('ql:fileOpened', fileResult(pendingFiles.shift()));
}

// ------------------------------------------------------------------------------------------
// Secure storage (API keys): encrypted with the OS keychain / DPAPI / libsecret via safeStorage

const secureFile = () => path.join(app.getPath('userData'), 'secure.json');
function readSecure() { try { return JSON.parse(fs.readFileSync(secureFile(), 'utf8')); } catch { return {}; } }
function writeSecure(o) { fs.writeFileSync(secureFile(), JSON.stringify(o), { mode: 0o600 }); }
/**
 * Whether safeStorage really encrypts. On Linux without a secret service (GNOME Keyring, KWallet)
 * Electron falls back to the 'basic_text' backend, which only obfuscates with a fixed key.
 */
function canEncrypt() {
  if (!safeStorage.isEncryptionAvailable()) return false;
  try {
    if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
  } catch { /* older Electron: trust isEncryptionAvailable */ }
  return true;
}
function seal(v) {
  return { enc: true, v: safeStorage.encryptString(v).toString('base64') };
}
function unseal(rec) {
  if (!rec) return null;
  return rec.enc ? safeStorage.decryptString(Buffer.from(rec.v, 'base64')) : rec.v;
}

// ------------------------------------------------------------------------------------------
// OAuth loopback (OpenRouter PKCE), as on Android: one-shot listener on 127.0.0.1 only

let loop = null;
function stopLoop() { if (loop) { clearTimeout(loop.timer); try { loop.server.close(); } catch { /* */ } loop = null; } }

// ------------------------------------------------------------------------------------------
// IPC

const safeUrl = (u) => typeof u === 'string' && /^(https?|mailto|tel|ftp|sms|geo):/i.test(u.trim());
/**
 * The app's own origin exactly (not a prefix: "app://quillstage.evil" must not pass). Node's URL
 * reports the origin of a custom scheme as "null", so scheme and host are compared instead.
 */
function isAppUrl(u) {
  try { const x = new URL(String(u)); return x.protocol === SCHEME + ':' && x.host === new URL(ORIGIN).host; } catch { return false; }
}
function handle(name, fn) {
  ipcMain.handle('ql:' + name, async (e, opts) => {
    if (!win || e.sender !== win.webContents || !e.senderFrame || !isAppUrl(e.senderFrame.url)) throw new Error('Refused');
    return fn(opts || {});
  });
}
/** AI requests in flight through the http bridge, by the id the renderer gave them (Stop cancels them). */
const httpRequests = new Map();
const HTTP_TIMEOUT_MS = 180000;

function registerIpc() {
  handle('openDocument', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Presentations', extensions: OPENABLE }, { name: 'Documents, slides and mail', extensions: DOCUMENTS }, { name: 'All files', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    grant(r.filePaths[0]);
    return fileResult(r.filePaths[0]);
  });
  handle('saveAs', async ({ name, data }) => {
    const ext = path.extname(String(name || '')).slice(1);
    const r = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath('documents'), path.basename(String(name || 'presentation'))),
      filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All files', extensions: ['*'] }] : undefined,
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    fs.writeFileSync(r.filePath, Buffer.from(String(data || ''), 'base64'));
    grant(r.filePath);
    return { uri: pathToFileURL(r.filePath).href, name: path.basename(r.filePath) };
  });
  handle('writeUri', async ({ uri, data }) => {
    const p = grantedPath(uri);
    // Write a temporary file first, so a failed write never truncates the presentation.
    const tmp = p + '.ql-saving';
    fs.writeFileSync(tmp, Buffer.from(String(data || ''), 'base64'));
    fs.renameSync(tmp, p);
    return { ok: true };
  });
  handle('readUri', async ({ uri }) => fileResult(grantedPath(uri)));
  handle('print', async () => new Promise((res) => win.webContents.print({}, () => res())));
  handle('share', async ({ name, data }) => {
    // Desktops have no share sheet: offer Save As.
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), path.basename(String(name || 'presentation'))) });
    if (!r.canceled && r.filePath) { fs.writeFileSync(r.filePath, Buffer.from(String(data || ''), 'base64')); grant(r.filePath); }
  });
  handle('getLaunchFile', async () => {
    const p = pendingFiles.shift();
    return p ? fileResult(p) : {};
  });
  // Sent by the preload script once the page listens for fileOpened: deliver anything that arrived earlier.
  ipcMain.on('ql:fileListenerReady', (e) => { if (win && e.sender === win.webContents) { rendererReady = true; flushPendingFiles(); } });
  handle('keepAwake', async ({ on }) => {
    if (on && wakeId < 0) wakeId = powerSaveBlocker.start('prevent-display-sleep');
    if (!on && wakeId >= 0) { powerSaveBlocker.stop(wakeId); wakeId = -1; }
  });
  // Without real encryption the key is not written unless the user agreed (allowPlain): the renderer
  // warns and otherwise keeps the key for this session only.
  handle('secureSet', async ({ key, value, allowPlain }) => {
    const encrypt = canEncrypt();
    if (!encrypt && allowPlain !== true) return { stored: false, reason: 'no-encryption' };
    const o = readSecure();
    o[String(key)] = encrypt ? seal(String(value)) : { enc: false, v: String(value) };
    writeSecure(o);
    return { stored: true, plaintext: !encrypt };
  });
  handle('secureGet', async ({ key }) => { try { return { value: unseal(readSecure()[String(key)]) }; } catch { return { value: null }; } });
  handle('secureRemove', async ({ key }) => { const o = readSecure(); delete o[String(key)]; writeSecure(o); });
  handle('readClipboard', async () => ({ text: clipboard.readText() }));
  handle('writeClipboard', async ({ text }) => { clipboard.writeText(String(text ?? '')); });
  handle('startLoopback', async ({ timeoutMs, successHtml, path: want }) => {
    stopLoop();
    const server = http.createServer((req, res) => {
      // Only this sign-in's nonce path counts: another program probing the port must not end it.
      if (typeof want === 'string' && want && String(req.url || '').split('?')[0] !== want) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(typeof successHtml === 'string' ? successHtml : '<p>You can close this tab.</p>');
      const port = server.address().port;
      if (win) win.webContents.send('ql:oauthCallback', { url: `http://127.0.0.1:${port}${req.url}` });
      if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
      setTimeout(stopLoop, 500);
    });
    await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
    loop = { server, timer: setTimeout(stopLoop, Math.min(Number(timeoutMs) || 300000, 900000)) };
    return { port: server.address().port };
  });
  handle('stopLoopback', async () => stopLoop());
  handle('openExternal', async ({ url }) => { if (safeUrl(url)) await shell.openExternal(url); });
  // Hand a document to the program registered for its type (Anne's Pen, Anne's Post or Anne's Stage when installed).
  handle('openWith', async ({ name, data }) => {
    const base = path.basename(String(name || 'document')).replace(/[\\/:*?"<>|]/g, '_');
    const ext = path.extname(base).slice(1).toLowerCase();
    if (!DOCUMENTS.includes(ext)) return { ok: false, error: 'This kind of file is not handed to other programs.' };
    const dir = path.join(app.getPath('temp'), 'quillstage-handoff');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now().toString(36)}-${base}`);
    fs.writeFileSync(file, Buffer.from(String(data || ''), 'base64'));
    const err = await shell.openPath(file);
    return err ? { ok: false, error: err } : { ok: true };
  });
  handle('http', async ({ url, method, headers, data, id, timeoutMs }) => {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) throw new Error('Only https requests are allowed');
    const ctl = new AbortController();
    const ms = Math.min(Math.max(Number(timeoutMs) || HTTP_TIMEOUT_MS, 1000), 600000);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, ms);
    const key = typeof id === 'string' && id ? id.slice(0, 64) : null;
    if (key) httpRequests.set(key, ctl);
    try {
      const res = await net.fetch(url, { method: method || 'GET', headers: headers || {}, body: data == null ? undefined : typeof data === 'string' ? data : JSON.stringify(data), signal: ctl.signal });
      return { status: res.status, text: await res.text() };
    } catch (err) {
      if (ctl.signal.aborted) throw new Error(timedOut ? `No answer within ${Math.round(ms / 1000)} seconds` : 'Stopped');
      throw err;
    } finally {
      clearTimeout(timer);
      if (key) httpRequests.delete(key);
    }
  });
  handle('httpAbort', async ({ id }) => { const ctl = httpRequests.get(String(id)); if (ctl) ctl.abort(); });
}

// ------------------------------------------------------------------------------------------
// Window

// Content Security Policy for the app. 'unsafe-eval' is needed by user macros (Developer tab);
// cdn.jsdelivr.net and wasm are for the optional on-device AI model; http to localhost is for
// Ollama and LM Studio. Inline scripts and plugins are never allowed.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net",
  "worker-src 'self' blob:",
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:* data: blob:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-src 'none'",
].join('; ');

function serveApp() {
  protocol.handle(SCHEME, async (req) => {
    const u = new URL(req.url);
    let rel;
    try { rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html'; } catch { return new Response('Bad Request', { status: 400 }); }
    const file = path.resolve(DIST, rel);
    if (!file.startsWith(DIST + path.sep) && file !== DIST) return new Response('Forbidden', { status: 403 });
    const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(DIST, 'index.html');
    const res = await net.fetch(pathToFileURL(target).href);
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', CSP);
    return new Response(res.body, { status: res.status, headers });
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }])] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 360,
    minHeight: 480,
    title: 'Anne\'s Stage',
    backgroundColor: '#ffffff',
    autoHideMenuBar: process.platform !== 'darwin',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false, // Anne's Stage has its own spelling checker
    },
  });
  // Links open in the system browser; the window never navigates away from the app. The one window
  // the app opens itself is the slide show's audience view (Presenter View): a blank, sandboxed window
  // the page writes into, placed full screen on another display when there is one.
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (frameName === 'quillstage-audience' && (url === 'about:blank' || url === '')) {
      const displays = screen.getAllDisplays();
      const mine = screen.getDisplayMatching(win.getBounds());
      const other = displays.find((d) => d.id !== mine.id);
      const b = (other || mine).bounds;
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          x: b.x, y: b.y, width: other ? b.width : Math.round(b.width * 0.6), height: other ? b.height : Math.round(b.height * 0.6),
          fullscreen: !!other, autoHideMenuBar: true, title: 'Anne\'s Stage Slide Show', backgroundColor: '#000000',
          webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
        },
      };
    }
    if (safeUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // will-navigate for this window (and every other one) is handled in 'web-contents-created' below.
  // The page asks before unloading with unsaved presentations: confirm here, as the browser would.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Close without saving', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Unsaved changes', message: 'Some presentations have unsaved changes. Close Anne\'s Stage anyway?' });
    if (choice === 0) e.preventDefault();
  });
  // A reload or navigation drops the page's listeners until it registers them again.
  win.webContents.on('did-start-loading', () => { rendererReady = false; });
  win.on('closed', () => { win = null; rendererReady = false; });
  void win.loadURL(`${ORIGIN}/index.html`);
}

// Every webContents (the main window, the audience window, anything else): no navigation away from
// the app's own origin, no new windows (the main window replaces this handler with its own, which
// allows only the audience view), no <webview>. External links go to the system browser.
app.on('web-contents-created', (_e, wc) => {
  const guard = (e, url) => { if (!isAppUrl(url)) { e.preventDefault(); if (safeUrl(url)) void shell.openExternal(url); } };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.setWindowOpenHandler(({ url }) => { if (safeUrl(url)) void shell.openExternal(url); return { action: 'deny' }; });
});

app.on('second-instance', (_e, argv) => {
  const p = fileFromArgs(argv);
  if (p) openExternalFile(p);
  else if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
// macOS: files opened from Finder (before or after launch).
app.on('open-file', (e, p) => { e.preventDefault(); if (app.isReady()) openExternalFile(p); else pendingFiles.push(p); });

app.whenReady().then(() => {
  loadGrants();
  const p = fileFromArgs(process.argv);
  if (p) pendingFiles.unshift(p);
  for (const f of pendingFiles) grant(f);
  serveApp();
  registerIpc();
  buildMenu();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { stopLoop(); if (process.platform !== 'darwin') app.quit(); });

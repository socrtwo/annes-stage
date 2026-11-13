// Exposes `window.quillDesktop`: the same interface as the Android QuillNative plugin
// (see src/platform/native.ts), plus openExternal and http. Runs sandboxed.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => (opts) => ipcRenderer.invoke('ql:' + name, opts);
const methods = ['openDocument', 'saveAs', 'writeUri', 'readUri', 'print', 'share', 'getLaunchFile', 'keepAwake', 'secureSet', 'secureGet', 'secureRemove', 'readClipboard', 'writeClipboard', 'startLoopback', 'stopLoopback', 'openExternal', 'http', 'httpAbort', 'openWith'];

const api = { platform: process.platform };
for (const m of methods) api[m] = call(m);
api.addListener = (event, cb) => {
  if (event !== 'fileOpened' && event !== 'oauthCallback') return Promise.reject(new Error('Unknown event'));
  const listener = (_e, data) => cb(data);
  ipcRenderer.on('ql:' + event, listener);
  if (event === 'fileOpened') ipcRenderer.send('ql:fileListenerReady');
  return Promise.resolve({ remove: () => ipcRenderer.removeListener('ql:' + event, listener) });
};

contextBridge.exposeInMainWorld('quillDesktop', api);

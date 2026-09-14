// This view can report only its color preference. No desktop actions or filesystem access.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopTheme', {
  report: mode => { if (['light', 'dark', 'system'].includes(mode)) ipcRenderer.send('desktop:workspace-theme', mode); },
});

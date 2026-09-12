const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  state: () => ipcRenderer.invoke('desktop:state'),
  action: (name, value) => ipcRenderer.invoke('desktop:action', name, value),
  onState: callback => { const listener = (_, state) => callback(state); ipcRenderer.on('desktop:state', listener); return () => ipcRenderer.removeListener('desktop:state', listener); },
});

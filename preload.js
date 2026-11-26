const { contextBridge, ipcRenderer } = require('electron/renderer');

contextBridge.exposeInMainWorld('api', {
    getStatus: () => ipcRenderer.invoke('app:status'),
    checkUpdate: () => ipcRenderer.invoke('update:check'),
    applyUpdate: () => ipcRenderer.invoke('update:apply'),
    login: () => ipcRenderer.invoke('fs:login'),
    logout: () => ipcRenderer.invoke('fs:logout'),
    search: (opts) => ipcRenderer.invoke('fs:search', opts),
    localSearch: (opts) => ipcRenderer.invoke('local:search', opts),
    localRead: (rel) => ipcRenderer.invoke('local:read', rel),
    giphySearch: (opts) => ipcRenderer.invoke('giphy:search', opts),
    download: (sound) => ipcRenderer.invoke('fs:download', sound),
    insert: (sound, trackIndex) => ipcRenderer.invoke('resolve:insert', sound, trackIndex),
    startDrag: (file) => ipcRenderer.send('drag:start', file),
    cleanup: () => ipcRenderer.invoke('resolve:cleanup')
});

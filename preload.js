'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 注册返回取消函数的监听器，页面重新初始化时不会留下重复 IPC 监听。
function subscribe(channel, callback) {
  const listener = (event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  readDirectory: (dirPath, sortMode, sortDir, recursive) => ipcRenderer.invoke('read-directory', dirPath, sortMode, sortDir, Boolean(recursive)),
  cancelDirectoryScan: () => ipcRenderer.invoke('cancel-directory-scan'),
  onMediaMetadataUpdated: (callback) => subscribe('media-metadata-updated', callback),
  onMediaMetadataComplete: (callback) => subscribe('media-metadata-complete', callback),
  onMediaScanError: (callback) => subscribe('media-scan-error', callback),

  getThumbnail: (filePath, size) => ipcRenderer.invoke('get-thumbnail', filePath, size),
  getPreview: (filePath) => ipcRenderer.invoke('get-preview', filePath),
  preparePreview: (filePath) => ipcRenderer.invoke('prepare-preview', filePath),

  getSubfolders: (dirPath) => ipcRenderer.invoke('get-subfolders', dirPath),
  deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
  deleteFiles: (filePaths) => ipcRenderer.invoke('delete-files', filePaths),
  renameFile: (filePath, newName) => ipcRenderer.invoke('rename-file', filePath, newName),
  moveFile: (filePath, destDir) => ipcRenderer.invoke('move-file', filePath, destDir),
  createFolder: (parentDir, folderName) => ipcRenderer.invoke('create-folder', parentDir, folderName),
  deleteFolder: (dirPath) => ipcRenderer.invoke('delete-folder', dirPath),
  deleteFolders: (dirPaths) => ipcRenderer.invoke('delete-folders', dirPaths),
  renameFolder: (dirPath, newName) => ipcRenderer.invoke('rename-folder', dirPath, newName),
  moveFolder: (srcPath, destDir) => ipcRenderer.invoke('move-folder', srcPath, destDir),
  openInExplorer: (dirPath) => ipcRenderer.invoke('open-in-explorer', dirPath),
  showFileInExplorer: (filePath) => ipcRenderer.invoke('show-file-in-explorer', filePath),
  copyFilePath: (filePath) => ipcRenderer.invoke('copy-file-path', filePath),
  toggleFavorite: (filePath) => ipcRenderer.invoke('toggle-favorite', filePath),

  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  watchDirectory: (dirPath) => ipcRenderer.send('watch-directory', dirPath),
  unwatchDirectory: () => ipcRenderer.send('unwatch-directory'),
  onDirectoryChanged: (callback) => subscribe('directory-changed', callback)
});

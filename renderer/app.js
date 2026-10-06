const App = {
  currentPath: null,
  currentPreviewPath: null,
  fileOperationPending: false,
  _lastOpTime: 0,

  async init() {
    FolderTree.init(
      'folder-list',
      (path) => this.onFolderPreview(path)
    );
    Waterfall.init('image-grid', 'image-grid-container');
    Preview.init();
    ContextMenu.init();

    SettingsManager.init(
      (mode) => this.onLayoutChange(mode),
      () => this.onSortChange(),
      () => this.onRecursiveChange()
    );

    document.getElementById('directory-bar').addEventListener('click', () => {
      this.selectDirectory();
    });

    // 监听目录变化，自动刷新
    window.api.onDirectoryChanged((dirPath) => {
      if (this.fileOperationPending || Date.now() - this._lastOpTime < 2000) {
        this.fileOperationPending = false;
        return;
      }
      if (dirPath === this.currentPreviewPath) {
        this.loadImagesForCurrentPreview();
      }
    });

    await this.restoreLastDir();
  },

  async restoreLastDir() {
    if (!SettingsManager.getRememberDir()) return;

    const lastDir = SettingsManager.getLastDir();
    if (!lastDir) return;

    try {
      const folders = await window.api.getSubfolders(lastDir);
      this.currentPath = lastDir;
      this.currentPreviewPath = lastDir;
      document.getElementById('directory-path').textContent = lastDir;
      await this.loadDirectory(lastDir);
    } catch (e) {
      // 目录不存在，忽略
    }
  },

  async selectDirectory() {
    const result = await window.api.selectDirectory();
    if (result && result.path) {
      this.currentPath = result.path;
      this.currentPreviewPath = result.path;
      document.getElementById('directory-path').textContent = result.path;
      SettingsManager.saveLastDir(result.path);
      await this.loadDirectory(result.path);
    }
  },

  async loadDirectory(dirPath) {
    await Promise.all([
      FolderTree.loadFolders(dirPath),
      Waterfall.loadImages(dirPath)
    ]);
    window.api.watchDirectory(dirPath);
  },

  async onFolderPreview(path) {
    this.currentPreviewPath = path;
    await Waterfall.loadImages(path);
    window.api.watchDirectory(path);
  },

  async loadImagesForCurrentPreview() {
    const path = this.currentPreviewPath;
    if (path) {
      await Waterfall.loadImages(path);
    }
  },

  onLayoutChange(mode) {
    SettingsManager.applyLayout(mode);
    Waterfall.applyZoom();
  },

  onSortChange() {
    const path = this.currentPreviewPath || this.currentPath;
    if (path) {
      Waterfall.loadImages(path);
    }
  },

  onRecursiveChange() {
    const path = this.currentPreviewPath || this.currentPath;
    if (path) {
      Waterfall.loadImages(path);
    }
  }
};

document.addEventListener('DOMContentLoaded', () => {
  App.init();
});

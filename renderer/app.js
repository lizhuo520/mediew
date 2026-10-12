const App = {
  currentPath: null,
  currentPreviewPath: null,
  fileOperationPending: false,
  _lastOpTime: 0,

  async init() {
    Toast.init();
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

    this.setupShortcuts();

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

  /**
   * 全局快捷键。这里只放真正全局的三条；网格内部的方向键/Enter/Delete 归
   * Waterfall、树的方向键归 FolderTree，集中在这里会让两边抢同一组按键。
   */
  setupShortcuts() {
    document.addEventListener('keydown', (event) => {
      const inField = Boolean(event.target.closest && event.target.closest('input, textarea'));
      const plainCtrl = event.ctrlKey && !event.altKey && !event.shiftKey;

      if (plainCtrl && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        this.selectDirectory();
        return;
      }

      if (plainCtrl && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        const input = document.getElementById('media-search');
        if (input) {
          input.focus();
          input.select();
        }
        return;
      }

      if (event.key === 'F5') {
        event.preventDefault();
        this.loadImagesForCurrentPreview();
        return;
      }

      // 搜索框里按 Esc：清空条件并退回网格，省得再拿鼠标点小叉
      if (event.key === 'Escape' && inField && event.target.id === 'media-search') {
        event.target.value = '';
        event.target.blur();
        Waterfall.applyFilters();
      }
    });
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

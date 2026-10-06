'use strict';

const ContextMenu = {
  el: null,
  currentImageInfo: null,
  _targetImages: [],

  init() {
    this.el = document.getElementById('context-menu');
    this.el.querySelector('[data-action="favorite"]').addEventListener('click', () => this.onFavorite());
    this.el.querySelector('[data-action="copy-path"]').addEventListener('click', () => this.onCopyPath());
    this.el.querySelector('[data-action="show-in-explorer"]').addEventListener('click', () => this.onShowInExplorer());
    this.el.querySelector('[data-action="rename"]').addEventListener('click', () => this.onRename());
    this.el.querySelector('[data-action="delete"]').addEventListener('click', () => this.onDelete());

    document.addEventListener('click', () => this.hide());
    document.addEventListener('contextmenu', (event) => {
      if (!event.target.closest('.image-card') && !event.target.closest('.preview-image-area')) this.hide();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.hide();
    });
  },

  show(x, y, imageInfo, canRename, targetImages) {
    this.currentImageInfo = imageInfo;
    this._targetImages = targetImages || [imageInfo];
    const count = this._targetImages.length;
    this.el.querySelector('[data-action="rename"]').style.display = (canRename && count === 1) ? '' : 'none';
    this.el.querySelector('[data-action="delete"]').textContent = count > 1 ? `删除选中 (${count})` : '删除';
    this.el.querySelector('[data-action="favorite"]').textContent = imageInfo.favorite ? '取消收藏' : '收藏';

    this.el.classList.remove('hidden');
    const menuRect = this.el.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, window.innerWidth - menuRect.width - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - menuRect.height - 4));
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  },

  hide() {
    this.el.classList.add('hidden');
    this.currentImageInfo = null;
    this._targetImages = [];
  },

  async onFavorite() {
    const images = this._targetImages.slice();
    const target = this.currentImageInfo;
    this.hide();
    if (!target || images.length === 0) return;

    // 批量操作以当前图片的目标状态为准，避免混合选择时结果不可预测。
    const targetFavorite = !target.favorite;
    for (const imageInfo of images) {
      if (imageInfo.favorite === targetFavorite) continue;
      const result = await window.api.toggleFavorite(imageInfo.path);
      if (result.success) Waterfall.toggleFavoriteCard(imageInfo, result.favorite);
    }
  },

  async onCopyPath() {
    const info = this.currentImageInfo;
    this.hide();
    if (info) await window.api.copyFilePath(info.path);
  },

  async onShowInExplorer() {
    const info = this.currentImageInfo;
    this.hide();
    if (info) await window.api.showFileInExplorer(info.path);
  },

  async onRename() {
    const info = this.currentImageInfo;
    this.hide();
    if (!info) return;
    if (Preview.isOpen) Preview.startRename();
    else Waterfall.startRenameCard(info);
  },

  async onDelete() {
    const images = this._targetImages.slice();
    this.hide();
    if (images.length === 0) return;

    const wasPreviewOpen = Preview.isOpen;
    const previewIndex = Preview.currentIndex;
    const paths = images.map((item) => item.path);
    App.fileOperationPending = true;

    const result = images.length === 1
      ? await window.api.deleteFile(paths[0])
      : await window.api.deleteFiles(paths);

    if (result.success) Waterfall.removeCards(paths);
    else App.fileOperationPending = false;
    App._lastOpTime = Date.now();

    if (wasPreviewOpen) {
      if (Waterfall.imageList.length === 0) Preview.close();
      else Preview.open(Waterfall.imageList, Math.min(previewIndex, Waterfall.imageList.length - 1));
    }
  }
};

window.ContextMenu = ContextMenu;

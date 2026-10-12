'use strict';

const ContextMenu = {
  el: null,
  currentImageInfo: null,
  _targetImages: [],
  _restoreFocus: null,

  init() {
    this.el = document.getElementById('context-menu');
    this.el.querySelector('[data-action="open-with-default"]').addEventListener('click', () => this.onOpenWithDefault());
    this.el.querySelector('[data-action="favorite"]').addEventListener('click', () => this.onFavorite());
    this.el.querySelector('[data-action="rename"]').addEventListener('click', () => this.onRename());
    this.el.querySelector('[data-action="move-to"]').addEventListener('click', () => this.onMoveTo());
    this.el.querySelector('[data-action="copy-path"]').addEventListener('click', () => this.onCopyPath());
    this.el.querySelector('[data-action="show-in-explorer"]').addEventListener('click', () => this.onShowInExplorer());
    this.el.querySelector('[data-action="delete"]').addEventListener('click', () => this.onDelete());

    // 键盘导航：菜单是 role=menu，条目是 role=menuitem，上下键循环、Home/End 跳首尾、
    // Enter/Space 激活、Esc 关闭并把焦点还给原来的卡片。
    this.el.addEventListener('keydown', (event) => this.handleKeydown(event));

    document.addEventListener('click', () => this.hide());
    document.addEventListener('contextmenu', (event) => {
      if (!event.target.closest('.image-card') && !event.target.closest('.preview-image-area')) this.hide();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.hide();
    });
  },

  /** 当前可见的菜单项（重命名等条目会按上下文隐藏）。 */
  items() {
    return Array.from(this.el.querySelectorAll('.context-menu-item'))
      .filter((item) => item.style.display !== 'none');
  },

  handleKeydown(event) {
    const items = this.items();
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement);

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      // 焦点不在菜单项上时（例如刚用鼠标打开），从第一项或最后一项进入
      const base = current === -1 ? (delta > 0 ? -1 : 0) : current;
      items[(base + delta + items.length) % items.length].focus();
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      items[event.key === 'Home' ? 0 : items.length - 1].focus();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      // 直接 click 走同一条路径，避免键盘与鼠标两套行为漂移
      (current === -1 ? items[0] : items[current]).click();
      return;
    }
    if (event.key === 'Tab') {
      // Tab 不该在菜单里游走，直接关掉并把焦点交还页面
      this.hide();
    }
  },

  show(x, y, imageInfo, canRename, targetImages) {
    this.currentImageInfo = imageInfo;
    this._targetImages = targetImages || [imageInfo];
    this._restoreFocus = document.activeElement;
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

    // 打开就把焦点放进菜单，屏幕阅读器和键盘用户才能立刻操作
    const items = this.items();
    if (items.length > 0) items[0].focus();
  },

  hide() {
    const wasOpen = !this.el.classList.contains('hidden');
    this.el.classList.add('hidden');
    this.currentImageInfo = null;
    this._targetImages = [];
    // 只在菜单确实开着、且焦点还留在菜单里时归还焦点，避免抢走用户新的聚焦目标
    if (wasOpen && this.el.contains(document.activeElement) && this._restoreFocus && this._restoreFocus.isConnected) {
      this._restoreFocus.focus();
    }
    this._restoreFocus = null;
  },

  async onOpenWithDefault() {
    const info = this.currentImageInfo;
    this.hide();
    if (!info) return;
    Toast.report(await window.api.openFile(info.path));
  },

  async onFavorite() {
    const images = this._targetImages.slice();
    const target = this.currentImageInfo;
    this.hide();
    if (!target || images.length === 0) return;

    // 批量操作以当前图片的目标状态为准，避免混合选择时结果不可预测。
    const targetFavorite = !target.favorite;
    let failed = 0;
    for (const imageInfo of images) {
      if (imageInfo.favorite === targetFavorite) continue;
      const result = await window.api.toggleFavorite(imageInfo.path);
      if (result.success) Waterfall.toggleFavoriteCard(imageInfo, result.favorite);
      else failed += 1;
    }
    if (failed > 0) Toast.error(`${failed} 个文件的收藏状态没能保存`);
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

  async onMoveTo() {
    const images = this._targetImages.slice();
    this.hide();
    if (images.length === 0) return;

    const picked = await window.api.selectDirectory('选择要移动到的文件夹');
    if (!picked || !picked.path) return;

    const wasPreviewOpen = Preview.isOpen;
    const previewIndex = Preview.currentIndex;
    App.fileOperationPending = true;

    const result = await window.api.moveFiles(images.map((item) => item.path), picked.path);
    const total = images.length;
    const movedPaths = (result && result.movedPaths) || [];

    if (movedPaths.length >= total) {
      Waterfall.removeCards(movedPaths);
      Toast.success(`已移动 ${movedPaths.length} 个文件`);
    } else if (movedPaths.length > 0) {
      // 部分成功：与其留下已经不在磁盘上的卡片，不如重新扫描让视图和磁盘一致
      App.fileOperationPending = false;
      await App.loadImagesForCurrentPreview();
      Toast.error(`${total - movedPaths.length} 个文件未能移动：\n${result.error}`);
    } else {
      App.fileOperationPending = false;
      Toast.error((result && result.error) || '移动失败');
    }
    App._lastOpTime = Date.now();

    if (wasPreviewOpen) {
      if (Waterfall.imageList.length === 0) Preview.close();
      else Preview.open(Waterfall.imageList, Math.min(previewIndex, Waterfall.imageList.length - 1));
    }
  },

  async onDelete() {
    const images = this._targetImages.slice();
    this.hide();
    if (images.length === 0) return;
    await this.deleteImages(images);
  },

  /**
   * 删除一组图片。右键菜单的「删除」和网格上的 Delete 键走同一条路径，
   * 免得两条分支对"部分成功"的处理迟早分叉。
   */
  async deleteImages(images) {
    if (!images || images.length === 0) return;

    const wasPreviewOpen = Preview.isOpen;
    const previewIndex = Preview.currentIndex;
    const paths = images.map((item) => item.path);
    App.fileOperationPending = true;

    const result = images.length === 1
      ? await window.api.deleteFile(paths[0])
      : await window.api.deleteFiles(paths);

    const total = paths.length;
    // successCount 只在批量删除里有；单文件删除成功就是全部成功
    const deletedCount = result.successCount === undefined ? (result.success ? total : 0) : result.successCount;

    if (deletedCount >= total) {
      Waterfall.removeCards(paths);
    } else if (deletedCount > 0) {
      App.fileOperationPending = false;
      await App.loadImagesForCurrentPreview();
      Toast.error(`${total - deletedCount} 个文件删除失败，可能正被其他程序占用`);
    } else if (result.error) {
      App.fileOperationPending = false;
      Toast.error(result.error);
    } else if (result.successCount === 0) {
      // delete-files 全部失败时不带 error 字段，只有 successCount: 0
      App.fileOperationPending = false;
      Toast.error('删除失败，文件可能正被其他程序占用');
    } else {
      // 用户在确认框里点了取消，静默返回
      App.fileOperationPending = false;
    }
    App._lastOpTime = Date.now();

    if (wasPreviewOpen) {
      if (Waterfall.imageList.length === 0) Preview.close();
      else Preview.open(Waterfall.imageList, Math.min(previewIndex, Waterfall.imageList.length - 1));
    }
  }
};

window.ContextMenu = ContextMenu;

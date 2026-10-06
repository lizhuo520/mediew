const FolderTree = {
  container: null,
  rootPath: null,
  onFolderPreview: null,
  _dragPath: null,

  selectedFolders: new Set(),
  lastClickedFolderIndex: -1,
  _isSelecting: false,
  _selectBox: null,
  _selectStartX: 0,
  _selectStartY: 0,
  _rubberBandCtrl: false,

  init(containerId, onFolderPreview) {
    this.container = document.getElementById(containerId);
    this.onFolderPreview = onFolderPreview;
    this.setupContextMenu();
    this.setupSelection();
  },

  setupContextMenu() {
    const menu = document.getElementById('folder-context-menu');
    document.addEventListener('click', () => {
      menu.classList.add('hidden');
    });
    document.addEventListener('contextmenu', (e) => {
      if (!menu.contains(e.target)) {
        menu.classList.add('hidden');
      }
    });

    menu.querySelectorAll('.context-menu-item').forEach(item => {
      item.addEventListener('click', async () => {
        const action = item.dataset.action;
        const dirPath = menu.dataset.dirPath;
        const isRoot = menu.dataset.isRoot === 'true';
        menu.classList.add('hidden');
        if (!dirPath) return;

        if (action === 'new-folder') {
          await this.handleNewFolder(dirPath);
        } else if (action === 'rename' && !isRoot) {
          this.handleRenameFolder(dirPath);
        } else if (action === 'delete' && !isRoot) {
          if (this.selectedFolders.size > 1) {
            await this.handleBatchDeleteFolders();
          } else {
            await this.handleDeleteFolder(dirPath);
          }
        } else if (action === 'open-in-explorer') {
          window.api.openInExplorer(dirPath);
        }
      });
    });
  },

  setupSelection() {
    this.container.addEventListener('mousedown', (e) => {
      if (e.target.closest('.folder-item')) return;
      if (e.button !== 0) return;

      this._isSelecting = true;
      this._rubberBandCtrl = e.ctrlKey;

      const containerRect = this.container.getBoundingClientRect();
      this._selectStartX = e.clientX - containerRect.left + this.container.scrollLeft;
      this._selectStartY = e.clientY - containerRect.top + this.container.scrollTop;

      if (!e.ctrlKey) {
        this.clearSelection();
      }

      this._selectBox = document.createElement('div');
      this._selectBox.className = 'selection-box';
      this.container.appendChild(this._selectBox);

      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!this._isSelecting || !this._selectBox) return;

      const containerRect = this.container.getBoundingClientRect();
      const currentX = e.clientX - containerRect.left + this.container.scrollLeft;
      const currentY = e.clientY - containerRect.top + this.container.scrollTop;

      const left = Math.min(this._selectStartX, currentX);
      const top = Math.min(this._selectStartY, currentY);
      const width = Math.abs(currentX - this._selectStartX);
      const height = Math.abs(currentY - this._selectStartY);

      this._selectBox.style.left = left + 'px';
      this._selectBox.style.top = top + 'px';
      this._selectBox.style.width = width + 'px';
      this._selectBox.style.height = height + 'px';

      this._updateRubberBandSelection(left, top, width, height);
    });

    document.addEventListener('mouseup', () => {
      if (!this._isSelecting) return;
      this._isSelecting = false;
      if (this._selectBox) {
        this._selectBox.remove();
        this._selectBox = null;
      }
    });
  },

  _updateRubberBandSelection(selLeft, selTop, selWidth, selHeight) {
    const containerRect = this.container.getBoundingClientRect();
    const allItems = this.container.querySelectorAll('.folder-item');

    allItems.forEach(item => {
      const itemRect = item.getBoundingClientRect();
      const itemLeft = itemRect.left - containerRect.left + this.container.scrollLeft;
      const itemTop = itemRect.top - containerRect.top + this.container.scrollTop;
      const itemWidth = itemRect.width;
      const itemHeight = itemRect.height;

      const intersects = !(
        selLeft > itemLeft + itemWidth ||
        selLeft + selWidth < itemLeft ||
        selTop > itemTop + itemHeight ||
        selTop + selHeight < itemTop
      );

      const folderPath = item.dataset.path;
      if (!folderPath) return;
      if (folderPath === this.rootPath) return;

      if (intersects) {
        this.selectedFolders.add(folderPath);
        item.classList.add('selected');
      } else if (!this._rubberBandCtrl) {
        this.selectedFolders.delete(folderPath);
        item.classList.remove('selected');
      }
    });
  },

  clearSelection() {
    this.selectedFolders.clear();
    this.lastClickedFolderIndex = -1;
    this.container.querySelectorAll('.folder-item.selected').forEach(el => {
      el.classList.remove('selected');
    });
  },

  _getVisibleFolderItems() {
    return Array.from(this.container.querySelectorAll('.folder-item'));
  },

  _getVisibleFolderIndex(item) {
    return this._getVisibleFolderItems().indexOf(item);
  },

  handleFolderClick(e, fullPath, item) {
    if (e.ctrlKey) {
      if (this.selectedFolders.has(fullPath)) {
        this.selectedFolders.delete(fullPath);
        item.classList.remove('selected');
      } else {
        this.selectedFolders.add(fullPath);
        item.classList.add('selected');
      }
      this.lastClickedFolderIndex = this._getVisibleFolderIndex(item);
    } else if (e.shiftKey) {
      if (this.lastClickedFolderIndex === -1) {
        this.lastClickedFolderIndex = this._getVisibleFolderIndex(item);
      }
      const allItems = this._getVisibleFolderItems();
      const start = Math.min(this.lastClickedFolderIndex, this._getVisibleFolderIndex(item));
      const end = Math.max(this.lastClickedFolderIndex, this._getVisibleFolderIndex(item));
      for (let i = start; i <= end; i++) {
        if (i < allItems.length) {
          const p = allItems[i].dataset.path;
          if (p && p !== this.rootPath) {
            this.selectedFolders.add(p);
            allItems[i].classList.add('selected');
          }
        }
      }
    } else {
      this.clearSelection();
      this.selectedFolders.add(fullPath);
      item.classList.add('selected');
      this.lastClickedFolderIndex = this._getVisibleFolderIndex(item);
      this.previewFolder(fullPath, item);
    }
  },

  showContextMenu(x, y, dirPath, isRoot) {
    const menu = document.getElementById('folder-context-menu');

    if (!isRoot) {
      const item = this.findWrapper(dirPath);
      if (item) {
        dirPath = item.dataset.path;
      }
    }

    if (!isRoot && !this.selectedFolders.has(dirPath)) {
      this.clearSelection();
      this.selectedFolders.add(dirPath);
      const item = this.findWrapper(dirPath);
      if (item) item.classList.add('selected');
    }

    const count = this.selectedFolders.size;

    menu.dataset.dirPath = dirPath;
    menu.dataset.isRoot = isRoot;
    menu.classList.remove('hidden');

    const deleteItem = menu.querySelector('[data-action="delete"]');
    const renameItem = menu.querySelector('[data-action="rename"]');
    const newItem = menu.querySelector('[data-action="new-folder"]');

    if (isRoot) {
      deleteItem.style.display = 'none';
      renameItem.style.display = 'none';
      newItem.style.display = '';
    } else if (count > 1) {
      deleteItem.textContent = `删除选中文件夹 (${count})`;
      deleteItem.style.display = '';
      renameItem.style.display = 'none';
      newItem.style.display = 'none';
    } else {
      deleteItem.textContent = '删除文件夹';
      deleteItem.style.display = '';
      renameItem.style.display = '';
      newItem.style.display = '';
    }

    const menuRect = menu.getBoundingClientRect();
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    let left = x;
    let top = y;
    if (x + menuRect.width > winW) left = x - menuRect.width;
    if (y + menuRect.height > winH) top = y - menuRect.height;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  },

  findWrapper(dirPath) {
    return this.container.querySelector(`.folder-wrapper > .folder-item[data-path="${CSS.escape(dirPath)}"]`);
  },

  async handleNewFolder(parentDir) {
    const existingFolders = await window.api.getSubfolders(parentDir);
    let name = '新建文件夹';
    let counter = 0;
    while (existingFolders.includes(name)) {
      counter++;
      name = `新建文件夹（${counter}）`;
    }

    const result = await window.api.createFolder(parentDir, name);
    if (!result.success) return;

    App.fileOperationPending = true;
    const parentItem = this.findWrapper(parentDir);

    if (!parentItem) {
      await this.reloadTree();
      return;
    }

    const parentWrapper = parentItem.parentElement;
    const newItem = await this.createFolderItem(parentDir, name);

    if (parentDir === this.rootPath) {
      parentWrapper.appendChild(newItem);
    } else {
      let subList = parentWrapper.querySelector(':scope > .subfolder-list');

      if (!subList) {
        subList = document.createElement('div');
        subList.className = 'subfolder-list';
        parentWrapper.appendChild(subList);
      }

      const expandIconEl = parentItem.querySelector('.expand-icon');
      if (expandIconEl && !expandIconEl.classList.contains('expanded')) {
        expandIconEl.classList.add('expanded');
      }
      if (!subList.classList.contains('expanded')) {
        subList.classList.add('expanded');
      }

      subList.appendChild(newItem);
    }
    App._lastOpTime = Date.now();
  },

  handleRenameFolder(dirPath) {
    const item = this.findWrapper(dirPath);
    if (!item) return;
    const nameEl = item.querySelector('.folder-name');
    if (!nameEl) return;

    const currentName = nameEl.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-rename-input';
    input.value = currentName;
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    const finishRename = async () => {
      const newName = input.value.trim();
      const restored = document.createElement('span');
      restored.className = 'folder-name';
      restored.title = currentName;
      if (newName && newName !== currentName) {
        App.fileOperationPending = true;
        const result = await window.api.renameFolder(dirPath, newName);
        if (result.success) {
          restored.textContent = newName;
          restored.title = newName;
          try { input.replaceWith(restored); } catch (_) {}
          item.dataset.path = result.newPath;
          if (App.currentPath === dirPath) {
            App.currentPath = result.newPath;
            App.currentPreviewPath = result.newPath;
            document.getElementById('directory-path').textContent = result.newPath;
          }
          App._lastOpTime = Date.now();
          App.fileOperationPending = false;
          return;
        } else {
          App.fileOperationPending = false;
        }
      }
      restored.textContent = currentName;
      try { input.replaceWith(restored); } catch (_) {}
      App.fileOperationPending = false;
      App._lastOpTime = Date.now();
    };

    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = currentName; input.blur(); }
    });
  },

  async handleDeleteFolder(dirPath) {
    App.fileOperationPending = true;
    const result = await window.api.deleteFolder(dirPath);
    if (!result.success) {
      App.fileOperationPending = false;
      return;
    }
    App._lastOpTime = Date.now();

    if (this.rootPath === dirPath) {
      App.currentPath = null;
      App.currentPreviewPath = null;
      document.getElementById('directory-path').textContent = '选择目录...';
      document.getElementById('image-grid').innerHTML = '';
      document.getElementById('welcome-screen').classList.remove('hidden');
      await this.reloadTree();
      return;
    }

    if (App.currentPath === dirPath || App.currentPreviewPath === dirPath) {
      const parentPath = dirPath.substring(0, dirPath.lastIndexOf('\\'));
      const targetPath = parentPath && parentPath.startsWith(this.rootPath) ? parentPath : this.rootPath;
      App.currentPath = targetPath;
      App.currentPreviewPath = targetPath;
      const targetItem = this.findWrapper(targetPath) || this.container.querySelector('.root-folder');
      if (targetItem) this.previewFolder(targetPath, targetItem);
    }

    const item = this.findWrapper(dirPath);
    if (!item) return;
    const wrapper = item.parentElement;
    const parentWrapper = wrapper.parentElement;
    wrapper.remove();

    this.clearSelection();
  },

  async handleBatchDeleteFolders() {
    const paths = Array.from(this.selectedFolders);
    App.fileOperationPending = true;
    const result = await window.api.deleteFolders(paths);
    if (!result.success) {
      App.fileOperationPending = false;
      return;
    }
    App._lastOpTime = Date.now();

    this.clearSelection();
    await this.reloadTree();

    const currentDir = App.currentPreviewPath || App.currentPath;
    if (currentDir && !this._pathExists(currentDir)) {
      App.currentPath = this.rootPath;
      App.currentPreviewPath = this.rootPath;
      const rootItem = this.container.querySelector('.root-folder');
      if (rootItem) this.previewFolder(this.rootPath, rootItem);
    }
  },

  _pathExists(dirPath) {
    return !!this.findWrapper(dirPath) || dirPath === this.rootPath;
  },

  async reloadTree() {
    const root = this.rootPath;
    if (root) {
      await this.loadFolders(root);
    }
  },

  async loadFolders(dirPath) {
    this.rootPath = dirPath;
    this.container.innerHTML = '';
    this.clearSelection();

    const rootName = dirPath.split('\\').pop() || dirPath.split('/').pop() || dirPath;
    const rootWrapper = document.createElement('div');
    rootWrapper.className = 'folder-wrapper';

    const rootItem = document.createElement('div');
    rootItem.className = 'folder-item root-folder';
    rootItem.dataset.path = dirPath;
    rootItem.innerHTML = `
      <span class="folder-name" title="${rootName}">${rootName}</span>
      <span class="root-badge">根目录</span>
    `;
    rootItem.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handleFolderClick(e, dirPath, rootItem);
    });
    rootItem.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showContextMenu(e.clientX, e.clientY, dirPath, true);
    });

    this.setupDropZone(rootItem);
    rootWrapper.appendChild(rootItem);
    this.container.appendChild(rootWrapper);
    this.setupContainerDropZone();
    
    this.previewFolder(dirPath, rootItem);
    
    const folders = await window.api.getSubfolders(dirPath);
    
    if (folders.length === 0) {
      return;
    }

    for (const folder of folders) {
      const item = await this.createFolderItem(dirPath, folder);
      rootWrapper.appendChild(item);
    }
  },

  async createFolderItem(parentPath, folderName) {
    const fullPath = `${parentPath}\\${folderName}`;
    const wrapper = document.createElement('div');
    wrapper.className = 'folder-wrapper';

    const item = document.createElement('div');
    item.className = 'folder-item';
    item.dataset.path = fullPath;
    item.dataset.childrenLoaded = 'false';

    const expandIcon = `
      <svg class="expand-icon" viewBox="0 0 24 24" fill="currentColor">
        <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
      </svg>
    `;

    item.innerHTML = `${expandIcon}<span class="folder-name" title="${folderName}">${folderName}</span>`;
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      this.handleFolderClick(event, item.dataset.path, item);
    });
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.showContextMenu(event.clientX, event.clientY, item.dataset.path, false);
    });

    this.setupFolderDrag(item, fullPath);
    this.setupDropZone(item);

    const expandIconEl = item.querySelector('.expand-icon');
    const subList = document.createElement('div');
    subList.className = 'subfolder-list';
    subList.dataset.loaded = 'false';

    expandIconEl.addEventListener('click', async (event) => {
      event.stopPropagation();
      await this.toggleFolderChildren(item, subList, fullPath, expandIconEl);
    });

    wrapper.appendChild(item);
    wrapper.appendChild(subList);
    return wrapper;
  },

  async toggleFolderChildren(item, subList, fullPath, expandIconEl) {
    const willExpand = !subList.classList.contains('expanded');
    if (!willExpand) {
      subList.classList.remove('expanded');
      expandIconEl.classList.remove('expanded');
      return;
    }

    if (subList.dataset.loaded !== 'true') {
      subList.dataset.loading = 'true';
      const folders = await window.api.getSubfolders(fullPath);
      for (const folder of folders) {
        const child = await this.createFolderItem(fullPath, folder);
        subList.appendChild(child);
      }
      subList.dataset.loaded = 'true';
      delete subList.dataset.loading;
      if (folders.length === 0) expandIconEl.style.visibility = 'hidden';
    }

    subList.classList.add('expanded');
    expandIconEl.classList.add('expanded');
  },

  previewFolder(path, element) {
    document.querySelectorAll('.folder-item.active').forEach(el => {
      el.classList.remove('active');
    });
    element.classList.add('active');
    
    if (this.onFolderPreview) {
      this.onFolderPreview(path);
    }
  },

  expandFolder(path) {
    const item = this.findWrapper(path);
    if (!item) return;
    const expandIconEl = item.querySelector('.expand-icon');
    const wrapper = item.parentElement;
    const subList = wrapper ? wrapper.querySelector(':scope > .subfolder-list') : null;
    if (subList && expandIconEl && !subList.classList.contains('expanded')) {
      this.toggleFolderChildren(item, subList, path, expandIconEl);
    }
  },

  setupFolderDrag(element, dirPath) {
    element.draggable = true;
    element.addEventListener('dragstart', (e) => {
      const currentPath = element.dataset.path;
      this._dragPath = currentPath;
      e.dataTransfer.setData('text/plain', currentPath);
      e.dataTransfer.setData('application/x-folder-path', currentPath);
      e.dataTransfer.effectAllowed = 'move';
      element.classList.add('dragging');
    });
    element.addEventListener('dragend', () => {
      this._dragPath = null;
      element.classList.remove('dragging');
    });
  },

  setupContainerDropZone() {
    this.container.addEventListener('dragover', (e) => {
      if (e.target !== this.container) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      this.container.classList.add('drag-over');
    });

    this.container.addEventListener('dragleave', (e) => {
      if (e.target === this.container) {
        this.container.classList.remove('drag-over');
      }
    });

    this.container.addEventListener('drop', async (e) => {
      if (e.target !== this.container) return;
      e.preventDefault();
      this.container.classList.remove('drag-over');
      const destDir = this.rootPath;
      if (!destDir) return;

      const folderPath = e.dataTransfer.getData('application/x-folder-path');
      if (folderPath) {
        if (folderPath === destDir) return;
        if (destDir.startsWith(folderPath + '\\') || destDir === folderPath) return;
        App.fileOperationPending = true;
        const result = await window.api.moveFolder(folderPath, destDir);
        if (result.success) {
          await this.reloadTree();
          this.expandFolder(destDir);
          if (App.currentPath === folderPath || App.currentPreviewPath === folderPath) {
            App.currentPath = result.newPath;
            App.currentPreviewPath = result.newPath;
            document.getElementById('directory-path').textContent = result.newPath;
          }
        } else {
          App.fileOperationPending = false;
        }
        App._lastOpTime = Date.now();
        return;
      }

      const batchPaths = e.dataTransfer.getData('application/x-file-paths');
      if (batchPaths) {
        const paths = JSON.parse(batchPaths);
        App.fileOperationPending = true;
        let successCount = 0;
        for (const filePath of paths) {
          if (filePath === destDir) continue;
          const result = await window.api.moveFile(filePath, destDir);
          if (result.success) successCount++;
        }
        if (successCount > 0) {
          Waterfall.removeCards(paths);
          if (destDir === App.currentPreviewPath) {
            await Waterfall.loadImages(destDir);
          }
        }
        App._lastOpTime = Date.now();
        App.fileOperationPending = false;
        return;
      }

      const filePath = e.dataTransfer.getData('text/plain');
      if (!filePath) return;
      if (filePath === destDir) return;

      App.fileOperationPending = true;
      const result = await window.api.moveFile(filePath, destDir);
      if (result.success) {
        Waterfall.removeCards([filePath]);
        if (destDir === App.currentPreviewPath) {
          await Waterfall.loadImages(destDir);
        }
      }
      App._lastOpTime = Date.now();
      App.fileOperationPending = false;
    });
  },

  setupDropZone(element) {
    element.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      element.classList.add('drag-over');
    });

    element.addEventListener('dragleave', (e) => {
      if (!element.contains(e.relatedTarget)) {
        element.classList.remove('drag-over');
      }
    });

    element.addEventListener('drop', async (e) => {
      e.preventDefault();
      element.classList.remove('drag-over');
      const destDir = element.dataset.path;
      if (!destDir) return;

      const folderPath = e.dataTransfer.getData('application/x-folder-path');
      if (folderPath) {
        if (folderPath === destDir) return;
        if (destDir.startsWith(folderPath + '\\') || destDir === folderPath) return;
        App.fileOperationPending = true;
        const result = await window.api.moveFolder(folderPath, destDir);
        if (result.success) {
          await this.reloadTree();
          this.expandFolder(destDir);
          if (App.currentPath === folderPath || App.currentPreviewPath === folderPath) {
            App.currentPath = result.newPath;
            App.currentPreviewPath = result.newPath;
            document.getElementById('directory-path').textContent = result.newPath;
          }
        } else {
          App.fileOperationPending = false;
        }
        App._lastOpTime = Date.now();
        return;
      }

      const batchPaths = e.dataTransfer.getData('application/x-file-paths');
      if (batchPaths) {
        const paths = JSON.parse(batchPaths);
        App.fileOperationPending = true;
        let successCount = 0;
        for (const filePath of paths) {
          if (filePath === destDir) continue;
          const result = await window.api.moveFile(filePath, destDir);
          if (result.success) successCount++;
        }
        if (successCount > 0) {
          Waterfall.removeCards(paths);
          if (destDir === App.currentPreviewPath) {
            await Waterfall.loadImages(destDir);
          }
        }
        App._lastOpTime = Date.now();
        App.fileOperationPending = false;
        return;
      }

      const filePath = e.dataTransfer.getData('text/plain');
      if (!filePath) return;
      if (filePath === destDir) return;

      App.fileOperationPending = true;
      const result = await window.api.moveFile(filePath, destDir);
      if (result.success) {
        Waterfall.removeCards([filePath]);
        if (destDir === App.currentPreviewPath) {
          await Waterfall.loadImages(destDir);
        }
      }
      App._lastOpTime = Date.now();
      App.fileOperationPending = false;
    });
  }
};

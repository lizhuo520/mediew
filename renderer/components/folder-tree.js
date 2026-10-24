'use strict';

// 文件夹名会拼进 innerHTML，必须先转义：名字里带 < > & " 的目录
// 会把结构拆坏（甚至注入标记），而目录名是用户可以任意取的。
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function baseName(targetPath) {
  return String(targetPath || '').split(/[\\/]/).filter(Boolean).pop() || String(targetPath || '');
}

// 拼接子路径时保持父路径的分隔符风格，不再硬编码反斜杠。
function joinPath(parent, child) {
  const base = String(parent || '').replace(/[\\/]+$/, '');
  // "C:" 这种只有盘符的情况按 Windows 习惯补反斜杠
  const sep = (base.includes('\\') || /^[A-Za-z]:$/.test(base)) ? '\\' : '/';
  return `${base}${sep}${child}`;
}

// 上一级目录，同样不假设分隔符是反斜杠。
function dirName(targetPath) {
  const trimmed = String(targetPath || '').replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return cut <= 0 ? '' : trimmed.slice(0, cut);
}

const FolderTree = {
  container: null,
  rootPath: null,
  onFolderPreview: null,
  _dragPath: null,
  // loadFolders 的异步代次：切根目录时旧请求的结果一律丢弃。
  _loadGeneration: 0,

  selectedFolders: new Set(),
  lastClickedFolderIndex: -1,
  // roving tabindex 的落点，重载目录树后靠它决定 Tab 进到哪一项
  _treeIndex: -1,
  _isSelecting: false,
  _selectBox: null,
  _selectStartX: 0,
  _selectStartY: 0,
  _rubberBandCtrl: false,

  init(containerId, onFolderPreview) {
    this.container = document.getElementById(containerId);
    this.onFolderPreview = onFolderPreview;
    // 树用 role="tree" + roving tabindex：Tab 只落到"当前文件夹"一项上，
    // 层级内部靠方向键走（左收右展、上下移动），与 Windows 资源管理器一致。
    if (this.container) {
      this.container.setAttribute('role', 'tree');
      this.container.setAttribute('aria-label', '文件夹');
      this.container.addEventListener('keydown', (event) => this.handleTreeKeydown(event));
    }
    this.setupContextMenu();
    this.setupSelection();
    // 容器上的放置区只装一次：原先放在 loadFolders 里，每换一次目录就多叠一层
    // 监听器，同一次拖放会被执行 N 遍。
    this.setupContainerDropZone();
  },

  // ---------- 键盘可达性 ----------
  applyItemAccessibility(item, folderName) {
    item.setAttribute('role', 'treeitem');
    item.setAttribute('aria-label', folderName);
    item.tabIndex = -1;
  },

  syncTreeRovingTabIndex(preferredIndex) {
    const items = this._getVisibleFolderItems();
    if (items.length === 0) {
      this._treeIndex = -1;
      return;
    }
    let index;
    if (typeof preferredIndex === 'number' && preferredIndex >= 0) {
      index = Math.min(preferredIndex, items.length - 1);
    } else if (this._treeIndex >= 0) {
      index = Math.min(this._treeIndex, items.length - 1);
    } else {
      index = 0;
    }
    items.forEach((item, position) => { item.tabIndex = position === index ? 0 : -1; });
    this._treeIndex = index;
  },

  focusFolderItemAt(index, options = {}) {
    const items = this._getVisibleFolderItems();
    if (items.length === 0) return null;
    const safeIndex = Math.max(0, Math.min(index, items.length - 1));
    const item = items[safeIndex];
    this.syncTreeRovingTabIndex(safeIndex);
    item.focus({ preventScroll: true });
    if (options.scrollIntoView !== false) {
      item.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    return item;
  },

  focusedFolderItem() {
    const active = document.activeElement;
    if (active && active.classList && active.classList.contains('folder-item')) return active;
    return null;
  },

  // 方向键的"上下"按肉眼顺序走：DOM 里每层的 .folder-item 是按先父后子的次序铺开的，
  // 直接取所有可见（已展开）项的下标就是视觉顺序。
  handleTreeKeydown(event) {
    if (event.defaultPrevented) return;
    if (!event.target.closest || !event.target.closest('.folder-item')) return;

    const items = this._getVisibleFolderItems();
    if (items.length === 0) return;
    const current = this.focusedFolderItem();
    const currentIndex = current ? items.indexOf(current) : this._treeIndex;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.focusFolderItemAt(currentIndex + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.focusFolderItemAt(currentIndex - 1);
        break;
      case 'Home':
        event.preventDefault();
        this.focusFolderItemAt(0);
        break;
      case 'End':
        event.preventDefault();
        this.focusFolderItemAt(items.length - 1);
        break;
      case 'ArrowRight':
        event.preventDefault();
        this.expandFocusedFolder(current);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        this.collapseFocusedFolder(current);
        break;
      case 'Enter':
      case ' ':
      case 'Spacebar': {
        event.preventDefault();
        if (!current) return;
        const path = current.dataset.path;
        if (path) this.handleFolderClick({ ctrlKey: false, shiftKey: false }, path, current);
        break;
      }
      case 'F2':
        event.preventDefault();
        if (current && current.dataset.path && !current.classList.contains('root-folder')) {
          this.handleRenameFolder(current.dataset.path);
        }
        break;
      case 'Delete':
        event.preventDefault();
        if (current && current.dataset.path && !current.classList.contains('root-folder')) {
          if (this.selectedFolders.size > 1) this.handleBatchDeleteFolders();
          else this.handleDeleteFolder(current.dataset.path);
        }
        break;
      case 'Escape':
        event.preventDefault();
        this.clearSelection();
        break;
      default:
        break;
    }
  },

  findParentItem(item) {
    const subList = item.closest('.subfolder-list');
    if (!subList || !subList.parentElement) return null;
    return subList.parentElement.querySelector(':scope > .folder-item');
  },

  itemSubList(item) {
    if (!item.parentElement) return null;
    return item.parentElement.querySelector(':scope > .subfolder-list');
  },

  async expandFocusedFolder(item) {
    if (!item) return;
    const subList = this.itemSubList(item);
    if (!subList) return;
    if (subList.classList.contains('expanded')) {
      // 已经展开了，右箭头按标准树行为进入第一个子项
      const items = this._getVisibleFolderItems();
      const index = items.indexOf(item);
      if (index >= 0 && items[index + 1]) this.focusFolderItemAt(index + 1);
      return;
    }
    await this.toggleFolderChildren(item, subList, item.dataset.path, item.querySelector('.expand-icon'));
  },

  collapseFocusedFolder(item) {
    if (!item) return;
    const subList = this.itemSubList(item);
    if (subList && subList.classList.contains('expanded')) {
      this.toggleFolderChildren(item, subList, item.dataset.path, item.querySelector('.expand-icon'));
      return;
    }
    // 已是收起状态：左箭头按标准树行为回到父项
    const parent = this.findParentItem(item);
    if (!parent) return;
    this.focusFolderItemAt(this._getVisibleFolderItems().indexOf(parent));
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
        item.setAttribute('aria-selected', 'true');
      } else if (!this._rubberBandCtrl) {
        this.selectedFolders.delete(folderPath);
        item.classList.remove('selected');
        item.setAttribute('aria-selected', 'false');
      }
    });
  },

  clearSelection() {
    this.selectedFolders.clear();
    this.lastClickedFolderIndex = -1;
    this.container.querySelectorAll('.folder-item.selected').forEach(el => {
      el.classList.remove('selected');
      el.setAttribute('aria-selected', 'false');
    });
  },

  _getVisibleFolderItems() {
    // 收起的分支是 display:none 但仍在 DOM 里，必须按渲染状态过滤：
    // 否则方向键会走到看不见的项上（框选也会把折叠里的项一起选中）。
    return Array.from(this.container.querySelectorAll('.folder-item'))
      .filter((item) => item.offsetParent !== null);
  },

  _getVisibleFolderIndex(item) {
    return this._getVisibleFolderItems().indexOf(item);
  },

  handleFolderClick(e, fullPath, item) {
    if (e.ctrlKey) {
      if (this.selectedFolders.has(fullPath)) {
        this.selectedFolders.delete(fullPath);
        item.classList.remove('selected');
        item.setAttribute('aria-selected', 'false');
      } else {
        this.selectedFolders.add(fullPath);
        item.classList.add('selected');
        item.setAttribute('aria-selected', 'true');
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
            allItems[i].setAttribute('aria-selected', 'true');
          }
        }
      }
    } else {
      this.clearSelection();
      this.selectedFolders.add(fullPath);
      item.classList.add('selected');
      item.setAttribute('aria-selected', 'true');
      this.lastClickedFolderIndex = this._getVisibleFolderIndex(item);
      this.previewFolder(fullPath, item);
    }
    // 鼠标点中的那一项同时成为 Tab 的落点
    this.syncTreeRovingTabIndex(this._getVisibleFolderIndex(item));
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
      if (item) {
        item.classList.add('selected');
        item.setAttribute('aria-selected', 'true');
      }
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
    if (!result.success) {
      Toast.error(result.error || '新建文件夹失败');
      return;
    }

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
          Toast.error(result.error || '重命名文件夹失败');
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
      // 没有 error 说明是用户在确认框里点了取消
      if (result.error) Toast.error(result.error);
      return;
    }
    App._lastOpTime = Date.now();

    if (this.rootPath === dirPath) {
      App.currentPath = null;
      App.currentPreviewPath = null;
      document.getElementById('directory-path').textContent = '选择目录...';
      // 只清 grid 的 DOM 不够：Waterfall 里的 allImages/selectedPaths/_cardByPath
      // 还留着已删目录的内容，之后任何 rebuild 都会把它们重新渲染回来（或者
      // 让 Delete 作用在已不存在的路径上）。
      if (typeof Waterfall !== 'undefined' && Waterfall.reset) Waterfall.reset();
      else document.getElementById('image-grid').innerHTML = '';
      document.getElementById('welcome-screen').classList.remove('hidden');
      await this.reloadTree();
      return;
    }

    if (App.currentPath === dirPath || App.currentPreviewPath === dirPath) {
      const parentPath = dirName(dirPath);
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
      if (result.error) Toast.error(result.error);
      else if (result.successCount === 0) Toast.error('删除文件夹失败，可能正被其他程序占用');
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
    // 每次换根目录都发一张"票"。getSubfolders 是 await 的，慢盘/网络盘上
    // 上一次的结果可能比这一次还晚回来，那种情况下必须整个丢弃，否则树会被
    // 旧目录的内容覆盖（还会把 rootPath 指回旧路径）。
    const generation = ++this._loadGeneration;
    this.rootPath = dirPath;
    this.container.innerHTML = '';
    this.clearSelection();

    const rootName = baseName(dirPath) || dirPath;
    const rootWrapper = document.createElement('div');
    rootWrapper.className = 'folder-wrapper';

    const rootItem = document.createElement('div');
    rootItem.className = 'folder-item root-folder';
    rootItem.dataset.path = dirPath;
    rootItem.innerHTML = `
      <span class="folder-name" title="${escapeHtml(rootName)}">${escapeHtml(rootName)}</span>
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
    this.applyItemAccessibility(rootItem, rootName);
    rootItem.setAttribute('aria-level', '1');

    this.setupDropZone(rootItem);
    rootWrapper.appendChild(rootItem);
    this.container.appendChild(rootWrapper);
    
    this.previewFolder(dirPath, rootItem);
    
    const folders = await window.api.getSubfolders(dirPath);
    if (generation !== this._loadGeneration) return;
    
    if (folders.length === 0) {
      this.syncTreeRovingTabIndex(0);
      return;
    }

    for (const folder of folders) {
      // createFolderItem 内部还有 await（懒加载图标/统计），逐项复查代次。
      if (generation !== this._loadGeneration) return;
      const item = await this.createFolderItem(dirPath, folder);
      if (generation !== this._loadGeneration) return;
      rootWrapper.appendChild(item);
    }
    if (generation !== this._loadGeneration) return;
    this.syncTreeRovingTabIndex(0);
  },

  async createFolderItem(parentPath, folderName) {
    const fullPath = joinPath(parentPath, folderName);
    const wrapper = document.createElement('div');
    wrapper.className = 'folder-wrapper';

    const item = document.createElement('div');
    item.className = 'folder-item';
    item.dataset.path = fullPath;
    item.dataset.childrenLoaded = 'false';
    this.applyItemAccessibility(item, folderName);

    const expandIcon = `
      <svg class="expand-icon" viewBox="0 0 24 24" fill="currentColor">
        <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
      </svg>
    `;

    item.innerHTML = `${expandIcon}<span class="folder-name" title="${escapeHtml(folderName)}">${escapeHtml(folderName)}</span>`;
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
      item.setAttribute('aria-expanded', 'false');
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
      // 只有确认过子目录数量才写 aria-expanded，否则读屏会说"可展开"却展不开
      if (folders.length > 0) item.setAttribute('aria-expanded', 'true');
    } else {
      item.setAttribute('aria-expanded', 'true');
    }

    subList.classList.add('expanded');
    expandIconEl.classList.add('expanded');
  },

  previewFolder(path, element) {
    document.querySelectorAll('.folder-item.active').forEach(el => {
      el.classList.remove('active');
      el.removeAttribute('aria-current');
    });
    element.classList.add('active');
    element.setAttribute('aria-current', 'true');
    this._treeIndex = this._getVisibleFolderIndex(element);
    
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

  // 容器空白处的放置目标 = 根目录。
  // 旧实现用 `e.target !== this.container` 当守卫，但容器里几乎铺满了 .folder-wrapper，
  // 事件目标永远不是容器本身，于是"拖到空白处移到根目录"实际上从未生效。
  setupContainerDropZone() {
    const isItemTarget = (e) => Boolean(e.target.closest && e.target.closest('.folder-item'));

    this.container.addEventListener('dragover', (e) => {
      if (isItemTarget(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      this.container.classList.add('drag-over');
    });

    this.container.addEventListener('dragleave', (e) => {
      if (!this.container.contains(e.relatedTarget)) {
        this.container.classList.remove('drag-over');
      }
    });

    this.container.addEventListener('drop', async (e) => {
      if (isItemTarget(e)) return;
      e.preventDefault();
      this.container.classList.remove('drag-over');
      const destDir = this.rootPath;
      if (!destDir) return;

      await this.handleDropOnFolder(destDir, e.dataTransfer);
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
      // 不冒泡到容器，否则同一次 drop 会被当成"移到根目录"再执行一遍
      e.stopPropagation();
      element.classList.remove('drag-over');
      const destDir = element.dataset.path;
      if (!destDir) return;

      await this.handleDropOnFolder(destDir, e.dataTransfer);
    });
  },

  _basename(targetPath) {
    return baseName(targetPath);
  },

  /**
   * 把拖拽内容移动到 destDir。
   * 原先「文件夹条目」和「树空白处」各有一份约 100 行的重复实现，
   * 两份都已经漂移，这里合成唯一一份。
   */
  async handleDropOnFolder(destDir, dataTransfer) {
    const folderPath = dataTransfer.getData('application/x-folder-path');
    if (folderPath) {
      if (folderPath === destDir) return;
      if (destDir.startsWith(folderPath + '\\') || destDir === folderPath) return;
      App.fileOperationPending = true;
      const result = await window.api.moveFolder(folderPath, destDir);
      if (result.success) {
        await this.reloadTree();
        this.expandFolder(destDir);
        Toast.success(`已移动「${this._basename(folderPath)}」到「${this._basename(destDir)}」`);
        if (App.currentPath === folderPath || App.currentPreviewPath === folderPath) {
          App.currentPath = result.newPath;
          App.currentPreviewPath = result.newPath;
          document.getElementById('directory-path').textContent = result.newPath;
        }
      } else {
        App.fileOperationPending = false;
        Toast.error(result.error || '移动文件夹失败');
      }
      App._lastOpTime = Date.now();
      return;
    }

    const batchRaw = dataTransfer.getData('application/x-file-paths');
    const single = dataTransfer.getData('text/plain');
    let paths = [];
    if (batchRaw) {
      try {
        paths = JSON.parse(batchRaw);
      } catch (_) {
        paths = [];
      }
    } else if (single) {
      paths = [single];
    }
    if (!Array.isArray(paths) || paths.length === 0) return;

    App.fileOperationPending = true;
    const result = await window.api.moveFiles(paths, destDir);
    const movedPaths = (result && result.movedPaths) || [];

    if (movedPaths.length > 0) {
      // 只移除真的移动成功的卡片，失败的要留在原处
      Waterfall.removeCards(movedPaths);
      if (destDir === App.currentPreviewPath) {
        await Waterfall.loadImages(destDir);
      }
      Toast.success(`已移动 ${movedPaths.length} 个文件到「${this._basename(destDir)}」`);
    }
    if (result && result.error) {
      Toast.error(`${paths.length - movedPaths.length} 个文件未能移动：\n${result.error}`);
    }
    App._lastOpTime = Date.now();
    App.fileOperationPending = false;
  }
};

// 这几个是纯函数，但一个管目录名转义（防注入）、一个管路径拼接（反斜杠硬编码的替代），
// 都属于"错了会静默出事"的类型，导出给 node --test 直接覆盖。
// 浏览器里没有 module，typeof 守卫不会误伤。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { escapeHtml, baseName, joinPath, dirName };
}

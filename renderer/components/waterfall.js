'use strict';

const Waterfall = {
  grid: null,
  container: null,
  allImages: [],
  imageList: [],
  _allImageByPath: new Map(),
  _imageIndexMap: new Map(),
  currentDirectory: '',
  _generation: 0,
  _scanId: null,
  _scanProgress: null,
  _metadataDirty: false,
  _scanBuffers: new Map(),
  _renderPlan: [],
  _renderIndex: 0,
  _loadMoreSentinel: null,
  _loadMoreObserver: null,
  _thumbnailObserver: null,
  _thumbnailQueue: [],
  _activeThumbnails: 0,
  // 与 gkpv 的 THUMB_CONCURRENCY 一致：渲染层最多同时排队 8 个缩略图请求。
  _thumbnailConcurrency: 8,
  _batchSize: 80,
  _cardImageMap: new WeakMap(),
  _thumbnailFailed: 0,
  _thumbnailFailedNames: [],

  zoomLevel: 1.0,
  ZOOM_MIN: 0.3,
  ZOOM_MAX: 3.0,
  ZOOM_STEP: 0.1,
  STORAGE_KEY: 'Mediew-zoom',
  _zoomIndicator: null,
  _zoomTimer: null,

  selectedPaths: new Set(),
  lastClickedIndex: -1,
  // roving tabindex 记的是"当前卡片"在网格里的位置，重排/增删后靠它把焦点落回原处。
  _keyboardIndex: -1,
  _gridHadFocus: false,
  _isSelecting: false,
  _selectBox: null,
  _selectStartX: 0,
  _selectStartY: 0,
  _rubberBandCtrl: false,
  _scrollTimer: null,

  init(gridId, containerId) {
    this.grid = document.getElementById(gridId);
    this.container = document.getElementById(containerId);
    this._zoomIndicator = document.getElementById('zoom-indicator');
    // 网格用 listbox/option + roving tabindex：Tab 只能进入"当前卡片"一张，
    // 卡片之间用方向键走（见 handleGridKeydown）。若每张卡片都 tabindex="0"，
    // 一个千张图的目录会变成按一千次 Tab 才能穿过去。
    if (this.grid) {
      this.grid.setAttribute('role', 'listbox');
      this.grid.setAttribute('aria-multiselectable', 'true');
      this.grid.setAttribute('aria-label', '媒体文件');
    }
    this.loadZoom();
    this.setupZoom();
    this.setupSelection();
    this.setupKeyboard();
    this.setupScrollPerformance();
    this.setupFilterControls();
    this.setupMetadataListeners();
    this.setupThumbnailObserver();
  },

  // ---------- 键盘可达性 ----------
  // 卡片本来是裸 div，Tab 根本进不来（审计实测 7/7 不可聚焦）。
  // 这里给它们 listbox/option 语义 + roving tabindex。
  applyCardAccessibility(card, imageInfo) {
    card.setAttribute('role', 'option');
    card.setAttribute('aria-selected', 'false');
    card.tabIndex = -1;
    const label = imageInfo.relativePath || imageInfo.name || this.getBasename(imageInfo.path);
    card.setAttribute('aria-label', label);
  },

  setupKeyboard() {
    if (!this.grid) return;
    this.grid.addEventListener('keydown', (event) => this.handleGridKeydown(event));
    this.syncRovingTabIndex(0);
  },

  cards() {
    if (!this.grid) return [];
    return Array.from(this.grid.querySelectorAll('.image-card'));
  },

  focusedCard() {
    const active = document.activeElement;
    if (active && active.classList && active.classList.contains('image-card')) return active;
    return null;
  },

  // 整个网格只留一张 tabindex="0" 的卡片：Tab 进入网格 = 回到上次停留的那张，
  // 而不是从第一张开始重新按一遍。
  syncRovingTabIndex(preferredIndex) {
    const cards = this.cards();
    if (cards.length === 0) {
      this._keyboardIndex = -1;
      return;
    }
    let index;
    if (typeof preferredIndex === 'number' && preferredIndex >= 0) {
      index = GridNav.clampIndex(preferredIndex, cards.length);
    } else if (this._keyboardIndex >= 0) {
      index = GridNav.clampIndex(this._keyboardIndex, cards.length);
    } else {
      index = 0;
    }
    cards.forEach((card, position) => { card.tabIndex = position === index ? 0 : -1; });
    this._keyboardIndex = index;
  },

  focusCardAt(index, options = {}) {
    const cards = this.cards();
    if (cards.length === 0) return null;
    const safeIndex = GridNav.clampIndex(index, cards.length);
    const card = cards[safeIndex];
    this.syncRovingTabIndex(safeIndex);
    card.focus({ preventScroll: true });
    if (options.scrollIntoView !== false) {
      card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    return card;
  },

  /**
   * 量所有卡片的几何位置。卡片是 content-visibility:auto，屏外未渲染的卡片
   * getBoundingClientRect() 只会返回 contain-intrinsic-size 的占位高度，
   * 拿它算"下一行"会跳到错误的卡片上。这里临时关掉跳过布局，量完立刻恢复。
   * 只在按键时发生，不进滚动路径。
   */
  measureCardRects(cards) {
    this.grid.classList.add('measuring-geometry');
    const rects = cards.map((card) => card.getBoundingClientRect());
    this.grid.classList.remove('measuring-geometry');
    return rects;
  },

  handleGridKeydown(event) {
    if (event.defaultPrevented) return;
    if (event.target.closest('input, textarea')) return;
    // 灯箱开着时方向键归预览用（缩放、翻页），网格快捷键一律让位
    if (Preview.isOpen) return;

    const cards = this.cards();
    if (cards.length === 0) return;
    const current = this.focusedCard();
    const currentIndex = current ? cards.indexOf(current) : this._keyboardIndex;

    const direction = GridNav.directionOfKey(event.key);
    if (direction) {
      event.preventDefault();
      if (currentIndex < 0) {
        this.focusCardAt(0);
        return;
      }
      const rects = this.measureCardRects(cards);
      const nextIndex = GridNav.pickNeighbor(rects, currentIndex, direction);
      this.focusCardAt(nextIndex < 0 ? currentIndex : nextIndex);
      return;
    }

    switch (event.key) {
      case 'Home':
        event.preventDefault();
        this.focusCardAt(0);
        break;
      case 'End':
        event.preventDefault();
        this.focusCardAt(cards.length - 1);
        break;
      case 'Enter':
        event.preventDefault();
        this.openFocusedCard();
        break;
      case ' ':
      case 'Spacebar':
        event.preventDefault();
        this.toggleFocusedSelection();
        break;
      case 'F2':
        event.preventDefault();
        this.renameFocusedCard();
        break;
      case 'Delete':
        event.preventDefault();
        this.deleteFocusedCard();
        break;
      case 'Escape':
        if (this.selectedPaths.size > 0) {
          event.preventDefault();
          this.clearSelection();
          this.updateStats();
        }
        break;
      default:
        break;
    }
  },

  openFocusedCard() {
    const card = this.focusedCard();
    if (!card) return;
    const index = this.imageList.findIndex((item) => item.path === card.dataset.path);
    if (index === -1) return;
    Preview.open(this.imageList, index);
  },

  toggleFocusedSelection() {
    const card = this.focusedCard();
    if (!card) return;
    const path = card.dataset.path;
    if (!path) return;
    const selected = !this.selectedPaths.has(path);
    if (selected) this.selectedPaths.add(path);
    else this.selectedPaths.delete(path);
    card.classList.toggle('selected', selected);
    card.setAttribute('aria-selected', selected ? 'true' : 'false');
    this._keyboardIndex = this.cards().indexOf(card);
    this.lastClickedIndex = this._keyboardIndex;
    this.updateStats();
  },

  renameFocusedCard() {
    const card = this.focusedCard();
    if (!card) return;
    const imageInfo = this._cardImageMap.get(card);
    if (!imageInfo) return;
    // 与右键菜单同一道门槛：内联重命名需要卡片上有 .image-filename，只有文件名布局有
    if (SettingsManager.getSortMode() !== 'filename') {
      Toast.info('内联重命名只在「文件名」布局下可用');
      return;
    }
    this.startRenameCard(imageInfo);
  },

  async deleteFocusedCard() {
    const card = this.focusedCard();
    if (!card) return;
    const path = card.dataset.path;
    if (!path) return;
    // 焦点卡片在多选集合里就删整批，否则只删这一张 —— 与右键菜单的语义一致
    const images = this.selectedPaths.has(path) && this.selectedPaths.size > 1
      ? this.getSelectedImages()
      : this.imageList.filter((item) => item.path === path);
    if (images.length === 0) return;
    await ContextMenu.deleteImages(images);
  },

  getBasename(filePath) {
    return filePath.replace(/^.*[\\/]/, '');
  },

  getFileURL(filePath) {
    return `file:///${filePath.split(/[\\/]/).map(encodeURIComponent).join('/')}`;
  },

  /**
   * 订阅后台 EXIF 扫描结果。
   * IPC 响应与事件存在极小的竞态窗口，因此按 scanId 暂存后再统一合并。
   */
  setupMetadataListeners() {
    window.api.onMediaMetadataUpdated((payload) => this.handleMetadataBatch(payload));
    window.api.onMediaMetadataComplete((payload) => this.handleMetadataComplete(payload));
    window.api.onMediaDimensionsUpdated((payload) => this.handleDimensionsBatch(payload));
    window.api.onMediaDimensionsComplete((payload) => this.handleDimensionsComplete(payload));
    window.api.onMediaScanError((payload) => {
      this._scanProgress = null;
      this.updateStats(`扫描失败：${payload.message}`);
    });
  },

  setupFilterControls() {
    this._searchInput = document.getElementById('media-search');
    this._favoriteFilter = document.getElementById('filter-favorites');
    this._rawFilter = document.getElementById('filter-raw');
    this._recursiveFilter = document.getElementById('filter-recursive');
    this._statsElement = document.getElementById('media-stats');

    if (this._searchInput) {
      let timer = null;
      this._searchInput.addEventListener('input', () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => this.applyFilters(), 180);
      });
    }

    if (this._favoriteFilter) {
      this._favoriteFilter.addEventListener('click', () => {
        this._favoriteFilter.classList.toggle('active');
        this.applyFilters();
      });
    }

    if (this._rawFilter) {
      this._rawFilter.addEventListener('click', () => {
        this._rawFilter.classList.toggle('active');
        this.applyFilters();
      });
    }

    if (this._recursiveFilter) {
      this._recursiveFilter.addEventListener('click', () => {
        SettingsManager.setRecursiveMode(!SettingsManager.getRecursiveMode());
      });
    }
  },

  setupScrollPerformance() {
    this.container.addEventListener('scroll', () => {
      document.documentElement.classList.add('is-scrolling');
      if (this._scrollTimer) clearTimeout(this._scrollTimer);
      this._scrollTimer = setTimeout(() => {
        document.documentElement.classList.remove('is-scrolling');
      }, 120);
    }, { passive: true });
  },

  setupThumbnailObserver() {
    if (this._thumbnailObserver) this._thumbnailObserver.disconnect();
    this._thumbnailObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        this._thumbnailObserver.unobserve(entry.target);
        const imageInfo = this._cardImageMap.get(entry.target);
        if (imageInfo) this.scheduleThumbnail(entry.target, imageInfo, this._generation);
      });
    }, {
      root: this.container,
      rootMargin: '900px 0px',
      threshold: 0.01
    });
  },

  loadZoom() {
    try {
      const saved = parseFloat(localStorage.getItem(this.STORAGE_KEY));
      if (!Number.isNaN(saved) && saved >= this.ZOOM_MIN && saved <= this.ZOOM_MAX) this.zoomLevel = saved;
    } catch (_) {}
  },

  saveZoom() {
    try { localStorage.setItem(this.STORAGE_KEY, String(this.zoomLevel)); } catch (_) {}
  },

  setupZoom() {
    this.container.addEventListener('wheel', (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const delta = event.deltaY > 0 ? -this.ZOOM_STEP : this.ZOOM_STEP;
      const newZoom = Math.round(Math.max(this.ZOOM_MIN, Math.min(this.ZOOM_MAX, this.zoomLevel + delta)) * 100) / 100;
      if (newZoom === this.zoomLevel) return;
      this.zoomLevel = newZoom;
      this.saveZoom();
      this.applyZoom();
      this.showZoomIndicator();
    }, { passive: false });

    let scheduled = false;
    const observer = new ResizeObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        this.applyZoom();
      });
    });
    observer.observe(this.container);
  },

  showZoomIndicator() {
    if (!this._zoomIndicator) return;
    this._zoomIndicator.textContent = `${Math.round(this.zoomLevel * 100)}%`;
    this._zoomIndicator.classList.add('visible');
    if (this._zoomTimer) clearTimeout(this._zoomTimer);
    this._zoomTimer = setTimeout(() => this._zoomIndicator.classList.remove('visible'), 800);
  },

  applyZoom() {
    if (!this.grid || !this.container || this.grid.classList.contains('hidden')) return;
    const mode = SettingsManager.getLayoutMode();
    const sortMode = SettingsManager.getSortMode();
    const width = this.container.clientWidth;
    if (sortMode === 'filename') {
      this.applyFilenameZoom();
    } else if (mode === 'grid') {
      this.applyGridZoom(width);
    } else {
      this.applyWaterfallZoom();
    }
  },

  applyWaterfallZoom() {
    const columns = Math.max(1, Math.round(3 / this.zoomLevel));
    this.grid.style.columnCount = columns;
  },

  applyGridZoom(containerWidth) {
    const gap = 8;
    const imageHeight = Math.round(200 * this.zoomLevel);
    const columns = Math.max(1, Math.floor((containerWidth + gap) / (imageHeight + gap)));
    this.grid.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
    this.grid.style.setProperty('--grid-image-height', `${imageHeight}px`);
  },

  applyFilenameZoom() {
    const cardWidth = Math.round(180 * this.zoomLevel);
    this.grid.style.setProperty('--filename-card-width', `${cardWidth}px`);
  },

  setupSelection() {
    this.container.addEventListener('mousedown', (event) => {
      if (event.target.closest('.image-card') || event.button !== 0) return;
      this._isSelecting = true;
      this._rubberBandCtrl = event.ctrlKey;
      const rect = this.container.getBoundingClientRect();
      this._selectStartX = event.clientX - rect.left + this.container.scrollLeft;
      this._selectStartY = event.clientY - rect.top + this.container.scrollTop;
      if (!event.ctrlKey) this.clearSelection();
      this._selectBox = document.createElement('div');
      this._selectBox.className = 'selection-box';
      this.container.appendChild(this._selectBox);
      event.preventDefault();
    });

    document.addEventListener('mousemove', (event) => {
      if (!this._isSelecting || !this._selectBox) return;
      const rect = this.container.getBoundingClientRect();
      const currentX = event.clientX - rect.left + this.container.scrollLeft;
      const currentY = event.clientY - rect.top + this.container.scrollTop;
      const left = Math.min(this._selectStartX, currentX);
      const top = Math.min(this._selectStartY, currentY);
      const width = Math.abs(currentX - this._selectStartX);
      const height = Math.abs(currentY - this._selectStartY);
      this._selectBox.style.left = `${left}px`;
      this._selectBox.style.top = `${top}px`;
      this._selectBox.style.width = `${width}px`;
      this._selectBox.style.height = `${height}px`;
      this._updateRubberBandSelection(left, top, width, height);
    });

    document.addEventListener('keydown', (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'a') return;
      if (event.target.closest('input, textarea') || Preview.isOpen) return;
      event.preventDefault();
      this.selectAllFiltered();
    });

    document.addEventListener('mouseup', () => {
      if (!this._isSelecting) return;
      this._isSelecting = false;
      if (this._selectBox) this._selectBox.remove();
      this._selectBox = null;
      this.updateStats();
    });
  },

  _updateRubberBandSelection(selLeft, selTop, selWidth, selHeight) {
    const containerRect = this.container.getBoundingClientRect();
    const cards = this.grid.querySelectorAll('.image-card');
    cards.forEach((card) => {
      const rect = card.getBoundingClientRect();
      const cardLeft = rect.left - containerRect.left + this.container.scrollLeft;
      const cardTop = rect.top - containerRect.top + this.container.scrollTop;
      const intersects = !(
        selLeft > cardLeft + rect.width ||
        selLeft + selWidth < cardLeft ||
        selTop > cardTop + rect.height ||
        selTop + selHeight < cardTop
      );
      const filePath = card.dataset.path;
      if (!filePath) return;
      if (intersects) {
        this.selectedPaths.add(filePath);
        card.classList.add('selected');
      } else if (!this._rubberBandCtrl) {
        this.selectedPaths.delete(filePath);
        card.classList.remove('selected');
      }
    });
  },

  selectAllFiltered() {
    this.selectedPaths = new Set(this.imageList.map((item) => item.path));
    this.grid.querySelectorAll('.image-card').forEach((card) => {
      card.classList.add('selected');
      card.setAttribute('aria-selected', 'true');
    });
    this.updateStats();
  },

  clearSelection() {
    this.selectedPaths.clear();
    this.lastClickedIndex = -1;
    this.grid.querySelectorAll('.image-card.selected').forEach((card) => {
      card.classList.remove('selected');
      card.setAttribute('aria-selected', 'false');
    });
    this.updateStats();
  },

  getSelectedImages() {
    if (this.selectedPaths.size === 0) return [];
    return this.imageList.filter((item) => this.selectedPaths.has(item.path));
  },

  handleCardClick(event, index, card) {
    const filePath = card.dataset.path;
    if (!filePath) return;
    const cards = Array.from(this.grid.querySelectorAll('.image-card'));
    const domIndex = cards.indexOf(card);
    if (event.ctrlKey) {
      if (this.selectedPaths.has(filePath)) {
        this.selectedPaths.delete(filePath);
        card.classList.remove('selected');
      } else {
        this.selectedPaths.add(filePath);
        card.classList.add('selected');
      }
      this.lastClickedIndex = domIndex;
    } else if (event.shiftKey) {
      if (this.lastClickedIndex === -1) this.lastClickedIndex = domIndex;
      const start = Math.min(this.lastClickedIndex, domIndex);
      const end = Math.max(this.lastClickedIndex, domIndex);
      for (let i = start; i <= end; i += 1) {
        const target = cards[i];
        if (!target) continue;
        const targetPath = target.dataset.path;
        if (!targetPath) continue;
        this.selectedPaths.add(targetPath);
        target.classList.add('selected');
      }
    } else {
      this.clearSelection();
      this.selectedPaths.add(filePath);
      card.classList.add('selected');
      this.lastClickedIndex = domIndex;
    }
    // 鼠标选中的那张同时成为 Tab 的落点，键盘接着用不会跳回第一张
    this._keyboardIndex = domIndex;
    this.syncRovingTabIndex(domIndex);
    this.updateStats();
  },

  /**
   * 目录读取完成后立即渲染第一批卡片，EXIF 信息继续在后台合并。
   */
  async loadImages(dirPath) {
    const generation = ++this._generation;
    this.currentDirectory = dirPath;
    this.grid.innerHTML = '<div class="grid-loading">正在读取目录...</div>';
    this.grid.classList.remove('hidden');
    document.getElementById('welcome-screen').classList.add('hidden');
    this.allImages = [];
    this.imageList = [];
    this._renderPlan = [];
    this._renderIndex = 0;
    this._scanId = null;
    this._scanProgress = null;
    this._metadataDirty = false;
    this._scanBuffers.clear();
    this._thumbnailFailed = 0;
    this._thumbnailFailedNames = [];
    this.clearSelection();

    const sortMode = SettingsManager.getSortMode();
    const sortDir = SettingsManager.getSortDir();
    const recursive = SettingsManager.getRecursiveMode();
    const result = await window.api.readDirectory(dirPath, sortMode, sortDir, recursive);
    if (generation !== this._generation) return;

    this._scanId = result.scanId || null;
    this.allImages = Array.isArray(result.items) ? result.items : [];
    this._allImageByPath = new Map(this.allImages.map((item) => [item.path, item]));
    if (result.pendingCount) this._scanProgress = { completed: 0, total: result.pendingCount };
    this.activateBufferedScan(this._scanId);
    this.applyFilters({ resetScroll: true });
  },

  activateBufferedScan(scanId) {
    if (!scanId || !this._scanBuffers.has(scanId)) return;
    const buffered = this._scanBuffers.get(scanId);
    buffered.dimensions.forEach((payload) => this.handleDimensionsBatch(payload, true));
    buffered.batches.forEach((payload) => this.handleMetadataBatch(payload, true));
    if (buffered.complete) this.handleMetadataComplete({ scanId }, true);
    this._scanBuffers.delete(scanId);
  },

  handleMetadataBatch(payload, force = false) {
    if (!payload || !payload.scanId) return;
    if (!force && payload.scanId !== this._scanId) {
      this.bufferScanPayload(payload.scanId, 'batches', payload);
      return;
    }
    payload.items.forEach((metadata) => {
      const target = this._allImageByPath.get(metadata.path);
      if (!target) return;
      // PNG/WebP/GIF 通常没有 EXIF 尺寸，此时 readMetadata 会返回 width/height = 0。
      // 直接 Object.assign 会把已经探测好的宽高比抹成 0，卡片就失去了占位比例
      // （逐项实测：这三类格式会因此完全不占位）。所以只在 EXIF 确实给出尺寸时才覆盖。
      const { width, height, ...rest } = metadata;
      Object.assign(target, rest);
      if (width > 0 && height > 0) {
        target.width = width;
        target.height = height;
        this.applyCardAspect(target);
      }
    });
    this._metadataDirty = true;
    this._scanProgress = { completed: payload.completed || 0, total: payload.total || 0 };
    this.updateStats();
  },

  handleMetadataComplete(payload, force = false) {
    if (!payload || !payload.scanId) return;
    if (!force && payload.scanId !== this._scanId) {
      this.bufferScanPayload(payload.scanId, 'complete', true);
      return;
    }
    this._scanProgress = null;
    if (this._metadataDirty) {
      this._metadataDirty = false;
      this.applyFilters({ preserveScroll: true });
    } else {
      this.updateStats();
    }
  },

  /**
   * 后台宽高比探测的增量结果。
   * 只补写 width/height 并就地修正已渲染卡片的比例，不触发整屏重建。
   */
  handleDimensionsBatch(payload, force = false) {
    if (!payload || !payload.scanId) return;
    if (!force && payload.scanId !== this._scanId) {
      this.bufferScanPayload(payload.scanId, 'dimensions', payload);
      return;
    }
    payload.items.forEach((size) => {
      const target = this._allImageByPath.get(size.path);
      if (!target || target.width > 0) return;
      target.width = size.width;
      target.height = size.height;
      this.applyCardAspect(target);
    });
  },

  handleDimensionsComplete(payload) {
    // 尺寸通道只影响占位比例，不影响分组/排序，因此不参与 _scanBuffers 的重放，
    // 也不会和 EXIF 的 complete 标记互相干扰。
    if (!payload || payload.scanId !== this._scanId) return;
    this.updateStats();
  },

  /**
   * 把已探测到的宽高比应用到已渲染的卡片上。
   * 用属性选择器定位，与 toggleFavoriteCard / startRenameCard 的既有写法保持一致。
   */
  applyCardAspect(imageInfo) {
    if (!imageInfo.width || !imageInfo.height) return;
    const card = this.grid.querySelector(`.image-card[data-path="${CSS.escape(imageInfo.path)}"]`);
    if (!card) return;
    const image = card.querySelector('.media-thumb');
    if (image) image.style.aspectRatio = `${imageInfo.width} / ${imageInfo.height}`;
  },

  bufferScanPayload(scanId, key, value) {
    if (!this._scanBuffers.has(scanId)) {
      this._scanBuffers.set(scanId, { batches: [], dimensions: [], complete: false });
    }
    const entry = this._scanBuffers.get(scanId);
    if (key === 'batches') {
      entry.batches.push(value);
      if (entry.batches.length > 100) entry.batches.shift();
    } else if (key === 'dimensions') {
      entry.dimensions.push(value);
      if (entry.dimensions.length > 100) entry.dimensions.shift();
    } else {
      entry.complete = true;
    }
    if (this._scanBuffers.size > 3) {
      const firstKey = this._scanBuffers.keys().next().value;
      this._scanBuffers.delete(firstKey);
    }
  },

  /**
   * 对当前目录执行文件名、相机、镜头、格式和收藏筛选。
   */
  applyFilters(options = {}) {
    const query = this._searchInput ? this._searchInput.value.trim().toLowerCase() : '';
    const favoritesOnly = this._favoriteFilter ? this._favoriteFilter.classList.contains('active') : false;
    const rawOnly = this._rawFilter ? this._rawFilter.classList.contains('active') : false;
    this.imageList = this.allImages.filter((item) => {
      if (favoritesOnly && !item.favorite) return false;
      if (rawOnly && !item.isRaw) return false;
      if (!query) return true;
      const searchable = [
        item.name, item.camera, item.lens, item.date, item.rawFormat
      ].filter(Boolean).join(' ').toLowerCase();
      return searchable.includes(query);
    });
    this._imageIndexMap = new Map(this.imageList.map((item, index) => [item.path, index]));
    this.rebuildView(options);
  },

  rebuildView({ resetScroll = false, preserveScroll = false, minimumCards = 0 } = {}) {
    const previousScroll = preserveScroll ? this.container.scrollTop : 0;
    const previousCards = preserveScroll ? this.grid.querySelectorAll('.image-card').length : minimumCards;
    const active = document.activeElement;
    this._gridHadFocus = Boolean(active && this.grid.contains(active));
    if (this._gridHadFocus) {
      const domIndex = this.cards().indexOf(this.focusedCard());
      if (domIndex >= 0) this._keyboardIndex = domIndex;
    }
    this.disconnectRenderObservers();
    this.grid.innerHTML = '';
    this._renderPlan = this.buildRenderPlan(this.imageList);
    this._renderIndex = 0;
    this.appendNextBatch(previousCards);
    this.applyZoom();
    if (preserveScroll) this.container.scrollTop = previousScroll;
    if (resetScroll) this.container.scrollTop = 0;
    // 卡片全被重建过，roving tabindex 也要重新分配；重建后焦点通常已掉到 body，
    // 这时把焦点收回原位置的卡片，键盘用户不会"按一下方向键就不知道自己在哪"。
    const hadFocus = this._gridHadFocus;
    this.syncRovingTabIndex(this._keyboardIndex);
    if (hadFocus) this.focusCardAt(this._keyboardIndex);
    this.updateStats();
  },

  buildRenderPlan(items) {
    if (SettingsManager.getSortMode() === 'filename') {
      return items.map((item) => ({ kind: 'card', item }));
    }
    const groupLevel = SettingsManager.getGroupLevel();
    const plan = [];
    let currentGroup = '';
    items.forEach((item) => {
      const groupKey = item[groupLevel] || item.day || item.date || '未知日期';
      if (groupKey !== currentGroup) {
        currentGroup = groupKey;
        plan.push({ kind: 'header', text: groupKey });
      }
      plan.push({ kind: 'card', item });
    });
    return plan;
  },

  /**
   * 只创建当前批次 DOM，其余卡片和缩略图进入视口附近后再加载。
   */
  appendNextBatch(minimumCards = 0) {
    if (!this._renderPlan.length) {
      this.grid.innerHTML = `
        <div class="empty-state" style="column-span: all;">
          <svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor">
            <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>
          </svg>
          <span>${this.allImages.length ? '没有符合筛选条件的媒体' : '该目录下没有媒体文件'}</span>
        </div>`;
      this.updateStats();
      return;
    }

    if (this._loadMoreSentinel) {
      this._loadMoreSentinel.remove();
      this._loadMoreSentinel = null;
    }

    const fragment = document.createDocumentFragment();
    const isFilename = SettingsManager.getSortMode() === 'filename';
    let appendedSlots = 0;
    let appendedCards = 0;
    const newCards = [];
    while (this._renderIndex < this._renderPlan.length && appendedSlots < this._batchSize) {
      const entry = this._renderPlan[this._renderIndex++];
      if (entry.kind === 'header') {
        const header = document.createElement('div');
        header.className = 'date-header';
        header.textContent = entry.text;
        // 容器是 role="listbox"，非 option 的子节点要让读屏跳过，
        // 否则日期分组标题会被当成"列表项"念出来。
        header.setAttribute('role', 'presentation');
        fragment.appendChild(header);
      } else {
        const index = this._imageIndexMap ? (this._imageIndexMap.get(entry.item.path) ?? -1) : -1;
        const card = isFilename ? this.createFilenameCard(entry.item, index) : this.createImageCard(entry.item, index);
        fragment.appendChild(card);
        appendedCards += 1;
        this._cardImageMap.set(card, entry.item);
        newCards.push(card);
      }
      appendedSlots += 1;
      if (minimumCards > 0 && appendedCards >= minimumCards) break;
    }
    this.grid.appendChild(fragment);
    // 必须在挂载后观察，Chromium 才会为首次可见卡片产生 intersection 回调。
    newCards.forEach((card) => this._thumbnailObserver.observe(card));

    if (this._renderIndex < this._renderPlan.length) {
      this._loadMoreSentinel = document.createElement('div');
      this._loadMoreSentinel.className = 'load-more-sentinel';
      this._loadMoreSentinel.setAttribute('role', 'presentation');
      this._loadMoreSentinel.textContent = '继续加载...';
      this.grid.appendChild(this._loadMoreSentinel);
      this.observeLoadMore();
    }
    // 新批次里可能还没有任何 tabindex="0" 的卡片（首批渲染、或原来那张被删除）
    this.syncRovingTabIndex();
    this.updateStats();
  },

  observeLoadMore() {
    if (this._loadMoreObserver) this._loadMoreObserver.disconnect();
    this._loadMoreObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) this.appendNextBatch();
    }, {
      root: this.container,
      rootMargin: '900px 0px'
    });
    if (this._loadMoreSentinel) this._loadMoreObserver.observe(this._loadMoreSentinel);
  },

  disconnectRenderObservers() {
    if (this._loadMoreObserver) {
      this._loadMoreObserver.disconnect();
      this._loadMoreObserver = null;
    }
    if (this._loadMoreSentinel) {
      this._loadMoreSentinel.remove();
      this._loadMoreSentinel = null;
    }
  },

  scheduleThumbnail(card, imageInfo, generation) {
    if (!card.isConnected || generation !== this._generation) return;
    this._thumbnailQueue.push({ card, imageInfo, generation });
    this.pumpThumbnailQueue();
  },

  pumpThumbnailQueue() {
    while (this._activeThumbnails < this._thumbnailConcurrency && this._thumbnailQueue.length > 0) {
      const job = this._thumbnailQueue.shift();
      if (job.generation !== this._generation || !job.card.isConnected) continue;
      this._activeThumbnails += 1;
      this.loadCardThumbnail(job.card, job.imageInfo, job.generation)
        .finally(() => {
          this._activeThumbnails -= 1;
          this.pumpThumbnailQueue();
        });
    }
  },

  async loadCardThumbnail(card, imageInfo, generation) {
    if (imageInfo.type === 'video') {
      await this.loadVideoCard(card, imageInfo, generation);
      return;
    }
    const result = await window.api.getThumbnail(imageInfo.path, 640);
    if (generation !== this._generation || !card.isConnected) return;
    const image = card.querySelector('.media-thumb');
    if (!image) return;
    if (!result.success) {
      this.showCardError(card, imageInfo.isRaw ? 'RAW 预览不可用' : '加载失败');
      return;
    }
    // 必须先注册回调再设置 src：命中内存缓存时 load 事件可能紧接着就触发。
    image.addEventListener('load', () => {
      if (generation !== this._generation) return;
      card.classList.add('thumbnail-loaded');
      card.querySelector('.image-loading')?.remove();
    }, { once: true });
    image.addEventListener('error', () => {
      this.showCardError(card, imageInfo.isRaw ? 'RAW 预览不可用' : '加载失败');
    }, { once: true });
    image.src = result.url;
  },

  async loadVideoCard(card, imageInfo, generation) {
    const video = card.querySelector('video.media-thumb');
    if (!video) return;
    video.src = this.getFileURL(imageInfo.path);
    video.load();
    video.addEventListener('loadeddata', () => {
      if (generation !== this._generation) return;
      card.classList.add('thumbnail-loaded');
      card.querySelector('.image-loading')?.remove();
    }, { once: true });
    video.addEventListener('error', () => {
      const ext = imageInfo.name.split('.').pop().toLowerCase();
      const unsupported = ['avi', 'mkv', 'wmv', 'flv', 'm4v'];
      this.showCardError(card, unsupported.includes(ext) ? '格式不支持' : '加载失败');
    }, { once: true });
  },

  showCardError(card, message) {
    const loading = card.querySelector('.image-loading');
    if (loading) loading.textContent = message;
    card.classList.add('thumbnail-error');
    this.noteThumbnailFailure(card.dataset.path, message);
  },

  /**
   * 记录缩略图失败，让统计栏能显示「N 张缩略图失败」并支持悬停查看文件名。
   * gkpv 同样把失败计入计数并保留前 50 个名字；否则用户只会看到空白卡片，
   * 也不知道到底哪几张没加载出来。
   */
  noteThumbnailFailure(filePath, message) {
    this._thumbnailFailed += 1;
    if (this._thumbnailFailedNames.length < 50) {
      const name = filePath ? this.getBasename(filePath) : '';
      this._thumbnailFailedNames.push(name ? `${name}：${message}` : message);
    }
    this.updateStats();
  },

  createFilenameCard(imageInfo, index) {
    const card = document.createElement('div');
    card.className = imageInfo.type === 'video' ? 'image-card filename-card video-card' : 'image-card filename-card';
    card.dataset.path = imageInfo.path;
    this.applyCardAccessibility(card, imageInfo);
    const name = this.createFilenameElement(imageInfo);
    card.appendChild(name);
    if (imageInfo.type === 'video') {
      card.appendChild(this.createVideoElement(imageInfo));
    } else {
      card.appendChild(this.createImageElement(imageInfo));
    }
    this.addCardBadges(card, imageInfo);
    this.bindCardEvents(card, imageInfo, index);
    return card;
  },

  createImageCard(imageInfo, index) {
    const card = document.createElement('div');
    card.className = imageInfo.type === 'video' ? 'image-card video-card' : 'image-card';
    card.dataset.path = imageInfo.path;
    this.applyCardAccessibility(card, imageInfo);
    if (imageInfo.type === 'video') {
      card.appendChild(this.createVideoElement(imageInfo));
    } else {
      card.appendChild(this.createImageElement(imageInfo));
    }
    this.addCardBadges(card, imageInfo);
    this.bindCardEvents(card, imageInfo, index);
    return card;
  },

  createFilenameElement(imageInfo) {
    const name = document.createElement('div');
    name.className = 'image-filename';
    name.textContent = imageInfo.name;
    name.title = imageInfo.relativePath || imageInfo.name;
    return name;
  },

  createImageElement(imageInfo) {
    const image = document.createElement('img');
    image.className = 'media-thumb';
    image.alt = imageInfo.name;
    image.title = imageInfo.name;
    // 注意：这里刻意不设置 loading="lazy"。
    // 加载时机完全由 _thumbnailObserver（900px 预加载边距）控制，与 gkpv 一致；
    // 再加一层原生懒加载会让视口外的卡片出现「src 已设置但 naturalWidth 恒为 0」
    // 的状态，卡片会一直停在占位态，缩略图状态也不再可判定。
    image.decoding = 'async';
    // 已知宽高比时先按比例占位，缩略图到达后不会引起瀑布流跳动。
    if (imageInfo.width > 0 && imageInfo.height > 0) {
      image.style.aspectRatio = `${imageInfo.width} / ${imageInfo.height}`;
    }
    return image;
  },

  createVideoElement(imageInfo) {
    const video = document.createElement('video');
    video.className = 'media-thumb';
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    const overlay = document.createElement('div');
    overlay.className = 'video-overlay';
    overlay.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    const wrapper = document.createElement('div');
    wrapper.className = 'video-thumb-wrapper';
    wrapper.appendChild(video);
    wrapper.appendChild(overlay);
    return wrapper;
  },

  addCardBadges(card, imageInfo) {
    const loading = document.createElement('div');
    loading.className = 'image-loading';
    loading.textContent = imageInfo.isRaw ? `${imageInfo.rawFormat} 预览` : '加载中...';
    card.appendChild(loading);

    if (imageInfo.isRaw) {
      const badge = document.createElement('span');
      badge.className = 'format-badge raw-badge';
      badge.textContent = `RAW · ${imageInfo.rawFormat}`;
      card.appendChild(badge);
    }
    if (imageInfo.folder) {
      const pathBadge = document.createElement('span');
      pathBadge.className = 'path-badge';
      pathBadge.textContent = imageInfo.relativePath;
      pathBadge.title = imageInfo.relativePath;
      card.appendChild(pathBadge);
    }
    if (imageInfo.favorite) card.classList.add('favorite');
    const favorite = document.createElement('span');
    favorite.className = 'favorite-badge';
    favorite.textContent = imageInfo.favorite ? '★' : '';
    card.appendChild(favorite);
  },

  bindCardEvents(card, imageInfo, index) {
    card.addEventListener('click', (event) => this.handleCardClick(event, index, card));
    card.addEventListener('dblclick', () => {
      const idx = this.imageList.findIndex((item) => item.path === imageInfo.path);
      if (idx !== -1) Preview.open(this.imageList, idx);
    });
    card.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!this.selectedPaths.has(imageInfo.path)) {
        this.clearSelection();
        this.selectedPaths.add(imageInfo.path);
        card.classList.add('selected');
      }
      const selectedImages = this.getSelectedImages();
      const canRename = SettingsManager.getSortMode() === 'filename' && selectedImages.length === 1;
      ContextMenu.show(event.clientX, event.clientY, imageInfo, canRename, selectedImages);
    });
    this.setupDraggable(card, imageInfo);
  },

  setupDraggable(card, imageInfo) {
    card.draggable = true;
    card.dataset.path = imageInfo.path;
    card.addEventListener('dragstart', (event) => {
      if (!this.selectedPaths.has(imageInfo.path)) {
        this.clearSelection();
        this.selectedPaths.add(imageInfo.path);
        card.classList.add('selected');
      }
      const selectedPaths = Array.from(this.selectedPaths);
      if (selectedPaths.length > 1) {
        event.dataTransfer.setData('application/x-file-paths', JSON.stringify(selectedPaths));
        event.dataTransfer.setData('text/plain', selectedPaths[0]);
      } else {
        event.dataTransfer.setData('text/plain', imageInfo.path);
      }
      card.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  },

  removeCards(paths) {
    const pathSet = new Set(paths);
    this.allImages = this.allImages.filter((item) => !pathSet.has(item.path));
    this.imageList = this.imageList.filter((item) => !pathSet.has(item.path));
    this._allImageByPath = new Map(this.allImages.map((item) => [item.path, item]));
    this.clearSelection();
    this.rebuildView({ preserveScroll: true });
  },

  toggleFavoriteCard(imageInfo, favorite) {
    imageInfo.favorite = favorite;
    const selector = `.image-card[data-path="${CSS.escape(imageInfo.path)}"]`;
    const card = this.grid.querySelector(selector);
    if (card) {
      card.classList.toggle('favorite', favorite);
      const badge = card.querySelector('.favorite-badge');
      if (badge) badge.textContent = favorite ? '★' : '';
    }
    if (this._favoriteFilter?.classList.contains('active')) this.applyFilters({ preserveScroll: true });
    this.updateStats();
  },

  updateStats(extraMessage = '') {
    if (!this._statsElement) return;
    const total = this.allImages.length;
    const shown = this.imageList.length;
    const rawCount = this.imageList.filter((item) => item.isRaw).length;
    const parts = [];
    if (extraMessage) parts.push(extraMessage);
    else if (this._scanProgress) parts.push(`读取拍摄信息 ${this._scanProgress.completed}/${this._scanProgress.total}`);
    parts.push(`显示 ${shown} / ${total}`);
    if (rawCount) parts.push(`RAW ${rawCount}`);
    if (typeof SettingsManager !== 'undefined' && SettingsManager.getRecursiveMode()) parts.push('递归');
    if (this.selectedPaths.size) parts.push(`已选 ${this.selectedPaths.size}`);
    let text = parts.join(' · ');
    // 失败也必须显式可见，否则空白卡片会被误认为「这张图就是这样」。
    if (this._thumbnailFailed > 0) text += `（${this._thumbnailFailed} 张缩略图失败）`;
    this._statsElement.textContent = text;
    this._statsElement.title = this._thumbnailFailed > 0 ? this._thumbnailFailedNames.join('\n') : '';
  },

  startRenameCard(imageInfo) {
    const card = this.grid.querySelector(`.image-card[data-path="${CSS.escape(imageInfo.path)}"]`);
    if (!card) return;
    const filenameEl = card.querySelector('.image-filename');
    if (!filenameEl) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-rename-input';
    input.value = imageInfo.name.replace(/\.[^.]+$/, '');
    filenameEl.replaceWith(input);
    input.focus();
    input.select();

    const finishRename = async () => {
      const newName = input.value.trim();
      if (newName && newName !== imageInfo.name.replace(/\.[^.]+$/, '')) {
        App.fileOperationPending = true;
        const result = await window.api.renameFile(imageInfo.path, newName);
        if (result.success) {
          const oldPath = imageInfo.path;
          imageInfo.name = this.getBasename(result.newPath);
          imageInfo.path = result.newPath;
          card.dataset.path = result.newPath;
          this.allImages.forEach((item) => {
            if (item.path === oldPath) {
              item.name = imageInfo.name;
              item.path = result.newPath;
            }
          });
          this._allImageByPath.delete(oldPath);
          this._allImageByPath.set(result.newPath, imageInfo);
          this._imageIndexMap = new Map(this.imageList.map((item, index) => [item.path, index]));
        } else {
          App.fileOperationPending = false;
          // 重命名成已存在的名字是最常见的失败，必须说出来而不是静默还原
          Toast.error(result.error || '重命名失败');
        }
      }
      const restored = document.createElement('div');
      restored.className = 'image-filename';
      restored.textContent = imageInfo.name;
      restored.title = imageInfo.name;
      input.replaceWith(restored);
    };

    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
      if (event.key === 'Escape') { input.value = imageInfo.name.replace(/\.[^.]+$/, ''); input.blur(); }
    });
  }
};

window.Waterfall = Waterfall;

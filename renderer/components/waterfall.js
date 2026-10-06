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
  _thumbnailConcurrency: 4,
  _batchSize: 80,
  _cardImageMap: new WeakMap(),

  zoomLevel: 1.0,
  ZOOM_MIN: 0.3,
  ZOOM_MAX: 3.0,
  ZOOM_STEP: 0.1,
  STORAGE_KEY: 'Mediew-zoom',
  _zoomIndicator: null,
  _zoomTimer: null,

  selectedPaths: new Set(),
  lastClickedIndex: -1,
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
    this.loadZoom();
    this.setupZoom();
    this.setupSelection();
    this.setupScrollPerformance();
    this.setupFilterControls();
    this.setupMetadataListeners();
    this.setupThumbnailObserver();
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
      rootMargin: '700px 0px',
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
    this.grid.querySelectorAll('.image-card').forEach((card) => card.classList.add('selected'));
    this.updateStats();
  },

  clearSelection() {
    this.selectedPaths.clear();
    this.lastClickedIndex = -1;
    this.grid.querySelectorAll('.image-card.selected').forEach((card) => card.classList.remove('selected'));
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
      if (target) Object.assign(target, metadata);
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

  bufferScanPayload(scanId, key, value) {
    if (!this._scanBuffers.has(scanId)) this._scanBuffers.set(scanId, { batches: [], complete: false });
    const entry = this._scanBuffers.get(scanId);
    if (key === 'batches') {
      entry.batches.push(value);
      if (entry.batches.length > 100) entry.batches.shift();
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
    this.disconnectRenderObservers();
    this.grid.innerHTML = '';
    this._renderPlan = this.buildRenderPlan(this.imageList);
    this._renderIndex = 0;
    this.appendNextBatch(previousCards);
    this.applyZoom();
    if (preserveScroll) this.container.scrollTop = previousScroll;
    if (resetScroll) this.container.scrollTop = 0;
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
      this._loadMoreSentinel.textContent = '继续加载...';
      this.grid.appendChild(this._loadMoreSentinel);
      this.observeLoadMore();
    }
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
    const result = await window.api.getThumbnail(imageInfo.path, 512);
    if (generation !== this._generation || !card.isConnected) return;
    const image = card.querySelector('.media-thumb');
    if (!image) return;
    if (!result.success) {
      this.showCardError(card, imageInfo.isRaw ? 'RAW 预览不可用' : '加载失败');
      return;
    }
    image.src = result.url;
    image.addEventListener('load', () => {
      if (generation !== this._generation) return;
      card.classList.add('thumbnail-loaded');
      card.querySelector('.image-loading')?.remove();
    }, { once: true });
    image.addEventListener('error', () => {
      this.showCardError(card, imageInfo.isRaw ? 'RAW 预览不可用' : '加载失败');
    }, { once: true });
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
  },

  createFilenameCard(imageInfo, index) {
    const card = document.createElement('div');
    card.className = imageInfo.type === 'video' ? 'image-card filename-card video-card' : 'image-card filename-card';
    card.dataset.path = imageInfo.path;
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
    image.loading = 'lazy';
    image.decoding = 'async';
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
    this._statsElement.textContent = parts.join(' · ');
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

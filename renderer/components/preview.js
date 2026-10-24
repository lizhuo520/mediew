const Preview = {
  modal: null,
  image: null,
  imageAlt: null,
  standbyImage: null,
  video: null,
  container: null,
  imageArea: null,
  prevBtn: null,
  nextBtn: null,
  counter: null,
  isOpen: false,
  imageList: [],
  currentIndex: 0,
  isVideo: false,
  lastToggleTime: 0,
  _previewToken: 0,
  _preloadImages: new Map(),
  _layerA: null,
  _layerB: null,
  _swapTimer: null,
  _loadingEl: null,
  _loadingText: null,
  _zoomIndicator: null,
  _zoomTimer: null,
  _rotateLeftBtn: null,
  _rotateRightBtn: null,
  _originalBtn: null,
  _rotationMap: null,
  _showingOriginal: false,
  _originalLoading: false,
  // 打开灯箱前的焦点归属，关闭时还回去（否则焦点会掉到 body，键盘用户迷路）。
  _lastFocused: null,
  _resizeTimer: null,

  rotation: 0,
  ROTATION_KEY: 'Mediew-manual-rotation',

  scale: 1,
  fitScale: 1,
  maxScale: 2,
  panX: 0,
  panY: 0,
  isDragging: false,
  dragStartX: 0,
  dragStartY: 0,
  lastPanX: 0,
  lastPanY: 0,

  init() {
    this.modal = document.getElementById('preview-modal');
    this._layerA = document.getElementById('preview-image');
    this._layerB = document.getElementById('preview-image-alt');
    this.image = this._layerA;
    this.imageAlt = this._layerB;
    this.video = document.getElementById('preview-video');
    this.imageArea = document.querySelector('.preview-image-area');
    this.container = document.querySelector('.preview-image-container');
    this.prevBtn = document.querySelector('.preview-prev');
    this.nextBtn = document.querySelector('.preview-next');
    this.counter = document.querySelector('.preview-counter');
    this._loadingEl = document.getElementById('preview-loading');
    this._loadingText = document.getElementById('preview-loading-text');
    this._zoomIndicator = document.getElementById('preview-zoom-indicator');
    this._rotateLeftBtn = document.getElementById('preview-rotate-left');
    this._rotateRightBtn = document.getElementById('preview-rotate-right');
    this._originalBtn = document.getElementById('preview-original');
    this.loadRotationStore();

    document.querySelector('.preview-close').addEventListener('click', () => this.close());

    this._rotateLeftBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.rotateBy(-90);
    });
    this._rotateRightBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.rotateBy(90);
    });
    this._originalBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleOriginal();
    });

    this.imageArea.addEventListener('click', (e) => {
      if (e.target === this.imageArea || e.target === this.container) {
        this.close();
      }
    });

    this.prevBtn.addEventListener('click', (e) => { e.stopPropagation(); this.prev(); });
    this.nextBtn.addEventListener('click', (e) => { e.stopPropagation(); this.next(); });

    this.container.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.container.addEventListener('mousedown', (e) => this.onMouseDown(e));
    document.addEventListener('mousemove', (e) => this.onMouseMove(e));
    document.addEventListener('mouseup', () => this.onMouseUp());
    this.container.addEventListener('dblclick', (e) => this.onDblClick(e));

    [this._layerA, this._layerB].forEach((layer) => {
      layer.addEventListener('dragstart', (e) => e.preventDefault());
    });
    document.addEventListener('keydown', (e) => this.onKeyDown(e));

    const filenameEl = document.getElementById('info-filename');
    filenameEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.startRename();
    });

    this.imageArea.addEventListener('contextmenu', (e) => {
      if (!this.isOpen) return;
      e.preventDefault();
      e.stopPropagation();
      const img = this.imageList[this.currentIndex];
      if (img) {
        const canRename = SettingsManager.getSortMode() === 'filename';
        ContextMenu.show(e.clientX, e.clientY, img, canRename);
      }
    });

    this.initVideoPlayer();
    this.updateOriginalButton();

    // 窗口尺寸变了，fitScale/maxScale 就过期了：不重算的话「适应窗口」的图会
    // 保持旧尺寸（拉大窗口留黑边、缩小窗口被裁掉）。200ms 防抖避免拖动时狂算。
    window.addEventListener('resize', () => {
      if (!this.isOpen) return;
      if (this._resizeTimer) clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        this._resizeTimer = null;
        if (this.isOpen) this.handleResize();
      }, 200);
    });

    this.modal.addEventListener('keydown', (event) => this.trapFocus(event));
  },

  /**
   * 灯箱是 aria-modal 的 dialog，Tab 不该跑到背后的网格上去。
   * 用 keydown 拦截而不是把背景设 inert：后者要改 DOM 树结构，风险更大。
   */
  trapFocus(event) {
    if (event.key !== 'Tab' || !this.isOpen) return;
    const focusable = this.getFocusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      this.modal.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const current = document.activeElement;
    if (event.shiftKey) {
      if (current === first || !this.modal.contains(current)) {
        event.preventDefault();
        last.focus();
      }
    } else if (current === last || !this.modal.contains(current)) {
      event.preventDefault();
      first.focus();
    }
  },

  getFocusableElements() {
    if (!this.modal) return [];
    const selector = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
    return Array.from(this.modal.querySelectorAll(selector)).filter((el) => {
      if (el.closest('[aria-hidden="true"]')) return false;
      // 不可见元素（隐藏的视频控制条、当前没显示的旋转按钮）不该吃到 Tab。
      return el.offsetParent !== null || el === document.activeElement;
    });
  },

  /**
   * 尺寸变化后重算缩放。看原图时保持"1 图像像素 = 1 物理像素"，
   * 其余情况重新贴回 fitScale，再夹一遍平移量避免图被拖出可视区。
   */
  handleResize() {
    if (!this.isOpen || this.isVideo) return;
    const { width, height } = this.getRotatedNaturalSize();
    if (!width || !height) return;
    this.calcScales();
    this.scale = this._showingOriginal ? this.getPixelScale() : this.fitScale;
    this.clampPan();
    this.applyTransform(false);
  },

  initVideoPlayer() {
    const playBtn = document.getElementById('video-play');
    const progressContainer = document.getElementById('video-progress-container');
    const progressBar = document.getElementById('video-progress');
    const timeDisplay = document.getElementById('video-time');
    const volumeBtn = document.getElementById('video-volume-btn');
    const volumeSlider = document.getElementById('video-volume-slider');

    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePlay();
    });

    this.video.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.togglePlay();
    });

    this.video.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });

    this.video.addEventListener('timeupdate', () => {
      const progress = (this.video.currentTime / this.video.duration) * 100;
      progressBar.style.width = `${progress}%`;
      timeDisplay.textContent = `${this.formatTime(this.video.currentTime)} / ${this.formatTime(this.video.duration)}`;
    });

    this.video.addEventListener('ended', () => {
      playBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    });

    progressContainer.addEventListener('click', (e) => {
      e.stopPropagation();
      const rect = progressContainer.getBoundingClientRect();
      const pos = (e.clientX - rect.left) / rect.width;
      this.video.currentTime = pos * this.video.duration;
    });

    let isDraggingProgress = false;

    progressContainer.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      isDraggingProgress = true;
      this.seekToPosition(e, progressContainer);
    });

    document.addEventListener('mousemove', (e) => {
      if (isDraggingProgress) {
        e.preventDefault();
        this.seekToPosition(e, progressContainer);
      }
    });

    document.addEventListener('mouseup', () => {
      isDraggingProgress = false;
    });

    volumeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.video.muted = !this.video.muted;
      this.updateVolumeIcon();
    });

    volumeSlider.addEventListener('input', (e) => {
      e.stopPropagation();
      this.video.volume = e.target.value;
      this.video.muted = e.target.value === 0;
      this.updateVolumeIcon();
    });

    this.video.addEventListener('volumechange', () => {
      volumeSlider.value = this.video.muted ? 0 : this.video.volume;
      this.updateVolumeIcon();
    });
  },

  togglePlay() {
    const now = Date.now();
    if (now - this.lastToggleTime < 100) return;
    this.lastToggleTime = now;

    const playBtn = document.getElementById('video-play');
    if (this.video.paused) {
      this.video.play();
      playBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
    } else {
      this.video.pause();
      playBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    }
  },

  toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      this.video.requestFullscreen();
    }
  },

  updateVolumeIcon() {
    const volumeBtn = document.getElementById('video-volume-btn');
    if (this.video.muted || this.video.volume === 0) {
      volumeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>';
    } else if (this.video.volume < 0.5) {
      volumeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/></svg>';
    } else {
      volumeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';
    }
  },

  seekToPosition(e, progressContainer) {
    const rect = progressContainer.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    this.video.currentTime = pos * this.video.duration;
  },

  formatTime(seconds) {
    if (isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  },

  loadRotationStore() {
    this._rotationMap = {};
    try {
      const parsed = JSON.parse(localStorage.getItem(this.ROTATION_KEY) || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) this._rotationMap = parsed;
    } catch (_) {
      this._rotationMap = {};
    }
  },

  getRotation(filePath) {
    return MediewOrientation.normalizeAngle(this._rotationMap[filePath] || 0);
  },

  saveRotation(filePath, angle) {
    const normalized = MediewOrientation.normalizeAngle(angle);
    if (normalized === 0) {
      delete this._rotationMap[filePath];
    } else {
      this._rotationMap[filePath] = normalized;
    }
    // 只保留最近 800 条，避免长年使用后 localStorage 无限膨胀。
    const keys = Object.keys(this._rotationMap);
    if (keys.length > 800) keys.slice(0, keys.length - 800).forEach((key) => delete this._rotationMap[key]);
    try {
      localStorage.setItem(this.ROTATION_KEY, JSON.stringify(this._rotationMap));
    } catch (_) {}
  },

  rotateBy(delta) {
    if (!this.isOpen || this.isVideo || this._originalLoading) return;
    const img = this.imageList[this.currentIndex];
    if (!img) return;

    this.rotation = MediewOrientation.normalizeAngle(this.rotation + delta);
    this.saveRotation(img.path, this.rotation);

    // 正在看原图时保持 100%，适应窗口时按旋转后的尺寸重新适配。
    const keepOriginal = this._showingOriginal;
    this.calcScales();
    this.scale = keepOriginal ? this.getPixelScale() : this.fitScale;
    this.panX = 0;
    this.panY = 0;
    this.clampPan();
    this.applyTransform(true);
    this.updateInfo(img);
    this.showZoomIndicator();
  },

  updateOriginalButton() {
    if (!this._originalBtn) return;
    const active = this._showingOriginal;
    this._originalBtn.classList.toggle('active', active);
    this._originalBtn.textContent = active ? '适应' : '原图';
    this._originalBtn.title = active
      ? '恢复到适应窗口 (O)'
      : '查看原图（1:1 原始分辨率，O）';
    this._originalBtn.disabled = this.isVideo || this._originalLoading;
    if (this._rotateLeftBtn) this._rotateLeftBtn.disabled = this.isVideo;
    if (this._rotateRightBtn) this._rotateRightBtn.disabled = this.isVideo;
  },

  async toggleOriginal() {
    if (!this.isOpen || this.isVideo || this._originalLoading) return;
    const img = this.imageList[this.currentIndex];
    if (!img) return;

    if (this._showingOriginal) {
      this._showingOriginal = false;
      this.calcScales();
      this.scale = this.fitScale;
      this.panX = 0;
      this.panY = 0;
      this.applyTransform(true);
      this.updateOriginalButton();
      return;
    }

    // 普通格式当前就是原图，直接切到 100%；RAW/TIFF 需要主进程生成
    // 全分辨率 JPEG（默认预览最长边只到 4096）。
    if (this.needsGeneratedPreview(img) && this._fullPreviewPath !== img.path) {
      await this.loadFullPreview(img);
      return;
    }

    this._showingOriginal = true;
    this.scale = this.getPixelScale();
    this.panX = 0;
    this.panY = 0;
    this.clampPan();
    this.applyTransform(true);
    this.updateOriginalButton();
    this.showZoomIndicator();
  },

  async loadFullPreview(img) {
    const token = ++this._previewToken;
    this._originalLoading = true;
    this.updateOriginalButton();
    this.showLoading('正在加载原图…');
    document.getElementById('info-dimensions').textContent = '正在加载原图…';

    const incoming = this.standbyImage;
    const outgoing = this.image;
    incoming.onload = null;
    incoming.onerror = null;
    incoming.classList.remove('loaded');
    incoming.style.display = 'block';
    incoming.style.opacity = '0';
    incoming.style.transition = 'opacity 0.22s ease';

    incoming.onload = () => {
      if (token !== this._previewToken || !this.isOpen) return;
      this._originalLoading = false;
      this._fullPreviewPath = img.path;
      this.onImageReady(incoming, outgoing, img, 0, { original: true });
    };
    incoming.onerror = () => {
      if (token !== this._previewToken) return;
      const srcAttr = incoming.getAttribute('src');
      if (!srcAttr || srcAttr === 'about:blank') return;
      this._originalLoading = false;
      this.hideLoading();
      this._showingOriginal = false;
      this.updateOriginalButton();
      if (outgoing && outgoing.classList.contains('loaded')) outgoing.style.opacity = '1';
      Toast.error(`${img.name}：原图加载失败`);
    };

    let result;
    try {
      result = await window.api.getPreview(img.path, { full: true });
    } catch (err) {
      // 主进程抛错（sharp 崩了/文件被独占/临时目录不可写）时，裸 await 会把
      // 整个函数 reject 掉：loading 遮罩永远转、"原图"按钮永久 disabled。
      if (token !== this._previewToken) return;
      this._originalLoading = false;
      this.hideLoading();
      this._showingOriginal = false;
      this.updateOriginalButton();
      if (outgoing && outgoing.classList.contains('loaded')) outgoing.style.opacity = '1';
      Toast.error(`${img.name}：${err?.message || '原图加载失败'}`);
      return;
    }
    if (token !== this._previewToken || !this.isOpen) return;
    if (!result.success) {
      this._originalLoading = false;
      this.hideLoading();
      this._showingOriginal = false;
      this.updateOriginalButton();
      if (outgoing && outgoing.classList.contains('loaded')) outgoing.style.opacity = '1';
      Toast.error(`${img.name}：${result.error || '原图不可用'}`);
      return;
    }
    incoming.src = result.url;
  },

  /**
   * 灯箱取图策略（对齐 gkpv）：
   * 浏览器能直接解码的格式一律加载原图，保留最高缩放质量；
   * TIFF / RAW 浏览器解不了，必须由主进程生成缓存 JPEG 预览。
   *
   * HEIC/HEIF 已从「需要生成」名单里去掉：它们已被扫描阶段过滤，不会走到灯箱。
   * 留在这里只会让人误以为该格式可用。
   */
  needsGeneratedPreview(imageInfo) {
    if (!imageInfo) return false;
    if (imageInfo.isRaw) return true;
    const extension = (imageInfo.extension || '').toLowerCase();
    return ['.tif', '.tiff'].includes(extension);
  },

  getViewSize() {
    const panel = document.querySelector('.preview-info-panel');
    const panelW = panel ? panel.offsetWidth : 0;
    return { w: window.innerWidth - panelW, h: window.innerHeight };
  },

  getRotatedNaturalSize() {
    return MediewOrientation.rotatedSize(
      this.image.naturalWidth,
      this.image.naturalHeight,
      this.rotation
    );
  },

  getDevicePixelRatio() {
    return window.devicePixelRatio || 1;
  },

  /** 让 1 个图像像素落在 1 个物理像素上（4K@150% 时是 0.667 CSS 比例）。 */
  getPixelScale() {
    return 1 / this.getDevicePixelRatio();
  },

  getEffectiveScale() {
    return this.scale * this.getDevicePixelRatio();
  },

  calcScales() {
    const { width: nW, height: nH } = this.getRotatedNaturalSize();
    if (!nW || !nH) return;

    const { w: vW, h: vH } = this.getViewSize();
    const pixelScale = this.getPixelScale();

    this.fitScale = Math.min(vW / nW, vH / nH);
    // 不把小图放大超过物理 1:1；此前上限是 1，在 150% 缩放下会放大 1.5 倍。
    if (this.fitScale > pixelScale) this.fitScale = pixelScale;
    // 允许「原图」切到物理 1:1，也允许适度放大查看。
    this.maxScale = Math.max(this.fitScale * 5, 1);
  },

  clampPan() {
    const { width: nW, height: nH } = this.getRotatedNaturalSize();
    const displayW = nW * this.scale;
    const displayH = nH * this.scale;
    const { w: vW, h: vH } = this.getViewSize();

    const maxPanX = Math.max(0, (displayW - vW) / 2);
    const maxPanY = Math.max(0, (displayH - vH) / 2);

    this.panX = Math.max(-maxPanX, Math.min(maxPanX, this.panX));
    this.panY = Math.max(-maxPanY, Math.min(maxPanY, this.panY));
  },

  applyTransform(animate) {
    // 未显式指定时保留 opacity 过渡：交叉淡化与缩放互不干扰。
    if (animate) {
      this.image.style.transition = 'transform 0.3s cubic-bezier(0.25, 0.1, 0.25, 1), opacity 0.22s ease';
    } else {
      this.image.style.transition = 'transform 0s, opacity 0.22s ease';
    }

    const angle = MediewOrientation.normalizeAngle(this.rotation);
    this.image.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale}) rotate(${angle}deg)`;

    this.container.classList.toggle('zoomed', this.scale > this.fitScale + 0.01);
  },

  /**
   * 图像区的加载态。生成 4096 预览要几秒，期间图像区是纯黑，
   * 只在右侧信息栏写一行小字用户根本注意不到。
   */
  showLoading(text) {
    if (!this._loadingEl) return;
    if (this._loadingText && text) this._loadingText.textContent = text;
    this._loadingEl.classList.add('visible');
  },

  hideLoading() {
    if (this._loadingEl) this._loadingEl.classList.remove('visible');
  },

  showZoomIndicator() {
    if (!this._zoomIndicator) return;
    // 显示物理缩放比：4K@150% 下 scale=0.667 才是真正的 100%。
    this._zoomIndicator.textContent = `${Math.round(this.getEffectiveScale() * 100)}%`;
    this._zoomIndicator.classList.add('visible');
    if (this._zoomTimer) clearTimeout(this._zoomTimer);
    this._zoomTimer = setTimeout(() => {
      this._zoomIndicator.classList.remove('visible');
    }, 1200);
  },

  zoomTo(target, animate) {
    const oldScale = this.scale;
    this.scale = Math.max(0.05, Math.min(this.maxScale * 2, target));

    if (oldScale > 0) {
      // panX/panY 是「图片中心相对视口中心」的偏移，视口中心在平移坐标系里就是原点 (0,0)。
      // 以中心为锚点缩放时，中心点的内容位置不变，偏移按同比例放大即可。
      // （此前误把容器绝对坐标 vW/2 当成锚点传入，每次缩放都会横向漂移 vW/2。）
      const ratio = this.scale / oldScale;
      this.panX *= ratio;
      this.panY *= ratio;
    }

    this.clampPan();
    this.applyTransform(animate);
    this.showZoomIndicator();
  },

  cancelSwap() {
    if (this._swapTimer) {
      clearTimeout(this._swapTimer);
      this._swapTimer = null;
    }
  },

  resetLayers() {
    this.cancelSwap();
    [this._layerA, this._layerB].forEach((layer) => {
      layer.onload = null;
      layer.onerror = null;
      layer.src = '';
      layer.classList.remove('loaded');
      layer.style.opacity = '0';
      layer.style.display = 'none';
      layer.style.transform = '';
      layer.style.transition = 'none';
    });
    this.image = this._layerA;
    this.imageAlt = this._layerB;
    this.standbyImage = this._layerB;
  },

  open(imageList, index) {
    this.imageList = imageList;
    this.currentIndex = index;
    this.isOpen = true;
    // 灯箱已经开着时又会走一次 open()（删图/移图后重建索引会再调一次）。
    // 那种情况下 activeElement 已经在灯箱内部，记下来只会在关闭时把焦点还回
    // 一个即将隐藏的按钮，所以只在焦点确实在外部时才记录。
    const activeEl = document.activeElement;
    if (!this._lastFocused || !activeEl || !this.modal.contains(activeEl)) {
      this._lastFocused = activeEl;
    }
    this.panX = 0;
    this.panY = 0;
    this.scale = 1;
    this.rotation = 0;
    this._showingOriginal = false;
    this._fullPreviewPath = null;
    this._originalLoading = false;
    this.resetLayers();
    this.showImage(0, { immediate: true });
    this.modal.classList.add('active');
    // dialog 打开后焦点要进来，否则 Tab 还在背后的网格里游走，
    // 读屏也不会宣告"进入了预览"。
    const focusTarget = this.modal.querySelector('.preview-close');
    if (focusTarget) focusTarget.focus();
    else this.modal.focus();
  },

  close() {
    this._previewToken += 1;
    this.hideLoading();
    this.modal.classList.remove('active');
    this.resetLayers();
    this.video.src = '';
    this.video.pause();
    this.container.classList.remove('video-mode');
    document.getElementById('video-controls').classList.remove('active');
    this.isOpen = false;
    this.isVideo = false;
    this.scale = 1;
    this.fitScale = 1;
    this.panX = 0;
    this.panY = 0;
    this.rotation = 0;
    this._showingOriginal = false;
    this._fullPreviewPath = null;
    this._originalLoading = false;
    this.modal.classList.remove('video-active');
    this.updateOriginalButton();
    for (const preload of this._preloadImages.values()) preload.src = '';
    this._preloadImages.clear();
    if (this._resizeTimer) {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = null;
    }
    // 焦点归还给打开灯箱的那张卡片，键盘用户能接着原地上下移动。
    const lastFocused = this._lastFocused;
    this._lastFocused = null;
    if (lastFocused && lastFocused.isConnected) {
      lastFocused.focus?.();
    } else if (typeof Waterfall !== 'undefined' && Waterfall.focusCardAt) {
      Waterfall.focusCardAt(Waterfall._keyboardIndex);
    }
  },

  async showImage(direction = 1, options = {}) {
    if (this.currentIndex < 0 || this.currentIndex >= this.imageList.length) return;
    const img = this.imageList[this.currentIndex];
    const token = ++this._previewToken;
    this.cancelSwap();
    this.video.style.display = 'none';
    document.getElementById('video-controls').classList.remove('active');
    this.isVideo = img.type === 'video';
    this.modal.classList.toggle('video-active', this.isVideo);
    this.rotation = this.getRotation(img.path);
    this._showingOriginal = false;
    this._fullPreviewPath = null;
    this._originalLoading = false;
    this.updateOriginalButton();

    if (this.isVideo) {
      this.hideLoading();
      [this._layerA, this._layerB].forEach((layer) => {
        layer.classList.remove('loaded');
        layer.style.opacity = '0';
        layer.style.display = 'none';
      });
      this.image = this._layerA;
      this.standbyImage = this._layerB;
      this.video.style.display = 'block';
      this.container.classList.add('video-mode');
      document.getElementById('video-controls').classList.add('active');
      document.getElementById('video-play').innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
      document.getElementById('video-progress').style.width = '0%';
      document.getElementById('video-time').textContent = '0:00 / 0:00';
      this.video.src = Waterfall.getFileURL(img.path);
      this.video.load();
      this.updateNav();
      this.updateInfo(img);

      this.video.onloadedmetadata = () => {
        document.getElementById('info-dimensions').textContent = `${this.video.videoWidth} × ${this.video.videoHeight} px`;
        this.video.currentTime = 0;
      };

      this.video.onerror = () => {
        const ext = img.name.split('.').pop().toLowerCase();
        const unsupported = ['avi', 'mkv', 'wmv', 'flv', 'm4v'];
        document.getElementById('info-dimensions').textContent = unsupported.includes(ext) ? '格式不支持' : '加载失败';
      };
      return;
    }

    this.container.classList.remove('video-mode');
    this.updateNav();
    this.updateInfo(img);

    const hasVisibleImage = Boolean(this.image && this.image.classList.contains('loaded'));
    // 首次打开就复用主图层；翻页时用备用图层承接新图，旧图保持可见直到解码完成。
    const incoming = (!options.immediate && hasVisibleImage && this.standbyImage)
      ? this.standbyImage
      : this.image;
    const outgoing = incoming === this.image ? null : this.image;

    incoming.onload = null;
    incoming.onerror = null;
    incoming.classList.remove('loaded');
    incoming.style.display = 'block';
    incoming.style.opacity = '0';
    incoming.style.transition = 'transform 0.3s cubic-bezier(0.25, 0.1, 0.25, 1), opacity 0.22s ease';
    incoming.style.transform = `translate(${direction * 22}px, 0px) scale(0.985) rotate(${this.rotation}deg)`;

    this.panX = 0;
    this.panY = 0;
    this.scale = 1;
    this.showLoading(this.needsGeneratedPreview(img) ? '正在生成预览…' : '正在加载…');

    incoming.onload = () => {
      if (token !== this._previewToken || !this.isOpen) return;
      this.onImageReady(incoming, outgoing, img, direction);
    };
    incoming.onerror = () => {
      if (token !== this._previewToken) return;
      // 空 src / 页面 URL 是清空图层时浏览器抛的伪错误，不是真的加载失败。
      const srcAttr = incoming.getAttribute('src');
      if (!srcAttr || srcAttr === 'about:blank') return;
      this.hideLoading();
      document.getElementById('info-dimensions').textContent = '加载失败';
      Toast.error(`${img.name}：图片加载失败`);
      // 新图失败时把旧图恢复出来，用户不会看到"翻页后整屏变黑"。
      if (outgoing && outgoing.classList.contains('loaded')) outgoing.style.opacity = '1';
    };

    if (this.needsGeneratedPreview(img)) {
      const generatingText = img.isRaw ? '正在生成 RAW 预览…' : '正在生成预览…';
      this.showLoading(generatingText);
      document.getElementById('info-dimensions').textContent = generatingText;
      let result;
      try {
        result = await window.api.getPreview(img.path);
      } catch (err) {
        // 同 loadFullPreview：这里 reject 会让 loading 遮罩永久转圈。
        if (token !== this._previewToken || !this.isOpen) return;
        const message = err?.message || '预览加载失败';
        this.hideLoading();
        document.getElementById('info-dimensions').textContent = message;
        Toast.error(`${img.name}：${message}`);
        if (outgoing && outgoing.classList.contains('loaded')) outgoing.style.opacity = '1';
        this.prefetchAdjacent();
        return;
      }
      if (token !== this._previewToken || !this.isOpen) return;
      if (!result.success) {
        const message = result.error || '预览不可用';
        this.hideLoading();
        document.getElementById('info-dimensions').textContent = message;
        // 信息栏在右侧、图像区是空的，只有这一行小字太容易被忽略，再弹一次提示
        Toast.error(`${img.name}：${message}`);
        if (outgoing && outgoing.classList.contains('loaded')) outgoing.style.opacity = '1';
        // 生成失败也要预热相邻项，避免连续翻页时每张都从零等待。
        this.prefetchAdjacent();
        return;
      }
      incoming.src = result.url;
    } else {
      incoming.src = Waterfall.getFileURL(img.path);
    }
  },

  onImageReady(incoming, outgoing, img, direction, options = {}) {
    this.hideLoading();
    this._originalLoading = false;
    this._showingOriginal = Boolean(options.original);
    this.image = incoming;
    this.standbyImage = incoming === this._layerA ? this._layerB : this._layerA;
    this.calcScales();
    this.scale = this._showingOriginal ? this.getPixelScale() : this.fitScale;
    this.panX = 0;
    this.panY = 0;
    if (this._showingOriginal && img) this._fullPreviewPath = img.path;
    incoming.classList.add('loaded');
    // 从 0.985 / 位移状态过渡到适配尺寸；方向只影响入场的一点点位移。
    void incoming.offsetWidth;
    this.applyTransform(true);
    incoming.style.opacity = '1';

    if (outgoing && outgoing !== incoming) {
      outgoing.style.opacity = '0';
      this._swapTimer = setTimeout(() => {
        if (this.image === outgoing) return;
        // 必须先解绑再清空 src：对 <img> 赋空 src 会触发 error，
        // 此时 onerror 还挂着就会误报「上一张加载失败」。
        outgoing.onload = null;
        outgoing.onerror = null;
        outgoing.classList.remove('loaded');
        outgoing.style.display = 'none';
        outgoing.src = '';
        outgoing.style.transform = '';
        this._swapTimer = null;
      }, 240);
    }

    if (img) {
      let suffix = img.isRaw ? ' · RAW 预览' : '';
      if (this._showingOriginal) suffix += ' · 原图';
      if (this.rotation) suffix += ` · 旋转 ${this.rotation}°`;
      // 「原图」显示实际解码出的像素尺寸；RAW 的内嵌全尺寸 JPEG 可能略小于
      // 传感器尺寸（例如 6208×4092 的 NEF 内嵌图是 6144×4080），如实显示。
      const useDecodedSize = this._showingOriginal && this.needsGeneratedPreview(img);
      const width = useDecodedSize ? incoming.naturalWidth : (img.width > 0 ? img.width : incoming.naturalWidth);
      const height = useDecodedSize ? incoming.naturalHeight : (img.height > 0 ? img.height : incoming.naturalHeight);
      const display = MediewOrientation.rotatedSize(width, height, this.rotation);
      document.getElementById('info-dimensions').textContent = `${display.width} × ${display.height} px${suffix}`;
      this.prefetchAdjacent();
      this.updateOriginalButton();
    }
  },

  /**
   * 预热前后各一张，与 gkpv 的 lbPreloadAdjacent() 目标一致。
   * 注意不循环：Mediew 的上一张/下一张在两端禁用，保持线性语义。
   * 生成型格式交给主进程 preparePreview；可解码格式在渲染层用 <img> 预热解码，
   * 等价于 gkpv 里 `const img = new Image(); img.src = url` 的做法。
   * _preloadImages 是这些预热对象的唯一持有者，离开保留集合就释放。
   */
  prefetchAdjacent() {
    const keep = new Set([this.currentIndex + 1, this.currentIndex - 1]);
    for (const [index, preload] of this._preloadImages) {
      if (keep.has(index)) continue;
      preload.src = '';
      this._preloadImages.delete(index);
    }
    keep.forEach((index) => {
      const item = this.imageList[index];
      if (!item || item.type !== 'image') return;
      if (this.needsGeneratedPreview(item)) {
        window.api.preparePreview(item.path);
        return;
      }
      if (this._preloadImages.has(index)) return;
      const preload = new Image(); // 只是让浏览器提前解码
      preload.src = Waterfall.getFileURL(item.path);
      this._preloadImages.set(index, preload);
    });
  },

  updateInfo(img) {
    const filenameEl = document.getElementById('info-filename');
    filenameEl.textContent = img.name;
    filenameEl.title = img.relativePath || img.name;
    document.getElementById('info-folder').textContent = img.folder || '当前目录';
    if (img.width && img.height) {
      const display = MediewOrientation.rotatedSize(img.width, img.height, this.rotation);
      const rotationSuffix = this.rotation ? ` · 旋转 ${this.rotation}°` : '';
      document.getElementById('info-dimensions').textContent = `${display.width} × ${display.height} px${rotationSuffix}`;
    } else {
      document.getElementById('info-dimensions').textContent = '加载中...';
    }
    document.getElementById('info-filesize').textContent = this.formatSize(img.size);
    document.getElementById('info-date').textContent = img.date || '未知日期';
    document.getElementById('info-camera').textContent = img.camera || '-';
    document.getElementById('info-lens').textContent = img.lens || '-';
    const exposure = [img.aperture, img.shutter].filter(Boolean).join(' · ') || '-';
    document.getElementById('info-exposure').textContent = exposure;
    document.getElementById('info-iso').textContent = img.iso ? `ISO ${img.iso}` : '-';
    document.getElementById('info-format').textContent = img.type === 'video'
      ? '视频'
      : (img.isRaw ? `RAW · ${img.rawFormat}` : (img.extension || '').replace('.', '').toUpperCase() || '图片');
    const infoTitle = document.querySelector('.info-title');
    if (infoTitle) infoTitle.textContent = img.type === 'video' ? '视频信息' : (img.isRaw ? 'RAW 信息' : '图片信息');
  },

  formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  },

  updateNav() {
    this.prevBtn.disabled = this.currentIndex <= 0;
    this.nextBtn.disabled = this.currentIndex >= this.imageList.length - 1;
    this.counter.textContent = `${this.currentIndex + 1} / ${this.imageList.length}`;
  },

  prev() {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      this.showImage(-1);
    }
  },

  next() {
    if (this.currentIndex < this.imageList.length - 1) {
      this.currentIndex++;
      this.showImage(1);
    }
  },

  onDblClick(e) {
    if (!this.isOpen) return;
    e.preventDefault();
    e.stopPropagation();

    if (this.isVideo) {
      this.toggleFullscreen();
      return;
    }

    const rect = this.container.getBoundingClientRect();
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top - rect.height / 2;

    const midScale = (this.fitScale + this.maxScale) / 2;
    const target = this.scale > midScale ? this.fitScale : this.maxScale;

    const oldScale = this.scale;
    this.scale = Math.max(0.05, Math.min(this.maxScale * 2, target));

    this.panX = cx - (cx - this.panX) * this.scale / oldScale;
    this.panY = cy - (cy - this.panY) * this.scale / oldScale;

    this.clampPan();
    this.applyTransform(true);
  },

  onWheel(e) {
    if (!this.isOpen) return;
    e.preventDefault();

    const rect = this.container.getBoundingClientRect();
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top - rect.height / 2;

    const oldScale = this.scale;
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    this.scale = Math.max(0.05, Math.min(this.maxScale * 2, this.scale * factor));

    this.panX = cx - (cx - this.panX) * this.scale / oldScale;
    this.panY = cy - (cy - this.panY) * this.scale / oldScale;

    this.clampPan();
    this.applyTransform(false);
  },

  onMouseDown(e) {
    if (!this.isOpen || e.button !== 0) return;
    if (this.isVideo) return;

    this.isDragging = true;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    this.lastPanX = this.panX;
    this.lastPanY = this.panY;
    this.container.classList.add('dragging');
    this.image.style.transition = 'none';
  },

  onMouseMove(e) {
    if (!this.isDragging) return;

    this.panX = this.lastPanX + (e.clientX - this.dragStartX);
    this.panY = this.lastPanY + (e.clientY - this.dragStartY);
    this.clampPan();
    this.applyTransform(false);
  },

  onMouseUp() {
    if (!this.isDragging) return;
    this.isDragging = false;
    this.container.classList.remove('dragging');
  },

  onKeyDown(e) {
    if (!this.isOpen) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (this.isVideo) {
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          this.video.currentTime = Math.max(0, this.video.currentTime - 5);
          break;
        case 'ArrowRight':
          e.preventDefault();
          this.video.currentTime = Math.min(this.video.duration, this.video.currentTime + 5);
          break;
        case 'Escape':
          if (document.fullscreenElement) {
            document.exitFullscreen();
          } else {
            this.close();
          }
          break;
        case ' ':
          e.preventDefault();
          this.togglePlay();
          break;
      }
      return;
    }

    if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      this.rotateBy(e.shiftKey ? -90 : 90);
      return;
    }
    if ((e.key === 'o' || e.key === 'O') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      this.toggleOriginal();
      return;
    }

    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        this.prev();
        break;
      case 'ArrowRight':
        e.preventDefault();
        this.next();
        break;
      case 'Escape':
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else {
          this.close();
        }
        break;
      case '+':
      case '=':
        e.preventDefault();
        this.zoomTo(this.scale * 1.2, false);
        break;
      case '-':
        e.preventDefault();
        this.zoomTo(this.scale / 1.2, false);
        break;
      case '0':
        e.preventDefault();
        this.zoomTo(this.fitScale, true);
        break;
    }
  },

  startRename() {
    if (!this.isOpen) return;
    const img = this.imageList[this.currentIndex];
    if (!img) return;

    const filenameEl = document.getElementById('info-filename');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-rename-input';
    input.value = img.name.replace(/\.[^.]+$/, '');

    filenameEl.replaceWith(input);
    input.focus();
    input.select();

    const finishRename = async () => {
      const newName = input.value.trim();
      if (newName && newName !== img.name.replace(/\.[^.]+$/, '')) {
        App.fileOperationPending = true;
        const result = await window.api.renameFile(img.path, newName);
        if (result.success) {
          img.name = result.newPath.replace(/^.*[\\/]/, '');
          img.path = result.newPath;
          Waterfall.imageList[this.currentIndex] = img;
          Waterfall.allImages.forEach((item) => {
            if (item === img) return;
            if (item.path === result.newPath || item.name === img.name) Object.assign(item, img);
          });
        } else {
          App.fileOperationPending = false;
          Toast.error(result.error || '重命名失败');
        }
      }
      const restored = document.createElement('span');
      restored.className = 'info-value';
      restored.id = 'info-filename';
      restored.textContent = img.name;
      restored.title = img.name;
      input.replaceWith(restored);
      restored.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this.startRename();
      });
    };

    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = img.name.replace(/\.[^.]+$/, ''); input.blur(); }
    });
    input.addEventListener('click', (e) => e.stopPropagation());
  }
};

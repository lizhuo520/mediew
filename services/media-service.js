'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const sharp = require('./sharp-config');
const exifr = require('exifr');
const { ExifTool } = require('exiftool-vendored');

const { getMediaInfo } = require('./media-types');
const { probeImageSize } = require('./image-size');
const { createLimiter, mapWithConcurrency } = require('./concurrency');
const { MetadataCache } = require('./metadata-cache');
const {
  buildDateInfo,
  formatAperture,
  formatExposure,
  parseDimensions
} = require('./date-utils');
const { Orientation } = require('../renderer/utils/orientation');

// 限制 sharp 处理超大图片时的像素数，防止异常文件拖垮进程。
const MAX_INPUT_PIXELS = 300000000;

// 输出规格与 gkpv 对齐：
// - 缩略图最长边 640、JPEG q0.8（gkpv 的 THUMB_MAX / THUMB_QUALITY）；
// - 预览图最长边 4096、JPEG q0.92（gkpv 灯箱对 RAW 重编码使用 q0.92）。
// 二者都只限制最长边，短边按比例，且不放大源图。
const THUMBNAIL_MAX = 640;
const THUMBNAIL_QUALITY = 80;
const PREVIEW_MAX = 4096;
const PREVIEW_QUALITY = 92;
// 「查看原图」用的全分辨率预览：不按 4096 缩，最长边上限放到 16384，
// 避免极少数 100MP 以上的图把内存打爆；正常照片就是原始像素。
const PREVIEW_FULL_MAX = 16384;
const PREVIEW_FULL_QUALITY = 95;

// 缓存内容版本号：缩略图/预览的语义变化时递增，旧条目会因为键变化而自动失效。
const CACHE_VERSION = 'v3-orientation';

// 宽高比探测的并发上限。sharp 只读文件头，属于轻量 IO 任务，
// 但 Windows 上过高的并发会让磁盘队列变长，因此取 16。
const DIMENSION_CONCURRENCY = 16;
const SKIP_DIRECTORY_NAMES = new Set([
  'node_modules', '.git', '.svn', '.hg', '$recycle.bin', 'system volume information'
]);
const EXIF_PICK = [
  'DateTimeOriginal', 'DateTimeDigitized', 'CreateDate',
  'Make', 'Model', 'LensModel', 'LensID',
  'FNumber', 'ApertureValue', 'ExposureTime', 'ShutterSpeedValue',
  'ISO', 'ISOSetting', 'RecommendedExposureIndex',
  'Orientation', 'ImageWidth', 'ImageHeight',
  'ExifImageWidth', 'ExifImageHeight', 'ImageSize'
];

/**
 * 判断路径是否存在且为普通文件。
 */
async function fileExists(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch (_) {
    return false;
  }
}

/**
 * 忽略清理临时文件时的错误，避免影响真正的缩略图生成结果。
 */
async function safeUnlink(filePath) {
  if (!filePath) return;
  // Windows 上 ExifTool/sharp 可能短暂保留文件句柄，失败时进行少量退避重试。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fsp.unlink(filePath);
      return;
    } catch (_) {
      if (attempt === 4) return;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

/**
 * 合并元数据，但绝不用「缺失的尺寸」覆盖已经探测好的宽高比。
 * PNG/WebP/GIF 通常没有 EXIF 尺寸，readMetadata 会返回 width/height = 0；
 * 直接 Object.assign 会让瀑布流丢掉占位比例（卡片会在缩略图到达后跳动）。
 * 返回 true 表示这次合并提供了有效尺寸。
 */
function mergeMetadata(target, metadata) {
  const { width, height, ...rest } = metadata;
  Object.assign(target, rest);
  if (width > 0 && height > 0) {
    target.width = width;
    target.height = height;
    return true;
  }
  return false;
}

/**
 * 清洗 EXIF 字符串，避免对象或多行文本直接显示到界面。
 */
function normalizeText(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.filter(Boolean).join(', ');
  if (typeof value === 'object') {
    if (typeof value.toString === 'function') {
      const text = value.toString();
      if (text && text !== '[object Object]') return text.trim();
    }
    return '';
  }
  return String(value).trim();
}

/**
 * 生成易读的相机名称，避免出现 "Canon Canon EOS R6" 这类重复前缀。
 */
function buildCameraName(tags) {
  const make = normalizeText(tags.Make);
  const model = normalizeText(tags.Model);
  if (!make) return model;
  if (!model) return make;
  return model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`;
}

/**
 * 将 EXIF 中的常见 ISO 字段归一化为数字或字符串。
 */
function normalizeIso(value) {
  if (value === undefined || value === null || value === '') return '';
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric) : normalizeText(value);
}

/**
 * 媒体服务负责目录扫描、元数据缓存、缩略图、RAW 预览、收藏和子目录读取。
 * 所有耗时任务都经过并发限制，避免阻塞 Electron 主进程事件循环。
 */
class MediaService {
  constructor({ userDataPath }) {
    this.userDataPath = userDataPath;
    this.cacheRoot = path.join(userDataPath, 'media-cache');
    this.thumbnailRoot = path.join(this.cacheRoot, 'thumbnails');
    this.previewRoot = path.join(this.cacheRoot, 'previews');
    this.tempRoot = path.join(this.cacheRoot, 'temp');
    this.favoritesFile = path.join(userDataPath, 'favorites.json');
    // 缓存文件名带版本：v1 存的是未按 EXIF 方向转正的宽高，
    // 会让竖拍照片的占位比例反过来，因此必须整体失效。
    this.metadataCache = new MetadataCache(path.join(userDataPath, 'metadata-cache-v3.json'));
    // 宽高比缓存单独存放：它在缩略图生成前就要用上，
    // 与 EXIF 的「待补齐」状态（metadataPending）互不影响。
    // v2 起使用统一的 Orientation 归一化规则，旧缓存可能带错误显示尺寸。
    this.dimensionCache = new MetadataCache(path.join(userDataPath, 'dimension-cache-v2.json'));
    this.rawOrientationCache = new Map();

    // ExifTool 使用子进程池；限制进程数可避免 RAW 扫描占满全部 CPU。
    const maxProcs = Math.max(2, Math.min(4, os.cpus().length || 2));
    this.exiftool = new ExifTool({
      maxProcs,
      minDelayBetweenSpawnMillis: 0,
      streamFlushMillis: 10
    });

    this.metadataLimiter = createLimiter(4);
    this.thumbnailLimiter = createLimiter(4);
    this.previewLimiter = createLimiter(2);
    this.thumbnailInflight = new Map();
    this.previewInflight = new Map();
    this.activeScan = null;
    this.scanSequence = 0;
    this.favorites = new Set();
    this.favoriteSaveTimer = null;
  }

  async initialize() {
    await Promise.all([
      fsp.mkdir(this.thumbnailRoot, { recursive: true }),
      fsp.mkdir(this.previewRoot, { recursive: true }),
      fsp.mkdir(this.tempRoot, { recursive: true }),
      this.metadataCache.load(),
      this.dimensionCache.load(),
      this.loadFavorites()
    ]);
  }

  /**
   * 快速建立目录快照。
   * 首屏只进行异步 readdir/stat，并使用缓存或文件时间立即返回；
   * 缺失的 EXIF 数据在后台分批补齐，因此不会让界面等待所有文件解析完成。
   */
  async startDirectoryScan(dirPath, options = {}) {
    this.cancelActiveScan();
    const scanId = `${Date.now()}-${++this.scanSequence}`;
    const recursive = Boolean(options.recursive);
    const scan = { scanId, cancelled: false, callbacks: options, recursive };
    this.activeScan = scan;

    let mediaEntries = [];
    try {
      mediaEntries = await this.collectMediaEntries(dirPath, recursive, scan);
    } catch (error) {
      if (typeof options.onError === 'function') options.onError(error);
      return { scanId, items: [], pendingCount: 0, recursive };
    }

    const items = await mapWithConcurrency(mediaEntries, 16, async (entry) => {
      const stat = await fsp.stat(entry.filePath);
      return this.createBaseItem(entry.filePath, stat, getMediaInfo(entry.filePath), entry.relativePath);
    });

    items.sort((a, b) => a.mtime - b.mtime);
    const pending = items.filter((item) => item.metadataPending && item.type === 'image');

    if (pending.length > 0) {
      this.enrichScan(scan, pending).catch((error) => {
        if (!scan.cancelled && typeof options.onError === 'function') options.onError(error);
      });
    } else {
      queueMicrotask(() => {
        if (!scan.cancelled && typeof options.onComplete === 'function') {
          options.onComplete({ scanId, total: 0, completed: 0 });
        }
      });
    }

    this.scheduleDimensionProbe(scan, items);

    return { scanId, items, pendingCount: pending.length, recursive };
  }

  /**
   * 读取当前目录或递归读取全部子目录中的媒体条目。
   * 每批并行读取 8 个目录，避免同步递归或一次性并发过高压垮主进程。
   */
  async collectMediaEntries(rootPath, recursive, scan) {
    if (!recursive) {
      const entries = await fsp.readdir(rootPath, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && getMediaInfo(entry.name).supported)
        .map((entry) => ({ filePath: path.join(rootPath, entry.name), relativePath: entry.name }));
    }

    const mediaEntries = [];
    const directories = [rootPath];
    let index = 0;
    while (index < directories.length) {
      if (scan.cancelled) break;
      const batch = directories.slice(index, index + 8);
      index += batch.length;
      const results = await Promise.all(batch.map(async (directory) => {
        try {
          return { directory, entries: await fsp.readdir(directory, { withFileTypes: true }) };
        } catch (_) {
          // 无权限目录或扫描过程中被删除的目录直接跳过。
          return { directory, entries: [] };
        }
      }));

      results.forEach(({ directory, entries }) => {
        entries.forEach((entry) => {
          const fullPath = path.join(directory, entry.name);
          if (entry.isFile() && getMediaInfo(entry.name).supported) {
            mediaEntries.push({ filePath: fullPath, relativePath: path.relative(rootPath, fullPath) });
          } else if (entry.isDirectory()) {
            const lowerName = entry.name.toLowerCase();
            if (!entry.name.startsWith('.') && !SKIP_DIRECTORY_NAMES.has(lowerName)) directories.push(fullPath);
          }
        });
      });
    }
    return mediaEntries;
  }

  /**
   * 取消上一轮目录扫描。
   * 已经进入底层解码的任务无法强制中止，但其结果不会再发送到渲染层。
   */
  cancelActiveScan() {
    if (this.activeScan) this.activeScan.cancelled = true;
    this.activeScan = null;
  }

  createBaseItem(filePath, stat, mediaInfo, relativePath = path.basename(filePath)) {
    const signature = `${stat.size}:${Math.floor(stat.mtimeMs)}`;
    const cached = this.metadataCache.get(filePath, signature);
    const fallback = buildDateInfo(stat.mtimeMs, 'mtime');
    const dimensions = mediaInfo.type === 'image' ? this.dimensionCache.get(filePath, signature) : null;

    const item = {
      name: path.basename(filePath),
      path: filePath,
      relativePath,
      folder: path.dirname(relativePath) === '.' ? '' : path.dirname(relativePath),
      size: stat.size,
      mtime: stat.mtimeMs,
      type: mediaInfo.type,
      isRaw: mediaInfo.isRaw,
      rawFormat: mediaInfo.rawFormat,
      extension: mediaInfo.extension,
      signature,
      favorite: this.favorites.has(filePath),
      ...fallback,
      width: 0,
      height: 0,
      metadataPending: !cached && mediaInfo.type === 'image'
    };

    // 先用缓存的宽高比占位；EXIF 尺寸更权威，但为 0 时不能反过来覆盖它。
    if (dimensions && dimensions.width > 0 && dimensions.height > 0) {
      item.width = dimensions.width;
      item.height = dimensions.height;
    }
    if (cached) mergeMetadata(item, cached);
    return item;
  }

  /**
   * 宽高比探测采用「快照优先、后台补正」。
   * 缓存命中项已经带着 width/height 返回，首屏即可按真实比例占位；
   * 未命中的项在后台限流探测并增量推送，不阻塞首屏渲染。
   * 目标与 gkpv 的 premeasureAspects 一致（消除缩略图到达后的跳动），
   * 但不引入 gkpv 那种「等全部测量完再排版」的整屏等待。
   */
  scheduleDimensionProbe(scan, items) {
    const targets = items.filter((item) => item.type === 'image' && !(item.width > 0 && item.height > 0));
    if (targets.length === 0) {
      queueMicrotask(() => {
        if (!scan.cancelled && typeof scan.callbacks.onDimensionsComplete === 'function') {
          scan.callbacks.onDimensionsComplete({ scanId: scan.scanId });
        }
      });
      return;
    }
    this.enrichDimensions(scan, targets).catch((error) => {
      if (!scan.cancelled && typeof scan.callbacks.onError === 'function') scan.callbacks.onError(error);
    });
  }

  /**
   * 后台分批探测宽高比。每批最多 24 条或间隔 150ms 推送一次，
   * 与 EXIF 的增量推送保持同样的节流节奏。
   */
  async enrichDimensions(scan, targets) {
    const total = targets.length;
    let completed = 0;
    let buffer = [];
    let lastFlush = 0;

    const flush = (force = false) => {
      if (scan.cancelled || buffer.length === 0) return;
      const now = Date.now();
      if (!force && buffer.length < 24 && now - lastFlush < 150) return;
      const items = buffer;
      buffer = [];
      lastFlush = now;
      if (typeof scan.callbacks.onDimensions === 'function') {
        scan.callbacks.onDimensions({ scanId: scan.scanId, items, completed, total });
      }
    };

    await mapWithConcurrency(targets, DIMENSION_CONCURRENCY, async (item) => {
      if (scan.cancelled) return;
      let size = null;
      try {
        size = await probeImageSize(item.path, { maxInputPixels: MAX_INPUT_PIXELS });
      } catch (_) {
        size = null;
      }
      completed += 1;
      // 探测失败不写缓存，也不推送：渲染层保留默认占位，下次访问可以重试。
      if (!size) return;
      item.width = size.width;
      item.height = size.height;
      this.dimensionCache.set(item.path, item.signature, { width: size.width, height: size.height });
      buffer.push({ path: item.path, width: size.width, height: size.height });
      flush(false);
    });

    flush(true);
    if (!scan.cancelled && typeof scan.callbacks.onDimensionsComplete === 'function') {
      scan.callbacks.onDimensionsComplete({ scanId: scan.scanId, total, completed });
    }
  }

  /**
   * 后台分批读取缺失的 EXIF 信息，并通过 IPC 回调推送增量结果。
   */
  async enrichScan(scan, pendingItems) {
    const total = pendingItems.length;
    let completed = 0;
    let buffer = [];
    let lastFlush = 0;

    const flush = (force = false) => {
      if (scan.cancelled || buffer.length === 0) return;
      const now = Date.now();
      if (!force && buffer.length < 16 && now - lastFlush < 120) return;
      const items = buffer;
      buffer = [];
      lastFlush = now;
      if (typeof scan.callbacks.onBatch === 'function') {
        scan.callbacks.onBatch({ scanId: scan.scanId, items, completed, total });
      }
    };

    await mapWithConcurrency(pendingItems, 4, async (item) => {
      if (scan.cancelled) return;
      let metadata;
      try {
        metadata = await this.metadataLimiter(() => this.readMetadata(item.path, item));
      } catch (error) {
        metadata = {
          ...buildDateInfo(item.mtime, 'mtime'),
          metadataPending: false,
          metadataError: true,
          metadataErrorText: error && error.message ? error.message : '元数据读取失败'
        };
      }

      this.metadataCache.set(item.path, item.signature, metadata);
      // 不能用 EXIF 里缺失的尺寸（0）覆盖已经探测好的宽高比。
      mergeMetadata(item, metadata);
      // 推送的载荷统一带上「当前已知的最佳尺寸」，避免渲染层收到 0。
      buffer.push({ path: item.path, ...metadata, width: item.width, height: item.height });
      completed += 1;
      flush(false);
    });

    flush(true);
    if (!scan.cancelled && typeof scan.callbacks.onComplete === 'function') {
      scan.callbacks.onComplete({ scanId: scan.scanId, total, completed });
    }
  }

  /**
   * 读取单张图片或 RAW 的拍摄信息。
   * 标准图片优先使用 exifr，RAW 使用 ExifTool；失败时保留文件时间作为降级结果。
   */
  async readMetadata(filePath, item) {
    const fallback = buildDateInfo(item.mtime, 'mtime');
    if (item.type === 'video') {
      return {
        ...fallback,
        camera: '', lens: '', aperture: '', shutter: '', iso: '',
        width: 0, height: 0, orientation: 1,
        metadataPending: false
      };
    }

    let tags = null;
    if (item.isRaw) {
      tags = await this.exiftool.read(filePath);
    } else {
      try {
        tags = await exifr.parse(filePath, {
          pick: EXIF_PICK,
          translateValues: false,
          reviveValues: true
        });
      } catch (_) {
        tags = null;
      }
    }
    tags = tags || {};

    const dateValue = tags.DateTimeOriginal || tags.CreateDate || tags.DateTimeDigitized;
    const dateInfo = dateValue ? buildDateInfo(dateValue, 'exif') : fallback;
    const dimensions = parseDimensions(
      tags.ExifImageWidth || tags.ImageWidth,
      tags.ExifImageHeight || tags.ImageHeight,
      tags.ImageSize
    );
    // EXIF 里的宽高是「传感器像素」尺寸，没有考虑 EXIF 方向。
    // 瀑布流占位和信息面板需要的是「显示尺寸」，因此这里与 probeImageSize()
    // 使用同一规则：Orientation 5~8 时交换宽高，保证与 sharp().rotate() 的
    // 输出、以及 <img> 的实际朝向三者一致。
    const orientation = Orientation.normalize(tags.Orientation);
    const displayDimensions = Orientation.toDisplaySize(dimensions.width, dimensions.height, orientation);

    return {
      ...dateInfo,
      camera: buildCameraName(tags),
      lens: normalizeText(tags.LensModel || tags.LensID || tags.Lens),
      aperture: formatAperture(tags.FNumber || tags.ApertureValue),
      shutter: formatExposure(tags.ExposureTime || tags.ShutterSpeedValue),
      iso: normalizeIso(tags.ISO || tags.ISOSetting || tags.RecommendedExposureIndex),
      width: displayDimensions.width,
      height: displayDimensions.height,
      orientation,
      metadataPending: false,
      metadataError: false
    };
  }

  /**
   * 读取一级子目录，供文件夹树懒加载使用。
   */
  async getSubfolders(dirPath) {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
  }

  /**
   * 返回标准图片或 RAW 的缓存缩略图。
   */
  async getThumbnail(filePath, requestedSize = THUMBNAIL_MAX) {
    const size = this.normalizeThumbnailSize(requestedSize);
    try {
      const stat = await fsp.stat(filePath);
      const mediaInfo = getMediaInfo(filePath);
      if (!mediaInfo.supported || mediaInfo.type !== 'image') {
        return { success: false, error: '该文件不是可预览图片' };
      }
      const key = this.createCacheKey(filePath, stat, `thumb-${size}`);
      const target = path.join(this.thumbnailRoot, `${key}.jpg`);
      if (await fileExists(target)) {
        return { success: true, url: pathToFileURL(target).href, fromCache: true };
      }
      if (this.thumbnailInflight.has(key)) return this.thumbnailInflight.get(key);

      const promise = this.thumbnailLimiter(async () => {
        const result = await this.generateImage(filePath, target, size, mediaInfo, THUMBNAIL_QUALITY);
        return {
          success: true,
          url: pathToFileURL(target).href,
          fromCache: false,
          source: result.source
        };
      }).catch((error) => ({
        success: false,
        error: this.toUserError(error, mediaInfo)
      })).finally(() => {
        this.thumbnailInflight.delete(key);
      });

      this.thumbnailInflight.set(key, promise);
      return promise;
    } catch (error) {
      return { success: false, error: this.toUserError(error, getMediaInfo(filePath)) };
    }
  }

  /**
   * 返回预览地址。
   * 普通图片继续使用原图以保留最高缩放质量；
   * RAW、TIFF、HEIC 等浏览器不能稳定显示的格式改为生成缓存 JPEG。
   */
  async getPreview(filePath, options = {}) {
    try {
      const stat = await fsp.stat(filePath);
      const mediaInfo = getMediaInfo(filePath);
      if (!mediaInfo.supported || mediaInfo.type !== 'image') {
        return { success: false, error: '该文件不是可预览图片' };
      }

      const needsGenerated = mediaInfo.isRaw || ['.tif', '.tiff', '.heic', '.heif'].includes(mediaInfo.extension);
      if (!needsGenerated) {
        return {
          success: true,
          url: pathToFileURL(filePath).href,
          isRaw: mediaInfo.isRaw,
          source: 'original',
          full: true
        };
      }

      const full = Boolean(options && options.full);
      const maxSize = full ? PREVIEW_FULL_MAX : PREVIEW_MAX;
      const quality = full ? PREVIEW_FULL_QUALITY : PREVIEW_QUALITY;
      // 标准预览沿用旧缓存键，只有「原图」使用新的 full 键。
      const variant = full ? `preview-full-${PREVIEW_FULL_MAX}` : `preview-${PREVIEW_MAX}`;
      const key = this.createCacheKey(filePath, stat, variant);
      const target = path.join(this.previewRoot, `${key}.jpg`);
      if (await fileExists(target)) {
        return { success: true, url: pathToFileURL(target).href, isRaw: mediaInfo.isRaw, source: 'cache', full };
      }
      if (this.previewInflight.has(key)) return this.previewInflight.get(key);

      const promise = this.previewLimiter(async () => {
        const result = await this.generateImage(filePath, target, maxSize, mediaInfo, quality);
        return {
          success: true,
          url: pathToFileURL(target).href,
          isRaw: mediaInfo.isRaw,
          source: result.source,
          full
        };
      }).catch((error) => ({
        success: false,
        error: this.toUserError(error, mediaInfo)
      })).finally(() => {
        this.previewInflight.delete(key);
      });

      this.previewInflight.set(key, promise);
      return promise;
    } catch (error) {
      return { success: false, error: this.toUserError(error, getMediaInfo(filePath)) };
    }
  }

  /**
   * 提前生成下一张预览，仍由独立并发限制控制，不阻塞当前预览。
   */
  preparePreview(filePath) {
    this.getPreview(filePath).catch(() => {});
    return { success: true };
  }

  /**
   * 缩略图只有唯一规格：最长边 640（与 gkpv 的 THUMB_MAX 一致，S/M/L 只影响显示大小）。
   * 保留 size 参数是为了不破坏既有 IPC 调用，任何取值都会归一到该规格。
   */
  normalizeThumbnailSize() {
    return THUMBNAIL_MAX;
  }

  createCacheKey(filePath, stat, variant) {
    const signature = `${CACHE_VERSION}|${filePath}|${stat.size}|${Math.floor(stat.mtimeMs)}|${variant}`;
    return crypto.createHash('sha256').update(signature).digest('hex');
  }

  /**
   * 根据媒体格式选择 sharp 或 ExifTool 提取路径，并原子写入缓存文件。
   */
  async generateImage(filePath, target, maxSize, mediaInfo, quality = THUMBNAIL_QUALITY) {
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      const result = mediaInfo.isRaw
        ? await this.generateRawImage(filePath, temporary, maxSize, mediaInfo, quality)
        : await this.resizeWithSharp(filePath, temporary, maxSize, quality);
      await this.commitTemporaryFile(temporary, target);
      return result;
    } catch (error) {
      await safeUnlink(temporary);
      throw error;
    }
  }

  /**
   * 标准图片缩放。orientation 会自动应用，输出 progressive JPEG 以便浏览器渐进显示。
   * 继续使用 mozjpeg：与 gkpv 的 Chromium 编码相比，同等 quality 下体积更小。
   */
  async resizeWithSharp(source, targetPath, maxSize, quality = THUMBNAIL_QUALITY, options = {}) {
    const inputOptions = { failOn: 'none', limitInputPixels: MAX_INPUT_PIXELS };
    if (typeof source === 'string') inputOptions.sequentialRead = true;
    let pipeline = sharp(source, inputOptions);
    // 输入自带 EXIF 时用 rotate() 自动定向；RAW 内嵌 JPEG 若没有方向标签，
    // 则用源 RAW 的 Orientation 显式旋转，避免内嵌预览与主文件方向不一致。
    if (options.explicitOrientation) {
      pipeline = Orientation.applyToSharp(pipeline, options.explicitOrientation);
    } else {
      pipeline = pipeline.rotate();
    }
    await pipeline
      .resize({
        width: maxSize,
        height: maxSize,
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({
        quality,
        progressive: true,
        mozjpeg: true,
        chromaSubsampling: '4:2:0'
      })
      .toFile(targetPath);
    return { source: 'sharp' };
  }

  /**
   * RAW 解码策略：
   * 1. DNG 等 TIFF-RAW 先尝试 sharp，成功时可获得完整图像；
   * 2. 其余格式优先提取相机内嵌 JPEG，兼容性最好且无需本机 LibRaw 编译；
   * 3. 最后再次回退 sharp，覆盖部分有效的 DNG/JPEG-in-RAW 变体。
   */
  async generateRawImage(filePath, targetPath, maxSize, mediaInfo, quality = THUMBNAIL_QUALITY) {
    let lastError = null;
    const preferSharp = ['.dng', '.tif', '.tiff'].includes(mediaInfo.extension);

    if (preferSharp) {
      try {
        return await this.resizeWithSharp(filePath, targetPath, maxSize, quality);
      } catch (error) {
        lastError = error;
      }
    }

    // 直接从 ExifTool 读取二进制预览，避免 Windows 临时文件句柄未释放导致 EPERM。
    const sourceOrientation = await this.getSourceOrientation(filePath);
    const previewTags = ['PreviewImage', 'JpgFromRaw', 'ThumbnailImage', 'OtherImage'];
    for (const tagName of previewTags) {
      try {
        const buffer = await this.exiftool.extractBinaryTagToBuffer(tagName, filePath);
        if (buffer && buffer.length > 0) {
          const embedded = await sharp(buffer, { failOn: 'none', limitInputPixels: MAX_INPUT_PIXELS }).metadata();
          const embeddedOrientation = Orientation.normalize(embedded && embedded.orientation);
          const explicitOrientation = embeddedOrientation === 1 && sourceOrientation !== 1 ? sourceOrientation : null;
          await this.resizeWithSharp(buffer, targetPath, maxSize, quality, { explicitOrientation });
          return { source: `buffer:${tagName}` };
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (!preferSharp) {
      try {
        return await this.resizeWithSharp(filePath, targetPath, maxSize, quality);
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(`未找到可解码的 RAW 预览${lastError && lastError.message ? `：${lastError.message}` : ''}`);
  }

  /**
   * 读取 RAW 主文件方向，供没有 EXIF 的内嵌 JPEG 使用。
   * 只取 Orientation 一个标签，并按文件签名做小幅缓存，避免预览/缩略图重复解析。
   */
  async getSourceOrientation(filePath) {
    try {
      const stat = await fsp.stat(filePath);
      const signature = `${stat.size}:${Math.floor(stat.mtimeMs)}`;
      const key = `${filePath}|${signature}`;
      if (this.rawOrientationCache.has(key)) return this.rawOrientationCache.get(key);
      // 目录扫描通常已经读过一次 EXIF，能命中就省掉一次 ExifTool 子进程往返。
      const cached = this.metadataCache.get(filePath, signature);
      if (cached && cached.orientation) {
        const orientation = Orientation.normalize(cached.orientation);
        this.rawOrientationCache.set(key, orientation);
        return orientation;
      }
      const tags = await this.exiftool.readRaw(filePath, ['-Orientation']);
      const orientation = Orientation.normalize(tags && tags.Orientation);
      this.rawOrientationCache.set(key, orientation);
      if (this.rawOrientationCache.size > 200) {
        this.rawOrientationCache.delete(this.rawOrientationCache.keys().next().value);
      }
      return orientation;
    } catch (_) {
      return 1;
    }
  }

  async commitTemporaryFile(source, target) {
    try {
      await fsp.rename(source, target);
    } catch (error) {
      // 并发请求可能已由其他任务写入同一缓存文件。
      if (await fileExists(target)) {
        await safeUnlink(source);
        return;
      }
      throw error;
    }
  }

  toUserError(error, mediaInfo) {
    const message = error && error.message ? error.message : '图片处理失败';
    if (mediaInfo && mediaInfo.isRaw) return `RAW 预览不可用：${message}`;
    return message;
  }

  async loadFavorites() {
    try {
      const raw = await fsp.readFile(this.favoritesFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) this.favorites = new Set(parsed.filter((item) => typeof item === 'string'));
    } catch (_) {
      this.favorites = new Set();
    }
  }

  /**
   * 切换收藏状态并延迟写盘，返回值供渲染层立即更新星标。
   */
  toggleFavorite(filePath) {
    if (this.favorites.has(filePath)) {
      this.favorites.delete(filePath);
    } else {
      this.favorites.add(filePath);
    }
    this.scheduleFavoriteSave();
    return { success: true, favorite: this.favorites.has(filePath) };
  }

  isFavorite(filePath) {
    return this.favorites.has(filePath);
  }

  scheduleFavoriteSave() {
    if (this.favoriteSaveTimer) clearTimeout(this.favoriteSaveTimer);
    this.favoriteSaveTimer = setTimeout(() => {
      this.saveFavorites().catch(() => {});
    }, 500);
    if (this.favoriteSaveTimer.unref) this.favoriteSaveTimer.unref();
  }

  async saveFavorites() {
    if (this.favoriteSaveTimer) {
      clearTimeout(this.favoriteSaveTimer);
      this.favoriteSaveTimer = null;
    }
    const tempFile = `${this.favoritesFile}.${process.pid}.tmp`;
    try {
      await fsp.mkdir(path.dirname(this.favoritesFile), { recursive: true });
      await fsp.writeFile(tempFile, JSON.stringify(Array.from(this.favorites)), 'utf8');
      await fsp.rename(tempFile, this.favoritesFile);
    } catch (_) {
      await safeUnlink(tempFile);
    }
  }

  /**
   * 释放子进程和缓存资源。Electron 退出前必须等待该方法完成。
   */
  async dispose() {
    this.cancelActiveScan();
    await Promise.allSettled([
      this.metadataCache.flush(),
      this.dimensionCache.flush(),
      this.saveFavorites(),
      this.exiftool.end()
    ]);
  }
}

module.exports = { MediaService };

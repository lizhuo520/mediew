'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const sharp = require('sharp');
const exifr = require('exifr');
const { ExifTool } = require('exiftool-vendored');

const { getMediaInfo } = require('./media-types');
const { createLimiter, mapWithConcurrency } = require('./concurrency');
const { MetadataCache } = require('./metadata-cache');
const {
  buildDateInfo,
  formatAperture,
  formatExposure,
  parseDimensions
} = require('./date-utils');

// 限制 sharp 处理超大图片时的像素数，防止异常文件拖垮进程。
const MAX_INPUT_PIXELS = 300000000;
const THUMBNAIL_SIZES = [256, 384, 512, 768];
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
    this.metadataCache = new MetadataCache(path.join(userDataPath, 'metadata-cache.json'));

    // ExifTool 使用子进程池；限制进程数可避免 RAW 扫描占满全部 CPU。
    const maxProcs = Math.max(2, Math.min(4, os.cpus().length || 2));
    this.exiftool = new ExifTool({
      maxProcs,
      minDelayBetweenSpawnMillis: 0,
      streamFlushMillis: 10
    });

    this.metadataLimiter = createLimiter(4);
    this.thumbnailLimiter = createLimiter(3);
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
      this.loadFavorites()
    ]);
  }

  /**
   * 快速建立目录快照。
   * 首屏只进行异步 readdir/stat，并使用缓存或文件时间立即返回；
   * 缺失的 EXIF 数据在后台分批补齐，因此不会让界面等待所有文件解析完成。
   */
  async startDirectoryScan(dirPath, callbacks = {}) {
    this.cancelActiveScan();
    const scanId = `${Date.now()}-${++this.scanSequence}`;
    const scan = { scanId, cancelled: false, callbacks };
    this.activeScan = scan;

    let entries = [];
    try {
      entries = await fsp.readdir(dirPath, { withFileTypes: true });
    } catch (error) {
      if (typeof callbacks.onError === 'function') callbacks.onError(error);
      return { scanId, items: [], pendingCount: 0 };
    }

    const mediaEntries = entries.filter((entry) => entry.isFile() && getMediaInfo(entry.name).supported);
    const items = await mapWithConcurrency(mediaEntries, 16, async (entry) => {
      const filePath = path.join(dirPath, entry.name);
      const stat = await fsp.stat(filePath);
      return this.createBaseItem(filePath, stat, getMediaInfo(entry.name));
    });

    items.sort((a, b) => a.mtime - b.mtime);
    const pending = items.filter((item) => item.metadataPending && item.type === 'image');

    if (pending.length > 0) {
      this.enrichScan(scan, pending).catch((error) => {
        if (!scan.cancelled && typeof callbacks.onError === 'function') callbacks.onError(error);
      });
    } else {
      queueMicrotask(() => {
        if (!scan.cancelled && typeof callbacks.onComplete === 'function') {
          callbacks.onComplete({ scanId, total: 0, completed: 0 });
        }
      });
    }

    return { scanId, items, pendingCount: pending.length };
  }

  /**
   * 取消上一轮目录扫描。
   * 已经进入底层解码的任务无法强制中止，但其结果不会再发送到渲染层。
   */
  cancelActiveScan() {
    if (this.activeScan) this.activeScan.cancelled = true;
    this.activeScan = null;
  }

  createBaseItem(filePath, stat, mediaInfo) {
    const signature = `${stat.size}:${Math.floor(stat.mtimeMs)}`;
    const cached = this.metadataCache.get(filePath, signature);
    const fallback = buildDateInfo(stat.mtimeMs, 'mtime');
    const metadata = cached || {};
    return {
      name: path.basename(filePath),
      path: filePath,
      size: stat.size,
      mtime: stat.mtimeMs,
      type: mediaInfo.type,
      isRaw: mediaInfo.isRaw,
      rawFormat: mediaInfo.rawFormat,
      extension: mediaInfo.extension,
      signature,
      favorite: this.favorites.has(filePath),
      ...fallback,
      ...metadata,
      metadataPending: !cached && mediaInfo.type === 'image'
    };
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
      Object.assign(item, metadata);
      buffer.push({ path: item.path, ...metadata });
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

    return {
      ...dateInfo,
      camera: buildCameraName(tags),
      lens: normalizeText(tags.LensModel || tags.LensID || tags.Lens),
      aperture: formatAperture(tags.FNumber || tags.ApertureValue),
      shutter: formatExposure(tags.ExposureTime || tags.ShutterSpeedValue),
      iso: normalizeIso(tags.ISO || tags.ISOSetting || tags.RecommendedExposureIndex),
      width: dimensions.width,
      height: dimensions.height,
      orientation: Number(tags.Orientation) || 1,
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
  async getThumbnail(filePath, requestedSize = 512) {
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
        const result = await this.generateImage(filePath, target, size, mediaInfo);
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
  async getPreview(filePath) {
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
          source: 'original'
        };
      }

      const key = this.createCacheKey(filePath, stat, 'preview-2560');
      const target = path.join(this.previewRoot, `${key}.jpg`);
      if (await fileExists(target)) {
        return { success: true, url: pathToFileURL(target).href, isRaw: mediaInfo.isRaw, source: 'cache' };
      }
      if (this.previewInflight.has(key)) return this.previewInflight.get(key);

      const promise = this.previewLimiter(async () => {
        const result = await this.generateImage(filePath, target, 2560, mediaInfo);
        return {
          success: true,
          url: pathToFileURL(target).href,
          isRaw: mediaInfo.isRaw,
          source: result.source
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

  normalizeThumbnailSize(size) {
    const numeric = Number(size) || 512;
    return THUMBNAIL_SIZES.reduce((best, current) => (
      Math.abs(current - numeric) < Math.abs(best - numeric) ? current : best
    ), THUMBNAIL_SIZES[0]);
  }

  createCacheKey(filePath, stat, variant) {
    const signature = `${filePath}|${stat.size}|${Math.floor(stat.mtimeMs)}|${variant}`;
    return crypto.createHash('sha256').update(signature).digest('hex');
  }

  /**
   * 根据媒体格式选择 sharp 或 ExifTool 提取路径，并原子写入缓存文件。
   */
  async generateImage(filePath, target, maxSize, mediaInfo) {
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      const result = mediaInfo.isRaw
        ? await this.generateRawImage(filePath, temporary, maxSize, mediaInfo)
        : await this.resizeWithSharp(filePath, temporary, maxSize);
      await this.commitTemporaryFile(temporary, target);
      return result;
    } catch (error) {
      await safeUnlink(temporary);
      throw error;
    }
  }

  /**
   * 标准图片缩放。orientation 会自动应用，输出 progressive JPEG 以便浏览器渐进显示。
   */
  async resizeWithSharp(source, targetPath, maxSize) {
    const inputOptions = { failOn: 'none', limitInputPixels: MAX_INPUT_PIXELS };
    if (typeof source === 'string') inputOptions.sequentialRead = true;
    await sharp(source, inputOptions)
      .rotate()
      .resize({
        width: maxSize,
        height: maxSize,
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({
        quality: maxSize <= 512 ? 78 : 84,
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
  async generateRawImage(filePath, targetPath, maxSize, mediaInfo) {
    let lastError = null;
    const preferSharp = ['.dng', '.tif', '.tiff'].includes(mediaInfo.extension);

    if (preferSharp) {
      try {
        return await this.resizeWithSharp(filePath, targetPath, maxSize);
      } catch (error) {
        lastError = error;
      }
    }

    // 直接从 ExifTool 读取二进制预览，避免 Windows 临时文件句柄未释放导致 EPERM。
    const previewTags = ['PreviewImage', 'JpgFromRaw', 'ThumbnailImage', 'OtherImage'];
    for (const tagName of previewTags) {
      try {
        const buffer = await this.exiftool.extractBinaryTagToBuffer(tagName, filePath);
        if (buffer && buffer.length > 0) {
          await this.resizeWithSharp(buffer, targetPath, maxSize);
          return { source: `buffer:${tagName}` };
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (!preferSharp) {
      try {
        return await this.resizeWithSharp(filePath, targetPath, maxSize);
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(`未找到可解码的 RAW 预览${lastError && lastError.message ? `：${lastError.message}` : ''}`);
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
      this.saveFavorites(),
      this.exiftool.end()
    ]);
  }
}

module.exports = { MediaService };

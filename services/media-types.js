'use strict';

// 标准图片扩展名：Chromium 或 sharp 通常可以直接解码。
//
// 这里只收录「当前打包的 sharp 真的能解码」的格式，避免用户看到永远破图的条目：
// - .bmp 需要 libvips 编译时带 magick（本项目的预编译产物没有），sharp 会报
//   "Input file contains unsupported image format"，且 sharp 完全读不出宽高，
//   瀑布流连占位比例都拿不到。因此移出支持列表。
// - .heic / .heif 需要 libheif 支持；sharp 0.35 的 heif 解码器只声明 .avif 后缀
//   （input.fileSuffix === ['.avif']），按路径打开真实 HEIC 必然失败。同样移出。
// - .avif 保留：走的就是 heif 解码器 + .avif 后缀，实测可解。
const STANDARD_IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.jpe', '.jfif',
  '.png', '.gif', '.webp',
  '.tif', '.tiff', '.avif'
]);

// 相机 RAW 扩展名：这里采用常见相机厂商格式集合。
// 部分格式可被 sharp 直接解码，其余格式依赖 ExifTool 提取内嵌 JPEG 预览。
const RAW_IMAGE_EXTENSIONS = new Set([
  '.dng', '.cr2', '.cr3', '.crw', '.nef', '.nrw', '.arw', '.srf', '.sr2',
  '.orf', '.rw2', '.raf', '.pef', '.srw', '.mrw', '.x3f', '.3fr', '.erf',
  '.kdc', '.dcr', '.rwl', '.iiq', '.mos', '.mef', '.cap', '.fff', '.gpr'
]);

// 视频扩展名沿用原项目范围，并补充常见的 HEVC 容器后缀。
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.webm', '.mov', '.avi', '.mkv', '.wmv', '.m4v', '.flv'
]);

/**
 * 安全地获取文件扩展名并统一转为小写。
 * 该函数不读取文件内容，因此可以用于高速目录扫描。
 */
function getExtension(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return '';
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot < 0) return '';
  return filePath.slice(lastDot).toLowerCase();
}

/**
 * 判断文件是否属于支持的媒体，并返回渲染层需要的类型信息。
 * type 保持 image/video 两种，RAW 通过 isRaw 和 rawFormat 额外标识，
 * 这样现有瀑布流和预览逻辑可以继续复用。
 */
function getMediaInfo(filePath) {
  const extension = getExtension(filePath);
  if (STANDARD_IMAGE_EXTENSIONS.has(extension)) {
    return { supported: true, type: 'image', isRaw: false, extension, rawFormat: '' };
  }
  if (RAW_IMAGE_EXTENSIONS.has(extension)) {
    return {
      supported: true,
      type: 'image',
      isRaw: true,
      extension,
      rawFormat: extension.slice(1).toUpperCase()
    };
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return { supported: true, type: 'video', isRaw: false, extension, rawFormat: '' };
  }
  return { supported: false, type: '', isRaw: false, extension, rawFormat: '' };
}

module.exports = {
  STANDARD_IMAGE_EXTENSIONS,
  RAW_IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  getExtension,
  getMediaInfo
};

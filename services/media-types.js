'use strict';

// 标准图片扩展名：Chromium 或 sharp 通常可以直接解码。
const STANDARD_IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.jpe', '.jfif',
  '.png', '.gif', '.webp', '.bmp',
  '.tif', '.tiff', '.avif', '.heic', '.heif'
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

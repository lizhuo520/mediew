'use strict';

// 必须经由 sharp-config 引入：它关闭了 libvips 的文件级缓存，
// 否则读取 .webp / .gif 之后源文件会被 mmap 长期占用。
const sharp = require('./sharp-config');
const { Orientation } = require('../renderer/utils/orientation');

// 与 media-service 保持一致的像素安全上限。
const DEFAULT_MAX_INPUT_PIXELS = 300000000;
// 尺寸合法区间：小于 1 或大得离谱的值一律当作探测失败。
const MIN_DIMENSION = 1;
const MAX_DIMENSION = 1000000;

function isSaneDimension(value) {
  return Number.isFinite(value) && value >= MIN_DIMENSION && value <= MAX_DIMENSION;
}

/**
 * 只读文件头解析图片的「显示尺寸」，供瀑布流在缩略图生成前预占位。
 *
 * 目标与 gkpv 的 readImageSize() 一致（先用便宜的方式拿到宽高比，
 * 避免缩略图到达后整屏跳动），但实现改用 sharp/libvips 的 metadata()：
 * - 不必自己解析 PNG/JPEG/WebP/GIF 的字节结构；
 * - 能覆盖 gkpv 解析不了的 TIFF —— gkpv 的 readImageSize() 没有 TIFF 分支，
 *   .tif 永远返回 null，导致 TIFF 只能按 1:1 正方形排版；
 * - 不做像素解码，代价与读一次文件头相当。
 *
 * 返回的是「显示尺寸」：EXIF Orientation 为 5~8 时宽高互换，
 * 与 resizeWithSharp() 里 sharp().rotate() 之后的实际朝向保持一致，
 * 否则竖拍照片会被按横图排版。
 *
 * 探测失败（RAW 无头信息、文件损坏、权限不足）返回 null，调用方回退到默认占位。
 */
async function probeImageSize(filePath, options = {}) {
  const limitInputPixels = Number(options.maxInputPixels) || DEFAULT_MAX_INPUT_PIXELS;
  try {
    const metadata = await sharp(filePath, { failOn: 'none', limitInputPixels }).metadata();
    if (!metadata) return null;

    let width = Number(metadata.width);
    let height = Number(metadata.height);
    if (!isSaneDimension(width) || !isSaneDimension(height)) return null;

    const orientation = Orientation.normalize(metadata.orientation);
    const display = Orientation.toDisplaySize(width, height, orientation);
    return { width: display.width, height: display.height, orientation };
  } catch (_) {
    return null;
  }
}

module.exports = { probeImageSize, isSaneDimension };

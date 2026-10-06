'use strict';

/**
 * 将 EXIF、视频或文件系统时间统一转换为 Date。
 * 不同解析库返回 Date、字符串、ExifDateTime 对象或带 toDate 方法的值，
 * 这里集中处理可以减少主服务中的分支。
 */
function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'object' && typeof value.toDate === 'function') {
    try {
      const converted = value.toDate();
      return converted instanceof Date && !Number.isNaN(converted.getTime()) ? converted : null;
    } catch (_) {
      return null;
    }
  }
  if (typeof value === 'object' && typeof value.toISOString === 'function') {
    try {
      const converted = new Date(value.toISOString());
      return Number.isNaN(converted.getTime()) ? null : converted;
    } catch (_) {
      return null;
    }
  }
  const converted = new Date(value);
  return Number.isNaN(converted.getTime()) ? null : converted;
}

/**
 * 生成瀑布流分组与预览面板使用的本地化日期字段。
 * dateSource 会明确标记日期来自 EXIF 还是文件修改时间，便于排查显示异常。
 */
function buildDateInfo(value, dateSource = 'mtime') {
  const d = toDate(value) || new Date(0);
  if (Number.isNaN(d.getTime())) {
    return {
      date: '未知日期', year: '', month: '', day: '', hour: '', dateSource
    };
  }
  const year = String(d.getFullYear());
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return {
    date: `${year}年${month}月${day}日 ${hours}:${minutes}`,
    year: `${year}年`,
    month: `${year}年${month}月`,
    day: `${year}年${month}月${day}日`,
    hour: `${year}年${month}月${day}日 ${hours}:00`,
    dateSource
  };
}

/**
 * 格式化光圈值，兼容数值和 EXIF 字符串。
 */
function formatAperture(value) {
  if (value === undefined || value === null || value === '') return '';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  return `f/${numeric.toFixed(numeric >= 10 ? 0 : 1).replace(/\.0$/, '')}`;
}

/**
 * 格式化快门速度，优先输出摄影领域常见的 1/x 秒写法。
 */
function formatExposure(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string' && value.includes('/')) {
    const parts = value.split('/').map(Number);
    if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1]) && parts[1] !== 0) {
      const seconds = parts[0] / parts[1];
      return seconds < 1 ? `1/${Math.round(1 / seconds)}s` : `${seconds.toFixed(1)}s`;
    }
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return String(value);
  if (numeric < 1) return `1/${Math.round(1 / numeric)}s`;
  return `${Number(numeric.toFixed(2))}s`;
}

/**
 * 从 "3408x2272"、数字或 EXIF 字段中提取宽高。
 */
function parseDimensions(width, height, imageSize) {
  const parsedWidth = Number(width);
  const parsedHeight = Number(height);
  if (Number.isFinite(parsedWidth) && parsedWidth > 0 && Number.isFinite(parsedHeight) && parsedHeight > 0) {
    return { width: Math.round(parsedWidth), height: Math.round(parsedHeight) };
  }
  if (typeof imageSize === 'string') {
    const match = imageSize.match(/(\d+)\s*[x×]\s*(\d+)/i);
    if (match) return { width: Number(match[1]), height: Number(match[2]) };
  }
  return { width: 0, height: 0 };
}

module.exports = {
  toDate,
  buildDateInfo,
  formatAperture,
  formatExposure,
  parseDimensions
};

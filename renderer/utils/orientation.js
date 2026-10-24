'use strict';

/**
 * EXIF Orientation 的统一语义层。
 *
 * 不同解析器会返回数字（6）、数字字符串（"6"）或 ExifTool 文本
 * （"Rotate 90 CW"）。旧代码直接 Number(value)，文本会被当成 1，
 * 于是宽高比不交换、RAW 内嵌预览也不旋转。这里集中归一化，
 * 主进程和渲染层共用，避免三条链路各写一套判断。
 */
const Orientation = {
  normalize(value) {
    if (value === undefined || value === null || value === '') return 1;
    if (typeof value === 'number') {
      return Number.isInteger(value) && value >= 1 && value <= 8 ? value : 1;
    }

    const text = String(value).trim();
    if (/^[1-8]$/.test(text)) return Number(text);
    const normalized = text.toLowerCase();

    // 组合描述必须先于单独的角度/镜像判断。
    if (normalized.includes('mirror') && normalized.includes('270')) return 5;
    if (normalized.includes('mirror') && normalized.includes('90')) return 7;
    if (normalized.includes('mirror') && normalized.includes('horizontal')) return 2;
    if (normalized.includes('mirror') && normalized.includes('vertical')) return 4;
    if (normalized.includes('flip') && normalized.includes('horizontal')) return 2;
    if (normalized.includes('flip') && normalized.includes('vertical')) return 4;
    if (normalized.includes('180')) return 3;
    if (normalized.includes('270') || normalized.includes('90 ccw') || normalized.includes('90° ccw')) return 8;
    if (normalized.includes('90')) return 6;
    return 1;
  },

  swapsDimensions(value) {
    const orientation = this.normalize(value);
    return orientation >= 5 && orientation <= 8;
  },

  toDisplaySize(width, height, orientation) {
    const w = Number(width) || 0;
    const h = Number(height) || 0;
    if (this.swapsDimensions(orientation)) return { width: h, height: w };
    return { width: w, height: h };
  },

  /**
   * 给没有携带 EXIF 的像素源显式应用方向（典型场景：RAW 内嵌 JPEG）。
   * 有 EXIF 的输入仍应优先使用 sharp().rotate() 的自动定向。
   *
   * 5/7 的顺序与 ExifTool 描述一致：
   * 5 = Mirror horizontal and rotate 270 CW
   * 7 = Mirror horizontal and rotate 90 CW
   */
  applyToSharp(pipeline, value) {
    const orientation = this.normalize(value);
    switch (orientation) {
      case 2: return pipeline.flop();
      case 3: return pipeline.rotate(180);
      case 4: return pipeline.flip();
      case 5: return pipeline.flop().rotate(270);
      case 6: return pipeline.rotate(90);
      case 7: return pipeline.flop().rotate(90);
      case 8: return pipeline.rotate(270);
      default: return pipeline;
    }
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Orientation };
}
if (typeof window !== 'undefined') {
  window.MediewOrientation = Orientation;
}

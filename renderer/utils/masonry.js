'use strict';

/**
 * Grid masonry 与缩略图视觉调度的纯逻辑。
 * 抽成无 DOM 依赖的函数，便于 node --test 锁定行为。
 */
const Masonry = {
  ROW_HEIGHT: 8,
  ROW_GAP: 8,
  DEFAULT_ASPECT: 4 / 3,

  /**
   * CSS Grid 的跨行数：N 行的高度 = N*rowHeight + (N-1)*gap。
   */
  spanForHeight(height, rowHeight = this.ROW_HEIGHT, gap = this.ROW_GAP) {
    const safeHeight = Math.max(1, Number(height) || 1);
    const safeRow = Math.max(1, Number(rowHeight) || this.ROW_HEIGHT);
    const safeGap = Math.max(0, Number(gap) || 0);
    return Math.max(1, Math.ceil((safeHeight + safeGap) / (safeRow + safeGap)));
  },

  aspectOf(imageInfo) {
    const width = Number(imageInfo && imageInfo.width);
    const height = Number(imageInfo && imageInfo.height);
    if (width > 0 && height > 0) {
      const ratio = width / height;
      if (Number.isFinite(ratio) && ratio > 0.02 && ratio < 50) return ratio;
    }
    return this.DEFAULT_ASPECT;
  },

  /**
   * 缩略图按视觉位置排队：先上后下；同一视觉行内先左后右。
   * top 差小于 rowTolerance 的卡片视为同一行，吸收 masonry 的亚像素误差。
   */
  compareVisualJobs(a, b, rowTolerance = 12) {
    const topDelta = (a.top || 0) - (b.top || 0);
    if (Math.abs(topDelta) > rowTolerance) return topDelta;
    const leftDelta = (a.left || 0) - (b.left || 0);
    if (Math.abs(leftDelta) > 1) return leftDelta;
    return (a.order || 0) - (b.order || 0);
  },

  sortVisualJobs(jobs, rowTolerance = 12) {
    return jobs.sort((a, b) => this.compareVisualJobs(a, b, rowTolerance));
  },

  /**
   * 行式瀑布流（justified rows）：按顺序把卡片塞进一行，宽度刚好铺满容器，
   * 行高由该行总宽高比反算。DOM 顺序因此严格等于视觉顺序（左→右、上→下），
   * 也不会出现 CSS Grid 自动排布把第 4 张丢到右列的跳跃。
   *
   * @param {number[]} aspects 每张卡片的宽高比（宽/高）
   * @param {{availableWidth:number, gap?:number, targetHeight?:number}} options
   * @returns {{positions:Array<{index:number,left:number,top:number,width:number,height:number}>, totalHeight:number}}
   */
  layoutRows(aspects, options = {}) {
    const availableWidth = Math.max(1, Number(options.availableWidth) || 1);
    const gap = Math.max(0, Number(options.gap) || 0);
    const targetHeight = Math.max(40, Number(options.targetHeight) || 240);
    const list = Array.isArray(aspects) ? aspects : [];

    const rows = [];
    let row = [];
    let rowWidth = 0;

    const flush = (isLast) => {
      if (row.length === 0) return;
      const count = row.length;
      const totalAspect = row.reduce((sum, item) => sum + item.aspect, 0);
      let height = targetHeight;
      if (!isLast && count >= 2) {
        const justified = (availableWidth - gap * (count - 1)) / totalAspect;
        // 极端长图/竖图并排时，行高可能被拉到离谱的数值；限制在目标高度附近。
        height = Math.min(Math.max(justified, targetHeight * 0.55), targetHeight * 2.4);
      }
      // 无论哪一行，都保证总宽度不超过容器（超宽全景图会按比例缩一点）。
      const fitHeight = (availableWidth - gap * (count - 1)) / totalAspect;
      height = Math.min(height, fitHeight);
      let left = 0;
      row.forEach((item) => {
        const width = item.aspect * height;
        rows.push({ index: item.index, left, top: 0, width, height });
        left += width + gap;
      });
      rows.push({ spacer: true, height, top: 0, left: 0, width: 0 });
      row = [];
      rowWidth = 0;
    };

    list.forEach((value, index) => {
      const raw = Number(value);
      const aspect = Number.isFinite(raw) && raw > 0.02 && raw < 50 ? raw : this.DEFAULT_ASPECT;
      const naturalWidth = aspect * targetHeight;
      const nextWidth = row.length === 0 ? naturalWidth : rowWidth + gap + naturalWidth;
      if (row.length > 0 && nextWidth > availableWidth + 0.5) flush(false);
      row.push({ index, aspect });
      rowWidth = row.length === 1 ? naturalWidth : rowWidth + gap + naturalWidth;
    });
    flush(true);

    const positions = [];
    let top = 0;
    let totalHeight = 0;
    rows.forEach((entry) => {
      if (entry.spacer) {
        top += entry.height + gap;
        totalHeight = top;
        return;
      }
      positions.push({ ...entry, top });
    });
    return { positions, totalHeight: Math.max(0, totalHeight - gap) };
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Masonry };
}
if (typeof window !== 'undefined') {
  window.MediewMasonry = Masonry;
}

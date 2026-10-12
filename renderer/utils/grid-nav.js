'use strict';

/**
 * 网格键盘导航的纯逻辑部分。
 *
 * 瀑布流用的是 CSS 多列布局，DOM 顺序是"一列填满再填下一列"，
 * 所以不能简单用 ±1 表达上下左右。这里用元素的实际矩形做几何邻居判定，
 * 三种布局模式（瀑布流 / 网格 / 文件名）都能得到符合直觉的结果。
 *
 * 抽成独立文件的原因：它不直接依赖 DOM（只接收矩形数据），
 * 可以被 node --test 覆盖，见 test/grid-nav.test.js。
 */
const GridNav = {
  /**
   * 在给定矩形集合中，找出某个方向上最合适的邻居。
   *
   * 判定规则：主方向必须有实际位移；交叉方向优先选"区间有重叠"的元素，
   * 没有重叠时按间隔距离惩罚，最后用主方向距离做次要排序。
   * 用区间重叠而不是中心点距离，是为了处理同一行里高度差很大的卡片
   * （比如一张长图旁边一张方图），中心点距离会把明显的邻居判丢。
   *
   * 例外：上下移动**必须**和当前卡片同列（水平区间有重叠）。
   * 瀑布流各列高度不等，列底那张卡片的下方在别的列里确实还有内容，
   * 但那是横向跳列，和"按 ↓ 在当前列里往下走"的直觉不符；跨列请用 ←/→。
   *
   * @param {Array<{left:number,top:number,right:number,bottom:number}>} rects 按 DOM 顺序排列
   * @param {number} current 当前索引
   * @param {'left'|'right'|'up'|'down'} direction 方向
   * @returns {number} 目标索引；找不到时返回当前索引，索引非法时返回 -1
   */
  pickNeighbor(rects, current, direction) {
    if (!Array.isArray(rects) || rects.length === 0) return -1;
    if (!Number.isInteger(current) || current < 0 || current >= rects.length) return -1;
    const from = rects[current];
    if (!from) return -1;

    const horizontal = direction === 'left' || direction === 'right';
    const vertical = direction === 'up' || direction === 'down';
    if (!horizontal && !vertical) return current;
    const sign = (direction === 'right' || direction === 'down') ? 1 : -1;

    const fromCx = (from.left + from.right) / 2;
    const fromCy = (from.top + from.bottom) / 2;

    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < rects.length; i += 1) {
      if (i === current) continue;
      const r = rects[i];
      if (!r) continue;

      const rx = (r.left + r.right) / 2;
      const ry = (r.top + r.bottom) / 2;
      const primary = horizontal ? (rx - fromCx) : (ry - fromCy);
      // 主方向必须有超过 1px 的实际位移，否则会把自己旁边的重叠元素选中
      if (primary * sign <= 1) continue;

      // 交叉方向：有重叠说明"在同一行/同一列"，视为最优
      const overlap = horizontal
        ? Math.max(0, Math.min(from.bottom, r.bottom) - Math.max(from.top, r.top))
        : Math.max(0, Math.min(from.right, r.right) - Math.max(from.left, r.left));
      const gap = horizontal
        ? Math.max(0, Math.max(from.top, r.top) - Math.min(from.bottom, r.bottom))
        : Math.max(0, Math.max(from.left, r.left) - Math.min(from.right, r.right));

      // 上下移动只在本列内进行：不同列的元素一律不是候选
      if (vertical && overlap <= 0) continue;

      const score = (overlap > 0 ? 0 : gap) * 1000 + Math.abs(primary);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best === -1 ? current : best;
  },

  /**
   * 把索引收敛到合法范围，避免越界后丢失焦点。
   */
  clampIndex(index, length) {
    if (!Number.isFinite(index) || length <= 0) return -1;
    return Math.max(0, Math.min(length - 1, Math.trunc(index)));
  },

  /**
   * 方向键到方向的映射，集中一处避免各组件写法漂移。
   */
  directionOfKey(key) {
    switch (key) {
      case 'ArrowLeft': return 'left';
      case 'ArrowRight': return 'right';
      case 'ArrowUp': return 'up';
      case 'ArrowDown': return 'down';
      default: return null;
    }
  }
};

// 同时支持浏览器全局与 node --test 的 CommonJS 引用
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GridNav };
}
if (typeof window !== 'undefined') {
  window.GridNav = GridNav;
}

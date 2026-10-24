'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Masonry } = require('../renderer/utils/masonry');

test('grid 跨行数按 8px 行高 + 8px 间距换算', () => {
  assert.equal(Masonry.spanForHeight(8), 1);
  assert.equal(Masonry.spanForHeight(9), 2);
  assert.equal(Masonry.spanForHeight(100), 7);
  // 非法高度回落到 1 行，不至于算出 0 或 NaN 让卡片消失
  assert.equal(Masonry.spanForHeight(0), 1);
  assert.equal(Masonry.spanForHeight(-20), 1);
  assert.equal(Masonry.spanForHeight(Number.NaN), 1);
});

test('宽高比优先使用元数据，缺失或异常时回落到 4:3', () => {
  assert.equal(Masonry.aspectOf({ width: 1200, height: 1800 }), 1200 / 1800);
  assert.equal(Masonry.aspectOf({ width: 0, height: 0 }), Masonry.DEFAULT_ASPECT);
  assert.equal(Masonry.aspectOf(null), Masonry.DEFAULT_ASPECT);
  assert.equal(Masonry.aspectOf({ width: 1, height: 100000 }), Masonry.DEFAULT_ASPECT);
});

test('行式布局：每行填满宽度、行高一致，且位置顺序等于输入顺序', () => {
  const aspects = [4 / 3, 4 / 3, 4 / 3, 4 / 3, 4 / 3, 4 / 3];
  const result = Masonry.layoutRows(aspects, { availableWidth: 1000, gap: 10, targetHeight: 200 });
  assert.equal(result.positions.length, 6);

  // 第一行三张应被拉伸到整行宽度 1000
  const firstRow = result.positions.filter((position) => position.top === 0);
  assert.equal(firstRow.length, 3);
  const rowWidth = firstRow.reduce((sum, item) => sum + item.width, 0) + 10 * (firstRow.length - 1);
  assert.ok(Math.abs(rowWidth - 1000) < 1, `行宽应铺满 1000，实际 ${rowWidth}`);

  // 第二行在下方，且最后一行保持目标高度（不强行撑满）
  const secondRow = result.positions.filter((position) => position.top > 0);
  assert.equal(secondRow.length, 3);
  assert.ok(secondRow[0].top > firstRow[0].top);
  assert.ok(Math.abs(secondRow[0].height - 200) < 0.001);

  // 同一行内 left 单调递增，视觉顺序 = 输入顺序
  assert.ok(firstRow[0].left < firstRow[1].left && firstRow[1].left < firstRow[2].left);
  assert.deepEqual(result.positions.map((position) => position.index), [0, 1, 2, 3, 4, 5]);
});

test('超宽全景图不会溢出容器', () => {
  const result = Masonry.layoutRows([8, 8], { availableWidth: 800, gap: 8, targetHeight: 300 });
  const rows = new Map();
  result.positions.forEach((position) => {
    const key = Math.round(position.top);
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(position);
  });
  for (const [top, items] of rows) {
    const rowWidth = items.reduce((sum, item) => sum + item.width, 0) + 8 * (items.length - 1);
    assert.ok(rowWidth <= 800.5, `top=${top} 的行宽 ${rowWidth} 不应超过 800`);
  }
});

test('缩略图调度按视觉行从左到右排序，而不是 DOM 顺序', () => {
  // 模拟 DOM 先填满左列：0,1,2 在左列，3,4,5 在中列，6,7,8 在右列。
  const cards = [
    { left: 0, top: 0, order: 0 },
    { left: 0, top: 120, order: 1 },
    { left: 0, top: 240, order: 2 },
    { left: 200, top: 0, order: 3 },
    { left: 200, top: 120, order: 4 },
    { left: 200, top: 240, order: 5 },
    { left: 400, top: 0, order: 6 },
    { left: 400, top: 120, order: 7 },
    { left: 400, top: 240, order: 8 }
  ];
  const sorted = Masonry.sortVisualJobs(cards.slice());
  assert.deepEqual(sorted.map((job) => job.order), [0, 3, 6, 1, 4, 7, 2, 5, 8]);
});

test('同一视觉行内的亚像素高度差仍按左到右', () => {
  const cards = [
    { left: 400, top: 3, order: 2 },
    { left: 0, top: 0, order: 0 },
    { left: 200, top: 5, order: 1 }
  ];
  const sorted = Masonry.sortVisualJobs(cards.slice());
  assert.deepEqual(sorted.map((job) => job.left), [0, 200, 400]);
});

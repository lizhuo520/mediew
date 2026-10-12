'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { GridNav } = require(path.join('..', 'renderer', 'utils', 'grid-nav.js'));

/**
 * 造一个 3 列 × 3 行的瀑布流：每列 x 固定，行高 100。
 * DOM 顺序按"先填满一列再下一列"，与 CSS 多列布局一致 —— 这正是不能
 * 用 ±1 表达上下左右的原因。
 */
function threeColumnRects() {
  const rects = [];
  for (let column = 0; column < 3; column += 1) {
    for (let row = 0; row < 3; row += 1) {
      rects.push({
        left: column * 200,
        right: column * 200 + 180,
        top: row * 100,
        bottom: row * 100 + 90
      });
    }
  }
  return rects;
}

test('directionOfKey 只认四个方向键', () => {
  assert.strictEqual(GridNav.directionOfKey('ArrowLeft'), 'left');
  assert.strictEqual(GridNav.directionOfKey('ArrowRight'), 'right');
  assert.strictEqual(GridNav.directionOfKey('ArrowUp'), 'up');
  assert.strictEqual(GridNav.directionOfKey('ArrowDown'), 'down');
  assert.strictEqual(GridNav.directionOfKey('Enter'), null);
  assert.strictEqual(GridNav.directionOfKey('a'), null);
});

test('clampIndex 收敛到合法范围，非法输入返回 -1', () => {
  assert.strictEqual(GridNav.clampIndex(0, 5), 0);
  assert.strictEqual(GridNav.clampIndex(7, 5), 4);
  assert.strictEqual(GridNav.clampIndex(-3, 5), 0);
  assert.strictEqual(GridNav.clampIndex(2.9, 5), 2);
  assert.strictEqual(GridNav.clampIndex(0, 0), -1);
  assert.strictEqual(GridNav.clampIndex(Number.NaN, 5), -1);
});

test('瀑布流里 Down 走同一列的下一行，不跳到下一列顶部', () => {
  const rects = threeColumnRects();
  // DOM 顺序：0,1,2 是第一列，3..5 第二列，6..8 第三列
  assert.strictEqual(GridNav.pickNeighbor(rects, 0, 'down'), 1);
  assert.strictEqual(GridNav.pickNeighbor(rects, 1, 'down'), 2);
});

test('瀑布流里 Right 跨到下一列同一行', () => {
  const rects = threeColumnRects();
  assert.strictEqual(GridNav.pickNeighbor(rects, 0, 'right'), 3);
  assert.strictEqual(GridNav.pickNeighbor(rects, 3, 'right'), 6);
  assert.strictEqual(GridNav.pickNeighbor(rects, 1, 'right'), 4);
});

test('瀑布流里 Left / Up 是对称的', () => {
  const rects = threeColumnRects();
  assert.strictEqual(GridNav.pickNeighbor(rects, 6, 'left'), 3);
  assert.strictEqual(GridNav.pickNeighbor(rects, 2, 'up'), 1);
});

test('列底按 Down 不跨列（下一列顶部元素在负方向，必须被排除）', () => {
  const rects = threeColumnRects();
  // 第一列最后一张是索引 2，下一列顶部是索引 3，它在 2 的上方
  assert.strictEqual(GridNav.pickNeighbor(rects, 2, 'down'), 2);
});

test('列底按 Down 不跨列（哪怕旁边那列在下方延伸得更长）', () => {
  // 第一列只有 1 张（0，高 90），第二列有 3 张且一直延伸到下面
  const rects = [
    { left: 0, right: 180, top: 0, bottom: 90 },
    { left: 200, right: 380, top: 0, bottom: 90 },
    { left: 200, right: 380, top: 100, bottom: 190 },
    { left: 200, right: 380, top: 200, bottom: 290 }
  ];
  // 1 与 2 的中心点确实在 0 的下方，但它们在另一列 —— 按 ↓ 必须停在原地，
  // 否则"在当前列往下走"会突然横跳到隔壁列。
  assert.strictEqual(GridNav.pickNeighbor(rects, 0, 'down'), 0);
  // 同列内仍然正常上下走
  assert.strictEqual(GridNav.pickNeighbor(rects, 1, 'down'), 2);
  assert.strictEqual(GridNav.pickNeighbor(rects, 2, 'up'), 1);
});

test('单列布局（窄窗口）里 Down 沿列向下走', () => {
  const rects = [
    { left: 0, right: 180, top: 0, bottom: 90 },
    { left: 0, right: 180, top: 100, bottom: 190 },
    { left: 0, right: 180, top: 200, bottom: 290 }
  ];
  assert.strictEqual(GridNav.pickNeighbor(rects, 0, 'down'), 1);
  assert.strictEqual(GridNav.pickNeighbor(rects, 1, 'down'), 2);
  assert.strictEqual(GridNav.pickNeighbor(rects, 0, 'up'), 0);
});

test('同一行高度差很大时靠区间重叠选中，而不是中心点最近', () => {
  // 长图（0）高 400，配方图（1）高 100，两张图左上角对齐
  const rects = [
    { left: 0, right: 180, top: 0, bottom: 400 },
    { left: 200, right: 380, top: 0, bottom: 100 },
    { left: 200, right: 380, top: 120, bottom: 220 }
  ];
  // 从长图按 Right：中心点看 1 更近（dy=150 vs dy=20？两者重叠），
  // 关键是绝不能因为中心点差得多就跳到 2 —— 1 与长图区间重叠，必须优先。
  assert.strictEqual(GridNav.pickNeighbor(rects, 0, 'right'), 1);
});

test('没有重叠时按交叉方向的间隔距离惩罚', () => {
  const rects = [
    { left: 0, right: 180, top: 0, bottom: 90 },
    { left: 200, right: 380, top: 300, bottom: 390 },
    { left: 400, right: 580, top: 100, bottom: 190 }
  ];
  // 目标都在右侧；2 与当前行同一高度（gap 10），1 差得远（gap 210）
  assert.strictEqual(GridNav.pickNeighbor(rects, 0, 'right'), 2);
});

test('边界上没有邻居时返回当前索引，而不是 -1', () => {
  const rects = threeColumnRects();
  assert.strictEqual(GridNav.pickNeighbor(rects, 0, 'up'), 0);
  assert.strictEqual(GridNav.pickNeighbor(rects, 0, 'left'), 0);
  assert.strictEqual(GridNav.pickNeighbor(rects, 8, 'down'), 8);
  assert.strictEqual(GridNav.pickNeighbor(rects, 6, 'right'), 6);
});

test('入参非法时返回 -1，不抛异常', () => {
  assert.strictEqual(GridNav.pickNeighbor(null, 0, 'down'), -1);
  assert.strictEqual(GridNav.pickNeighbor([], 0, 'down'), -1);
  const rects = threeColumnRects();
  assert.strictEqual(GridNav.pickNeighbor(rects, -1, 'down'), -1);
  assert.strictEqual(GridNav.pickNeighbor(rects, 99, 'down'), -1);
  assert.strictEqual(GridNav.pickNeighbor(rects, 1.5, 'down'), -1);
});

test('方向字符串不认识时停在原地', () => {
  const rects = threeColumnRects();
  assert.strictEqual(GridNav.pickNeighbor(rects, 4, 'sideways'), 4);
  assert.strictEqual(GridNav.pickNeighbor(rects, 4, undefined), 4);
});

test('单张卡片时任何方向都停在原地', () => {
  const rects = [{ left: 0, right: 100, top: 0, bottom: 100 }];
  for (const direction of ['left', 'right', 'up', 'down']) {
    assert.strictEqual(GridNav.pickNeighbor(rects, 0, direction), 0);
  }
});

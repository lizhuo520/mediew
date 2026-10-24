'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { Orientation } = require('../renderer/utils/orientation');

// 2x3 像素画布：A B / C D / E F，用纯色区分每个像素位置。
const COLORS = {
  A: [255, 0, 0],
  B: [0, 255, 0],
  C: [0, 0, 255],
  D: [255, 255, 0],
  E: [255, 0, 255],
  F: [0, 255, 255]
};

function baseBuffer() {
  return Buffer.from([
    ...COLORS.A, ...COLORS.B,
    ...COLORS.C, ...COLORS.D,
    ...COLORS.E, ...COLORS.F
  ]);
}

async function applyOrientation(orientation) {
  const pipeline = Orientation.applyToSharp(
    sharp(baseBuffer(), { raw: { width: 2, height: 3, channels: 3 } }),
    orientation
  );
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  const rows = [];
  for (let y = 0; y < info.height; y += 1) {
    const row = [];
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      row.push([data[offset], data[offset + 1], data[offset + 2]]);
    }
    rows.push(row);
  }
  return rows;
}

const EXPECTED = {
  1: [['A', 'B'], ['C', 'D'], ['E', 'F']],
  2: [['B', 'A'], ['D', 'C'], ['F', 'E']],
  3: [['F', 'E'], ['D', 'C'], ['B', 'A']],
  4: [['E', 'F'], ['C', 'D'], ['A', 'B']],
  5: [['A', 'C', 'E'], ['B', 'D', 'F']],
  6: [['E', 'C', 'A'], ['F', 'D', 'B']],
  7: [['F', 'D', 'B'], ['E', 'C', 'A']],
  8: [['B', 'D', 'F'], ['A', 'C', 'E']]
};

test('8 种 EXIF 方向都能转成正确的像素排布', async () => {
  for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const rows = await applyOrientation(orientation);
    const mapped = rows.map((row) => row.map((pixel) => {
      const entry = Object.entries(COLORS).find(([, value]) => value.every((v, i) => v === pixel[i]));
      assert.ok(entry, `方向 ${orientation} 出现未知像素 ${pixel}`);
      return entry[0];
    }));
    assert.deepEqual(mapped, EXPECTED[orientation], `方向 ${orientation} 的像素排布不正确`);
  }
});

test('数字字符串与 ExifTool 文本都能归一化为 1~8', () => {
  const cases = [
    [1, 1], ['1', 1], ['6', 6], [6, 6], [0, 1], [99, 1], [null, 1], ['', 1],
    ['Horizontal (normal)', 1],
    ['Mirror horizontal', 2],
    ['Rotate 180', 3],
    ['Mirror vertical', 4],
    ['Mirror horizontal and rotate 270 CW', 5],
    ['Rotate 90 CW', 6],
    ['Mirror horizontal and rotate 90 CW', 7],
    ['Rotate 270 CW', 8],
    ['Rotate 90 CCW', 8]
  ];
  for (const [input, expected] of cases) {
    assert.equal(Orientation.normalize(input), expected, `输入 ${input} 应归一化为 ${expected}`);
  }
});

test('只有 5~8 交换显示宽高', () => {
  for (const orientation of [1, 2, 3, 4]) {
    assert.deepEqual(
      Orientation.toDisplaySize(1200, 1800, orientation),
      { width: 1200, height: 1800 }
    );
  }
  for (const orientation of [5, 6, 7, 8]) {
    assert.deepEqual(
      Orientation.toDisplaySize(1200, 1800, orientation),
      { width: 1800, height: 1200 }
    );
  }
  assert.equal(Orientation.swapsDimensions('Rotate 90 CW'), true);
  assert.equal(Orientation.swapsDimensions('Rotate 180'), false);
});

test('RAW 内嵌预览缺失方向标签时可用源方向补正', async () => {
  // 先生成一张 2x3 的无方向 PNG，再以 orientation=6 显式旋转，等价于
  // “内嵌 JPEG 没有 EXIF、主文件 RAW 有 Orientation=6”的场景。
  const plain = await sharp(baseBuffer(), { raw: { width: 2, height: 3, channels: 3 } })
    .png()
    .toBuffer();
  const rotated = await Orientation.applyToSharp(sharp(plain), 6)
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(rotated.info.width, 3);
  assert.equal(rotated.info.height, 2);
});

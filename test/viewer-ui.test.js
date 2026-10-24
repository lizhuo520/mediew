'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
const waterfall = fs.readFileSync(path.join(root, 'renderer', 'components', 'waterfall.js'), 'utf8');
const preview = fs.readFileSync(path.join(root, 'renderer', 'components', 'preview.js'), 'utf8');

test('瀑布流使用行式绝对布局，而不是按列填充的 column-count', () => {
  assert.match(css, /#image-grid\s*\{[^}]*position:\s*relative/s);
  assert.match(css, /#image-grid:not\(\.grid-mode\):not\(\.filename-mode\) \.image-card\s*\{[^}]*position:\s*absolute/s);
  assert.doesNotMatch(css, /column-count:\s*3/);
  assert.match(waterfall, /MediewMasonry\.layoutRows/);
  assert.match(waterfall, /positionCard\(/);
});

test('缩略图调度按视觉位置排序，换目录时清空旧队列', () => {
  assert.match(waterfall, /sortVisualJobs/);
  assert.match(waterfall, /getCardVisualPosition/);
  assert.match(waterfall, /_thumbnailQueue\.length = 0/);
});

test('灯箱有两个图片图层并支持交叉淡化', () => {
  assert.match(html, /id="preview-image"/);
  assert.match(html, /id="preview-image-alt"/);
  assert.match(css, /\.preview-image-layer\.loaded/);
  assert.match(css, /\.preview-image-layer\s*\{[^}]*transition:\s*opacity/s);
  assert.match(preview, /onImageReady\(incoming, outgoing/);
});

test('系统开启减少动态效果时关闭灯箱过渡', () => {
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/);
  assert.ok(reduced, '应有 prefers-reduced-motion 规则');
});

test('方向工具与瀑布流工具在页面脚本中先于组件加载', () => {
  const orientationIndex = html.indexOf('utils/orientation.js');
  const masonryIndex = html.indexOf('utils/masonry.js');
  const waterfallIndex = html.indexOf('components/waterfall.js');
  const previewIndex = html.indexOf('components/preview.js');
  assert.ok(orientationIndex > 0 && orientationIndex < waterfallIndex);
  assert.ok(masonryIndex > 0 && masonryIndex < waterfallIndex);
  assert.ok(orientationIndex < previewIndex);
});

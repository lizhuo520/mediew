'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { probeImageSize, isSaneDimension } = require('../services/image-size');

async function makeTempDirectory(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Windows 上 libvips 可能短暂持有文件句柄，直接 rm 会报 EBUSY。
 * 这里带退避重试，避免清理失败掩盖真正的断言结果。
 */
async function removeTempDirectory(dir) {
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * 缩略图生成前必须先拿到宽高比，否则瀑布流会在缩略图到达后整体跳动。
 * gkpv 用自己写的字节解析实现这一点，但它的 readImageSize() 没有 TIFF 分支，
 * .tif 永远返回 null。Mediew 改用 sharp.metadata()，本文件锁定覆盖范围。
 */
test('文件头探测可读出常见格式的显示尺寸', async () => {
  const dir = await makeTempDirectory('mediew-size-');
  try {
    const base = () => sharp({ create: { width: 800, height: 600, channels: 3, background: '#204060' } });
    const cases = [
      ['a.jpg', base().jpeg()],
      ['a.png', base().png()],
      ['a.webp', base().webp()],
      ['a.gif', base().gif()],
      // TIFF 是 gkpv 探测不到、也是缩略图会失败的关键格式。
      ['a.tif', base().tiff()]
    ];

    for (const [name, pipeline] of cases) {
      await pipeline.toFile(path.join(dir, name));
      const size = await probeImageSize(path.join(dir, name));
      assert.ok(size, `${name} 应该能探测到尺寸`);
      assert.equal(size.width, 800, `${name} 宽度`);
      assert.equal(size.height, 600, `${name} 高度`);
    }
  } finally {
    await removeTempDirectory(dir);
  }
});

test('EXIF Orientation 5~8 时返回交换后的显示尺寸', async () => {
  const dir = await makeTempDirectory('mediew-size-orient-');
  try {
    // 像素 600x800 + Orientation=6（顺时针 90° 显示）→ 显示尺寸应为 800x600。
    // 必须与 resizeWithSharp() 里 sharp().rotate() 之后的实际朝向一致，
    // 否则竖拍照片会被按横图排版。
    const rotated = path.join(dir, 'rotated.jpg');
    await sharp({ create: { width: 600, height: 800, channels: 3, background: '#402040' } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toFile(rotated);

    const size = await probeImageSize(rotated);
    assert.ok(size);
    assert.equal(size.width, 800);
    assert.equal(size.height, 600);
    assert.equal(size.orientation, 6);

    // 生成缩略图后实际像素也应该是 640x480（最长边 640、比例 4:3），二者一致。
    const thumb = path.join(dir, 'rotated-thumb.jpg');
    await sharp(rotated, { failOn: 'none' })
      .rotate()
      .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
      .jpeg()
      .toFile(thumb);
    const thumbMeta = await sharp(thumb).metadata();
    assert.equal(thumbMeta.width, 640);
    assert.equal(thumbMeta.height, 480);
  } finally {
    await removeTempDirectory(dir);
  }
});

test('探测失败时返回 null 而不是抛错', async () => {
  const dir = await makeTempDirectory('mediew-size-bad-');
  try {
    assert.equal(await probeImageSize(path.join(dir, 'missing.jpg')), null);

    const junk = path.join(dir, 'junk.png');
    await fsp.writeFile(junk, Buffer.from('this is definitely not a png'));
    assert.equal(await probeImageSize(junk), null);

    const empty = path.join(dir, 'empty.jpg');
    await fsp.writeFile(empty, Buffer.alloc(0));
    assert.equal(await probeImageSize(empty), null);
  } finally {
    await removeTempDirectory(dir);
  }
});

test('尺寸合法性判定拒绝异常值', () => {
  assert.equal(isSaneDimension(1), true);
  assert.equal(isSaneDimension(1000000), true);
  assert.equal(isSaneDimension(0), false);
  assert.equal(isSaneDimension(-5), false);
  assert.equal(isSaneDimension(Number.NaN), false);
  assert.equal(isSaneDimension(Number.POSITIVE_INFINITY), false);
  assert.equal(isSaneDimension(1000001), false);
  assert.equal(isSaneDimension(undefined), false);
});

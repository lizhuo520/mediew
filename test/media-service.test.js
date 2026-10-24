'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const sharp = require('sharp');
const { MediaService } = require('../services/media-service');

async function makeTempDirectory(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Windows 上元数据缓存的原子写入（rename）与 sharp 的文件句柄可能略有滞后，
 * 直接 rm 会偶发 EBUSY / ENOTEMPTY。这里带退避重试，避免清理失败掩盖断言结果。
 */
async function removeTempDirectory(dir) {
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

test('目录扫描、后台元数据与缩略图缓存可工作', async () => {
  const mediaDir = await makeTempDirectory('mediew-media-');
  const userDataDir = await makeTempDirectory('mediew-user-');
  const service = new MediaService({ userDataPath: userDataDir });
  await service.initialize();
  try {
    await sharp({ create: { width: 640, height: 480, channels: 3, background: '#336699' } })
      .jpeg()
      .toFile(path.join(mediaDir, 'sample.jpg'));

    let completeResolve;
    const complete = new Promise((resolve) => { completeResolve = resolve; });
    const result = await service.startDirectoryScan(mediaDir, {
      onComplete: (payload) => completeResolve(payload)
    });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].type, 'image');
    const completion = await Promise.race([
      complete,
      new Promise((_, reject) => setTimeout(() => reject(new Error('元数据扫描超时')), 10000))
    ]);
    assert.equal(completion.completed, 1);

    const thumbnail = await service.getThumbnail(path.join(mediaDir, 'sample.jpg'), 256);
    assert.equal(thumbnail.success, true);
    assert.ok(fs.statSync(fileURLToPath(thumbnail.url)).size > 0);

    const cached = await service.getThumbnail(path.join(mediaDir, 'sample.jpg'), 256);
    assert.equal(cached.success, true);
    assert.equal(cached.fromCache, true);
  } finally {
    await service.dispose();
    await removeTempDirectory(mediaDir);
    await removeTempDirectory(userDataDir);
  }
});

test('递归模式可读取子文件夹图片并保留相对路径', async () => {
  const mediaDir = await makeTempDirectory('mediew-recursive-');
  const userDataDir = await makeTempDirectory('mediew-recursive-user-');
  const nestedDir = path.join(mediaDir, 'child', 'grandchild');
  await fsp.mkdir(nestedDir, { recursive: true });
  const service = new MediaService({ userDataPath: userDataDir });
  await service.initialize();
  try {
    await sharp({ create: { width: 320, height: 240, channels: 3, background: '#224466' } })
      .jpeg()
      .toFile(path.join(mediaDir, 'root.jpg'));
    await sharp({ create: { width: 240, height: 320, channels: 3, background: '#662244' } })
      .jpeg()
      .toFile(path.join(nestedDir, 'nested.jpg'));

    const flat = await service.startDirectoryScan(mediaDir, { recursive: false });
    assert.equal(flat.items.length, 1);
    assert.equal(flat.items[0].relativePath, 'root.jpg');

    const recursive = await service.startDirectoryScan(mediaDir, { recursive: true });
    assert.equal(recursive.items.length, 2);
    const nested = recursive.items.find((item) => item.name === 'nested.jpg');
    assert.ok(nested);
    assert.equal(nested.relativePath, path.join('child', 'grandchild', 'nested.jpg'));
    assert.equal(nested.folder, path.join('child', 'grandchild'));
  } finally {
    await service.dispose();
    await removeTempDirectory(mediaDir);
    await removeTempDirectory(userDataDir);
  }
});

test('缩略图规格统一为最长边 640', async () => {
  const userDataDir = await makeTempDirectory('mediew-size-norm-');
  const service = new MediaService({ userDataPath: userDataDir });
  await service.initialize();
  try {
    // 保留 size 参数只是为了兼容既有 IPC 调用，任何取值都归一到 640。
    for (const requested of [undefined, null, 0, 256, 384, 512, 768, 4096]) {
      assert.equal(service.normalizeThumbnailSize(requested), 640);
    }
  } finally {
    await service.dispose();
    await removeTempDirectory(userDataDir);
  }
});

test('TIFF 可生成 640 缩略图、缓存预览并探测到宽高比', async () => {
  const mediaDir = await makeTempDirectory('mediew-tiff-');
  const userDataDir = await makeTempDirectory('mediew-tiff-user-');
  const service = new MediaService({ userDataPath: userDataDir });
  await service.initialize();
  try {
    // gkpv 的已知 bug：tif/tiff 能被扫描到，但 Chromium 解不了，
    // readImageSize() 也没有 TIFF 分支，缩略图与灯箱预览都会失败。
    // Mediew 走 sharp，下面这些断言就是该 bug 的回归保护。
    const tiffPath = path.join(mediaDir, 'scan.tif');
    await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#123456' } })
      .tiff()
      .toFile(tiffPath);

    const thumbnail = await service.getThumbnail(tiffPath, 640);
    assert.equal(thumbnail.success, true, thumbnail.error);
    const thumbPath = fileURLToPath(thumbnail.url);
    assert.ok(fs.statSync(thumbPath).size > 0);
    const thumbMeta = await sharp(thumbPath).metadata();
    assert.equal(Math.max(thumbMeta.width, thumbMeta.height), 640);
    assert.equal(thumbMeta.format, 'jpeg');

    const cached = await service.getThumbnail(tiffPath, 640);
    assert.equal(cached.success, true);
    assert.equal(cached.fromCache, true);

    // TIFF 浏览器不能直接显示，所以预览必须由主进程生成，而不是回原图。
    const preview = await service.getPreview(tiffPath);
    assert.equal(preview.success, true, preview.error);
    assert.equal(preview.source, 'sharp');
    assert.notEqual(preview.url, pathToFileURL(tiffPath).href);
    const previewMeta = await sharp(fileURLToPath(preview.url)).metadata();
    assert.equal(previewMeta.format, 'jpeg');
    assert.ok(Math.max(previewMeta.width, previewMeta.height) <= 4096);
    // 源图 1200x900 小于 4096，因此不放大，保持原始像素。
    assert.equal(previewMeta.width, 1200);
    assert.equal(previewMeta.height, 900);

    // 宽高比探测：gkpv 的 readImageSize() 没有 TIFF 分支，拿不到比例。
    const seen = [];
    const result = await service.startDirectoryScan(mediaDir, {
      onDimensions: (payload) => {
        payload.items.forEach((item) => seen.push(item));
      }
    });
    for (let i = 0; i < 60 && seen.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const probed = seen.find((item) => item.path === tiffPath);
    assert.ok(probed, '应该通过维度通道推送 TIFF 的宽高');
    assert.equal(probed.width, 1200);
    assert.equal(probed.height, 900);
    // enrichDimensions 直接改的是同一批 item 对象，因此扫描结果也应已带上尺寸。
    assert.equal(result.items[0].width, 1200);
    assert.equal(result.items[0].height, 900);
  } finally {
    await service.dispose();
    await removeTempDirectory(mediaDir);
    await removeTempDirectory(userDataDir);
  }
});

test('宽高比探测结果会持久化，重启后二次扫描直接命中', async () => {
  const mediaDir = await makeTempDirectory('mediew-dimcache-');
  const userDataDir = await makeTempDirectory('mediew-dimcache-user-');
  const file = path.join(mediaDir, 'plain.png');
  // 用 PNG：它没有 EXIF 尺寸，宽高只能来自探测，因此能真正验证缓存链路。
  await sharp({ create: { width: 800, height: 400, channels: 3, background: '#135724' } }).png().toFile(file);

  const first = new MediaService({ userDataPath: userDataDir });
  await first.initialize();
  try {
    const seen = [];
    await first.startDirectoryScan(mediaDir, { onDimensions: (payload) => seen.push(...payload.items) });
    for (let i = 0; i < 60 && seen.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(seen.length, 1, '首次扫描应推送一次宽高比');
    assert.equal(seen[0].width, 800);
    assert.equal(seen[0].height, 400);
  } finally {
    // dispose 会把 dimension-cache.json 落盘
    await first.dispose();
  }

  const second = new MediaService({ userDataPath: userDataDir });
  await second.initialize();
  try {
    const seenAgain = [];
    const result = await second.startDirectoryScan(mediaDir, {
      onDimensions: (payload) => seenAgain.push(...payload.items)
    });
    // 缓存命中时 createBaseItem 会同步带上宽高，不依赖后台探测。
    assert.equal(result.items[0].width, 800, '重启后应直接命中缓存的宽度');
    assert.equal(result.items[0].height, 400);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(seenAgain.length, 0, '缓存命中时不应再推送宽高比批次');
  } finally {
    await second.dispose();
    await removeTempDirectory(mediaDir);
    await removeTempDirectory(userDataDir);
  }
});

test('EXIF 方向 5~8 时 readMetadata 返回显示尺寸而非传感器尺寸', async () => {
  const mediaDir = await makeTempDirectory('mediew-orient-');
  const userDataDir = await makeTempDirectory('mediew-orient-user-');
  const service = new MediaService({ userDataPath: userDataDir });
  await service.initialize();
  try {
    // 像素 1200x1800 + Orientation=6 → 显示尺寸 1800x1200。
    // 修前这里返回 1200x1800，导致竖拍照片的瀑布流占位比例反了。
    const file = path.join(mediaDir, 'rotated.jpg');
    await sharp({ create: { width: 1200, height: 1800, channels: 3, background: '#5f0ba5' } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toFile(file);

    const stat = await fsp.stat(file);
    const metadata = await service.readMetadata(file, {
      type: 'image', isRaw: false, extension: '.jpg', mtime: stat.mtimeMs
    });
    assert.equal(metadata.orientation, 6);
    if (metadata.width > 0 && metadata.height > 0) {
      assert.equal(metadata.width, 1800, '宽度应为显示尺寸');
      assert.equal(metadata.height, 1200, '高度应为显示尺寸');
    }

    // 缩略图本身也必须转正：1200x1800 + Orientation=6 → 640x427（3:2 横向）。
    const thumbnail = await service.getThumbnail(file, 640);
    assert.equal(thumbnail.success, true, thumbnail.error);
    const thumbMeta = await sharp(fileURLToPath(thumbnail.url)).metadata();
    assert.equal(thumbMeta.width, 640, '缩略图最长边应为 640');
    assert.equal(thumbMeta.height, 427, '缩略图应按显示方向输出 3:2 横向');
  } finally {
    await service.dispose();
    await removeTempDirectory(mediaDir);
    await removeTempDirectory(userDataDir);
  }
});

test('生成缩略图后源文件不会被占用（.webp / .gif 回归）', async () => {
  const userDataDir = await makeTempDirectory('mediew-lock-user-');
  const service = new MediaService({ userDataPath: userDataDir });
  await service.initialize();
  try {
    // libvips 默认会缓存打开过的文件（含 mmap 映射）。Windows 上这会让
    // .webp / .gif 的源文件在生成缩略图后长期无法删除/重命名/移动。
    // 该行为已由 services/sharp-config.js 的 sharp.cache({ files: 0 }) 修掉，
    // 这里的断言就是防止它被改回去。
    const cases = [
      ['webp', (base) => base.webp()],
      ['gif', (base) => base.gif()],
      ['jpg', (base) => base.jpeg()]
    ];
    for (const [ext, encode] of cases) {
      const mediaDir = await makeTempDirectory(`mediew-lock-${ext}-`);
      const source = path.join(mediaDir, `sample.${ext}`);
      const base = sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#204060' } });
      await encode(base).toFile(source);

      const thumbnail = await service.getThumbnail(source, 640);
      assert.equal(thumbnail.success, true, `${ext}: ${thumbnail.error}`);

      // 不加重试：如果句柄没释放，这里会直接 EBUSY 失败。
      await fsp.unlink(source);
      assert.ok(fs.statSync(fileURLToPath(thumbnail.url)).size > 0, `${ext} 缩略图缓存应仍然存在`);
      await removeTempDirectory(mediaDir);
    }
  } finally {
    await service.dispose();
    await removeTempDirectory(userDataDir);
  }
});

test('真实 RAW 样片可生成缓存缩略图与预览', { skip: !process.env.MEDIEW_RAW_FIXTURE }, async () => {
  const rawPath = process.env.MEDIEW_RAW_FIXTURE;
  assert.equal(fs.existsSync(rawPath), true, `RAW 样片不存在：${rawPath}`);
  const userDataDir = await makeTempDirectory('mediew-raw-user-');
  const service = new MediaService({ userDataPath: userDataDir });
  await service.initialize();
  try {
    const rawStat = await fsp.stat(rawPath);
    const metadata = await service.readMetadata(rawPath, { type: 'image', isRaw: true, extension: '.cr3', mtime: rawStat.mtimeMs });
    assert.match(metadata.camera, /Canon/);
    assert.equal(metadata.dateSource, 'exif');

    const thumbnail = await service.getThumbnail(rawPath, 512);
    assert.equal(thumbnail.success, true, thumbnail.error);
    assert.ok(fs.statSync(fileURLToPath(thumbnail.url)).size > 0);

    const preview = await service.getPreview(rawPath);
    assert.equal(preview.success, true, preview.error);
    assert.equal(preview.isRaw, true);
    assert.ok(fs.statSync(fileURLToPath(preview.url)).size > 0);
  } finally {
    await service.dispose();
    await removeTempDirectory(userDataDir);
  }
});

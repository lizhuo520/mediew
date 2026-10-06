'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const sharp = require('sharp');
const { MediaService } = require('../services/media-service');

async function makeTempDirectory(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
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
    await fsp.rm(mediaDir, { recursive: true, force: true });
    await fsp.rm(userDataDir, { recursive: true, force: true });
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
    await fsp.rm(mediaDir, { recursive: true, force: true });
    await fsp.rm(userDataDir, { recursive: true, force: true });
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
    await fsp.rm(userDataDir, { recursive: true, force: true });
  }
});

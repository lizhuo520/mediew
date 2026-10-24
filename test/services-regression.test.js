'use strict';

/**
 * 1.1.3 服务层回归：扫描容错 / 缓存健壮性 / 收藏迁移 / 负缓存 / 格式与日期。
 * 这些用例锁定的是「坏输入不应升级成灾难」这一类行为，与渲染层无关。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { MediaService } = require('../services/media-service');
const { MetadataCache } = require('../services/metadata-cache');
const { getMediaInfo } = require('../services/media-types');
const { buildDateInfo } = require('../services/date-utils');
const { cleanupStale, enforceCacheLimits } = require('../services/cache-maintenance');

async function makeTempDirectory(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function removeTempDirectory(dir) {
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

test('单个文件 stat 失败不会让整次扫描归零', async () => {
  const mediaDir = await makeTempDirectory('mediew-a1-');
  const userDataDir = await makeTempDirectory('mediew-a1-user-');
  const service = new MediaService({ userDataPath: userDataDir });
  await service.initialize();

  const realStat = fsp.stat;
  try {
    for (let i = 0; i < 6; i += 1) {
      await sharp({ create: { width: 40, height: 30, channels: 3, background: '#223344' } })
        .jpeg()
        .toFile(path.join(mediaDir, `p${i}.jpg`));
    }

    // 模拟 p3.jpg 在 readdir 与 stat 之间消失。
    fsp.stat = async (target, ...rest) => {
      if (typeof target === 'string' && target.endsWith('p3.jpg')) {
        const error = new Error("ENOENT: no such file or directory, stat 'p3.jpg'");
        error.code = 'ENOENT';
        throw error;
      }
      return realStat.call(fsp, target, ...rest);
    };

    const result = await service.startDirectoryScan(mediaDir, {});
    assert.equal(result.items.length, 5, '其余 5 个文件必须照常返回');
    assert.equal(result.items.some((item) => item.path.endsWith('p3.jpg')), false);
  } finally {
    fsp.stat = realStat;
    await service.dispose();
    await removeTempDirectory(mediaDir);
    await removeTempDirectory(userDataDir);
  }
});

test('目录不可读时返回 error 字段，而不是伪装成空目录', async () => {
  const userDataDir = await makeTempDirectory('mediew-a0-user-');
  const service = new MediaService({ userDataPath: userDataDir });
  await service.initialize();
  const events = [];
  try {
    const missing = path.join(os.tmpdir(), `mediew-does-not-exist-${Date.now()}`);
    const result = await service.startDirectoryScan(missing, { onError: (e) => events.push(e.message) });
    assert.equal(result.items.length, 0);
    assert.equal(typeof result.error, 'string', '返回值必须带 error，渲染层靠它区分空目录和读取失败');
    assert.equal(result.error.length > 0, true);
    assert.equal(events.length, 1, 'onError 事件仍要照常发出，统计栏依赖它');
  } finally {
    await service.dispose();
    await removeTempDirectory(userDataDir);
  }
});

test('同一文件的大小写不同写法共用一份缩略图缓存', { skip: process.platform !== 'win32' }, async () => {
  const mediaDir = await makeTempDirectory('mediew-case-');
  const userDataDir = await makeTempDirectory('mediew-case-user-');
  const service = new MediaService({ userDataPath: userDataDir });
  await service.initialize();
  try {
    const file = path.join(mediaDir, 'Mixed.JPG');
    await sharp({ create: { width: 90, height: 60, channels: 3, background: '#334455' } }).jpeg().toFile(file);

    const stat = await fsp.stat(file);
    assert.equal(
      service.createCacheKey(file, stat, 'thumb-640'),
      service.createCacheKey(file.toUpperCase(), stat, 'thumb-640')
    );

    const first = await service.getThumbnail(file, 640);
    const second = await service.getThumbnail(file.toUpperCase(), 640);
    assert.equal(first.fromCache, false);
    assert.equal(second.fromCache, true, '第二种写法必须命中同一份缓存');
    assert.equal(fs.readdirSync(path.join(userDataDir, 'media-cache', 'thumbnails')).length, 1);
  } finally {
    await service.dispose();
    await removeTempDirectory(mediaDir);
    await removeTempDirectory(userDataDir);
  }
});

test('缓存 JSON 损坏时备份现场并从 .bak 恢复', async () => {
  const dir = await makeTempDirectory('mediew-cache-');
  try {
    const file = path.join(dir, 'metadata-cache-v3.json');
    const cache = new MetadataCache(file);
    cache.set('a', 'sig-a', { v: 1 });
    cache.set('b', 'sig-b', { v: 2 });
    await cache.flush();
    await fsp.copyFile(file, `${file}.bak`);

    await fsp.writeFile(file, '{ 这不是合法 JSON', 'utf8');

    const reloaded = new MetadataCache(file);
    await reloaded.load();
    assert.equal(reloaded.entries.size, 2, '应从 .bak 恢复');
    assert.equal(fs.readdirSync(dir).some((name) => name.includes('.corrupt-')), true, '坏文件应被备份留证');
  } finally {
    await removeTempDirectory(dir);
  }
});

test('收藏文件损坏时不会用空集合覆写原文件', async () => {
  const userDataDir = await makeTempDirectory('mediew-fav-');
  const favoritesFile = path.join(userDataDir, 'favorites.json');
  const service = new MediaService({ userDataPath: userDataDir });
  try {
    await fsp.writeFile(favoritesFile, '{"broken": tru', 'utf8');
    await service.initialize();
    assert.equal(service.favoritesLoadedCleanly, false);

    service.toggleFavorite(path.join(userDataDir, 'a.jpg'));
    await service.saveFavorites();

    assert.equal(fs.existsSync(favoritesFile), false, '原文件不能被空 Set 覆写');
    const names = fs.readdirSync(userDataDir);
    assert.equal(names.some((name) => name.startsWith('favorites.json.corrupt-')), true);
    assert.equal(names.some((name) => name.startsWith('favorites.json.recovered-')), true);
  } finally {
    await service.dispose();
    await removeTempDirectory(userDataDir);
  }
});

test('收藏路径迁移 / 批量删除 / 目录前缀删除', async () => {
  const userDataDir = await makeTempDirectory('mediew-fav-api-');
  const service = new MediaService({ userDataPath: userDataDir });
  await service.initialize();
  try {
    service.favorites = new Set(['C:\\p\\a.jpg', 'C:\\p\\b.jpg', 'C:\\q\\c.jpg']);

    assert.deepEqual(service.remapFavoritePaths([['C:\\p\\a.jpg', 'C:\\p\\z.jpg']]), { success: true, changed: 1 });
    assert.equal(service.favorites.has('C:\\p\\z.jpg'), true);
    assert.equal(service.favorites.has('C:\\p\\a.jpg'), false);

    assert.deepEqual(service.forgetFavoritePaths(['C:\\p\\b.jpg']), { success: true, changed: 1 });
    assert.deepEqual(service.forgetFavoritesUnder('C:\\p'), { success: true, changed: 1 });
    assert.deepEqual(Array.from(service.favorites), ['C:\\q\\c.jpg']);

    // 前缀必须以分隔符收边：C:\q 不能误删 C:\qq 下的收藏。
    service.favorites.add('C:\\qq\\d.jpg');
    assert.deepEqual(service.forgetFavoritesUnder('C:\\q'), { success: true, changed: 1 });
    assert.equal(service.favorites.has('C:\\qq\\d.jpg'), true);
  } finally {
    await service.dispose();
    await removeTempDirectory(userDataDir);
  }
});

test('解码失败会进负缓存，短时间内不再重复解码', async () => {
  const mediaDir = await makeTempDirectory('mediew-neg-');
  const userDataDir = await makeTempDirectory('mediew-neg-user-');
  const service = new MediaService({ userDataPath: userDataDir });
  await service.initialize();
  try {
    const broken = path.join(mediaDir, 'broken.jpg');
    await fsp.writeFile(broken, Buffer.from('definitely not a jpeg'));

    const first = await service.getThumbnail(broken, 640);
    assert.equal(first.success, false);
    assert.equal(service.failureCache.size, 1);

    const second = await service.getThumbnail(broken, 640);
    assert.equal(second.success, false);
    assert.equal(second.cached, true, '第二次应直接命中失败缓存');
  } finally {
    await service.dispose();
    await removeTempDirectory(mediaDir);
    await removeTempDirectory(userDataDir);
  }
});

test('bmp / heic / heif 不再声明为支持格式，avif 仍支持', () => {
  assert.equal(getMediaInfo('a.bmp').supported, false);
  assert.equal(getMediaInfo('a.heic').supported, false);
  assert.equal(getMediaInfo('a.heif').supported, false);
  assert.equal(getMediaInfo('a.avif').supported, true);
});

test('非法日期返回未知日期而不是 1970', () => {
  const info = buildDateInfo('not-a-date', 'exif');
  assert.equal(info.date, '未知日期');
  assert.equal(info.year, '未知');
  assert.equal(info.dateSource, 'exif');
});

test('退出时在途 EXIF 必须落盘，不能因为取消标记被丢弃', async () => {
  const mediaDir = await makeTempDirectory('mediew-dispose-');
  const userDataDir = await makeTempDirectory('mediew-dispose-user-');
  const service = new MediaService({ userDataPath: userDataDir });
  await service.initialize();
  try {
    const total = 30;
    for (let i = 0; i < total; i += 1) {
      await sharp({ create: { width: 120, height: 80, channels: 3, background: '#445566' } })
        .withMetadata({ exif: { IFD0: { Make: 'DisposeCam', Model: 'M1' } } })
        .jpeg()
        .toFile(path.join(mediaDir, `d${i}.jpg`));
    }

    // 扫描一返回就退出：这正是「关窗口时后台还在读 EXIF」的场景。
    await service.startDirectoryScan(mediaDir, {});
    await service.dispose();

    const reopened = new MetadataCache(path.join(userDataDir, 'metadata-cache-v3.json'));
    await reopened.load();
    let withCamera = 0;
    for (const [, entry] of reopened.entries) {
      if (entry.value && entry.value.camera) withCamera += 1;
    }
    // 允许 5s 上限内没跑完的极少数，但绝不能是「几乎全丢」。
    assert.ok(withCamera >= total * 0.8, `退出后应保留大部分 EXIF，实际 ${withCamera}/${total}`);
  } finally {
    await removeTempDirectory(mediaDir);
    await removeTempDirectory(userDataDir);
  }
});

test('缓存容量超出上限时淘汰到 80%，且不动 1 小时内新文件', async () => {
  const userDataDir = await makeTempDirectory('mediew-evict-');
  const cacheRoot = path.join(userDataDir, 'media-cache');
  const thumbs = path.join(cacheRoot, 'thumbnails');
  try {
    await fsp.mkdir(thumbs, { recursive: true });
    // 10 个 100 KB 的旧文件 + 1 个刚生成的新文件
    for (let i = 0; i < 10; i += 1) {
      const file = path.join(thumbs, `old${i}.jpg`);
      await fsp.writeFile(file, Buffer.alloc(100 * 1024));
      const past = new Date(Date.now() - (i + 2) * 3600 * 1000);
      await fsp.utimes(file, past, past);
    }
    const fresh = path.join(thumbs, 'fresh.jpg');
    await fsp.writeFile(fresh, Buffer.alloc(100 * 1024));

    const limit = 300 * 1024;
    const result = await enforceCacheLimits({ cacheRoot, maxBytes: limit, maxAgeDays: 180 });
    assert.ok(result.removed > 0, '应发生淘汰');
    assert.ok(result.totalBytes <= Math.floor(limit * 0.8) + 100 * 1024, '应降到 80% 附近');
    assert.equal(fs.existsSync(fresh), true, '1 小时内生成的新缓存不能被删');
  } finally {
    await removeTempDirectory(userDataDir);
  }
});

test('启动清理会删掉旧版本缓存 JSON、孤儿 tmp 与过期 temp 文件', async () => {
  const userDataDir = await makeTempDirectory('mediew-cleanup-');
  const cacheRoot = path.join(userDataDir, 'media-cache');
  const thumbs = path.join(cacheRoot, 'thumbnails');
  const tempRoot = path.join(cacheRoot, 'temp');
  try {
    await fsp.mkdir(thumbs, { recursive: true });
    await fsp.mkdir(tempRoot, { recursive: true });

    await fsp.writeFile(path.join(userDataDir, 'metadata-cache.json'), '{}');
    await fsp.writeFile(path.join(userDataDir, 'metadata-cache-v2.json'), '{}');
    await fsp.writeFile(path.join(userDataDir, 'metadata-cache-v3.json'), '{"keep":1}');
    await fsp.writeFile(path.join(userDataDir, 'dimension-cache.json'), '{}');
    await fsp.writeFile(path.join(userDataDir, 'dimension-cache-v2.json'), '{"keep":2}');
    const orphanTmp = path.join(thumbs, 'x.jpg.1.abcd.tmp');
    await fsp.writeFile(orphanTmp, 'x');
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    await fsp.utimes(orphanTmp, twoHoursAgo, twoHoursAgo);
    // 刚生成的 tmp 必须保留，避免误删正在写入的缩略图
    const liveTmp = path.join(thumbs, 'live.jpg.1.efgh.tmp');
    await fsp.writeFile(liveTmp, 'y');

    const staleTemp = path.join(tempRoot, 'old.extractPreview.jpg');
    await fsp.writeFile(staleTemp, Buffer.alloc(512));
    const old = new Date(Date.now() - 48 * 3600 * 1000);
    await fsp.utimes(staleTemp, old, old);

    const result = await cleanupStale({
      userDataPath: userDataDir,
      cacheRoot,
      keepCacheFiles: [
        path.join(userDataDir, 'metadata-cache-v3.json'),
        path.join(userDataDir, 'dimension-cache-v2.json')
      ]
    });

    assert.equal(result.removedCacheFiles, 3);
    assert.equal(fs.existsSync(path.join(userDataDir, 'metadata-cache-v3.json')), true);
    assert.equal(fs.existsSync(path.join(userDataDir, 'dimension-cache-v2.json')), true);
    assert.equal(fs.existsSync(orphanTmp), false, '1 小时前的孤儿 tmp 应被清掉');
    assert.equal(fs.existsSync(liveTmp), true, '刚生成的 tmp 不能被误删');
    assert.equal(fs.existsSync(staleTemp), false);
  } finally {
    await removeTempDirectory(userDataDir);
  }
});

test('限流器在任务抛错后不会泄漏并发槽位', async () => {
  const { createLimiter } = require('../services/concurrency');
  const limit = createLimiter(2);
  let active = 0;
  let maxActive = 0;
  const tasks = [];
  for (let i = 0; i < 10; i += 1) {
    tasks.push(limit(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (i % 3 === 0) throw new Error('boom');
      return i;
    }).catch((error) => `err:${error.message}`));
  }
  const results = await Promise.all(tasks);
  assert.equal(maxActive <= 2, true, `并发不能超过 2，实际 ${maxActive}`);
  assert.equal(results.length, 10);
  // 抛错后队列必须仍然可继续推进
  const after = await limit(() => 42);
  assert.equal(after, 42);
});

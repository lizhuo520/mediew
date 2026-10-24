'use strict';

const fsp = require('node:fs').promises;
const path = require('node:path');

/** 缩略图 + 预览的默认总容量上限（2 GB）。 */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** 超过这个天数的缓存文件直接淘汰。 */
const DEFAULT_MAX_AGE_DAYS = 180;
/** 只清理 temp/ 下超过 24 小时的文件。 */
const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** 淘汰时跳过 1 小时内生成的文件，避免删掉刚生成、可能正在用的缓存。 */
const FRESH_GUARD_MS = 60 * 60 * 1000;

const CACHE_JSON_PATTERN = /^(metadata-cache|dimension-cache).*\.json$/i;

/**
 * 解析容量上限：优先环境变量，其次参数，最后默认值。
 * 环境变量用 MB 表达，方便用户按需调整。
 */
function resolveMaxBytes(explicit) {
  const envValue = Number(process.env.MEDIEW_CACHE_MAX_MB);
  if (Number.isFinite(envValue) && envValue > 0) return Math.floor(envValue * 1024 * 1024);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  return DEFAULT_MAX_BYTES;
}

/**
 * 列出目录下的普通文件。
 * 用并发上限批量 stat：缩略图目录在上限下可能有数万个文件，
 * 串行 stat 在机械盘/杀软环境下会拖到十几秒。
 */
async function listFiles(directory, concurrency = 32) {
  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  const files = [];
  const queue = entries.filter((entry) => entry.isFile());
  let cursor = 0;

  const worker = async () => {
    while (cursor < queue.length) {
      const entry = queue[cursor];
      cursor += 1;
      const fullPath = path.join(directory, entry.name);
      try {
        const stat = await fsp.stat(fullPath);
        files.push({ path: fullPath, name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch (_) {
        // 读不到就跳过，清理任务不该因为单个文件失败而中断。
      }
    }
  };

  const workers = [];
  const width = Math.max(1, Math.min(concurrency, queue.length));
  for (let i = 0; i < width; i += 1) workers.push(worker());
  await Promise.all(workers);
  return files;
}

async function unlinkQuietly(filePath) {
  try {
    await fsp.unlink(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 启动清理。
 * 1) 删除旧版本遗留的 metadata-cache*.json / dimension-cache*.json（保留 keepCacheFiles 里的当前版本）
 * 2) 删除 cacheRoot 下所有孤儿 .tmp（上次进程被强杀留下的）
 * 3) 删除 temp/ 下超过 24 小时的文件
 *
 * 全部失败静默：清理是锦上添花，不能影响应用启动。
 */
async function cleanupStale({ userDataPath, cacheRoot, keepCacheFiles = [] } = {}) {
  const result = { removedCacheFiles: 0, removedTempFiles: 0, removedBytes: 0 };
  if (!userDataPath && !cacheRoot) return result;

  const keep = new Set(
    keepCacheFiles
      .filter((item) => typeof item === 'string' && item.length > 0)
      .map((item) => path.resolve(item).toLowerCase())
  );

  // 1) 旧版本缓存 JSON
  if (userDataPath) {
    const cacheJsonFiles = await listFiles(userDataPath);
    for (const file of cacheJsonFiles) {
      if (!CACHE_JSON_PATTERN.test(file.name)) continue;
      if (keep.has(path.resolve(file.path).toLowerCase())) continue;
      if (await unlinkQuietly(file.path)) {
        result.removedCacheFiles += 1;
        result.removedBytes += file.size;
      }
    }
  }

  if (!cacheRoot) return result;

  // 2) 孤儿 .tmp（thumbnails/ previews/ temp/ 里都可能有）
  //    只删 1 小时前的：启动清理与用户立刻打开目录可能重叠，
  //    正在生成的缩略图临时文件被误删会让 rename 失败并把失败结果记进负缓存。
  for (const sub of ['', 'thumbnails', 'previews']) {
    const directory = sub ? path.join(cacheRoot, sub) : cacheRoot;
    const files = await listFiles(directory);
    for (const file of files) {
      if (!file.name.endsWith('.tmp')) continue;
      if (Date.now() - file.mtimeMs < FRESH_GUARD_MS) continue;
      if (await unlinkQuietly(file.path)) {
        result.removedTempFiles += 1;
        result.removedBytes += file.size;
      }
    }
  }

  // 3) temp/ 下超过 24 小时的中间产物
  const tempRoot = path.join(cacheRoot, 'temp');
  const now = Date.now();
  const tempFiles = await listFiles(tempRoot);
  for (const file of tempFiles) {
    if (now - file.mtimeMs < TEMP_MAX_AGE_MS) continue;
    if (await unlinkQuietly(file.path)) {
      result.removedTempFiles += 1;
      result.removedBytes += file.size;
    }
  }

  return result;
}

/**
 * 容量淘汰。
 * thumbnails/ 与 previews/ 的合计字节数超过上限时，按 mtime 从旧到新删，
 * 直到降到上限的 80%。同时删除超过 maxAgeDays 的陈旧缓存。
 *
 * @returns {{ removed:number, removedBytes:number, totalBytes:number }}
 */
async function enforceCacheLimits({ cacheRoot, maxBytes, maxAgeDays = DEFAULT_MAX_AGE_DAYS } = {}) {
  const result = { removed: 0, removedBytes: 0, totalBytes: 0 };
  if (!cacheRoot) return result;

  const limit = resolveMaxBytes(maxBytes);
  const maxAgeMs = (Number.isFinite(maxAgeDays) && maxAgeDays > 0 ? maxAgeDays : DEFAULT_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const files = [];
  for (const sub of ['thumbnails', 'previews']) {
    const directory = path.join(cacheRoot, sub);
    const listed = await listFiles(directory);
    for (const file of listed) files.push({ ...file, bucket: sub });
  }

  let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  result.totalBytes = totalBytes;

  // 先判定「是否超限」，再一路裁到 80%。不能在循环里用「当前是否 > 上限」判断，
  // 那样删到刚好等于上限就会停手，下一次启动又立刻触发淘汰，形成每次启动都删一批的抖动。
  const overLimit = totalBytes > limit;
  const targetBytes = Math.floor(limit * 0.8);

  const removable = files
    .filter((file) => now - file.mtimeMs > FRESH_GUARD_MS)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  for (const file of removable) {
    const tooOld = now - file.mtimeMs > maxAgeMs;
    const trimming = overLimit && totalBytes > targetBytes;
    if (!tooOld && !trimming) {
      // 已超出上限且已降到 80% 以下；或既不过期也未超限。两种情况都可以收工，
      // 但如果只是这一条不过期，后面的更「新」，更不该删，所以直接 break。
      break;
    }
    if (await unlinkQuietly(file.path)) {
      totalBytes -= file.size;
      result.removed += 1;
      result.removedBytes += file.size;
    }
  }

  result.totalBytes = totalBytes;
  return result;
}

module.exports = {
  cleanupStale,
  enforceCacheLimits,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_AGE_DAYS,
  CACHE_JSON_PATTERN,
  resolveMaxBytes
};

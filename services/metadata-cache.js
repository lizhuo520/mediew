'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

/**
 * 持久化媒体元数据缓存。
 * 缓存键使用绝对路径，签名使用 size + mtime，文件发生变化时自动失效。
 * 保存操作采用短延迟合并，避免目录扫描过程中频繁写磁盘。
 *
 * 健壮性约定：
 * - 写盘走「临时文件 + rename」三段式，rename 在同卷上是原子的，不会留下半个 JSON；
 * - 每次成功写盘后再复制一份 .bak，主文件损坏时可以从 .bak 恢复；
 * - 主文件解析失败时不再静默丢弃，而是重命名为 .corrupt-<ts> 并告警，数据可事后人工抢救。
 */
class MetadataCache {
  constructor(cacheFile, maxEntries = 50000) {
    this.cacheFile = cacheFile;
    this.backupFile = `${cacheFile}.bak`;
    this.maxEntries = maxEntries;
    /** 超限时一次裁剪到 90%，避免「删一条→又超一条」的抖动式反复裁剪。 */
    this.pruneTargetRatio = 0.9;
    /** 只有超过上限 1.1 倍才真正排序裁剪，把 O(n log n) 从每次 set 降到每几百次一次。 */
    this.pruneSlackRatio = 1.1;
    this.entries = new Map();
    this.loaded = false;
    this.saveTimer = null;
    this.savePromise = Promise.resolve();
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;

    const primary = await this.readCacheFile(this.cacheFile);
    if (primary.ok) {
      this.applyEntries(primary.entries);
      return;
    }

    // 主文件存在但读不出来（JSON 损坏 / 权限 / 半写）：先留证据，再尝试 .bak。
    if (primary.error && primary.error.code !== 'ENOENT') {
      const corruptFile = `${this.cacheFile}.corrupt-${Date.now()}`;
      try {
        await fsp.rename(this.cacheFile, corruptFile);
        console.warn(`[metadata-cache] ${path.basename(this.cacheFile)} 解析失败，已备份为 ${path.basename(corruptFile)}，改用空缓存。`, primary.error.message);
      } catch (renameError) {
        console.warn(`[metadata-cache] ${path.basename(this.cacheFile)} 解析失败且无法备份（${renameError.message}），改用空缓存。`);
      }
    }

    const backup = await this.readCacheFile(this.backupFile);
    if (backup.ok && backup.entries.size > 0) {
      this.applyEntries(backup.entries);
      console.warn(`[metadata-cache] 已从 ${path.basename(this.backupFile)} 恢复 ${backup.entries.size} 条缓存。`);
    }
  }

  /**
   * 读取并解析一个缓存文件。返回 { ok } 或 { ok:false, error }，永不抛出。
   */
  async readCacheFile(filePath) {
    let raw;
    try {
      raw = await fsp.readFile(filePath, 'utf8');
    } catch (error) {
      return { ok: false, error };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { ok: false, error };
    }
    const rawEntries = parsed && typeof parsed === 'object' && parsed.entries ? parsed.entries : parsed;
    const entries = new Map();
    if (rawEntries && typeof rawEntries === 'object') {
      Object.entries(rawEntries).forEach(([key, value]) => {
        if (value && typeof value === 'object') entries.set(key, value);
      });
    }
    return { ok: true, entries };
  }

  applyEntries(entries) {
    entries.forEach((value, key) => this.entries.set(key, value));
    this.prune(true);
  }

  get(key, signature) {
    const entry = this.entries.get(key);
    if (!entry || entry.signature !== signature) return null;
    entry.updatedAt = Date.now();
    return entry.value || null;
  }

  set(key, signature, value) {
    this.entries.set(key, { signature, value, updatedAt: Date.now() });
    this.prune();
    this.scheduleSave();
  }

  delete(key) {
    this.entries.delete(key);
    this.scheduleSave();
  }

  /**
   * 按 updatedAt 淘汰旧条目。
   * 默认只在「超过 maxEntries 的 1.1 倍」时才真正排序，一次裁到 90%，
   * 把满载后每次 set() 都要全表 O(n log n) 排序的开销摊薄到几百次一条。
   */
  prune(force = false) {
    if (this.entries.size <= this.maxEntries) return;
    if (!force && this.entries.size < this.maxEntries * this.pruneSlackRatio) return;
    const target = Math.max(0, Math.floor(this.maxEntries * this.pruneTargetRatio));
    const removeCount = this.entries.size - target;
    if (removeCount <= 0) return;
    const byAge = Array.from(this.entries.entries()).sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0));
    for (let i = 0; i < removeCount; i += 1) {
      this.entries.delete(byAge[i][0]);
    }
  }

  scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save().catch(() => {});
    }, 1200);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  async save() {
    // 串行化：定时保存与 flush() 可能重叠，两个 save 各自 rename 到同一路径时，
    // 后完成的那次可能反而是更旧的快照。先等上一次真正结束，保证「后发起的赢」。
    const previous = this.savePromise;
    const data = { version: 1, entries: Object.fromEntries(this.entries) };
    const directory = path.dirname(this.cacheFile);
    // 随机后缀：即便两次 save 交错，也不会互相截断同一个临时文件。
    const tempFile = `${this.cacheFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    this.savePromise = (async () => {
      await previous;
      await fsp.mkdir(directory, { recursive: true });
      await fsp.writeFile(tempFile, JSON.stringify(data), 'utf8');
      await fsp.rename(tempFile, this.cacheFile);
      // 落盘成功后再补一份备份，供下次启动在 JSON 损坏时恢复。失败不影响主流程。
      try {
        await fsp.copyFile(this.cacheFile, this.backupFile);
      } catch (_) {}
    })().catch(async () => {
      // 写入失败时清理临时文件，不影响应用主流程。
      try { await fsp.unlink(tempFile); } catch (_) {}
    });
    return this.savePromise;
  }

  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    return this.save();
  }
}

module.exports = { MetadataCache };

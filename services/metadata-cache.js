'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

/**
 * 持久化媒体元数据缓存。
 * 缓存键使用绝对路径，签名使用 size + mtime，文件发生变化时自动失效。
 * 保存操作采用短延迟合并，避免目录扫描过程中频繁写磁盘。
 */
class MetadataCache {
  constructor(cacheFile, maxEntries = 50000) {
    this.cacheFile = cacheFile;
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.loaded = false;
    this.saveTimer = null;
    this.savePromise = Promise.resolve();
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fsp.readFile(this.cacheFile, 'utf8');
      const parsed = JSON.parse(raw);
      const entries = parsed && typeof parsed === 'object' && parsed.entries ? parsed.entries : parsed;
      if (entries && typeof entries === 'object') {
        Object.entries(entries).forEach(([key, value]) => {
          if (value && typeof value === 'object') this.entries.set(key, value);
        });
      }
    } catch (_) {
      // 首次运行或缓存损坏时直接使用空缓存。
    }
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

  prune() {
    if (this.entries.size <= this.maxEntries) return;
    const byAge = Array.from(this.entries.entries()).sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0));
    const removeCount = this.entries.size - this.maxEntries;
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
    const data = { version: 1, entries: Object.fromEntries(this.entries) };
    const directory = path.dirname(this.cacheFile);
    const tempFile = `${this.cacheFile}.${process.pid}.tmp`;
    this.savePromise = (async () => {
      await fsp.mkdir(directory, { recursive: true });
      await fsp.writeFile(tempFile, JSON.stringify(data), 'utf8');
      await fsp.rename(tempFile, this.cacheFile);
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

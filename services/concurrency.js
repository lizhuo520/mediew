'use strict';

/**
 * 创建一个带并发上限的任务调度器。
 * 用于限制 EXIF 解析、缩略图生成和 RAW 预览提取的并发数量，
 * 避免一次性占满磁盘或 CPU 导致窗口失去响应。
 */
function createLimiter(maxConcurrency) {
  const limit = Math.max(1, Number(maxConcurrency) || 1);
  const queue = [];
  let active = 0;

  function runNext() {
    if (active >= limit || queue.length === 0) return;
    active += 1;
    const job = queue.shift();
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        active -= 1;
        runNext();
      });
  }

  return function limited(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      runNext();
    });
  };
}

/**
 * 按指定并发执行数组映射，并保留输入顺序。
 * 该实现不依赖第三方库，便于 Electron 打包和单元测试。
 */
async function mapWithConcurrency(items, maxConcurrency, mapper) {
  const list = Array.isArray(items) ? items : [];
  const limit = createLimiter(maxConcurrency);
  return Promise.all(list.map((item, index) => limit(() => mapper(item, index))));
}

module.exports = { createLimiter, mapWithConcurrency };

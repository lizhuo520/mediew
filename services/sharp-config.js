'use strict';

const sharp = require('sharp');

// libvips 默认会缓存最近打开的文件（含 mmap 映射）。在 Windows 上这会让
// .webp / .gif 的源文件在读取（探测宽高比或生成缩略图）之后仍被占用，
// 用户在界面里「删除 / 重命名 / 移动」这些文件就会报 EBUSY。
// 逐项实测：不设置该项时 webp 与 gif 的源文件在 3 秒内始终无法删除；
// 设置为 0 后所有格式都能立刻释放，且生成耗时没有变化（16~33ms）。
// Mediew 每张图只读一次并立即写出缓存，文件级缓存没有复用价值，因此直接关闭。
sharp.cache({ files: 0 });

// 限制 sharp 内部线程数，将并行度留给多张缩略图任务，避免线程过度订阅。
sharp.concurrency(2);

// 统一从这里取 sharp，避免出现「某处直接用 sharp 而漏掉上述配置」的情况。
module.exports = sharp;

'use strict';

const { contextBridge } = require('electron');

// 30 张「RAW」样片，方向/比例各异，用于验证瀑布流排列与缩略图调度顺序。
const ASPECTS = [
  [1600, 1200], [1200, 1800], [2400, 1200], [1080, 1920], [2000, 2000], [3000, 1000]
];

const items = Array.from({ length: 30 }, (_, index) => {
  const [width, height] = ASPECTS[index % ASPECTS.length];
  const number = String(index + 1).padStart(4, '0');
  return {
    name: `IMG_${number}.cr2`,
    path: `D:\\Fake\\IMG_${number}.cr2`,
    relativePath: `IMG_${number}.cr2`,
    folder: '',
    size: 20 * 1024 * 1024,
    mtime: Date.now() - index * 60000,
    type: 'image',
    isRaw: true,
    rawFormat: 'CR2',
    extension: '.cr2',
    width,
    height,
    orientation: 1,
    camera: 'Canon EOS R6',
    lens: 'RF 24-70mm F2.8',
    aperture: 'f/2.8',
    shutter: '1/250s',
    iso: 400,
    date: '2026年10月20日 12:00',
    year: '2026年',
    month: '2026年10月',
    day: '2026年10月20日',
    hour: '2026年10月20日 12:00',
    dateSource: 'exif',
    favorite: false,
    metadataPending: false
  };
});

const thumbnailOrder = [];
const previewOrder = [];
const previewFullRequests = [];

function svgDataUrl(width, height, index) {
  const hue = (index * 47) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="hsl(${hue},55%,42%)"/>
    <rect x="${width * 0.1}" y="${height * 0.1}" width="${width * 0.8}" height="${height * 0.8}" fill="rgba(255,255,255,0.08)"/>
    <text x="50%" y="52%" text-anchor="middle" font-size="${Math.round(Math.min(width, height) / 5)}" fill="rgba(255,255,255,0.85)">${index + 1}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const api = {
  selectDirectory: async () => null,
  readDirectory: async () => ({ scanId: 'fake-scan', items, pendingCount: 0, recursive: false }),
  cancelDirectoryScan: async () => ({ success: true }),
  onMediaMetadataUpdated: () => () => {},
  onMediaMetadataComplete: () => () => {},
  onMediaScanError: () => () => {},
  onMediaDimensionsUpdated: () => () => {},
  onMediaDimensionsComplete: () => () => {},
  getThumbnail: async (filePath) => {
    thumbnailOrder.push(filePath);
    const index = items.findIndex((item) => item.path === filePath);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const [width, height] = ASPECTS[(index < 0 ? 0 : index) % ASPECTS.length];
    const scale = 640 / Math.max(width, height);
    return {
      success: true,
      url: svgDataUrl(Math.round(width * scale), Math.round(height * scale), Math.max(0, index)),
      fromCache: false
    };
  },
  getPreview: async (filePath, options = {}) => {
    previewOrder.push(filePath);
    if (options && options.full) previewFullRequests.push(filePath);
    const index = Math.max(0, items.findIndex((item) => item.path === filePath));
    await new Promise((resolve) => setTimeout(resolve, 120));
    const [width, height] = ASPECTS[index % ASPECTS.length];
    const maxSide = options && options.full ? 1600 : 1100;
    const scale = maxSide / Math.max(width, height);
    return {
      success: true,
      url: svgDataUrl(Math.round(width * scale), Math.round(height * scale), index),
      isRaw: true,
      source: 'fake',
      full: Boolean(options && options.full)
    };
  },
  preparePreview: async () => ({ success: true }),
  getSubfolders: async () => [],
  deleteFile: async () => ({ success: true }),
  deleteFiles: async () => ({ success: true }),
  renameFile: async () => ({ success: false, error: 'stub' }),
  moveFile: async () => ({ success: true }),
  moveFiles: async () => ({ success: true, movedPaths: [] }),
  createFolder: async () => ({ success: true }),
  deleteFolder: async () => ({ success: true }),
  deleteFolders: async () => ({ success: true }),
  renameFolder: async () => ({ success: true }),
  moveFolder: async () => ({ success: true }),
  openInExplorer: async () => ({ success: true }),
  showFileInExplorer: async () => ({ success: true }),
  openFile: async () => ({ success: true }),
  copyFilePath: async () => ({ success: true }),
  toggleFavorite: async () => ({ success: true, favorite: true }),
  minimizeWindow: () => {},
  maximizeWindow: () => {},
  closeWindow: () => {},
  isWindowMaximized: async () => false,
  onWindowMaximizedChanged: () => () => {},
  watchDirectory: () => {},
  unwatchDirectory: () => {},
  onDirectoryChanged: () => () => {},
  getThumbnailOrder: () => thumbnailOrder.slice(),
  getPreviewOrder: () => previewOrder.slice(),
  getPreviewFullRequests: () => previewFullRequests.slice(),
  resetOrders: () => {
    thumbnailOrder.length = 0;
    previewOrder.length = 0;
    previewFullRequests.length = 0;
  }
};

contextBridge.exposeInMainWorld('api', api);

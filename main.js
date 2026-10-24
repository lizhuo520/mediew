'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  clipboard,
  session
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;

const { MediaService } = require('./services/media-service');

const DEFAULT_WINDOW_STATE = { width: 1200, height: 800, x: undefined, y: undefined };

let win = null;
let mediaService = null;
let currentWatcher = null;
let watchedPath = null;
let debounceTimer = null;
let isReadyToQuit = false;
let windowStateSavePromise = null;

/**
 * 窗口状态迁移到 userData 目录，避免安装目录不可写时保存失败。
 */
function getStateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

/**
 * 启动时只读取一次窗口状态，属于轻量同步操作，不会影响渲染性能。
 * 文件被手工编辑坏（null / 数组 / 字符串）时不能把坏值喂给 BrowserWindow，
 * 否则会出现 0 宽高或 NaN 坐标的隐形窗口，这里统一回退到默认值。
 */
function loadWindowState() {
  try {
    const state = JSON.parse(fs.readFileSync(getStateFile(), 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state)) return { ...DEFAULT_WINDOW_STATE };
    return state;
  } catch (_) {
    return { ...DEFAULT_WINDOW_STATE };
  }
}

/**
 * 关闭窗口时异步保存状态。返回 Promise，退出流程可以等待写入完成，
 * 避免 app.exit() 抢在 writeFile 之前把进程杀掉导致窗口状态丢失。
 */
function saveWindowState() {
  if (!win || win.isDestroyed()) return Promise.resolve();
  let state;
  try {
    state = { ...win.getBounds(), isMaximized: win.isMaximized() };
  } catch (_) {
    return Promise.resolve();
  }
  windowStateSavePromise = fsp.mkdir(path.dirname(getStateFile()), { recursive: true })
    .then(() => fsp.writeFile(getStateFile(), JSON.stringify(state), 'utf8'))
    .catch(() => {});
  return windowStateSavePromise;
}

function createWindow() {
  const state = loadWindowState();
  win = new BrowserWindow({
    width: state.width || 1200,
    height: state.height || 800,
    x: state.x,
    y: state.y,
    frame: false,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#15202b',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true
    }
  });

  if (state.isMaximized) win.maximize();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('close', () => {
    stopWatching();
    saveWindowState();
  });

  // 无边框窗口里最大化按钮是唯一的状态提示：不把状态推给渲染层，
  // 按钮会永远显示"最大化"图标，用户双击标题栏后就看不出当前是不是最大化。
  const pushMaximizedState = () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('window-maximized-changed', win.isMaximized());
  };
  win.on('maximize', pushMaximizedState);
  win.on('unmaximize', pushMaximizedState);
  win.on('ready-to-show', pushMaximizedState);
}

/**
 * 按当前设置对主进程返回的快照排序。
 * EXIF 只在后台补充，因此排序始终基于可靠的 mtime 或文件名，不会因异步更新跳动。
 */
function sortMedia(items, sortMode, sortDir) {
  const list = Array.isArray(items) ? items : [];
  if (sortMode === 'filename') {
    list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    if (sortDir !== 'asc') list.reverse();
  } else {
    list.sort((a, b) => a.mtime - b.mtime);
    if (sortDir !== 'asc') list.reverse();
  }
  return list;
}

/**
 * 目录读取改为两阶段：立即返回基础文件信息，后台分批合并 EXIF。
 */
ipcMain.handle('read-directory', async (event, dirPath, sortMode, sortDir, recursive) => {
  if (typeof dirPath !== 'string' || !dirPath) {
    return { scanId: null, items: [], pendingCount: 0, error: '参数无效' };
  }
  if (!mediaService) return { scanId: null, items: [], pendingCount: 0 };
  const sender = event.sender;
  try {
    const result = await mediaService.startDirectoryScan(dirPath, {
      recursive: Boolean(recursive),
      onBatch: (payload) => {
        if (!sender.isDestroyed()) sender.send('media-metadata-updated', payload);
      },
      onComplete: (payload) => {
        if (!sender.isDestroyed()) sender.send('media-metadata-complete', payload);
      },
      // 宽高比探测结果单独走一条通道：它比 EXIF 先到达，
      // 用于在缩略图生成前就按真实比例占位，避免瀑布流跳动。
      onDimensions: (payload) => {
        if (!sender.isDestroyed()) sender.send('media-dimensions-updated', payload);
      },
      onDimensionsComplete: (payload) => {
        if (!sender.isDestroyed()) sender.send('media-dimensions-complete', payload);
      },
      onError: (error) => {
        if (!sender.isDestroyed()) {
          sender.send('media-scan-error', { message: error && error.message ? error.message : '目录读取失败' });
        }
      }
    });
    sortMedia(result.items, sortMode, sortDir);
    return result;
  } catch (error) {
    return { scanId: null, items: [], pendingCount: 0, error: error.message };
  }
});

ipcMain.handle('cancel-directory-scan', async () => {
  if (mediaService) mediaService.cancelActiveScan();
  return { success: true };
});

// 缩略图和 RAW/大格式预览由主进程生成并缓存，渲染层只接收 file:// 地址。
ipcMain.handle('get-thumbnail', async (event, filePath, size) => {
  if (typeof filePath !== 'string' || !filePath) return { success: false, error: '参数无效' };
  return mediaService ? mediaService.getThumbnail(filePath, size) : { success: false, error: '服务尚未初始化' };
});

ipcMain.handle('get-preview', async (event, filePath, options) => {
  if (typeof filePath !== 'string' || !filePath) return { success: false, error: '参数无效' };
  return mediaService ? mediaService.getPreview(filePath, options) : { success: false, error: '服务尚未初始化' };
});

ipcMain.handle('prepare-preview', async (event, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return { success: false, error: '参数无效' };
  try {
    // 预生成是"顺手做"的优化：任何失败都不能冒泡成未处理的 reject，
    // 否则渲染层 await 到的是一个永远不会 settle 的 Promise。
    if (mediaService) mediaService.preparePreview(filePath).catch(() => {});
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-subfolders', async (event, dirPath) => {
  if (typeof dirPath !== 'string' || !dirPath) return [];
  try {
    return mediaService ? await mediaService.getSubfolders(dirPath) : [];
  } catch (_) {
    return [];
  }
});

ipcMain.handle('select-directory', async (event, title) => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: (typeof title === 'string' && title) ? title : '选择媒体目录'
  });
  return result.canceled ? null : { path: result.filePaths[0] };
});

// 收藏状态持久化在 userData 目录，不修改用户媒体文件。
ipcMain.handle('toggle-favorite', async (event, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return { success: false, error: '参数无效' };
  return mediaService ? mediaService.toggleFavorite(filePath) : { success: false };
});

ipcMain.handle('copy-file-path', async (event, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return { success: false, error: '参数无效' };
  clipboard.writeText(filePath);
  return { success: true };
});

ipcMain.handle('show-file-in-explorer', async (event, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return { success: false, error: '参数无效' };
  shell.showItemInFolder(filePath);
  return { success: true };
});

// 「用默认程序打开」：交给系统关联程序，Mediew 自身不解码这些格式也没关系。
ipcMain.handle('open-file', async (event, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return { success: false, error: '参数无效' };
  try {
    // shell.openPath 用返回值表达失败（成功时是空串），不抛异常
    const message = await shell.openPath(filePath);
    if (message) return { success: false, error: message };
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

/**
 * 判断路径是否存在：只有 ENOENT 才当作"不存在"。
 * 旧实现用其实等价于"存在或没权限"的 access() + 空 catch，会把 EPERM/EBUSY
 * 误判成"可以写"，随后 rename 直接覆盖掉同名文件。
 */
async function pathExists(targetPath) {
  try {
    await fsp.lstat(targetPath);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function createExistsError(message) {
  const error = new Error(message);
  error.code = 'EEXIST';
  return error;
}

/**
 * 移动单个文件且绝不覆盖目标：同卷走硬链接（原子独占创建）+ 删除源文件，
 * 跨卷走 COPYFILE_EXCL + 复制时间戳 + 删除源文件。任一步失败都保留源文件。
 */
async function moveWithoutOverwrite(srcPath, destPath) {
  try {
    await fsp.link(srcPath, destPath);
  } catch (error) {
    const code = error && error.code;
    if (code === 'EEXIST') throw createExistsError('目标位置已存在同名文件');
    // 跨卷（EXDEV）以及某些文件系统 / 权限策略不支持硬链接时退回复制。
    if (code === 'EXDEV' || code === 'ENOSYS' || code === 'EPERM' || code === 'EACCES' || code === 'EINVAL') {
      return copyFileWithoutOverwrite(srcPath, destPath);
    }
    throw error;
  }
  try {
    await fsp.unlink(srcPath);
  } catch (error) {
    // 删不掉源文件就回滚刚建的硬链接，宁可移动失败也不能留下两份。
    await fsp.unlink(destPath).catch(() => {});
    throw error;
  }
  return destPath;
}

async function copyFileWithoutOverwrite(srcPath, destPath) {
  const stat = await fsp.stat(srcPath);
  try {
    await fsp.copyFile(srcPath, destPath, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if (error && error.code === 'EEXIST') throw createExistsError('目标位置已存在同名文件');
    throw error;
  }
  try {
    // 时间戳参与缩略图缓存 key 与排序，跨卷复制必须显式还原。
    await fsp.utimes(destPath, stat.atime, stat.mtime);
  } catch (_) {}
  try {
    await fsp.unlink(srcPath);
  } catch (error) {
    await fsp.unlink(destPath).catch(() => {});
    throw error;
  }
  return destPath;
}

/**
 * 移动单个目录且绝不覆盖：同卷 rename（Windows 上目标已存在时 rename 会报 EPERM，
 * 不会静默合并），跨卷 cp + rm，失败回滚已复制的副本。
 */
async function moveFolderWithoutOverwrite(srcPath, destPath) {
  if (await pathExists(destPath)) throw createExistsError('目标位置已存在同名文件夹');
  try {
    await fsp.rename(srcPath, destPath);
    return destPath;
  } catch (error) {
    const code = error && error.code;
    if (code !== 'EXDEV') {
      // Windows 上目标已存在时 rename 报的是 EPERM 而不是 EEXIST，
      // 复查一下目标是否在这期间被别人建了出来，好给出中文提示。
      if ((code === 'EPERM' || code === 'EACCES') && await pathExists(destPath).catch(() => false)) {
        throw createExistsError('目标位置已存在同名文件夹');
      }
      throw error;
    }
  }
  await fsp.cp(srcPath, destPath, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true
  });
  try {
    await fsp.rm(srcPath, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    // 这里不能回滚删 dest：rm 是逐个删文件的，中途失败意味着源目录已经少了一部分，
    // 删掉目标副本会把这些文件彻底弄丢。宁可留下两份，让用户手工清理。
    throw new Error(`已复制到「${destPath}」，但源目录未能完全删除：${error.message}`);
  }
  return destPath;
}

// 批量移动：右键菜单的「移动到…」入口，不必再靠拖拽才能移动文件。
// 逐个移动而不是整体失败，部分成功时也要把已移动的路径回传给渲染层。
ipcMain.handle('move-files', async (event, filePaths, destDir) => {
  const paths = Array.isArray(filePaths)
    ? filePaths.filter((item) => typeof item === 'string' && item)
    : [];
  if (typeof destDir !== 'string' || !destDir) return { success: false, error: '参数无效' };
  if (paths.length === 0) return { success: false, error: '没有可移动的文件' };

  const movedPaths = [];
  const movedPairs = [];
  const failures = [];
  for (const filePath of paths) {
    const destPath = path.join(destDir, path.basename(filePath));
    if (path.resolve(filePath).toLowerCase() === path.resolve(destPath).toLowerCase()) {
      failures.push(`${path.basename(filePath)}：已在该文件夹中`);
      continue;
    }
    try {
      await moveWithoutOverwrite(filePath, destPath);
      movedPaths.push(destPath);
      movedPairs.push([filePath, destPath]);
    } catch (error) {
      failures.push(`${path.basename(filePath)}：${error.message}`);
    }
  }

  if (movedPairs.length > 0 && mediaService) {
    // 收藏是按绝对路径存的，文件挪了位置要把收藏一起搬过去；
    // 迁移失败不能影响已经成功的文件操作，所以只吞掉异常。
    try {
      await mediaService.remapFavoritePaths(movedPairs);
    } catch (_) {}
  }

  if (movedPaths.length === 0) {
    return { success: false, error: failures[0] || '没有文件被移动' };
  }
  return {
    success: true,
    movedPaths,
    failedCount: failures.length,
    error: failures.length ? failures.join('\n') : undefined
  };
});

// 目录监听仍采用 fs.watch，但将刷新消息合并到更短的 800ms 窗口。
function startWatching(dirPath) {
  stopWatching();
  try {
    currentWatcher = fs.watch(dirPath, (eventType) => {
      if (eventType !== 'rename' && eventType !== 'change') return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (win && !win.isDestroyed()) win.webContents.send('directory-changed', dirPath);
      }, 800);
    });
    currentWatcher.on('error', stopWatching);
    watchedPath = dirPath;
  } catch (_) {
    currentWatcher = null;
    watchedPath = null;
  }
}

function stopWatching() {
  if (currentWatcher) {
    currentWatcher.close();
    currentWatcher = null;
  }
  watchedPath = null;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

ipcMain.on('watch-directory', (event, dirPath) => {
  if (typeof dirPath !== 'string' || !dirPath) return;
  startWatching(dirPath);
});
ipcMain.on('unwatch-directory', () => stopWatching());

// Windows 文件名规则：这些字符在 NTFS 上是非法的，提前拦下比让系统
// 兜底报 EINVAL 更友好（EINVAL 是英文，用户看不懂也不知道改哪个字符）。
const INVALID_NAME_CHARS = /[<>:"/\\|?*]/;
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

/**
 * 校验用户输入的单个文件名 / 文件夹名，返回错误文案，合法时返回 null。
 */
function validateEntryName(name) {
  const value = typeof name === 'string' ? name.trim() : '';
  if (!value) return '名称不能为空';
  if (INVALID_NAME_CHARS.test(value)) return '名称不能包含 < > : " / \\ | ? *';
  if (value === '.' || value === '..') return '名称不能是 "." 或 ".."';
  if (/[. ]$/.test(value)) return '名称不能以点或空格结尾';
  const stem = value.split('.')[0].trim().toUpperCase();
  if (WINDOWS_RESERVED_NAMES.has(stem)) return `"${value.split('.')[0]}" 是 Windows 保留名称`;
  return null;
}

// 文件操作统一使用异步 fs，避免大目录或网络盘操作造成主进程假死。

// 批量确认框只列出前几个名字：几十个文件全铺进 detail 会把对话框撑到屏幕外，
// 反而看不清到底要删什么。
const DIALOG_NAME_LIMIT = 8;
function describeNames(names, total) {
  const list = names.slice(0, DIALOG_NAME_LIMIT);
  if (total > list.length) list.push(`…等 ${total} 个`);
  return list.join('\n');
}

ipcMain.handle('delete-file', async (event, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return { success: false, error: '参数无效' };
  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['删除', '取消'],
    defaultId: 1,
    title: '确认删除',
    message: '确定要删除这个文件吗？',
    detail: path.basename(filePath)
  });
  if (result.response !== 0) return { success: false };
  try {
    await shell.trashItem(filePath);
    if (mediaService) {
      try {
        await mediaService.forgetFavoritePaths([filePath]);
      } catch (_) {}
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('delete-files', async (event, filePaths) => {
  const paths = Array.isArray(filePaths)
    ? filePaths.filter((item) => typeof item === 'string' && item)
    : [];
  if (paths.length === 0) return { success: false, error: '参数无效' };
  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['删除', '取消'],
    defaultId: 1,
    title: '确认删除',
    message: `确定要删除这 ${paths.length} 个文件吗？`,
    detail: describeNames(paths.map((item) => path.basename(item)), paths.length)
  });
  if (result.response !== 0) return { success: false };

  const outcomes = await Promise.allSettled(paths.map((filePath) => shell.trashItem(filePath)));
  const removedPaths = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') removedPaths.push(paths[index]);
  });
  const successCount = removedPaths.length;
  if (successCount > 0 && mediaService) {
    try {
      await mediaService.forgetFavoritePaths(removedPaths);
    } catch (_) {}
  }
  return { success: successCount > 0, successCount };
});

ipcMain.handle('rename-file', async (event, filePath, newName) => {
  if (typeof filePath !== 'string' || !filePath) return { success: false, error: '参数无效' };
  try {
    const dir = path.dirname(filePath);
    const cleanName = String(newName ?? '').trim();
    if (!cleanName) return { success: false, error: '文件名不能为空' };
    const nameError = validateEntryName(cleanName);
    if (nameError) return { success: false, error: nameError };

    // 用户显式写了扩展名就按用户的来（my.holiday 不该被截成 my.jpg），
    // 没写才补上源文件的扩展名。
    const parsed = path.parse(cleanName);
    const finalName = parsed.ext ? cleanName : `${cleanName}${path.extname(filePath)}`;
    const finalError = validateEntryName(finalName);
    if (finalError) return { success: false, error: finalError };

    const newPath = path.join(dir, finalName);
    if (path.resolve(path.dirname(newPath)) !== path.resolve(dir)) {
      return { success: false, error: '文件名不能包含路径' };
    }
    const resolvedNew = path.resolve(newPath);
    const resolvedOld = path.resolve(filePath);
    if (resolvedNew === resolvedOld) return { success: true, newPath: filePath };

    if (resolvedNew.toLowerCase() === resolvedOld.toLowerCase()) {
      // 只改大小写：NTFS 认为两者是同一个文件，link 会报 EEXIST，
      // 必须走 rename 才能真的改掉显示出来的大小写。
      await fsp.rename(filePath, newPath);
      return { success: true, newPath };
    }

    if (await pathExists(newPath)) return { success: false, error: '文件已存在' };
    await moveWithoutOverwrite(filePath, newPath);
    if (mediaService) {
      try {
        await mediaService.remapFavoritePaths([[filePath, newPath]]);
      } catch (_) {}
    }
    return { success: true, newPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('move-file', async (event, filePath, destDir) => {
  if (typeof filePath !== 'string' || !filePath) return { success: false, error: '参数无效' };
  if (typeof destDir !== 'string' || !destDir) return { success: false, error: '参数无效' };
  try {
    const destPath = path.join(destDir, path.basename(filePath));
    if (path.resolve(filePath).toLowerCase() === path.resolve(destPath).toLowerCase()) {
      return { success: false, error: '文件已在该目录' };
    }
    await moveWithoutOverwrite(filePath, destPath);
    if (mediaService) {
      try {
        await mediaService.remapFavoritePaths([[filePath, destPath]]);
      } catch (_) {}
    }
    return { success: true, newPath: destPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('create-folder', async (event, parentDir, folderName) => {
  if (typeof parentDir !== 'string' || !parentDir) return { success: false, error: '参数无效' };
  try {
    const nameError = validateEntryName(folderName);
    if (nameError) return { success: false, error: nameError };
    const name = String(folderName).trim();
    const newPath = path.join(parentDir, name);
    if (path.resolve(path.dirname(newPath)) !== path.resolve(parentDir)) {
      return { success: false, error: '名称不能包含路径' };
    }
    if (await pathExists(newPath)) return { success: false, error: '文件夹已存在' };
    await fsp.mkdir(newPath);
    return { success: true, path: newPath };
  } catch (error) {
    if (error && error.code === 'EEXIST') return { success: false, error: '文件夹已存在' };
    return { success: false, error: error.message };
  }
});

/**
 * 监听中的目录被删除 / 改名后 fs.watch 会持续报错并触发整表刷新，
 * 所以在真正删除成功之后再停掉 watcher（先停会让删除过程中的
 * 变更事件丢掉，用户会看到一张过期的列表）。
 */
function stopWatchingIfRemoved(removedDirs) {
  if (!watchedPath || !Array.isArray(removedDirs) || removedDirs.length === 0) return;
  const watched = path.resolve(watchedPath).toLowerCase();
  const hit = removedDirs.some((dirPath) => {
    const target = path.resolve(dirPath).toLowerCase();
    return watched === target || watched.startsWith(`${target}${path.sep}`);
  });
  if (hit) stopWatching();
}

ipcMain.handle('delete-folder', async (event, dirPath) => {
  if (typeof dirPath !== 'string' || !dirPath) return { success: false, error: '参数无效' };
  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['删除', '取消'],
    defaultId: 1,
    title: '确认删除文件夹',
    message: '确定要删除这个文件夹吗？',
    detail: `${dirPath}\n\n文件夹内的所有内容都将被删除。`
  });
  if (result.response !== 0) return { success: false };
  try {
    await shell.trashItem(dirPath);
  } catch (error) {
    return { success: false, error: error.message };
  }
  stopWatchingIfRemoved([dirPath]);
  if (mediaService) {
    try {
      await mediaService.forgetFavoritesUnder(dirPath);
    } catch (_) {}
  }
  return { success: true };
});

ipcMain.handle('delete-folders', async (event, dirPaths) => {
  const paths = Array.isArray(dirPaths)
    ? dirPaths.filter((item) => typeof item === 'string' && item)
    : [];
  if (paths.length === 0) return { success: false, error: '参数无效' };
  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['删除', '取消'],
    defaultId: 1,
    title: '确认删除文件夹',
    message: `确定要删除这 ${paths.length} 个文件夹吗？`,
    detail: `${describeNames(paths.map((item) => path.basename(item)), paths.length)}\n\n文件夹内的所有内容都将被删除。`
  });
  if (result.response !== 0) return { success: false };

  const outcomes = await Promise.allSettled(paths.map((dirPath) => shell.trashItem(dirPath)));
  const removedDirs = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') removedDirs.push(paths[index]);
  });
  const successCount = removedDirs.length;
  stopWatchingIfRemoved(removedDirs);
  if (successCount > 0 && mediaService) {
    for (const dirPath of removedDirs) {
      try {
        await mediaService.forgetFavoritesUnder(dirPath);
      } catch (_) {}
    }
  }
  return { success: successCount > 0, successCount };
});

ipcMain.handle('rename-folder', async (event, dirPath, newName) => {
  if (typeof dirPath !== 'string' || !dirPath) return { success: false, error: '参数无效' };
  try {
    const nameError = validateEntryName(newName);
    if (nameError) return { success: false, error: nameError };
    const name = String(newName).trim();
    const newPath = path.join(path.dirname(dirPath), name);
    if (path.resolve(path.dirname(newPath)) !== path.resolve(path.dirname(dirPath))) {
      return { success: false, error: '名称不能包含路径' };
    }
    const resolvedNew = path.resolve(newPath);
    const resolvedOld = path.resolve(dirPath);
    if (resolvedNew === resolvedOld) return { success: true, newPath: dirPath };
    if (resolvedNew.toLowerCase() === resolvedOld.toLowerCase()) {
      await fsp.rename(dirPath, newPath);
      return { success: true, newPath };
    }
    if (await pathExists(newPath)) return { success: false, error: '文件夹已存在' };
    await fsp.rename(dirPath, newPath);
    return { success: true, newPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('move-folder', async (event, srcPath, destDir) => {
  if (typeof srcPath !== 'string' || !srcPath) return { success: false, error: '参数无效' };
  if (typeof destDir !== 'string' || !destDir) return { success: false, error: '参数无效' };
  try {
    const destPath = path.join(destDir, path.basename(srcPath));
    const srcLower = path.resolve(srcPath).toLowerCase();
    const destLower = path.resolve(destPath).toLowerCase();
    if (srcLower === destLower) return { success: false, error: '不能移动到自身' };
    if (destLower.startsWith(`${srcLower}${path.sep}`)) return { success: false, error: '不能移动到自身子目录' };
    await moveFolderWithoutOverwrite(srcPath, destPath);
    return { success: true, newPath: destPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('open-in-explorer', async (event, dirPath) => {
  if (typeof dirPath !== 'string' || !dirPath) return { success: false, error: '参数无效' };
  try {
    // shell.openPath 不会抛异常，失败信息全在返回值里。
    const message = await shell.openPath(dirPath);
    if (message) return { success: false, error: message };
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 自定义标题栏控制。
ipcMain.on('window-minimize', () => win && win.minimize());
ipcMain.on('window-maximize', () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('window-close', () => win && win.close());
ipcMain.handle('is-window-maximized', () => Boolean(win && !win.isDestroyed() && win.isMaximized()));

// 单实例：第二次启动时把已有窗口唤到前面，而不是开第二个主进程
// （两个进程会同时持有同一个缩略图缓存目录和 window-state.json）。
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(async () => {
    mediaService = new MediaService({ userDataPath: app.getPath('userData') });
    await mediaService.initialize();
    createWindow();
  }).catch((error) => {
    dialog.showErrorBox('Mediew 启动失败', String(error && error.message ? error.message : error));
    app.exit(1);
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// 退出前把渲染层的 localStorage/IndexedDB 写盘刷掉，避免设置项丢失。
app.on('before-quit', () => {
  stopWatching();
  try {
    if (session && session.defaultSession && typeof session.defaultSession.flushStorageData === 'function') {
      session.defaultSession.flushStorageData();
    }
  } catch (_) {}
});

// 退出前等待 ExifTool 子进程和缓存写入完成，避免遗留进程或缓存损坏。
// 3 秒兜底：dispose 卡住（ExifTool 挂死 / 网络盘写不动）时也必须退得出去。
app.on('will-quit', (event) => {
  if (isReadyToQuit || !mediaService) return;
  event.preventDefault();
  isReadyToQuit = true;
  stopWatching();
  const shutdown = Promise.allSettled([
    windowStateSavePromise || saveWindowState(),
    mediaService.dispose()
  ]);
  const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
  Promise.race([shutdown, timeout]).finally(() => app.exit(0));
});

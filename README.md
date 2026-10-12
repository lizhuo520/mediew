# Mediew

具有瀑布流和网格风格的轻量图片/视频浏览器，基于 Electron、sharp 和 ExifTool。

## 功能特性

- **文件夹导航**：左侧树形目录，按需懒加载，避免启动时递归扫描整个磁盘。
- **图片预览**：支持 JPG、PNG、GIF、WebP、BMP、TIFF、AVIF、HEIC/HEIF。TIFF 与 HEIC 由主进程用 sharp 解码后输出缓存 JPEG，不依赖浏览器的原生解码能力。
- **RAW 照片**：支持 DNG、CR2、CR3、CRW、NEF、NRW、ARW、ORF、RW2、RAF、PEF、SRW、MRW、X3F、GPR 等常见相机格式。
- **高性能瀑布流**：首屏只渲染可见批次，进入视口附近后才请求缩略图。
- **缩略图缓存**：普通图片使用 sharp 生成缓存 JPEG，RAW 优先读取内嵌预览。
- **稳定布局**：先探测图片宽高比并预占位，缩略图到达时不会再引起整屏跳动。
- **递归子文件夹**：可在工具栏或设置中开启，显示当前目录及所有子目录中的媒体。
- **目录搜索**：按文件名、相机、镜头、日期或 RAW 格式筛选。
- **收藏筛选**：右键收藏照片，并可只显示收藏内容。
- **拍摄信息**：预览面板显示相机、镜头、光圈、快门、ISO、尺寸和格式。
- **文件操作**：重命名、删除、批量拖拽移动、复制路径、在资源管理器中定位，以及用默认程序打开、移动到指定文件夹。
- **操作反馈**：重命名冲突、目标目录已有同名文件、文件被占用等情况都会明确提示，不再静默失败。
- **键盘操作**：网格与文件夹树都有完整的键盘导航，焦点位置始终可见。
- **视频播放**：进度条、音量、倍速、全屏和画中画等现有功能保持可用。
- **主题与布局**：深色/浅色主题、瀑布流/网格/文件名布局。首次启动为深色主题。
- **无障碍**：全部文字对比度达到 WCAG AA 4.5:1；网格与文件夹树带 listbox/tree 语义与选中状态。

## 键盘操作

网格（先用 Tab 进入网格，之后方向键在卡片间移动）：

| 按键 | 作用 |
| --- | --- |
| 方向键 | 上下在**同一列**内移动，左右跨列 |
| Home / End | 跳到首张 / 末张 |
| Enter | 打开预览 |
| 空格 | 切换当前卡片的选中状态 |
| Ctrl+A | 全选 |
| Esc | 取消选择 |
| F2 | 重命名（仅「文件名」布局） |
| Delete | 删除当前卡片（或已选中的全部） |

文件夹树：

| 按键 | 作用 |
| --- | --- |
| ↑ / ↓ | 在可见的文件夹之间移动 |
| → / ← | 展开 / 收起，或在父子之间移动 |
| Enter / 空格 | 切换到该文件夹 |
| Home / End | 跳到第一个 / 最后一个可见文件夹 |
| F2 | 重命名（根目录除外） |
| Delete | 删除文件夹 |

全局：

| 按键 | 作用 |
| --- | --- |
| Ctrl+O | 选择目录 |
| Ctrl+F | 聚焦搜索框 |
| F5 | 重新扫描当前目录 |
| Esc | 退出搜索框 |
| 右键菜单 | 打开后自动聚焦第一项，方向键移动，Tab 或 Esc 关闭并把焦点交还页面 |

## RAW 支持说明

Mediew 不修改 RAW 原文件。显示 RAW 时的处理顺序如下：

1. DNG/TIFF-RAW 优先尝试由 sharp 直接解码；
2. 其他 RAW 通过 ExifTool 读取 `PreviewImage`、`JpgFromRaw`、`ThumbnailImage` 或 `OtherImage` 内嵌 JPEG；
3. 如果文件本身没有预览且当前解码器无法读取，界面会明确显示“RAW 预览不可用”。

该策略兼容性广、无需用户安装 LibRaw 或相机厂商软件；但它显示的是 RAW 内嵌预览，不是完整的去马赛克和色彩编辑结果。如果相机文件没有内嵌预览，仍需要后续接入 LibRaw 才能完整解码。

## 缩略图与预览规格

取图规格与单文件版看图工具 gkpv 对齐（见 `services/media-service.js` 顶部常量）。

| 项目 | 规格 | 说明 |
| --- | --- | --- |
| 缩略图最长边 | 640 px | 只限制最长边，短边按比例；源图更小则不放大 |
| 缩略图编码 | JPEG q80、progressive、mozjpeg | 与 gkpv 的 q0.8 一致，mozjpeg 体积更小 |
| 缩略图并发 | 渲染层 8 / 主进程 4 | 渲染层排队并发对齐 gkpv，主进程限流保护 CPU |
| 预览图最长边 | 4096 px | 仅对 TIFF / HEIC / RAW 生成；其他格式直接加载原图 |
| 预览图编码 | JPEG q92 | 与 gkpv 灯箱重编码质量一致 |
| 宽高比探测 | `sharp().metadata()` 只读文件头 | 结果写入 `dimension-cache.json` 持久化 |

**为什么灯箱对普通图片直接加载原图**：gkpv 的灯箱同样加载原图，这样 100% 缩放才是真正的 1:1 像素。只有浏览器无法解码的格式（TIFF / HEIC / RAW）才由主进程生成预览。

**与 gkpv 的差异**：gkpv 在渲染进程用 `createImageBitmap` 解码，因此无法处理 TIFF（Chromium 没有 TIFF 解码器，`readImageSize()` 也没有 TIFF 分支，缩略图与灯箱都会失败）。Mediew 把解码放在主进程由 sharp 完成，TIFF / HEIC / RAW 因此都能正常显示缩略图与预览图，这一点由 `test/image-size.test.js` 与 `test/media-service.test.js` 中的 TIFF 用例锁定。

## 性能设计

- 主进程使用异步 `readdir/stat`，不阻塞 Electron 事件循环。
- 目录快照立即返回，EXIF 与宽高比在后台分批补充，使用缓存和受限并发。
- 元数据缓存位于 `%APPDATA%\mediew\metadata-cache-v2.json`，宽高比缓存位于 `%APPDATA%\mediew\dimension-cache.json`。
- 缩略图规格统一为**最长边 640 px、JPEG q80**（源图更小则不放大），主进程最多 4 路并行生成。
- 预览图规格为**最长边 4096 px、JPEG q92**，只对浏览器无法解码的 TIFF / HEIC / RAW 生成。
- 缩略图和预览缓存位于 `%APPDATA%\mediew\media-cache`，缓存键包含文件大小与修改时间，文件变化时自动失效。
- 宽高比由 `sharp().metadata()` 只读文件头探测，比完整解码便宜得多；结果持久化后再次进入同一目录无需重新探测。
- 瀑布流按批次创建 DOM，避免一次创建数千张卡片。
- 图片和视频只有接近视口时才加载（预加载边距 900 px），该边距是唯一的加载时机控制；不使用原生 `loading="lazy"`，避免出现「已设置地址但始终不解码」的状态。
- 文件夹树只在展开目录时读取下一级子目录。
- 递归浏览使用异步广度优先遍历，每批并行读取 8 个目录。
- 读取图片后会立即释放文件句柄（关闭 libvips 的文件级缓存），确保用户能正常删除、重命名或移动刚浏览过的文件。

## 安装运行

```powershell
npm install
npm start
```

## 测试

```powershell
npm test
```

真实 RAW 集成测试可通过环境变量启用：

```powershell
$env:MEDIEW_RAW_FIXTURE='D:\samples\photo.CR3'
npm test
```

## 打包

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
npm run build:zip
```

打包配置会将 `sharp` 原生库和 `exiftool-vendored` 可执行文件解包到 `app.asar.unpacked`，确保安装后的 RAW 功能可用。

## 许可证

[MIT License](LICENSE)

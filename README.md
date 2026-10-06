# Mediew

具有瀑布流和网格风格的轻量图片/视频浏览器，基于 Electron、sharp 和 ExifTool。

## 功能特性

- **文件夹导航**：左侧树形目录，按需懒加载，避免启动时递归扫描整个磁盘。
- **图片预览**：支持 JPG、PNG、GIF、WebP、BMP、TIFF、AVIF、HEIC/HEIF。
- **RAW 照片**：支持 DNG、CR2、CR3、CRW、NEF、NRW、ARW、ORF、RW2、RAF、PEF、SRW、MRW、X3F、GPR 等常见相机格式。
- **高性能瀑布流**：首屏只渲染可见批次，进入视口附近后才请求缩略图。
- **缩略图缓存**：普通图片使用 sharp 生成缓存 JPEG，RAW 优先读取内嵌预览。
- **递归子文件夹**：可在工具栏或设置中开启，显示当前目录及所有子目录中的媒体。
- **目录搜索**：按文件名、相机、镜头、日期或 RAW 格式筛选。
- **收藏筛选**：右键收藏照片，并可只显示收藏内容。
- **拍摄信息**：预览面板显示相机、镜头、光圈、快门、ISO、尺寸和格式。
- **文件操作**：重命名、删除、批量拖拽移动、复制路径、在资源管理器中定位。
- **视频播放**：进度条、音量、倍速、全屏和画中画等现有功能保持可用。
- **主题与布局**：深色/浅色主题、瀑布流/网格/文件名布局。

## RAW 支持说明

Mediew 不修改 RAW 原文件。显示 RAW 时的处理顺序如下：

1. DNG/TIFF-RAW 优先尝试由 sharp 直接解码；
2. 其他 RAW 通过 ExifTool 读取 `PreviewImage`、`JpgFromRaw`、`ThumbnailImage` 或 `OtherImage` 内嵌 JPEG；
3. 如果文件本身没有预览且当前解码器无法读取，界面会明确显示“RAW 预览不可用”。

该策略兼容性广、无需用户安装 LibRaw 或相机厂商软件；但它显示的是 RAW 内嵌预览，不是完整的去马赛克和色彩编辑结果。如果相机文件没有内嵌预览，仍需要后续接入 LibRaw 才能完整解码。

## 性能设计

- 主进程使用异步 `readdir/stat`，不阻塞 Electron 事件循环。
- 目录快照立即返回，EXIF 在后台分批补充，使用缓存和受限并发。
- 元数据缓存位于 `%APPDATA%\mediew\metadata-cache.json`。
- 网格缩略图默认输出 384 px，主进程最多 4 路并行生成。
- 缩略图和预览缓存位于 `%APPDATA%\mediew\media-cache`。
- 瀑布流按批次创建 DOM，避免一次创建数千张卡片。
- 图片和视频只有接近视口时才加载，滚动时关闭高开销悬停合成。
- 文件夹树只在展开目录时读取下一级子目录。
- 递归浏览使用异步广度优先遍历，每批并行读取 8 个目录。

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

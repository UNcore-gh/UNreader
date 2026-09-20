# UNreader

A beautiful, local-first e-book reader — **EPUB first**, plus MOBI/AZW3, TXT, local HTML and RSS/Atom/JSON Feed subscriptions. Reflowable layout with a seamless continuous scroll, a floating table of contents, an on-edge chapter rail, highlights / bookmarks / comments, and a full appearance system (fonts, backgrounds, presets).

> Part of the **UN series** by [UNcore](https://github.com/UNcore-gh).

## Features

| Feature | Description |
|---------|-------------|
| **📚 EPUB first** | Reflowable EPUB with a real outline/TOC, chapter navigation and footnote support |
| **📖 MOBI / AZW3 / TXT / HTML** | KF8 (AZW3/MOBI) reflow, TXT with automatic encoding detection and chapter splitting, and local HTML/HTM that keeps the page's own layout and author CSS. Relative assets resolve against the vault, and a reading-device control re-renders the page at phone, tablet or desktop width for comfortable reading on smaller screens |
| **📂 Shelf filters** | Hide folders from the bookshelf and *Open book* picker. Obsidian's own **Excluded files** are respected by default, and extra vault folders can be added in Settings → UNreader → Shelf |
| **📰 Feeds** | RSS 2.0 / Atom / RDF / JSON Feed subscriptions in the same sidebar as your shelf — OPML import and export, feed discovery from a web page, full-text article fetch, cached articles for offline reading, podcast enclosures, star/favourite state, and an original-article footer link |
| **📜 Continuous scroll** | Chapters render as stacked same-origin frames — one seamless document, no page-flip friction |
| **🧭 Two ways to navigate** | Floating TOC panel **and** a chapter rail on the right edge (dash length = outline depth; hover to preview, click to jump) |
| **️ Annotations** | Highlights, bookmarks and comments, with a dedicated annotations sidebar and an in-text selection toolbar. Feed articles are starred instead of bookmarked |
| **🎨 Appearance** | Import your own fonts; control size, line height, letter/paragraph spacing, indent and margins; light–dark themes with custom colours |
| **🖼️ Backgrounds & glass** | Background images with a blur/glass layer, per light/dark or shared |
| **🎛️ Presets** | Named appearance presets you can switch between, export and reuse across books |
| **⏱️ Progress** | Per-book position and percentage are saved and restored; optional chapter progress bar and page numbers |
| **️ Immersive mode** | Auto-hiding chrome with tap-to-reveal, coordinated with Obsidian's native bars on mobile |
| **📱 Mobile ready** | Swipe from the text area to open the side drawer, touch-friendly rail, soft-keyboard aware layout |

**Not supported:** PDF, Markdown and FB2 are not treated as books. Obsidian's core viewer owns the `.pdf` extension and renders PDFs better than a plugin can, while other file types continue to open normally from the vault.

## Source code

The full TypeScript source ships in this repository (`src/`, `vendor/`, `esbuild.config.mjs`, `tsconfig.json`) so the plugin can be reviewed and rebuilt:

```bash
npm install
npm run build   # tsc -noEmit -skipLibCheck + esbuild production bundle → main.js + styles.css
```

Development happens in the private repository `UNcore-gh/UNreader-src`; the source copies here are release snapshots. See [LICENSE-SOURCE.md](LICENSE-SOURCE.md) for the source-code licence.

## Installation

### Via BRAT (recommended for now)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin
2. **BRAT → Add Beta plugin** → `UNcore-gh/UNreader`
3. Enable **UNreader** in **Settings → Community plugins**

### Manual

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](../../releases)
2. Copy them into `<vault>/.obsidian/plugins/unreader/`
3. Reload Obsidian and enable **UNreader** in **Settings → Community plugins**

## Usage

- Click any `.epub` / `.mobi` / `.azw3` / `.txt` / `.html` / `.htm` file in your vault — UNreader opens it directly
- Or run **UNreader: 打开书籍** from the command palette
- Set your books folder in **Settings → UNreader**

| Command | What it does |
|---------|--------------|
| `UNreader: 打开书籍` | Open a book from the configured library folder |
| `UNreader: 切换书籍侧边栏` | Toggle the bookshelf sidebar |
| `UNreader: 切换订阅侧边栏` | Toggle the feeds sidebar |
| `UNreader: 刷新全部订阅` | Refresh every subscription |
| `UNreader: 添加订阅` | Add a subscription by URL, or discover one from an ordinary web page |
| `UNreader: 打开下一篇未读文章` | Open the next unread article |
| `UNreader: 显示/隐藏浮动目录` | Toggle the floating table of contents |
| `UNreader: 切换标注侧边栏` | Toggle the highlights / bookmarks / comments panel |
| `UNreader: 添加书签` | Bookmark the current position |
| `UNreader: 阅读外观` | Open the appearance panel |

## Network and privacy

UNreader is **offline by default** and collects **no telemetry**. It reads the book files inside your vault, plus its own settings, fonts, appearance presets, reading progress, annotation data and cached feed snapshots. Podcast and image media caches are local IndexedDB data and are not part of vault sync.

Network access happens only after an explicit user action:

- adding or refreshing a subscription
- resolving a web page into a feed
- fetching an article's full text
- downloading a podcast episode

Reading ordinary books, opening an already-cached article and restoring the workspace never start feed polling. The first time the Feeds sidebar is opened, UNreader may perform one controlled refresh when that setting is enabled. There is no background periodic polling, no paywall or login bypass, and video podcasts are not supported.

No accounts. No cloud.

## License

- **Compiled plugin** (`main.js`, `styles.css`, `manifest.json`) — [MIT](LICENSE): install, use and redistribute the built plugin freely.
- **Source code** in this repository (`src/`, `vendor/`, build config) — [UNcore Source Available License](LICENSE-SOURCE.md): read, audit and learn from it; commercial use requires authorization.

---

# 中文说明

**UNreader** 是 Obsidian 的电子书阅读器——**以 EPUB 为主**，同时支持 MOBI/AZW3 与 TXT。重排阅读、无缝连续滚动、浮动目录 + 右缘章节轨、高亮/书签/批注，以及完整的外观系统（字体、背景图、外观预设），完全离线运行。

> **UN 系列**成员，作者 [UNcore](https://github.com/UNcore-gh)。

## 功能一览

| 功能 | 说明 |
|------|------|
| **📚 EPUB 优先** | 重排 EPUB，支持真实目录/大纲、章节导航与脚注 |
| **📖 MOBI / AZW3 / TXT / HTML** | KF8（AZW3/MOBI）重排；TXT 自动判定编码并切分章节；本地 HTML/HTM 保留原页面布局与作者 CSS，相对资源按库内路径解析，并可用「阅读设备」按手机、平板或桌面宽度重新排版 |
| **📂 书架过滤** | 可从书架与「打开书籍」列表隐藏文件夹；默认遵循 Obsidian 的 **排除文件** 设置，也可在 设置 → UNreader → 书架 中追加每个库自己的排除目录 |
| **📰 订阅** | RSS 2.0 / Atom / RDF / JSON Feed 与书架共用侧栏；支持 OPML 导入导出、网页自动发现、全文抓取、离线文章快照、播客附件、星标收藏，以及文末原文跳转 |
| ** 连续滚动** | 每章渲染为堆叠的同源 frame，读起来是一整篇文档，没有翻页顿挫 |
| **🧭 两种导航** | 浮动目录面板 **+** 右缘章节轨：短横长度编码大纲层级，悬停预览、点击跳转，远跳一次落地无中间闪烁 |
| **️ 标注系统** | 高亮、书签、评论三类标注，独立批注侧边栏 + 划过即出的选区工具条；订阅文章使用星标收藏，不占书籍书签 |
| **🎨 阅读外观** | 导入自定义字体；字号、行高、字距、段间距、首行缩进、左右边距全可调；明暗主题 + 自定义配色 |
| **🖼️ 背景与毛玻璃** | 背景图支持毛玻璃层，明/暗可共用或分别设置 |
| **🎛️ 外观预设** | 命名预设随时切换，可导出复用 |
| **⏱️ 阅读进度** | 每本书的位置与百分比自动保存并恢复；可选章节进度条与页码 |
| **️ 沉浸模式** | 自动隐藏界面元素，点按唤出；移动端与官方状态栏/底栏协同 |
| **📱 移动端适配** | 正文区横滑呼出侧栏，触屏友好的章节轨，软键盘感知布局 |

**不收录 PDF / Markdown / FB2**：Obsidian 核心查看器占用了 `.pdf` 扩展名，且官方渲染比插件自造更成熟；其他类型仍可在库中正常打开，只是不作为书籍收录。

## 源码

完整的 TypeScript 源码随本仓库一起发布（`src/`、`vendor/`、`esbuild.config.mjs`、`tsconfig.json`），便于审核与自行构建：

```bash
npm install
npm run build   # tsc 类型检查 + esbuild 生产打包 → main.js + styles.css
```

日常开发在私有仓库 `UNcore-gh/UNreader-src` 中进行，这里的源码是发布快照。源码许可见 [LICENSE-SOURCE.md](LICENSE-SOURCE.md)。

## 安装

### BRAT（当前推荐）

1. 安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 插件
2. **BRAT → Add Beta plugin** → 填 `UNcore-gh/UNreader`
3. 在 **设置 → 第三方插件** 中启用 **UNreader**

### 手动安装

1. 从 [最新 Release](../../releases) 下载 `main.js`、`manifest.json`、`styles.css`
2. 放进 `<vault>/.obsidian/plugins/unreader/`
3. 重启 Obsidian，在 **设置 → 第三方插件** 中启用 **UNreader**

## 使用

- 直接点击库里的 `.epub` / `.mobi` / `.azw3` / `.txt` / `.html` / `.htm` 文件即可用 UNreader 打开
- 或在命令面板运行 **UNreader: 打开书籍**
- 书籍文件夹在 **设置 → UNreader** 中配置

| 命令 | 作用 |
|------|------|
| `UNreader: 打开书籍` | 从配置的书籍文件夹打开一本书 |
| `UNreader: 显示/隐藏浮动目录` | 开关浮动目录面板 |
| `UNreader: 切换标注侧边栏` | 开关高亮/书签/评论面板 |
| `UNreader: 添加书签` | 为当前位置添加书签 |
| `UNreader: 阅读外观` | 打开阅读外观面板 |

## 隐私

UNreader **完全离线**：

- 零网络请求
- 零遥测收集
- 只读取你库内的书籍文件，以及它自己的设置、字体、外观预设、阅读进度与标注数据

没有账号、没有云端、没有后台进程。

## 许可

- **编译产物**（`main.js`、`styles.css`、`manifest.json`）— [MIT](LICENSE)：可自由安装、使用、再分发。
- **源码**（本仓库的 `src/`、`vendor/` 与构建配置）— [UNcore Source Available 协议](LICENSE-SOURCE.md)：可阅读、审计、学习；商用需授权。

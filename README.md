# UNreader

A beautiful local-first reader for Obsidian — **EPUB first**, plus MOBI/AZW3, TXT, local HTML, RSS/Atom/JSON Feed articles and podcast enclosures. Reflowable layout, a floating table of contents, an on-edge chapter rail, highlights / bookmarks / comments, and a fully customisable appearance system (fonts, backgrounds, presets).

> Part of the **UN series** by [UNcore](https://github.com/UNcore-gh).

This is the **source repository** (`UNcore-gh/UNreader-src`, private). The plugin's binary releases live in the public mirror [`UNcore-gh/UNreader`](https://github.com/UNcore-gh/UNreader).

## Features

- **Formats** — EPUB (reflowable, full TOC/nav support), MOBI / AZW3 (KF8), TXT (encoding detection + automatic chapter splitting), and local HTML/HTM. HTML renders **the way the web page looks**: the document stays in one piece (no splitting into book chapters), the author's CSS is kept, and relative assets (images, `srcset`, stylesheets, CSS `url()`/`@import`) are resolved against the vault — reading is continuous and full-width, so the page's own layout wins. A **reading device** button on the action rail re-renders the page at a phone (390px), tablet (834px) or desktop (1280px) viewport and scales it down to the reading area — so a fixed-width desktop page is fully readable on a phone instead of overflowing past the right edge (the default *Auto* mode just follows the reading area). Scripts, event handlers, form controls and `<meta http-equiv=refresh>` are always stripped. PDF is deliberately **not** supported: Obsidian's core viewer owns the `.pdf` extension and is already better at it. The bookshelf and the *Open book* picker list **exactly these formats** — PDF, Markdown, FB2 and anything else stay in the vault (and open normally from the file explorer) but are not treated as books.
- **Shelf filters** — hide folders from the bookshelf and the *Open book* picker. By default it follows Obsidian's own **Excluded files** (Settings → Files & links), so a folder you already marked as "not my reading material" disappears from the shelf too; extra folders can be added per-vault in Settings → UNreader → Shelf. Filtering only affects the lists: the files keep working, and reading progress, pinned books and annotations are untouched.
- **Feeds** — RSS 2.0, Atom, RDF/RSS 1.0 and JSON Feed subscriptions in the same sidebar as annotations and the bookshelf. Import/export OPML, discover feeds from ordinary web pages, fetch full article text, cache article snapshots for offline reading, play or download podcast enclosures, and **star articles** — the reading toolbar's star button (which takes the bookmark button's place while a feed article is open) toggles the same 收藏 state as the star on each card, filterable from the `收藏` tab. A footer link at the very end of each article opens the original in your system browser (the same entry as the toolbar's external-link button).
- **Continuous reading** — every chapter renders as its own same-origin frame, stacked into one seamless scroll. Links, footnotes, page keys and text selection are all handled by the reader.
- **Navigation** — floating TOC panel, plus a chapter rail on the right edge whose dash length encodes outline depth; hover to preview a chapter, click to jump. Distant jumps settle in one pass (no intermediate flicker).
- **Annotations** — highlights, bookmarks and comments, with a dedicated annotations sidebar and an in-text selection toolbar. Bookmarks mark a position inside a book; feed articles are starred instead of bookmarked.
- **Appearance** — built-in and user-imported fonts, size / line-height / letter-spacing / paragraph-spacing / indent / margins, light-dark themes with custom colours, background images with a glass (blur) layer, and named presets you can export and reuse.
- **Reading progress** — per-book position and percentage are stored and restored, with an optional chapter progress bar and page numbers.
- **Immersive mode** — auto-hiding chrome with tap-to-reveal; on mobile it coordinates with Obsidian's native status/nav bars.
- **Mobile** — swipe from the text area to open Obsidian's side drawer, touch-friendly rail interaction, soft-keyboard aware layout.

## Development

```bash
npm install
npm run dev        # esbuild watch mode → main.js + styles.css
npm run build      # tsc -noEmit -skipLibCheck + production bundle
npm run typecheck  # types only
```

Build outputs (`main.js`, `styles.css`) land at the repository root and are gitignored — edit `src/styles.css`, never the root `styles.css`.

Regression probes (`npm run test:tocjump`, `test:focusgate`, `test:swipe`, `test:startup-layout`, `test:html`, …) drive a real Chromium engine via CDP; the full list and the invariants each one protects are documented in [`AGENTS.md`](AGENTS.md).

### Release

```bash
npm run release        # patch bump + build + sync binaries into ../UNreader-github
npm run release:minor  # minor / major variants: release:minor, release:major
npm run release:sync   # rebuild + sync without a version bump
```

`scripts/release-sync.mjs` builds **first** (a type error aborts before any version bump), then updates `manifest.json` / `package.json` / `package-lock.json` / `versions.json` and copies the release artifacts plus a source snapshot (`src/`, `vendor/`, build configs) into the public mirror. Obsidian's review bot requires source files to be present in the submitted repository. The script intentionally does not commit or push.

## Layout

```
UNreader-src/      ← this repo: source of truth (private)
  src/             TypeScript sources (main.ts, core/, ui/)
  vendor/foliate-js/  vendored foliate engine — do not modify
  test/ .perf/     CDP regression probes and the startup benchmark harness
UNreader-github/   ← public release mirror: binaries + reviewable source snapshot
                     (main.js / manifest.json / styles.css / versions.json / src / vendor / builds)
                     + README + LICENCEs; 内部材料（AGENTS.md / CLAUDE.md / test / .perf）不镜像
_notes/            ← human decision logs, not tracked by either repo
```

## Network and privacy

UNreader is **offline by default**. It collects **no telemetry**. Books, annotations and cached feed snapshots stay in your vault; podcast/image media caches are local IndexedDB data and are not part of vault sync.

Network access happens only after an explicit user action: adding or refreshing a subscription, resolving a website into a feed, fetching an article's full text, or downloading a podcast. Opening a cached article, restoring the workspace, and reading ordinary books do not start feed polling. The first time the Feeds sidebar is opened, UNreader may perform one controlled refresh when the setting is enabled. There is no background periodic polling, no paywall/login bypass, and video podcasts are not supported.

## License

Source Available License — 商用需授权。详见 [LICENSE](LICENSE)。

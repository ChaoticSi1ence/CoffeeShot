# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CoffeeShot is a Manifest V3 screenshot extension for Brave and other Chromium browsers, written in plain JavaScript, HTML and CSS. There is no package.json, bundler, framework, linter or test suite. The six runtime files (`manifest.json`, `background.js`, `capture.js`, `result.html`, `result.css`, `result.js`) are loaded by the browser exactly as they sit in this folder. Testing is manual, in Brave.

## Commands

All scripts are PowerShell and assume Windows. The two asset scripts drive headless Edge from a hardcoded path (`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`) and write scratch files to gitignored `work` folders.

Run from the checkout: open `brave://extensions` (or `chrome://extensions`), turn Developer mode on, click Load unpacked and pick this folder. After editing, press reload on the extension card. That restarts the service worker, and any capture it was holding in memory is gone.

Package a release zip as `dist/CoffeeShot-<version>.zip`, with the version read from `manifest.json`:

    powershell -ExecutionPolicy Bypass -File build.ps1

`build.ps1` copies an explicit `$files` list. A new runtime file must be added there or it will not ship.

Regenerate the icon PNGs from `icons/source/icon.jpg` and `glyph.svg`:

    powershell -ExecutionPolicy Bypass -File icons\source\make-icons.ps1

Regenerate the Web Store screenshots and promo tiles. `-Refresh` re-fetches the two live web pages used as backdrops; without it, cached renders in `store/source/work/` are reused:

    powershell -ExecutionPolicy Bypass -File store\source\render.ps1 [-Refresh]

`render.ps1` lifts the picker's stylesheet out of `capture.js` by regex-matching the `HOST`, `PANEL` and `CSS` constants. Renaming or restructuring those breaks the store render.

## Architecture

Three JavaScript contexts, and every capture flows through the first:

1. **`background.js`, the service worker.** The only code that calls `chrome.tabs.captureVisibleTab`. It owns a `jobs` Map; each job holds its PNG strips as data URLs in worker memory, plus `mode`, stitching geometry (`meta`), a user-facing `note` and a `fallback` flag. `busyTab` enforces one capture at a time. Cropping a dragged area also happens here, on an `OffscreenCanvas` on the extension's own origin, because Brave's fingerprint protection may perturb canvases on page origins.
2. **`capture.js`, injected on demand** with `chrome.scripting.executeScript` into the tab the user clicked (re-entry guarded by `window.__coffeeshot`). It draws the picker into a closed shadow root with `all: initial` so page CSS cannot reach it, and it drives full-page capture by scrolling the page and asking the worker for one `shot` per screen. It never touches the page's scripts and removes everything it added when done.
3. **`result.html` / `result.css` / `result.js`, the result tab**, opened at `result.html#<jobId>`. It pulls `job` and then each `strip` by index from the worker, shows or stitches the image on the `#base` canvas, takes markup on the separate `#ink` canvas, then copies or saves the PNG and closes itself.

### Job lifecycle

`start(tab, mode)` snapshots the visible tab *before* injecting `capture.js`, so the picker is drawn over a frozen frame and never appears in the shot. Modes: `pick` (toolbar click, picker with the F/V/S pill) and `area` / `full` / `visible` (chosen up front from the cup's right-click menu). A `visible` job skips the picker and opens the result tab at once.

If the page refuses the script (brave://, the Web Store, other extensions' pages, XML/SVG documents) or is the PDF viewer (accepts the script but cannot scroll), the job becomes `mode: "visible", fallback: true`. The result tab then opens with the Crop tool preselected and the image fitted to the window. That is the area picker for pages that cannot host one.

Chromium shuts the worker down after about 30 s without events and the capture lives only in its memory, so the open picker (`KEEPALIVE_MS` 20 s) and the result tab (25 s) both send `ping` while alive. A picker silent for `IDLE_MS` (90 s) is presumed gone and its job dropped. A job dies with its result tab (`tabs.onRemoved`). Until that tab opens it also dies with the source tab, or when the source tab navigates and stops answering `alive`.

### Messages

Everything crosses `chrome.runtime.sendMessage` with a `type` and the job `id`. The worker's `handle()` is the single dispatcher and answers `{ ok, ... }` or `{ ok: false, error }`. The errors `"expired"` and `"lost"` both mean the job is gone; the page shows the `LOST` toast.

- From the picker: `ping`, `cancel`, `open` (hand the finished capture to a result tab; an area is cropped here, once), `save` (1.0's path, straight to Downloads, no tab), `crop` (return the crop so the page can put it on the clipboard), `full-start`, `shot`.
- From the result tab: `job`, `strip`, `ping`.
- Worker to page: `start`, `alive`, `close`. `close` is answered only after the overlay has been off screen for two frames, because the caller's next shot may be of this tab.

### Full page

`fullPage()` in `capture.js` finds the scroller (the document, or the inner element under the viewport centre when the document does not scroll), forces `scroll-behavior: auto` and `scroll-snap-type: none`, nudges lazy content by scrolling to the bottom and back, collects fixed and sticky candidates, and after the first strip hides the ones that did not move with the content so headers appear once. The worker paces `captureVisibleTab` to Chromium's quota (`STEP_MS` 550 ms, two per second, one retry) and caps at `MAX_STRIPS` 40. `buildFull()` in `result.js` stitches from the recorded `ys`, painting only rows not already covered by an earlier strip, and scales the result so no side exceeds `MAX_SIDE` 16,384 px. The two caps live in different files on purpose.

### Result tab invariants

- The `#ink` canvas is allocated on the first stroke, never before. A full-page capture is tens of millions of pixels and most are exported untouched.
- Nothing redraws the whole ink layer on pointer move. Pen strokes extend by one segment; rectangles, arrows and the crop selection repaint only a dirty rectangle (`repaint`, `live`, `union`). Keep it that way.
- The crop selection (`sel`) is not a stroke. It never enters `ops`, is drawn over the strokes, and `applySel()` applies it before any export. The undo stack (`actions`) holds either the string `"stroke"` or an `{ image, ops }` snapshot taken before a crop.
- Clipboard writes must start inside the click handler. The blob is passed as a promise so encoding time cannot outlive the user activation. Save keeps its blob URL alive until `downloads.onChanged` reports `complete`, because closing the tab revokes it.
- Esc is layered: abort the stroke in progress, else clear the selection, else close the tab if nothing has been drawn and no save is in flight.

## Conventions the code is built around

- **One shape for every control: a capsule** (`border-radius: 999px`). The colour swatches are the same capsule at 1:1, a circle. This applies to the picker CSS inside `capture.js` and to `result.css` alike.
- **One key scheme.** Picker: F, V, S, Esc. Selection toolbar: C, S, E, with Esc clearing the selection. Result tab: P, R, A, X for tools, Enter applies a crop or copies, C and S copy and save, Ctrl+Z undoes. Ctrl+C and Ctrl+S always mirror C and S, and buttons show their key as a `<kbd>` keycap in their label. The keycap rule lives in both stylesheets, the `CSS` template in `capture.js` and `result.css`, and the store mocks under `store/source/` carry the same markup. A new action needs a key that fits, and the key list in the manifest's `default_title`, the README and the store copy must follow.
- **Motion runs on entrance only** and is fully disabled under `prefers-reduced-motion`. The picker overlay is torn down synchronously, never faded out, because the next `captureVisibleTab` could catch it.
- **The page context menu has exactly one item** (`pick`). Chrome collapses two or more of an extension's items into a submenu with no way to opt out. The four modes live on the cup's own menu (`contexts: ["action"]`).
- **No host permissions, no network, no storage.** Each of the four permissions is justified line by line in `README.md` and `store/description.txt`. Adding one is a product decision, not a code one.
- **Docs travel with behaviour.** The commit history pairs each feature with matching edits to `README.md` and `store/description.txt`. Release commits are titled `<version>: <what changed>`, with the version bumped in `manifest.json`, the only place it is stored.
